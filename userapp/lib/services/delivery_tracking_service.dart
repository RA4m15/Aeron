import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;
import '../core/constants.dart';
import '../models/delivery_tracking_models.dart';
import 'citizen_api_service.dart';
import 'secure_storage_service.dart';

class HealthcareDeliveryTrackingService extends ChangeNotifier {
  static HealthcareDeliveryTrackingService? _instance;
  static HealthcareDeliveryTrackingService get instance =>
      _instance ??= HealthcareDeliveryTrackingService();

  final CitizenApiService _apiService;
  final SecureStorageService _storage;
  final bool enableSocket;

  HealthcareDeliveryTrackingService({
    CitizenApiService? apiService,
    SecureStorageService? storage,
    this.enableSocket = true,
  })  : _apiService = apiService ?? CitizenApiService(),
        _storage = storage ?? SecureStorageService();

  DeliveryTrackingState _state = const DeliveryTrackingState();
  DeliveryTrackingState get state => _state;

  bool _isTracking = false;
  bool get isTracking => _isTracking;

  bool _isDisposed = false;
  bool get isDisposed => _isDisposed;

  Timer? _pollingTimer;
  io.Socket? _socket;
  String? _subscribedDeliveryId;
  bool _isFetching = false;

  /// Starts delivery tracking.
  Future<void> start() async {
    if (_isTracking || _isDisposed) return;
    _isTracking = true;

    await refreshNow();

    _pollingTimer?.cancel();
    _pollingTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      if (_isTracking && !_isFetching && !_isDisposed) {
        refreshNow(isSilent: true);
      }
    });
  }

  /// Stops tracking, closes socket subscriptions, and cleans up timers.
  void stop() {
    if (_isDisposed) return;
    _isTracking = false;
    _pollingTimer?.cancel();
    _pollingTimer = null;
    _cleanupSocket();
    _state = _state.copyWith(
      socketStatus: SocketConnectionStatus.disconnected,
    );
    notifyListeners();
  }

  /// Manually refreshes active delivery status from REST API.
  Future<void> refreshNow({bool isSilent = false}) async {
    if (_isFetching) return;
    _isFetching = true;

    if (!isSilent) {
      _state = _state.copyWith(isLoading: true, clearError: true);
      notifyListeners();
    }

    try {
      final token = await _storage.getAccessToken();
      if (token == null) {
        _state = _state.copyWith(
          clearActiveDelivery: true,
          isLoading: false,
          socketStatus: SocketConnectionStatus.disconnected,
          lastRefreshedAt: DateTime.now(),
        );
        _cleanupSocket();
        notifyListeners();
        return;
      }

      final deliveryData = await _apiService.getActiveDelivery();

      if (deliveryData == null) {
        // No active delivery for this citizen
        _state = _state.copyWith(
          clearActiveDelivery: true,
          isLoading: false,
          clearError: true,
          lastRefreshedAt: DateTime.now(),
        );
        _cleanupSocket();
      } else {
        final delivery = HealthcareDelivery.fromJson(deliveryData);
        _state = _state.copyWith(
          activeDelivery: delivery,
          isLoading: false,
          clearError: true,
          lastRefreshedAt: DateTime.now(),
        );

        // Connect or update Socket.IO subscription
        if (delivery.isActive) {
          _setupSocketForDelivery(delivery.deliveryId, token);
        } else {
          _cleanupSocket();
        }
      }
    } catch (e) {
      _state = _state.copyWith(
        isLoading: false,
        errorMessage: e.toString().replaceAll('Exception: ', ''),
        lastRefreshedAt: DateTime.now(),
      );
    } finally {
      _isFetching = false;
      notifyListeners();
    }
  }

  /// Connects to Socket.IO and subscribes to the citizen:delivery room.
  void _setupSocketForDelivery(String deliveryId, String token) {
    if (!enableSocket) {
      _subscribedDeliveryId = deliveryId;
      _state = _state.copyWith(socketStatus: SocketConnectionStatus.connected);
      notifyListeners();
      return;
    }

    if (_subscribedDeliveryId == deliveryId &&
        _socket != null &&
        _socket!.connected) {
      return;
    }

    _cleanupSocket();
    _subscribedDeliveryId = deliveryId;
    _state = _state.copyWith(socketStatus: SocketConnectionStatus.connecting);
    notifyListeners();

    try {
      final socketUrl = AppConstants.socketBaseUrl;

      _socket = io.io(
        socketUrl,
        io.OptionBuilder()
            .setTransports(['websocket'])
            .disableAutoConnect()
            .setAuth({'token': token})
            .enableReconnection()
            .setReconnectionDelay(2000)
            .build(),
      );

      _socket!.onConnect((_) {
        _state = _state.copyWith(socketStatus: SocketConnectionStatus.connected);
        notifyListeners();

        // Subscribe to private delivery room
        _socket!.emit('delivery:subscribe', {'deliveryId': deliveryId});
      });

      _socket!.onDisconnect((_) {
        _state = _state.copyWith(
          socketStatus: SocketConnectionStatus.disconnected,
        );
        notifyListeners();
      });

      _socket!.onConnectError((err) {
        _state = _state.copyWith(
          socketStatus: SocketConnectionStatus.error,
        );
        notifyListeners();
      });

      // Streamed telemetry from Backend
      _socket!.on('delivery:telemetry', (data) {
        _handleIncomingTelemetry(data);
      });

      _socket!.connect();
    } catch (e) {
      _state = _state.copyWith(socketStatus: SocketConnectionStatus.error);
      notifyListeners();
    }
  }

  /// Processes incoming delivery:telemetry events.
  @visibleForTesting
  void handleIncomingTelemetry(dynamic rawData) {
    _handleIncomingTelemetry(rawData);
  }

  void _handleIncomingTelemetry(dynamic rawData) {
    if (rawData is! Map<String, dynamic> || _state.activeDelivery == null) {
      return;
    }

    final incomingDeliveryId = rawData['deliveryId'] as String?;
    if (incomingDeliveryId != null &&
        incomingDeliveryId != _state.activeDelivery!.deliveryId) {
      // Discard mismatched delivery telemetry
      return;
    }

    final updatedTelemetry = DroneTelemetryData.fromJson(rawData);

    // Update status if provided in socket event
    DeliveryStatus currentStatus = _state.activeDelivery!.status;
    if (rawData['deliveryStatus'] != null) {
      currentStatus = DeliveryStatus.fromBackend(rawData['deliveryStatus'] as String?);
    }

    final updatedDelivery = _state.activeDelivery!.copyWith(
      status: currentStatus,
      isFlying: currentStatus != DeliveryStatus.ordered &&
          currentStatus != DeliveryStatus.assigned &&
          currentStatus != DeliveryStatus.delivered &&
          currentStatus != DeliveryStatus.cancelled,
      telemetry: updatedTelemetry,
    );

    _state = _state.copyWith(
      activeDelivery: updatedDelivery,
      lastRefreshedAt: DateTime.now(),
    );

    // If delivery reached terminal status, unsubscribe
    if (!currentStatus.isActive) {
      _cleanupSocket();
    }

    notifyListeners();
  }

  /// Cleanly closes socket and unsubscribes.
  void _cleanupSocket() {
    if (_socket != null) {
      if (_subscribedDeliveryId != null && _socket!.connected) {
        try {
          _socket!.emit('delivery:unsubscribe', {'deliveryId': _subscribedDeliveryId});
        } catch (_) {}
      }
      try {
        _socket!.disconnect();
        _socket!.destroy();
        _socket!.dispose();
      } catch (_) {}
      _socket = null;
    }
    _subscribedDeliveryId = null;
  }

  @override
  void dispose() {
    _isDisposed = true;
    _isTracking = false;
    _pollingTimer?.cancel();
    _pollingTimer = null;
    _cleanupSocket();
    super.dispose();
  }
}
