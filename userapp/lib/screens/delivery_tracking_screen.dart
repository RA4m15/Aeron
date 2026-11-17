import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import '../models/delivery_tracking_models.dart';
import '../services/delivery_tracking_service.dart';
import '../theme/app_colors.dart';

class DeliveryTrackingScreen extends StatefulWidget {
  final String deliveryId;
  final HealthcareDeliveryTrackingService? trackingService;

  const DeliveryTrackingScreen({
    super.key,
    required this.deliveryId,
    this.trackingService,
  });

  @override
  State<DeliveryTrackingScreen> createState() => _DeliveryTrackingScreenState();
}

class _DeliveryTrackingScreenState extends State<DeliveryTrackingScreen>
    with SingleTickerProviderStateMixin {
  late final MapController _mapController;
  late final HealthcareDeliveryTrackingService _trackingService;
  late final AnimationController _pulseController;
  late final Animation<double> _pulseAnimation;

  @override
  void initState() {
    super.initState();
    _mapController = MapController();
    _trackingService =
        widget.trackingService ?? HealthcareDeliveryTrackingService.instance;

    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1400),
    )..repeat(reverse: true);

    _pulseAnimation = CurvedAnimation(
      parent: _pulseController,
      curve: Curves.easeInOut,
    );
  }

  @override
  void dispose() {
    _pulseController.dispose();
    _mapController.dispose();
    super.dispose();
  }

  void _recenterMap(HealthcareDelivery delivery) {
    if (delivery.telemetry != null && delivery.telemetry!.hasCoordinates) {
      _mapController.move(
        LatLng(
          delivery.telemetry!.latitude!,
          delivery.telemetry!.longitude!,
        ),
        15.0,
      );
    } else {
      _mapController.move(
        LatLng(
          delivery.destinationLocation.latitude,
          delivery.destinationLocation.longitude,
        ),
        14.0,
      );
    }
  }

  void _zoomIn() {
    final currentZoom = _mapController.camera.zoom;
    _mapController.move(_mapController.camera.center, currentZoom + 1);
  }

  void _zoomOut() {
    final currentZoom = _mapController.camera.zoom;
    _mapController.move(_mapController.camera.center, currentZoom - 1);
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _trackingService,
      builder: (context, _) {
        final state = _trackingService.state;
        final delivery = state.activeDelivery;

        return Scaffold(
          backgroundColor: AppColors.background,
          appBar: AppBar(
            backgroundColor: AppColors.surface,
            elevation: 0,
            leading: IconButton(
              icon: const Icon(Icons.arrow_back, color: Colors.white),
              onPressed: () => Navigator.of(context).pop(),
            ),
            title: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  delivery?.deliveryId ?? widget.deliveryId,
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 16,
                    fontWeight: FontWeight.bold,
                    letterSpacing: 0.8,
                  ),
                ),
                Text(
                  _formatPackageType(delivery?.packageType ?? 'HEALTHCARE DELIVERY'),
                  style: const TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
            actions: [
              IconButton(
                icon: const Icon(Icons.refresh, color: AppColors.primaryAccent),
                onPressed: () => _trackingService.refreshNow(),
                tooltip: 'Refresh Status',
              ),
            ],
          ),
          body: delivery == null
              ? _buildLoadingOrError(state)
              : _buildDeliveryContent(delivery, state),
        );
      },
    );
  }

  Widget _buildLoadingOrError(DeliveryTrackingState state) {
    if (state.isLoading) {
      return const Center(
        child: CircularProgressIndicator(color: AppColors.primaryAccent),
      );
    }
    if (state.errorMessage != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, color: Colors.redAccent, size: 48),
              const SizedBox(height: 12),
              Text(
                state.errorMessage!,
                style: const TextStyle(color: Colors.white70),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 16),
              ElevatedButton(
                onPressed: () => _trackingService.refreshNow(),
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.primaryAccent,
                  foregroundColor: Colors.black,
                ),
                child: const Text('Try Again'),
              ),
            ],
          ),
        ),
      );
    }
    return const Center(
      child: Text(
        'Delivery information is currently unavailable.',
        style: TextStyle(color: AppColors.textSecondary),
      ),
    );
  }

  Widget _buildDeliveryContent(
      HealthcareDelivery delivery, DeliveryTrackingState state) {
    return Column(
      children: [
        // 1. Interactive Map Section (Top half)
        Expanded(
          flex: 5,
          child: Stack(
            children: [
              _buildMap(delivery),
              _buildMapControls(delivery),
              _buildFreshnessOverlayBanner(delivery, state),
            ],
          ),
        ),

        // 2. Lifecycle Stages & Telemetry Details (Bottom half)
        Expanded(
          flex: 6,
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(16.0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _buildStatusHeader(delivery, state),
                const SizedBox(height: 16),
                _buildLifecycleProgress(delivery),
                const SizedBox(height: 16),
                _buildTelemetryCards(delivery),
                const SizedBox(height: 16),
                _buildLocationsSection(delivery),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildMap(HealthcareDelivery delivery) {
    final destination = LatLng(
      delivery.destinationLocation.latitude,
      delivery.destinationLocation.longitude,
    );
    final pickup = LatLng(
      delivery.pickupLocation.latitude,
      delivery.pickupLocation.longitude,
    );

    final telem = delivery.telemetry;
    final bool hasDroneCoords = telem != null && telem.hasCoordinates;
    final dronePos = hasDroneCoords
        ? LatLng(telem.latitude!, telem.longitude!)
        : destination;

    final initialCenter = hasDroneCoords ? dronePos : destination;

    return FlutterMap(
      mapController: _mapController,
      options: MapOptions(
        initialCenter: initialCenter,
        initialZoom: 14.5,
        minZoom: 4.0,
        maxZoom: 18.0,
      ),
      children: [
        TileLayer(
          urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
          userAgentPackageName: 'com.aeron.citizenapp',
        ),
        MarkerLayer(
          markers: [
            // Pickup Marker (Depot)
            Marker(
              point: pickup,
              width: 44,
              height: 44,
              child: const _MapPin(
                icon: Icons.local_hospital,
                color: Color(0xFF00C853),
                label: 'Depot',
              ),
            ),
            // Destination Marker (Patient)
            Marker(
              point: destination,
              width: 44,
              height: 44,
              child: const _MapPin(
                icon: Icons.home,
                color: Color(0xFFFF5252),
                label: 'Recipient',
              ),
            ),
            // Real-time Drone Marker
            if (hasDroneCoords)
              Marker(
                point: dronePos,
                width: 64,
                height: 64,
                child: _buildDroneMarker(telem),
              ),
          ],
        ),
      ],
    );
  }

  Widget _buildDroneMarker(DroneTelemetryData telem) {
    final isLive = telem.isLive;
    final heading = telem.heading ?? 0.0;

    return AnimatedBuilder(
      animation: _pulseAnimation,
      builder: (context, child) {
        return Stack(
          alignment: Alignment.center,
          children: [
            if (isLive)
              Container(
                width: 48 + (12 * _pulseAnimation.value),
                height: 48 + (12 * _pulseAnimation.value),
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: AppColors.primaryAccent.withValues(alpha: 0.25 * (1 - _pulseAnimation.value)),
                ),
              ),
            Transform.rotate(
              angle: (heading * math.pi) / 180,
              child: Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: isLive ? AppColors.primaryAccent : Colors.grey[700],
                  border: Border.all(color: Colors.black, width: 2),
                  boxShadow: [
                    BoxShadow(
                      color: isLive
                          ? AppColors.primaryAccent.withValues(alpha: 0.6)
                          : Colors.black38,
                      blurRadius: 8,
                    ),
                  ],
                ),
                child: Icon(
                  Icons.navigation,
                  size: 24,
                  color: isLive ? Colors.black : Colors.white70,
                ),
              ),
            ),
          ],
        );
      },
    );
  }

  Widget _buildMapControls(HealthcareDelivery delivery) {
    return Positioned(
      right: 12,
      bottom: 24,
      child: Column(
        children: [
          FloatingActionButton.small(
            heroTag: 'zoomInBtn',
            backgroundColor: AppColors.surface.withValues(alpha: 0.9),
            foregroundColor: Colors.white,
            onPressed: _zoomIn,
            child: const Icon(Icons.add),
          ),
          const SizedBox(height: 8),
          FloatingActionButton.small(
            heroTag: 'zoomOutBtn',
            backgroundColor: AppColors.surface.withValues(alpha: 0.9),
            foregroundColor: Colors.white,
            onPressed: _zoomOut,
            child: const Icon(Icons.remove),
          ),
          const SizedBox(height: 8),
          FloatingActionButton.small(
            heroTag: 'recenterBtn',
            backgroundColor: AppColors.primaryAccent,
            foregroundColor: Colors.black,
            onPressed: () => _recenterMap(delivery),
            child: const Icon(Icons.my_location),
          ),
        ],
      ),
    );
  }

  Widget _buildFreshnessOverlayBanner(
      HealthcareDelivery delivery, DeliveryTrackingState state) {
    final telem = delivery.telemetry;
    final isStale = telem?.freshness == TelemetryFreshness.stale;
    final isUnavailable = telem == null ||
        telem.freshness == TelemetryFreshness.unavailable;

    if (!isStale && !isUnavailable) {
      return const SizedBox.shrink();
    }

    return Positioned(
      top: 12,
      left: 12,
      right: 12,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: isStale
              ? Colors.amber[900]?.withValues(alpha: 0.92)
              : Colors.black87,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(
            color: isStale ? Colors.amberAccent : Colors.white24,
          ),
        ),
        child: Row(
          children: [
            Icon(
              isStale ? Icons.warning_amber_rounded : Icons.info_outline,
              color: Colors.white,
              size: 20,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                isStale
                    ? 'GPS update delayed (>30s). Displaying last verified coordinates.'
                    : 'Awaiting initial GPS fix from assigned delivery drone.',
                style: const TextStyle(color: Colors.white, fontSize: 12),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildStatusHeader(
      HealthcareDelivery delivery, DeliveryTrackingState state) {
    final telem = delivery.telemetry;
    final isLive = telem?.isLive ?? false;

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.white12),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                delivery.status.displayName.toUpperCase(),
                style: TextStyle(
                  color: isLive ? AppColors.primaryAccent : Colors.white,
                  fontSize: 16,
                  fontWeight: FontWeight.bold,
                  letterSpacing: 0.8,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                'Drone: ${delivery.assignedDrone?.droneId ?? 'Pending Assignment'}',
                style: const TextStyle(
                  color: AppColors.textSecondary,
                  fontSize: 13,
                ),
              ),
            ],
          ),
          Row(
            children: [
              // Socket connection badge
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: state.socketStatus == SocketConnectionStatus.connected
                      ? const Color(0xFF1B5E20)
                      : Colors.grey[800],
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  state.socketStatus.displayName.toUpperCase(),
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 10,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
              const SizedBox(width: 6),
              // GPS Freshness badge
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: isLive
                      ? AppColors.primaryAccent
                      : (telem?.freshness == TelemetryFreshness.stale
                          ? Colors.amber[800]
                          : Colors.grey[800]),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  (telem?.freshness.displayName ?? 'NO GPS').toUpperCase(),
                  style: TextStyle(
                    color: isLive ? Colors.black : Colors.white,
                    fontSize: 10,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildLifecycleProgress(HealthcareDelivery delivery) {
    final stages = [
      'ORDERED',
      'ASSIGNED',
      'DISPATCHED',
      'IN TRANSIT',
      'APPROACHING',
      'DELIVERED'
    ];

    final currentStage = delivery.status.stageIndex;

    return Container(
      padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.white12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'DELIVERY LIFECYCLE PROGRESS',
            style: TextStyle(
              color: AppColors.textSecondary,
              fontSize: 11,
              fontWeight: FontWeight.bold,
              letterSpacing: 0.8,
            ),
          ),
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: List.generate(stages.length, (index) {
              final stageNum = index + 1;
              final isDone = stageNum < currentStage;
              final isCurrent = stageNum == currentStage;

              return Column(
                children: [
                  Container(
                    width: 28,
                    height: 28,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: isDone || isCurrent
                          ? AppColors.primaryAccent
                          : Colors.grey[800],
                      border: Border.all(
                        color: isCurrent ? Colors.white : Colors.transparent,
                        width: 2,
                      ),
                    ),
                    child: Center(
                      child: isDone
                          ? const Icon(Icons.check, size: 16, color: Colors.black)
                          : Text(
                              '$stageNum',
                              style: TextStyle(
                                color: isCurrent ? Colors.black : Colors.white70,
                                fontWeight: FontWeight.bold,
                                fontSize: 12,
                              ),
                            ),
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    stages[index].split(' ')[0],
                    style: TextStyle(
                      color: isCurrent ? AppColors.primaryAccent : Colors.white60,
                      fontSize: 9,
                      fontWeight:
                          isCurrent ? FontWeight.bold : FontWeight.normal,
                    ),
                  ),
                ],
              );
            }),
          ),
        ],
      ),
    );
  }

  Widget _buildTelemetryCards(HealthcareDelivery delivery) {
    final telem = delivery.telemetry;
    final speed = telem?.groundSpeed != null
        ? '${(telem!.groundSpeed! * 3.6).toStringAsFixed(1)} km/h'
        : 'N/A';
    final altitude =
        telem?.altitude != null ? '${telem!.altitude!.toStringAsFixed(1)} m' : 'N/A';
    final heading =
        telem?.heading != null ? '${telem!.heading!.toStringAsFixed(0)}°' : 'N/A';

    return Row(
      children: [
        Expanded(
          child: _buildTelemetryMetric(
            icon: Icons.speed,
            label: 'SPEED',
            value: speed,
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: _buildTelemetryMetric(
            icon: Icons.height,
            label: 'ALTITUDE',
            value: altitude,
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: _buildTelemetryMetric(
            icon: Icons.explore,
            label: 'HEADING',
            value: heading,
          ),
        ),
      ],
    );
  }

  Widget _buildTelemetryMetric({
    required IconData icon,
    required String label,
    required String value,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 8),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: Colors.white12),
      ),
      child: Column(
        children: [
          Icon(icon, color: AppColors.primaryAccent, size: 20),
          const SizedBox(height: 4),
          Text(
            value,
            style: const TextStyle(
              color: Colors.white,
              fontWeight: FontWeight.bold,
              fontSize: 13,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            label,
            style: const TextStyle(
              color: AppColors.textSecondary,
              fontSize: 9,
              letterSpacing: 0.5,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildLocationsSection(HealthcareDelivery delivery) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.white12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.circle, size: 12, color: Color(0xFF00C853)),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'PICKUP HUB',
                      style: TextStyle(
                        color: AppColors.textSecondary,
                        fontSize: 10,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    Text(
                      delivery.pickupLocation.name ??
                          delivery.pickupLocation.address ??
                          'AERON Medical Depot',
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 13,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const Padding(
            padding: EdgeInsets.only(left: 5, top: 4, bottom: 4),
            child: SizedBox(
              height: 16,
              child: VerticalDivider(color: Colors.white24, thickness: 1.5),
            ),
          ),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.location_on, size: 14, color: Color(0xFFFF5252)),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'DESTINATION RECIPIENT',
                      style: TextStyle(
                        color: AppColors.textSecondary,
                        fontSize: 10,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    Text(
                      delivery.destinationLocation.address ??
                          delivery.destinationLocation.name ??
                          'Patient Location',
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 13,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  String _formatPackageType(String raw) {
    return raw
        .replaceAll('_', ' ')
        .split(' ')
        .map((w) => w.isNotEmpty ? '${w[0].toUpperCase()}${w.substring(1).toLowerCase()}' : '')
        .join(' ');
  }
}

class _MapPin extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String label;

  const _MapPin({
    required this.icon,
    required this.color,
    required this.label,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          padding: const EdgeInsets.all(5),
          decoration: BoxDecoration(
            color: color,
            shape: BoxShape.circle,
            border: Border.all(color: Colors.white, width: 2),
            boxShadow: const [BoxShadow(color: Colors.black45, blurRadius: 4)],
          ),
          child: Icon(icon, size: 16, color: Colors.white),
        ),
      ],
    );
  }
}
