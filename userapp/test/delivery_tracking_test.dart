import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:userapp/main.dart';
import 'package:userapp/models/auth_user.dart';
import 'package:userapp/models/delivery_tracking_models.dart';
import 'package:userapp/screens/delivery_tracking_screen.dart';
import 'package:userapp/services/auth_service.dart';
import 'package:userapp/services/citizen_api_service.dart';
import 'package:userapp/services/delivery_tracking_service.dart';
import 'package:userapp/services/secure_storage_service.dart';
import 'package:userapp/widgets/delivery_tracking_pill.dart';

// --- Mocks and Fakes ---

class FakeSecureStorageService implements SecureStorageService {
  String? token;
  FakeSecureStorageService({this.token = 'mock-jwt-token-xyz'});

  @override
  Future<String?> getAccessToken() async => token;

  @override
  Future<String?> getRefreshToken() async => 'mock-refresh-token';

  @override
  Future<void> saveTokens({required String accessToken, String? refreshToken}) async {
    token = accessToken;
  }

  @override
  Future<void> clearAll() async {
    token = null;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeAuthService extends ChangeNotifier implements CitizenAuthService {
  bool authenticated;
  FakeAuthService({this.authenticated = true});

  @override
  bool get isAuthenticated => authenticated;

  @override
  CitizenAuthUser? get currentUser => authenticated
      ? const CitizenAuthUser(
          id: 'cit-101',
          name: 'Jane Citizen',
          email: 'jane@aeron.org',
          role: 'citizen',
          accountStatus: 'active',
        )
      : null;

  @override
  bool get isLoading => false;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeCitizenApiService implements CitizenApiService {
  Map<String, dynamic>? activeDeliveryResponse;
  bool shouldThrow = false;
  String errorMessage = 'Network connection failed';
  int fetchCallCount = 0;

  FakeCitizenApiService({this.activeDeliveryResponse});

  @override
  Future<Map<String, dynamic>?> getActiveDelivery() async {
    fetchCallCount++;
    if (shouldThrow) {
      throw Exception(errorMessage);
    }
    return activeDeliveryResponse;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

// Sample JSON payloads mirroring AERON Backend REST and Socket responses
Map<String, dynamic> sampleActiveDeliveryJson({
  String deliveryId = 'DEL-2026-MED01',
  String status = 'IN_TRANSIT',
  String freshness = 'available',
  bool isLivePosition = true,
  double droneLat = 12.9716,
  double droneLng = 77.5946,
}) {
  return {
    '_id': 'mongodb-id-001',
    'deliveryId': deliveryId,
    'status': status,
    'packageType': 'EMERGENCY_INSULIN',
    'recipient': {
      'id': 'cit-101',
      'name': 'Jane Citizen',
      'email': 'jane@aeron.org',
    },
    'assignedDrone': {
      '_id': 'drone-mongo-1',
      'droneId': 'AERON-PX4-BENCH01',
      'model': 'Hexacopter-V2',
    },
    'pickupLocation': {
      'type': 'Point',
      'coordinates': [77.5800, 12.9600],
      'address': 'Apollo Central Hospital Drone Port #2',
    },
    'destinationLocation': {
      'type': 'Point',
      'coordinates': [77.6100, 12.9900],
      'address': 'Building 4, Sector 7, Outer Ring Road',
    },
    'dispatchedAt': '2026-11-16T12:00:00.000Z',
    'createdAt': '2026-11-16T11:45:00.000Z',
    'updatedAt': '2026-11-16T12:05:00.000Z',
    'telemetry': {
      'droneId': 'AERON-PX4-BENCH01',
      'latitude': droneLat,
      'longitude': droneLng,
      'altitude': 42.5,
      'groundSpeed': 11.2,
      'heading': 78.0,
      'batteryPercentage': 88,
      'freshness': freshness,
      'isLivePosition': isLivePosition,
      'recordedAt': '2026-11-16T12:05:10.000Z',
    },
  };
}

void main() {
  group('Delivery Tracking Models & Serialization Tests', () {
    test('HealthcareDelivery parses full active backend payload correctly', () {
      final json = sampleActiveDeliveryJson();
      final delivery = HealthcareDelivery.fromJson(json);

      expect(delivery.deliveryId, 'DEL-2026-MED01');
      expect(delivery.status, DeliveryStatus.inTransit);
      expect(delivery.isActive, isTrue);
      expect(delivery.packageType, 'EMERGENCY_INSULIN');
      expect(delivery.assignedDrone?.droneId, 'AERON-PX4-BENCH01');
      expect(delivery.pickupLocation.longitude, 77.5800);
      expect(delivery.pickupLocation.latitude, 12.9600);
      expect(delivery.pickupLocation.address, 'Apollo Central Hospital Drone Port #2');
      expect(delivery.destinationLocation.longitude, 77.6100);
      expect(delivery.destinationLocation.latitude, 12.9900);
      expect(delivery.destinationLocation.address, 'Building 4, Sector 7, Outer Ring Road');
      expect(delivery.telemetry, isNotNull);
      expect(delivery.telemetry!.isLive, isTrue);
      expect(delivery.telemetry!.freshness, TelemetryFreshness.available);
      expect(delivery.telemetry!.latitude, 12.9716);
      expect(delivery.telemetry!.longitude, 77.5946);
      expect(delivery.telemetry!.altitude, 42.5);
      expect(delivery.telemetry!.groundSpeed, 11.2);
      expect(delivery.telemetry!.heading, 78.0);
    });

    test('DroneTelemetryData parses stale and unavailable freshness correctly', () {
      final staleJson = sampleActiveDeliveryJson(
        freshness: 'stale',
        isLivePosition: false,
      )['telemetry'] as Map<String, dynamic>;

      final staleTelem = DroneTelemetryData.fromJson(staleJson);
      expect(staleTelem.freshness, TelemetryFreshness.stale);
      expect(staleTelem.isLivePosition, isFalse);
      expect(staleTelem.isLive, isFalse);
      expect(staleTelem.hasCoordinates, isTrue);

      final unavailJson = {
        'freshness': 'unavailable',
        'isLivePosition': false,
        'message': 'No telemetry record found',
      };
      final unavailTelem = DroneTelemetryData.fromJson(unavailJson);
      expect(unavailTelem.freshness, TelemetryFreshness.unavailable);
      expect(unavailTelem.isLive, isFalse);
      expect(unavailTelem.hasCoordinates, isFalse);
      expect(unavailTelem.latitude, isNull);
      expect(unavailTelem.longitude, isNull);
    });

    test('DeliveryStatus enum maps all stages, active states, and indexes correctly', () {
      expect(DeliveryStatus.fromBackend('ORDERED'), DeliveryStatus.ordered);
      expect(DeliveryStatus.fromBackend('ASSIGNED'), DeliveryStatus.assigned);
      expect(DeliveryStatus.fromBackend('DISPATCHED'), DeliveryStatus.dispatched);
      expect(DeliveryStatus.fromBackend('IN_TRANSIT'), DeliveryStatus.inTransit);
      expect(DeliveryStatus.fromBackend('APPROACHING'), DeliveryStatus.approaching);
      expect(DeliveryStatus.fromBackend('DELIVERED'), DeliveryStatus.delivered);
      expect(DeliveryStatus.fromBackend('CANCELLED'), DeliveryStatus.cancelled);
      expect(DeliveryStatus.fromBackend('UNKNOWN_VALUE'), DeliveryStatus.ordered);

      expect(DeliveryStatus.ordered.isActive, isTrue);
      expect(DeliveryStatus.assigned.isActive, isTrue);
      expect(DeliveryStatus.dispatched.isActive, isTrue);
      expect(DeliveryStatus.inTransit.isActive, isTrue);
      expect(DeliveryStatus.approaching.isActive, isTrue);
      expect(DeliveryStatus.delivered.isActive, isFalse);
      expect(DeliveryStatus.cancelled.isActive, isFalse);

      expect(DeliveryStatus.ordered.stageIndex, 1);
      expect(DeliveryStatus.assigned.stageIndex, 2);
      expect(DeliveryStatus.dispatched.stageIndex, 3);
      expect(DeliveryStatus.inTransit.stageIndex, 4);
      expect(DeliveryStatus.approaching.stageIndex, 5);
      expect(DeliveryStatus.delivered.stageIndex, 6);
    });

    test('DeliveryTrackingState copyWith works as expected', () {
      const state = DeliveryTrackingState();
      expect(state.activeDelivery, isNull);
      expect(state.isLoading, isFalse);
      expect(state.hasActiveDelivery, isFalse);
      expect(state.socketStatus, SocketConnectionStatus.disconnected);

      final delivery = HealthcareDelivery.fromJson(sampleActiveDeliveryJson());
      final updated = state.copyWith(
        activeDelivery: delivery,
        isLoading: true,
        socketStatus: SocketConnectionStatus.connected,
      );

      expect(updated.hasActiveDelivery, isTrue);
      expect(updated.activeDelivery?.deliveryId, 'DEL-2026-MED01');
      expect(updated.isLoading, isTrue);
      expect(updated.socketStatus, SocketConnectionStatus.connected);

      final cleared = updated.copyWith(clearActiveDelivery: true, isLoading: false);
      expect(cleared.activeDelivery, isNull);
      expect(cleared.hasActiveDelivery, isFalse);
      expect(cleared.isLoading, isFalse);
    });
  });

  group('HealthcareDeliveryTrackingService State & Polling Tests', () {
    test('Unauthenticated user returns clean state without active delivery', () async {
      final fakeStorage = FakeSecureStorageService(token: null);
      final fakeApi = FakeCitizenApiService(
        activeDeliveryResponse: sampleActiveDeliveryJson(),
      );

      final service = HealthcareDeliveryTrackingService(
        storage: fakeStorage,
        apiService: fakeApi,
      );

      await service.refreshNow();

      expect(service.state.activeDelivery, isNull);
      expect(service.state.hasActiveDelivery, isFalse);
      expect(fakeApi.fetchCallCount, 0); // Should not call API when token is absent
    });

    test('Authenticated user with active delivery sets state correctly', () async {
      final fakeStorage = FakeSecureStorageService(token: 'valid-jwt');
      final fakeApi = FakeCitizenApiService(
        activeDeliveryResponse: sampleActiveDeliveryJson(),
      );

      final service = HealthcareDeliveryTrackingService(
        storage: fakeStorage,
        apiService: fakeApi,
        enableSocket: false,
      );
      addTearDown(() => service.dispose());

      await service.refreshNow();

      expect(service.state.activeDelivery, isNotNull);
      expect(service.state.activeDelivery!.deliveryId, 'DEL-2026-MED01');
      expect(service.state.hasActiveDelivery, isTrue);
      expect(service.state.errorMessage, isNull);
      expect(fakeApi.fetchCallCount, 1);
    });

    test('Authenticated user with no active delivery sets clean standby state', () async {
      final fakeStorage = FakeSecureStorageService(token: 'valid-jwt');
      final fakeApi = FakeCitizenApiService(activeDeliveryResponse: null);

      final service = HealthcareDeliveryTrackingService(
        storage: fakeStorage,
        apiService: fakeApi,
        enableSocket: false,
      );
      addTearDown(() => service.dispose());

      await service.refreshNow();

      expect(service.state.activeDelivery, isNull);
      expect(service.state.hasActiveDelivery, isFalse);
      expect(service.state.errorMessage, isNull);
    });

    test('API failure safely captures error without unhandled exceptions', () async {
      final fakeStorage = FakeSecureStorageService(token: 'valid-jwt');
      final fakeApi = FakeCitizenApiService();
      fakeApi.shouldThrow = true;
      fakeApi.errorMessage = '503 Service Unavailable';

      final service = HealthcareDeliveryTrackingService(
        storage: fakeStorage,
        apiService: fakeApi,
        enableSocket: false,
      );
      addTearDown(() => service.dispose());

      await service.refreshNow();

      expect(service.state.activeDelivery, isNull);
      expect(service.state.errorMessage, contains('503 Service Unavailable'));
      expect(service.state.isLoading, isFalse);
    });

    test('Incoming socket telemetry updates delivery state and coordinates', () async {
      final fakeStorage = FakeSecureStorageService(token: 'valid-jwt');
      final fakeApi = FakeCitizenApiService(
        activeDeliveryResponse: sampleActiveDeliveryJson(
          droneLat: 12.9716,
          droneLng: 77.5946,
        ),
      );

      final service = HealthcareDeliveryTrackingService(
        storage: fakeStorage,
        apiService: fakeApi,
        enableSocket: false,
      );
      addTearDown(() => service.dispose());

      await service.refreshNow();
      expect(service.state.activeDelivery!.telemetry!.latitude, 12.9716);

      // Simulate incoming telemetry event from socket
      service.handleIncomingTelemetry({
        'deliveryId': 'DEL-2026-MED01',
        'deliveryStatus': 'APPROACHING',
        'latitude': 12.9850,
        'longitude': 77.6050,
        'altitude': 18.0,
        'groundSpeed': 4.5,
        'heading': 85.0,
        'freshness': 'available',
        'isLivePosition': true,
        'recordedAt': DateTime.now().toIso8601String(),
      });

      expect(service.state.activeDelivery!.status, DeliveryStatus.approaching);
      expect(service.state.activeDelivery!.telemetry!.latitude, 12.9850);
      expect(service.state.activeDelivery!.telemetry!.longitude, 77.6050);
      expect(service.state.activeDelivery!.telemetry!.altitude, 18.0);
      expect(service.state.activeDelivery!.telemetry!.groundSpeed, 4.5);
      expect(service.state.activeDelivery!.telemetry!.isLive, isTrue);
    });

    test('Incoming socket telemetry ignores mismatched delivery ID', () async {
      final fakeStorage = FakeSecureStorageService(token: 'valid-jwt');
      final fakeApi = FakeCitizenApiService(
        activeDeliveryResponse: sampleActiveDeliveryJson(
          deliveryId: 'DEL-2026-MED01',
        ),
      );

      final service = HealthcareDeliveryTrackingService(
        storage: fakeStorage,
        apiService: fakeApi,
        enableSocket: false,
      );
      addTearDown(() => service.dispose());

      await service.refreshNow();

      // Send telemetry with mismatched ID
      service.handleIncomingTelemetry({
        'deliveryId': 'DEL-DIFFERENT-ID',
        'location': {
          'type': 'Point',
          'coordinates': [80.0, 13.0],
        },
      });

      // Coordinates should remain untouched
      expect(service.state.activeDelivery!.telemetry!.latitude, 12.9716);
      expect(service.state.activeDelivery!.telemetry!.longitude, 77.5946);
    });

    test('start() and stop() control polling lifecycle cleanly', () async {
      final fakeStorage = FakeSecureStorageService(token: 'valid-jwt');
      final fakeApi = FakeCitizenApiService(
        activeDeliveryResponse: sampleActiveDeliveryJson(),
      );

      final service = HealthcareDeliveryTrackingService(
        storage: fakeStorage,
        apiService: fakeApi,
        enableSocket: false,
      );
      addTearDown(() => service.dispose());

      expect(service.isTracking, isFalse);
      await service.start();
      expect(service.isTracking, isTrue);
      expect(fakeApi.fetchCallCount, 1);

      service.stop();
      expect(service.isTracking, isFalse);
    });
  });

  group('DeliveryTrackingPill Widget Tests', () {
    testWidgets('Renders standby state when no active delivery exists', (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: DeliveryTrackingPill(
              delivery: null,
              animatePulse: false,
            ),
          ),
        ),
      );

      expect(find.text('DRONE DELIVERY TRACKING'), findsOneWidget);
      expect(find.text('NO ACTIVE DELIVERY'), findsOneWidget);
      expect(find.text('STANDBY'), findsOneWidget);
      expect(find.byIcon(Icons.medical_services_outlined), findsOneWidget);
    });

    testWidgets('Tapping standby pill opens bottom modal with explanation', (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: DeliveryTrackingPill(
              delivery: null,
              animatePulse: false,
            ),
          ),
        ),
      );

      await tester.tap(find.byType(DeliveryTrackingPill));
      await tester.pumpAndSettle();

      expect(
        find.textContaining('No healthcare delivery is currently assigned to your address'),
        findsOneWidget,
      );
      expect(find.text('Check for Updates'), findsOneWidget);
    });

    testWidgets('Renders live active delivery with LIVE badge and pulsating indicator', (tester) async {
      final delivery = HealthcareDelivery.fromJson(
        sampleActiveDeliveryJson(
          deliveryId: 'DEL-2026-MED01',
          status: 'IN_TRANSIT',
          freshness: 'available',
          isLivePosition: true,
        ),
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: DeliveryTrackingPill(
              delivery: delivery,
              animatePulse: false,
            ),
          ),
        ),
      );

      expect(find.textContaining('DEL-2026-MED01'), findsOneWidget);
      expect(find.text('IN TRANSIT'), findsOneWidget);
      expect(find.text('LIVE'), findsOneWidget);
    });

    testWidgets('Renders STALE GPS badge when telemetry is stale', (tester) async {
      final delivery = HealthcareDelivery.fromJson(
        sampleActiveDeliveryJson(
          deliveryId: 'DEL-2026-MED01',
          status: 'IN_TRANSIT',
          freshness: 'stale',
          isLivePosition: false,
        ),
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: DeliveryTrackingPill(
              delivery: delivery,
              animatePulse: false,
            ),
          ),
        ),
      );

      expect(find.textContaining('DEL-2026-MED01'), findsOneWidget);
      expect(find.text('STALE GPS'), findsOneWidget);
      expect(find.text('LIVE'), findsNothing);
    });

    testWidgets('Pill disappears when empty-state modal opens and reappears after Check for Updates dismissal', (tester) async {
      final navKey = GlobalKey<NavigatorState>();
      final fakeAuth = FakeAuthService(authenticated: true);
      final fakeStorage = FakeSecureStorageService(token: 'valid-jwt');
      final fakeApi = FakeCitizenApiService(activeDeliveryResponse: null);

      final trackingService = HealthcareDeliveryTrackingService(
        storage: fakeStorage,
        apiService: fakeApi,
        enableSocket: false,
      );
      addTearDown(() => trackingService.dispose());
      await trackingService.refreshNow();

      await tester.pumpWidget(
        AeronCitizenApp(
          authService: fakeAuth,
          deliveryTrackingService: trackingService,
          navigatorKey: navKey,
          animatePulse: false,
          autoStartTracking: false,
        ),
      );
      await tester.pump();

      // Standby capsule is visible in global overlay
      expect(find.text('DRONE DELIVERY TRACKING'), findsOneWidget);
      expect(find.text('NO ACTIVE DELIVERY'), findsOneWidget);
      expect(find.text('STANDBY'), findsOneWidget);

      // Tap standby capsule to open modal
      await tester.tap(find.text('DRONE DELIVERY TRACKING'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      // Modal content is visible and unobscured
      expect(
        find.textContaining('No healthcare delivery is currently assigned to your address'),
        findsOneWidget,
      );
      expect(find.text('Check for Updates'), findsOneWidget);

      // CRITICAL: The overlay pill must be hidden while modal is open to avoid obscuring content
      expect(find.text('NO ACTIVE DELIVERY'), findsNothing);
      expect(find.text('STANDBY'), findsNothing);

      // Dismiss via 'Check for Updates' action
      await tester.tap(find.text('Check for Updates'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      // Modal is dismissed and pill is restored
      expect(
        find.textContaining('No healthcare delivery is currently assigned to your address'),
        findsNothing,
      );
      expect(find.text('NO ACTIVE DELIVERY'), findsOneWidget);
      expect(find.text('STANDBY'), findsOneWidget);
    });

    testWidgets('Pill reappears after outside barrier tap dismissal', (tester) async {
      final navKey = GlobalKey<NavigatorState>();
      final fakeAuth = FakeAuthService(authenticated: true);
      final fakeStorage = FakeSecureStorageService(token: 'valid-jwt');
      final fakeApi = FakeCitizenApiService(activeDeliveryResponse: null);

      final trackingService = HealthcareDeliveryTrackingService(
        storage: fakeStorage,
        apiService: fakeApi,
        enableSocket: false,
      );
      addTearDown(() => trackingService.dispose());
      await trackingService.refreshNow();

      await tester.pumpWidget(
        AeronCitizenApp(
          authService: fakeAuth,
          deliveryTrackingService: trackingService,
          navigatorKey: navKey,
          animatePulse: false,
          autoStartTracking: false,
        ),
      );
      await tester.pump();

      // Open modal
      await tester.tap(find.text('DRONE DELIVERY TRACKING'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.text('NO ACTIVE DELIVERY'), findsNothing);

      // Dismiss via outside tap on the barrier
      await tester.tapAt(const Offset(100, 50));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      // Modal dismissed and pill restored
      expect(
        find.textContaining('No healthcare delivery is currently assigned to your address'),
        findsNothing,
      );
      expect(find.text('NO ACTIVE DELIVERY'), findsOneWidget);
    });

    testWidgets('Pill reappears after Android back button dismissal', (tester) async {
      final navKey = GlobalKey<NavigatorState>();
      final fakeAuth = FakeAuthService(authenticated: true);
      final fakeStorage = FakeSecureStorageService(token: 'valid-jwt');
      final fakeApi = FakeCitizenApiService(activeDeliveryResponse: null);

      final trackingService = HealthcareDeliveryTrackingService(
        storage: fakeStorage,
        apiService: fakeApi,
        enableSocket: false,
      );
      addTearDown(() => trackingService.dispose());
      await trackingService.refreshNow();

      await tester.pumpWidget(
        AeronCitizenApp(
          authService: fakeAuth,
          deliveryTrackingService: trackingService,
          navigatorKey: navKey,
          animatePulse: false,
          autoStartTracking: false,
        ),
      );
      await tester.pump();

      // Open modal
      await tester.tap(find.text('DRONE DELIVERY TRACKING'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.text('NO ACTIVE DELIVERY'), findsNothing);

      // Simulate Android physical / gesture back button
      await tester.binding.handlePopRoute();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      // Modal dismissed and pill restored
      expect(
        find.textContaining('No healthcare delivery is currently assigned to your address'),
        findsNothing,
      );
      expect(find.text('NO ACTIVE DELIVERY'), findsOneWidget);
    });

    testWidgets('Pill reappears after drag down dismissal', (tester) async {
      final navKey = GlobalKey<NavigatorState>();
      final fakeAuth = FakeAuthService(authenticated: true);
      final fakeStorage = FakeSecureStorageService(token: 'valid-jwt');
      final fakeApi = FakeCitizenApiService(activeDeliveryResponse: null);

      final trackingService = HealthcareDeliveryTrackingService(
        storage: fakeStorage,
        apiService: fakeApi,
        enableSocket: false,
      );
      addTearDown(() => trackingService.dispose());
      await trackingService.refreshNow();

      await tester.pumpWidget(
        AeronCitizenApp(
          authService: fakeAuth,
          deliveryTrackingService: trackingService,
          navigatorKey: navKey,
          animatePulse: false,
          autoStartTracking: false,
        ),
      );
      await tester.pump();

      // Open modal
      await tester.tap(find.text('DRONE DELIVERY TRACKING'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.text('NO ACTIVE DELIVERY'), findsNothing);

      // Drag modal sheet down
      await tester.drag(
        find.textContaining('No healthcare delivery is currently assigned to your address'),
        const Offset(0, 400),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      // Modal dismissed and pill restored
      expect(
        find.textContaining('No healthcare delivery is currently assigned to your address'),
        findsNothing,
      );
      expect(find.text('NO ACTIVE DELIVERY'), findsOneWidget);
    });

    testWidgets('Tapping standby capsule on pushed routes temporarily hides pill and restores it upon dismissal', (tester) async {
      final navKey = GlobalKey<NavigatorState>();
      final fakeAuth = FakeAuthService(authenticated: true);
      final fakeStorage = FakeSecureStorageService(token: 'valid-jwt');
      final fakeApi = FakeCitizenApiService(activeDeliveryResponse: null);

      final trackingService = HealthcareDeliveryTrackingService(
        storage: fakeStorage,
        apiService: fakeApi,
        enableSocket: false,
      );
      addTearDown(() => trackingService.dispose());
      await trackingService.refreshNow();

      await tester.pumpWidget(
        AeronCitizenApp(
          authService: fakeAuth,
          deliveryTrackingService: trackingService,
          navigatorKey: navKey,
          animatePulse: false,
          autoStartTracking: false,
        ),
      );
      await tester.pump();

      // Push secondary screen onto the navigator
      navKey.currentState?.push(
        MaterialPageRoute(
          builder: (_) => const Scaffold(
            body: Center(child: Text('PUSHED SECONDARY SCREEN')),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      // Verify pushed screen and persistent tracking pill are both visible
      expect(find.text('PUSHED SECONDARY SCREEN'), findsOneWidget);
      expect(find.text('DRONE DELIVERY TRACKING'), findsOneWidget);
      expect(find.text('NO ACTIVE DELIVERY'), findsOneWidget);

      // Tap capsule on the pushed route
      await tester.tap(find.text('DRONE DELIVERY TRACKING'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      // Modal bottom sheet opens properly above pushed route
      expect(
        find.textContaining('No healthcare delivery is currently assigned to your address'),
        findsOneWidget,
      );
      // Pill must be hidden
      expect(find.text('NO ACTIVE DELIVERY'), findsNothing);

      // Dismiss modal
      await tester.tap(find.text('Check for Updates'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      // Pill is restored on the pushed route
      expect(find.text('PUSHED SECONDARY SCREEN'), findsOneWidget);
      expect(find.text('NO ACTIVE DELIVERY'), findsOneWidget);
    });
  });

  group('DeliveryTrackingScreen UI Component Tests', () {
    testWidgets('Renders delivery header, drone ID, and lifecycle stages', (tester) async {
      final delivery = HealthcareDelivery.fromJson(
        sampleActiveDeliveryJson(
          deliveryId: 'DEL-2026-MED01',
          status: 'IN_TRANSIT',
        ),
      );

      final fakeStorage = FakeSecureStorageService(token: 'valid-jwt');
      final fakeApi = FakeCitizenApiService(
        activeDeliveryResponse: sampleActiveDeliveryJson(),
      );

      final service = HealthcareDeliveryTrackingService(
        storage: fakeStorage,
        apiService: fakeApi,
        enableSocket: false,
      );
      addTearDown(() => service.dispose());
      await service.refreshNow();

      await tester.pumpWidget(
        MaterialApp(
          home: DeliveryTrackingScreen(
            deliveryId: delivery.deliveryId,
            trackingService: service,
          ),
        ),
      );
      await tester.pump();

      // Header verification
      expect(find.text('DEL-2026-MED01'), findsWidgets);
      expect(find.textContaining('Drone: AERON-PX4-BENCH01'), findsOneWidget);
      expect(find.text('DELIVERY LIFECYCLE PROGRESS'), findsOneWidget);

      // Lifecycle milestones: stages 1, 2, 3 are complete (check icons); stage 4 is current; 5 and 6 pending
      expect(find.byIcon(Icons.check), findsNWidgets(3));
      expect(find.text('4'), findsOneWidget);
      expect(find.text('5'), findsOneWidget);
      expect(find.text('6'), findsOneWidget);

      // Locations
      expect(find.text('Apollo Central Hospital Drone Port #2'), findsOneWidget);
      expect(find.text('Building 4, Sector 7, Outer Ring Road'), findsOneWidget);

      // Telemetry metrics
      expect(find.text('40.3 km/h'), findsOneWidget);
      expect(find.text('42.5 m'), findsOneWidget);
      expect(find.text('78°'), findsOneWidget);

      // Map control buttons
      expect(find.byIcon(Icons.add), findsOneWidget);
      expect(find.byIcon(Icons.remove), findsOneWidget);
      expect(find.byIcon(Icons.my_location), findsOneWidget);
    });

    testWidgets('Displays stale telemetry warning banner when GPS is stale', (tester) async {
      final fakeStorage = FakeSecureStorageService(token: 'valid-jwt');
      final fakeApi = FakeCitizenApiService(
        activeDeliveryResponse: sampleActiveDeliveryJson(
          freshness: 'stale',
          isLivePosition: false,
        ),
      );

      final service = HealthcareDeliveryTrackingService(
        storage: fakeStorage,
        apiService: fakeApi,
        enableSocket: false,
      );
      addTearDown(() => service.dispose());
      await service.refreshNow();

      await tester.pumpWidget(
        MaterialApp(
          home: DeliveryTrackingScreen(
            deliveryId: 'DEL-2026-MED01',
            trackingService: service,
          ),
        ),
      );
      await tester.pump();

      expect(
        find.textContaining('GPS update delayed (>30s)'),
        findsOneWidget,
      );
    });
  });
}
