import React, { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import { useHardware } from '../context/HardwareContext';
import { TelemetryData } from '../types';
import { SimulatorControlWidget } from '../components/SimulatorControlWidget';
import { ACTIVE_DRONE_ID, AIRFRAME_IMAGE_HEADING_OFFSET_DEG } from '../config/drone';
import {
  isValidCoordinate,
  haversineDistance,
  formatCoordinate,
  getHeadingCardinal,
  classifyGpsFix,
  classifyHdop,
  shouldAppendBreadcrumb,
  calculateTrackStats,
  formatDuration,
  isNewerTelemetry,
  getStoredLaunchOrigin,
  setStoredLaunchOrigin,
  clearStoredLaunchOrigin,
  BreadcrumbPoint,
  LaunchOrigin
} from '../utils/gis';

type MapLayerType = 'satellite' | 'streets' | 'hybrid';

const AIRCRAFT_MARKER_SIZE = 80;
const AIRCRAFT_IMAGE_SRC = '/assets/aeron-actual-quadcopter-map-marker.png';

const SATELLITE_TILE_URL =
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const SATELLITE_ATTRIBUTION =
  'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';

const STREETS_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const STREETS_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const LABELS_OVERLAY_URL =
  'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';

export const GPSTrackingPage: React.FC = () => {
  // Authoritative Telemetry State from HardwareContext (Single Source of Truth)
  const {
    isOnline,
    latestTelemetry,
    latestAttitude,
    yaw: contextYaw,
    hardwareStatusLabel
  } = useHardware();

  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const baseTileLayerRef = useRef<L.TileLayer | null>(null);
  const overlayTileLayerRef = useRef<L.TileLayer | null>(null);
  const droneMarkerRef = useRef<L.Marker | null>(null);
  const launchOriginMarkerRef = useRef<L.Marker | null>(null);
  const breadcrumbPolylineRef = useRef<L.Polyline | null>(null);
  const geofenceCircleRef = useRef<L.Circle | null>(null);

  // Synchronous refs for map event handlers and state synchronization
  const followModeRef = useRef<boolean>(true);
  const hasInitialCenteredRef = useRef<boolean>(false);
  const latestWatermarkMsRef = useRef<number>(0);
  const lastBreadcrumbRef = useRef<BreadcrumbPoint | null>(null);

  // 1-second interval ticker for packet freshness, link timeouts and offline state transition
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Component UI State
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbPoint[]>([]);
  const [activeLayer, setActiveLayer] = useState<MapLayerType>('satellite');
  const [followMode, setFollowMode] = useState<boolean>(true);
  const [showGeofence, setShowGeofence] = useState<boolean>(true);
  const [tileError, setTileError] = useState<boolean>(false);
  const [launchOrigin, setLaunchOrigin] = useState<LaunchOrigin | null>(() =>
    getStoredLaunchOrigin(ACTIVE_DRONE_ID)
  );

  // Keep ref synchronized with state
  useEffect(() => {
    followModeRef.current = followMode;
  }, [followMode]);

  // Derive coordinates and validity from authoritative latestTelemetry
  const lat = latestTelemetry?.latitude;
  const lon = latestTelemetry?.longitude;
  const hasValidCoords = isValidCoordinate(lat, lon) && (lat !== 0 || lon !== 0);
  const fixClassification = classifyGpsFix(latestTelemetry?.gpsFixType);

  // Provenance determination (strict metadata check)
  const isRealHardware =
    (latestTelemetry?.source === 'REAL' && latestTelemetry?.isSimulated === false) ||
    (isOnline && latestTelemetry?.source !== 'SIMULATION');
  const isExplicitSimulation =
    latestTelemetry?.source === 'SIMULATION' && latestTelemetry?.isSimulated === true;
  const isUnknownProvenance = !isRealHardware && !isExplicitSimulation;

  // Packet timing & freshness
  const packetTimeMs = latestTelemetry?.recordedAt
    ? new Date(latestTelemetry.recordedAt).getTime()
    : latestTelemetry?.receivedAt
    ? new Date(latestTelemetry.receivedAt).getTime()
    : 0;
  const elapsedSincePacketSec = packetTimeMs > 0 ? Math.max(0, (nowMs - packetTimeMs) / 1000) : 999;
  const isPacketStale = elapsedSincePacketSec > 10;
  const isLinkOffline = !isOnline || elapsedSincePacketSec > 30;

  // Primary heading calculation: ATTITUDE yaw > Context yaw > telemetry yaw > telemetry heading
  const rawHeading =
    latestAttitude?.yaw !== undefined && Number.isFinite(latestAttitude.yaw)
      ? latestAttitude.yaw
      : contextYaw !== undefined && Number.isFinite(contextYaw)
      ? contextYaw
      : latestTelemetry?.yaw !== undefined && Number.isFinite(latestTelemetry.yaw)
      ? latestTelemetry.yaw
      : latestTelemetry?.heading !== undefined && Number.isFinite(latestTelemetry.heading)
      ? latestTelemetry.heading
      : 0;

  const calibratedHeading = ((rawHeading + AIRFRAME_IMAGE_HEADING_OFFSET_DEG) % 360 + 360) % 360;

  // Unwrapped continuous rotation to eliminate 359° <-> 0° reverse spin
  const continuousHeadingRef = useRef<number>(calibratedHeading);
  const prevHeadingRef = useRef<number>(calibratedHeading);

  useEffect(() => {
    let delta = calibratedHeading - (prevHeadingRef.current % 360);
    if (delta < -180) delta += 360;
    if (delta > 180) delta -= 360;
    continuousHeadingRef.current += delta;
    prevHeadingRef.current = calibratedHeading;

    // Fast-path: immediately update DOM transform on the marker rotator if mounted
    const markerEl = droneMarkerRef.current?.getElement();
    if (markerEl) {
      const rotatorEl = markerEl.querySelector('.aeron-aircraft-rotator') as HTMLElement | null;
      if (rotatorEl) {
        rotatorEl.style.transform = `rotate(${continuousHeadingRef.current}deg)`;
      }
    }
  }, [calibratedHeading]);

  // GNSS Operational Status: Pixhawk connection state vs GPS lock quality
  let gnssStatusText = 'GNSS OFFLINE';
  let gnssBadgeClass = 'bg-surface-elevated text-text-muted border-border';

  if (isLinkOffline) {
    gnssStatusText = 'GNSS OFFLINE';
    gnssBadgeClass = 'bg-surface-elevated text-text-muted border-border';
  } else if (!hasValidCoords || fixClassification.status === 'NO_FIX') {
    gnssStatusText = 'PIXHAWK CONNECTED • AWAITING GPS FIX';
    gnssBadgeClass = 'bg-warning/15 text-warning border-warning/40';
  } else if (isPacketStale) {
    gnssStatusText = 'GNSS STALE';
    gnssBadgeClass = 'bg-warning/15 text-warning border-warning/40';
  } else if (fixClassification.status === 'LIVE') {
    gnssStatusText = `GNSS LIVE (${fixClassification.label})`;
    gnssBadgeClass = 'bg-success/15 text-success border-success/40';
  } else if (fixClassification.status === 'DEGRADED') {
    gnssStatusText = 'GNSS DEGRADED (2D)';
    gnssBadgeClass = 'bg-warning/15 text-warning border-warning/40';
  }

  // ---------------------------------------------------------------------------
  // 1. TILE LAYER MANAGEMENT
  // ---------------------------------------------------------------------------
  const applyTileLayer = useCallback((layerType: MapLayerType, map: L.Map) => {
    if (baseTileLayerRef.current) {
      map.removeLayer(baseTileLayerRef.current);
      baseTileLayerRef.current = null;
    }
    if (overlayTileLayerRef.current) {
      map.removeLayer(overlayTileLayerRef.current);
      overlayTileLayerRef.current = null;
    }

    setTileError(false);

    if (layerType === 'satellite' || layerType === 'hybrid') {
      const satLayer = L.tileLayer(SATELLITE_TILE_URL, {
        maxNativeZoom: 19,
        maxZoom: 20,
        attribution: SATELLITE_ATTRIBUTION
      });

      satLayer.on('tileerror', () => {
        setTileError(true);
      });
      satLayer.on('load', () => {
        setTileError(false);
      });

      satLayer.addTo(map);
      baseTileLayerRef.current = satLayer;

      if (layerType === 'hybrid') {
        const labelsLayer = L.tileLayer(LABELS_OVERLAY_URL, {
          maxNativeZoom: 19,
          maxZoom: 20,
          attribution: SATELLITE_ATTRIBUTION
        });
        labelsLayer.addTo(map);
        overlayTileLayerRef.current = labelsLayer;
      }
    } else if (layerType === 'streets') {
      const streetLayer = L.tileLayer(STREETS_TILE_URL, {
        maxNativeZoom: 19,
        maxZoom: 20,
        attribution: STREETS_ATTRIBUTION
      });

      streetLayer.on('tileerror', () => {
        setTileError(true);
      });
      streetLayer.on('load', () => {
        setTileError(false);
      });

      streetLayer.addTo(map);
      baseTileLayerRef.current = streetLayer;
    }
  }, []);

  // ---------------------------------------------------------------------------
  // 2. AIRCRAFT MARKER UPDATE HELPER
  // ---------------------------------------------------------------------------
  const updateAircraftMarker = useCallback(
    (
      map: L.Map,
      latitude: number,
      longitude: number,
      tel: TelemetryData,
      headingDeg: number,
      unwrappedDeg: number,
      offline: boolean,
      stale: boolean,
      isReal: boolean
    ) => {
      const pos: [number, number] = [latitude, longitude];

      // Dynamic visual styling for aircraft marker
      let haloColor = '#BFF42E';
      let markerFilter = 'drop-shadow(0 0 12px rgba(191,244,46,0.7)) drop-shadow(0 4px 8px rgba(0,0,0,0.85))';
      let pulseStyle = 'animation: ping 2.5s cubic-bezier(0, 0, 0.2, 1) infinite;';

      if (offline) {
        haloColor = '#6B7280';
        markerFilter = 'grayscale(85%) opacity(0.55) drop-shadow(0 4px 6px rgba(0,0,0,0.8))';
        pulseStyle = '';
      } else if (stale) {
        haloColor = '#F59E0B';
        markerFilter = 'drop-shadow(0 0 10px rgba(245,158,11,0.85)) drop-shadow(0 4px 8px rgba(0,0,0,0.8))';
        pulseStyle = 'animation: ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite;';
      } else if (!isReal) {
        haloColor = '#F2B95F';
        markerFilter = 'drop-shadow(0 0 12px rgba(242,185,95,0.75)) drop-shadow(0 4px 8px rgba(0,0,0,0.8))';
      }

      const aircraftIcon = L.divIcon({
        className: 'aeron-aircraft-marker',
        html: `
          <div class="aeron-aircraft-container" style="position: relative; width: ${AIRCRAFT_MARKER_SIZE}px; height: ${AIRCRAFT_MARKER_SIZE}px; display: flex; align-items: center; justify-content: center; pointer-events: auto;">
            <!-- Tactical Radar Halo -->
            <div style="position: absolute; width: ${AIRCRAFT_MARKER_SIZE * 0.88}px; height: ${AIRCRAFT_MARKER_SIZE * 0.88}px; border-radius: 50%; background: ${haloColor}; opacity: ${offline ? '0.08' : '0.22'}; ${pulseStyle} pointer-events: none;"></div>
            <!-- Rotating Aircraft Frame (Only the image/rotator rotates) -->
            <div class="aeron-aircraft-rotator" style="position: relative; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; transform: rotate(${unwrappedDeg}deg); transition: transform 50ms linear; will-change: transform; pointer-events: none;">
              <img
                src="${AIRCRAFT_IMAGE_SRC}"
                alt="AERON Quadcopter (QUAD-01)"
                style="width: 100%; height: 100%; object-fit: contain; filter: ${markerFilter}; pointer-events: auto; cursor: pointer;"
              />
            </div>
          </div>
        `,
        iconSize: [AIRCRAFT_MARKER_SIZE, AIRCRAFT_MARKER_SIZE],
        iconAnchor: [AIRCRAFT_MARKER_SIZE / 2, AIRCRAFT_MARKER_SIZE / 2],
        popupAnchor: [0, -AIRCRAFT_MARKER_SIZE / 2]
      });

      const popupHtml = `
        <div style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11px; color: #F0F4F6; background: #0D141B; border: 1px solid #334451; border-radius: 8px; padding: 10px 12px; min-width: 240px; box-shadow: 0 12px 28px -4px rgba(0,0,0,0.85);">
          <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #2A3944; padding-bottom: 6px; margin-bottom: 8px;">
            <div>
              <div style="font-weight: 800; font-size: 12px; color: #BFF42E; letter-spacing: 0.05em;">AERON QUADCOPTER</div>
              <div style="font-size: 10px; color: #84939E;">QUAD-01 • ID: ${tel.droneId || ACTIVE_DRONE_ID}</div>
            </div>
            <span style="padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: 700; background: ${offline ? '#1F2937' : stale ? 'rgba(245,158,11,0.2)' : 'rgba(121,189,145,0.2)'}; color: ${offline ? '#9CA3AF' : stale ? '#F59E0B' : '#79BD91'}; border: 1px solid ${offline ? '#374151' : stale ? 'rgba(245,158,11,0.5)' : 'rgba(121,189,145,0.5)'};">
              ${offline ? 'OFFLINE' : stale ? 'STALE' : (isReal ? 'REAL HARDWARE' : 'SIMULATION')}
            </span>
          </div>
          <div style="display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; line-height: 1.45;">
            <span style="color: #84939E;">FC Status:</span>
            <span style="font-weight: 600; color: ${isOnline ? '#79BD91' : '#F07878'}; text-align: right;">${hardwareStatusLabel}</span>
            <span style="color: #84939E;">Flight Mode:</span>
            <span style="font-weight: 600; color: #F0F4F6; text-align: right;">${tel.flightMode || 'STABILIZE'}</span>
            <span style="color: #84939E;">Armed State:</span>
            <span style="font-weight: 600; color: ${tel.armed ? '#F07878' : '#789BFF'}; text-align: right;">${tel.armed ? 'ARMED' : 'DISARMED'}</span>
            <span style="color: #84939E;">Latitude:</span>
            <span style="font-weight: 600; color: #F0F4F6; text-align: right;">${formatCoordinate(latitude, true)}</span>
            <span style="color: #84939E;">Longitude:</span>
            <span style="font-weight: 600; color: #F0F4F6; text-align: right;">${formatCoordinate(longitude, false)}</span>
            <span style="color: #84939E;">Altitude Rel (Launch Ref):</span>
            <span style="font-weight: 600; color: #BFF42E; text-align: right;">${typeof tel.relativeAltitude === 'number' ? tel.relativeAltitude.toFixed(1) + ' m' : 'N/A'}</span>
            <span style="color: #84939E;">Altitude MSL (Baro):</span>
            <span style="font-weight: 600; color: #F0F4F6; text-align: right;">${typeof tel.altitude === 'number' ? tel.altitude.toFixed(1) + ' m' : 'N/A'}</span>
            <span style="color: #84939E;">Ground Speed:</span>
            <span style="font-weight: 600; color: #F0F4F6; text-align: right;">${typeof tel.groundSpeed === 'number' ? tel.groundSpeed.toFixed(1) + ' m/s' : '—'}</span>
            <span style="color: #84939E;">Heading:</span>
            <span style="font-weight: 600; color: #F0F4F6; text-align: right;">${Math.round(headingDeg)}° (${getHeadingCardinal(headingDeg)})</span>
            <span style="color: #84939E;">GNSS Fix:</span>
            <span style="font-weight: 600; color: #F0F4F6; text-align: right;">${tel.gpsFixType || (hasValidCoords ? '3D_FIX' : 'NO_FIX')} (${tel.satellites || 0} Sats)</span>
            <span style="color: #84939E;">Provenance:</span>
            <span style="font-weight: 600; color: ${isReal ? '#79BD91' : '#F2B95F'}; text-align: right;">${isReal ? 'Pixhawk 2.4.8 (Physical)' : 'Simulator'}</span>
          </div>
          <div style="border-top: 1px solid #2A3944; margin-top: 8px; padding-top: 4px; font-size: 9px; color: #84939E; text-align: right;">
            Telemetry: ${tel.recordedAt ? new Date(tel.recordedAt).toLocaleTimeString() : 'Live'}
          </div>
        </div>
      `;

      if (!droneMarkerRef.current) {
        droneMarkerRef.current = L.marker(pos, { icon: aircraftIcon })
          .bindPopup(popupHtml, { className: 'aeron-leaflet-popup', offset: [0, -AIRCRAFT_MARKER_SIZE / 2], autoPan: false })
          .addTo(map);
      } else {
        droneMarkerRef.current.setLatLng(pos);
        droneMarkerRef.current.setIcon(aircraftIcon);
        droneMarkerRef.current.setPopupContent(popupHtml);
      }
    },
    [hardwareStatusLabel, isOnline]
  );

  // ---------------------------------------------------------------------------
  // 3. MAP INITIALIZATION (NO HARDCODED BENGALURU)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return;

    // Check if valid coordinates are already available from HardwareContext on mount
    const hasInitialCoords =
      latestTelemetry &&
      isValidCoordinate(latestTelemetry.latitude, latestTelemetry.longitude) &&
      typeof latestTelemetry.latitude === 'number' &&
      typeof latestTelemetry.longitude === 'number';

    const initialCenter: [number, number] = hasInitialCoords
      ? [latestTelemetry.latitude as number, latestTelemetry.longitude as number]
      : launchOrigin
      ? [launchOrigin.lat, launchOrigin.lon]
      : [23.18294, 77.30155]; // Bench hardware test coordinates

    const initialZoom = hasInitialCoords || launchOrigin ? 17 : 16;

    const map = L.map(mapContainerRef.current, {
      center: initialCenter,
      zoom: initialZoom,
      zoomControl: false
    });

    L.control.zoom({ position: 'topright' }).addTo(map);

    // Apply default satellite basemap
    applyTileLayer('satellite', map);

    // Setup Breadcrumb Polyline
    const polyline = L.polyline([], {
      color: '#38BDF8',
      weight: 3.5,
      opacity: 0.95,
      lineJoin: 'round'
    }).addTo(map);
    breadcrumbPolylineRef.current = polyline;

    // Detect user manual dragging or panning to disable follow-mode
    map.on('dragstart', () => {
      setFollowMode(false);
      followModeRef.current = false;
    });

    mapInstanceRef.current = map;

    // If valid coordinates already arrived prior to Leaflet mount, immediately position marker!
    if (hasInitialCoords) {
      const initLat = latestTelemetry.latitude as number;
      const initLon = latestTelemetry.longitude as number;
      updateAircraftMarker(
        map,
        initLat,
        initLon,
        latestTelemetry,
        calibratedHeading,
        continuousHeadingRef.current,
        isLinkOffline,
        isPacketStale,
        isRealHardware
      );
      hasInitialCenteredRef.current = true;
    }

    return () => {
      map.remove();
      mapInstanceRef.current = null;
    };
  }, [applyTileLayer, updateAircraftMarker]); // eslint-disable-line react-hooks/exhaustive-deps

  // Switch layers when activeLayer state changes
  useEffect(() => {
    if (mapInstanceRef.current) {
      applyTileLayer(activeLayer, mapInstanceRef.current);
    }
  }, [activeLayer, applyTileLayer]);

  // ---------------------------------------------------------------------------
  // 4. LAUNCH ORIGIN & GEOFENCE PERIMETER RENDERING
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    if (launchOrigin && isValidCoordinate(launchOrigin.lat, launchOrigin.lon)) {
      const originPos: [number, number] = [launchOrigin.lat, launchOrigin.lon];
      const originIcon = L.divIcon({
        className: 'aeron-launch-origin-marker',
        html: `
          <div style="background-color: #2563EB; width: 22px; height: 22px; border-radius: 50%; border: 2.5px solid #FFFFFF; box-shadow: 0 0 14px rgba(37,99,235,0.9); display: flex; align-items: center; justify-content: center; font-size: 11px; color: #FFFFFF; font-weight: bold;">
            ⌂
          </div>
        `,
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      });

      if (!launchOriginMarkerRef.current) {
        launchOriginMarkerRef.current = L.marker(originPos, { icon: originIcon })
          .bindPopup(`
            <div style="font-family: sans-serif; font-size: 11px; color: #111; line-height: 1.4; padding: 2px;">
              <strong>Mission Launch Origin</strong><br/>
              <span style="font-family: monospace; color: #333;">[${formatCoordinate(launchOrigin.lat, true)}, ${formatCoordinate(launchOrigin.lon, false)}]</span><br/>
              <span style="font-size: 10px; color: #666;">Fixed 500m Perimeter Center</span>
            </div>
          `)
          .addTo(map);
      } else {
        launchOriginMarkerRef.current.setLatLng(originPos);
      }

      // Fixed 500m Geofence Perimeter (Centered strictly at launch origin)
      if (showGeofence) {
        if (!geofenceCircleRef.current) {
          geofenceCircleRef.current = L.circle(originPos, {
            radius: 500,
            color: '#BFF42E',
            fillColor: '#BFF42E',
            fillOpacity: 0.08,
            weight: 2,
            dashArray: '6, 8'
          }).addTo(map);
        } else {
          geofenceCircleRef.current.setLatLng(originPos);
          if (!map.hasLayer(geofenceCircleRef.current)) {
            geofenceCircleRef.current.addTo(map);
          }
        }
      } else if (geofenceCircleRef.current) {
        geofenceCircleRef.current.remove();
      }
    } else {
      if (launchOriginMarkerRef.current) {
        launchOriginMarkerRef.current.remove();
        launchOriginMarkerRef.current = null;
      }
      if (geofenceCircleRef.current) {
        geofenceCircleRef.current.remove();
        geofenceCircleRef.current = null;
      }
    }
  }, [launchOrigin, showGeofence]);

  // ---------------------------------------------------------------------------
  // 5. SYNCHRONIZATION EFFECT: PROCESS INCOMING TELEMETRY FROM HARDWARECONTEXT
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!latestTelemetry) return;

    const latitude = latestTelemetry.latitude;
    const longitude = latestTelemetry.longitude;

    if (!isValidCoordinate(latitude, longitude) || typeof latitude !== 'number' || typeof longitude !== 'number') {
      return;
    }

    // Out-of-order rejection check
    const incomingTime = latestTelemetry.recordedAt || latestTelemetry.receivedAt;
    if (!isNewerTelemetry(incomingTime, latestWatermarkMsRef.current)) {
      return;
    }
    const incomingMs = incomingTime ? new Date(incomingTime).getTime() : Date.now();
    if (incomingMs > 0) {
      latestWatermarkMsRef.current = incomingMs;
    }

    const map = mapInstanceRef.current;
    if (!map) return;

    const pos: [number, number] = [latitude, longitude];

    // Update aircraft marker
    updateAircraftMarker(
      map,
      latitude,
      longitude,
      latestTelemetry,
      calibratedHeading,
      continuousHeadingRef.current,
      isLinkOffline,
      isPacketStale,
      isRealHardware
    );

    // Automatic map centering and follow
    if (!hasInitialCenteredRef.current) {
      map.setView(pos, 17, { animate: true });
      hasInitialCenteredRef.current = true;
    } else if (followModeRef.current) {
      const currentCenter = map.getCenter();
      const distFromCenter = haversineDistance(currentCenter.lat, currentCenter.lng, latitude, longitude);
      if (distFromCenter > 1.5) {
        map.panTo(pos, { animate: true, duration: 0.5 });
      }
    }

    // Append to dynamic breadcrumbs with anti-jitter deduplication
    const newPoint: BreadcrumbPoint = {
      lat: latitude,
      lon: longitude,
      altitude: latestTelemetry.relativeAltitude,
      timestamp: incomingMs
    };

    if (shouldAppendBreadcrumb(lastBreadcrumbRef.current, newPoint, 1.0, 500)) {
      lastBreadcrumbRef.current = newPoint;
      setBreadcrumbs((prev) => {
        const updated = prev.length >= 1000 ? [...prev.slice(prev.length - 999), newPoint] : [...prev, newPoint];
        if (breadcrumbPolylineRef.current) {
          breadcrumbPolylineRef.current.setLatLngs(updated.map((p) => [p.lat, p.lon]));
        }
        return updated;
      });
    }
  }, [
    latestTelemetry,
    updateAircraftMarker,
    calibratedHeading,
    isLinkOffline,
    isPacketStale,
    isRealHardware
  ]);

  // Re-apply aircraft marker styling when offline or stale state transitions
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (
      !map ||
      !droneMarkerRef.current ||
      !latestTelemetry ||
      !hasValidCoords ||
      typeof lat !== 'number' ||
      typeof lon !== 'number'
    ) {
      return;
    }
    updateAircraftMarker(
      map,
      lat,
      lon,
      latestTelemetry,
      calibratedHeading,
      continuousHeadingRef.current,
      isLinkOffline,
      isPacketStale,
      isRealHardware
    );
  }, [isLinkOffline, isPacketStale]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // 6. OPERATOR ACTIONS
  // ---------------------------------------------------------------------------
  const handleCenterVehicle = () => {
    const map = mapInstanceRef.current;
    if (!map) return;

    if (hasValidCoords && typeof lat === 'number' && typeof lon === 'number') {
      map.panTo([lat, lon], { animate: true, duration: 0.5 });
      setFollowMode(true);
      followModeRef.current = true;
    } else if (launchOrigin) {
      map.panTo([launchOrigin.lat, launchOrigin.lon], { animate: true, duration: 0.5 });
    }
  };

  const handleToggleFollow = () => {
    const next = !followMode;
    setFollowMode(next);
    followModeRef.current = next;
    if (next && hasValidCoords && typeof lat === 'number' && typeof lon === 'number' && mapInstanceRef.current) {
      mapInstanceRef.current.panTo([lat, lon], { animate: true, duration: 0.5 });
    }
  };

  const handleSetLaunchOrigin = () => {
    if (!hasValidCoords || typeof lat !== 'number' || typeof lon !== 'number') {
      alert('Cannot set launch origin: Valid GPS coordinates are required.');
      return;
    }

    const newOrigin: LaunchOrigin = {
      lat,
      lon,
      altitude: latestTelemetry?.relativeAltitude,
      setAt: new Date().toISOString(),
      droneId: ACTIVE_DRONE_ID
    };

    setStoredLaunchOrigin(ACTIVE_DRONE_ID, newOrigin);
    setLaunchOrigin(newOrigin);
  };

  const handleClearLaunchOrigin = () => {
    clearStoredLaunchOrigin(ACTIVE_DRONE_ID);
    setLaunchOrigin(null);
  };

  const handleClearBreadcrumb = () => {
    setBreadcrumbs([]);
    lastBreadcrumbRef.current = null;
    if (breadcrumbPolylineRef.current) {
      breadcrumbPolylineRef.current.setLatLngs([]);
    }
  };

  // ---------------------------------------------------------------------------
  // 7. CALCULATED METRICS
  // ---------------------------------------------------------------------------
  const trackStats = calculateTrackStats(breadcrumbs);
  const distToLaunchOrigin =
    launchOrigin && hasValidCoords && typeof lat === 'number' && typeof lon === 'number'
      ? haversineDistance(lat, lon, launchOrigin.lat, launchOrigin.lon)
      : null;

  const isInsideGeofence = distToLaunchOrigin !== null ? distToLaunchOrigin <= 500 : true;

  const satsStr = isOnline && latestTelemetry?.satellites !== undefined ? `${latestTelemetry.satellites} Sats` : '0 Sats';
  const hdopClassification = classifyHdop(latestTelemetry?.hdop);
  const latStr = isOnline && hasValidCoords && typeof lat === 'number' ? formatCoordinate(lat, true) : '—';
  const lonStr = isOnline && hasValidCoords && typeof lon === 'number' ? formatCoordinate(lon, false) : '—';
  const altRelStr = isOnline && typeof latestTelemetry?.relativeAltitude === 'number' ? `${latestTelemetry.relativeAltitude.toFixed(1)} m (Launch Ref)` : 'N/A';
  const altMslStr = isOnline && typeof latestTelemetry?.altitude === 'number' ? `${latestTelemetry.altitude.toFixed(1)} m MSL` : 'N/A';
  const speedStr = isOnline && typeof latestTelemetry?.groundSpeed === 'number' ? `${latestTelemetry.groundSpeed.toFixed(1)} m/s (${(latestTelemetry.groundSpeed * 3.6).toFixed(1)} km/h)` : '—';
  const headingStr = isOnline && typeof latestTelemetry?.heading === 'number' ? getHeadingCardinal(latestTelemetry.heading) : '—';

  return (
    <div className="flex flex-col w-full px-6 py-6 space-y-6 max-w-[1680px] mx-auto text-text-primary">
      {/* Top Bar Header & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 bg-surface rounded-xl border border-border shadow-sm">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="material-symbols-outlined text-accent-primary text-[24px]">satellite_alt</span>
            <h1 className="font-sans font-bold text-base tracking-normal text-text-primary">
              Tactical Satellite GPS Tracking & Geofence
            </h1>
            <span className="px-2 py-0.5 rounded text-[10px] font-bold font-mono uppercase bg-surface-elevated text-accent-primary border border-accent-soft">
              {ACTIVE_DRONE_ID}
            </span>
          </div>
          <p className="font-sans text-xs text-text-muted mt-0.5">
            Esri World Imagery High-Resolution Satellite Map • U-Blox NEO-M8N GNSS Constellation
          </p>
        </div>

        {/* Global Action Toolbar */}
        <div className="flex flex-wrap items-center gap-2 font-sans text-xs">
          {/* Follow Toggle */}
          <button
            onClick={handleToggleFollow}
            className={`px-3 py-1.5 rounded-lg border font-medium flex items-center gap-2 transition-all ${
              followMode
                ? 'bg-accent-primary text-background border-accent-soft font-semibold shadow-sm'
                : 'bg-surface-elevated text-text-muted hover:text-text-primary border-border'
            }`}
            title={followMode ? 'Automatic map follow is ON' : 'Automatic map follow is OFF'}
          >
            <span className="material-symbols-outlined text-[16px]">
              {followMode ? 'lock' : 'lock_open'}
            </span>
            <span>{followMode ? 'FOLLOW: ON' : 'FOLLOW: OFF'}</span>
          </button>

          {/* Center Vehicle */}
          <button
            onClick={handleCenterVehicle}
            className="px-3 py-1.5 bg-surface-elevated hover:bg-surface-muted text-text-primary rounded-lg border border-border flex items-center gap-2 transition-colors"
            title="Center map on live aircraft position"
          >
            <span className="material-symbols-outlined text-[16px] text-accent-primary">my_location</span>
            <span>Center Vehicle</span>
          </button>

          {/* Set Launch Origin */}
          <button
            onClick={handleSetLaunchOrigin}
            disabled={!hasValidCoords}
            className="px-3 py-1.5 bg-surface-elevated hover:bg-surface-muted disabled:opacity-40 text-text-secondary hover:text-text-primary rounded-lg border border-border flex items-center gap-2 transition-colors"
            title="Set launch origin at current aircraft position"
          >
            <span className="material-symbols-outlined text-[16px] text-info">flag</span>
            <span>Set Launch Origin</span>
          </button>

          {/* Geofence Toggle */}
          <button
            onClick={() => setShowGeofence(!showGeofence)}
            className={`px-3 py-1.5 rounded-lg border font-medium flex items-center gap-2 transition-colors ${
              showGeofence
                ? 'bg-surface-muted text-accent-primary border-accent-soft/40'
                : 'bg-surface-elevated text-text-muted border-border'
            }`}
          >
            <span className="material-symbols-outlined text-[16px]">shield</span>
            <span>Geofence (500m)</span>
          </button>

          {/* Clear Breadcrumb */}
          <button
            onClick={handleClearBreadcrumb}
            className="px-3 py-1.5 bg-surface-elevated hover:bg-surface-muted text-text-secondary hover:text-text-primary rounded-lg border border-border flex items-center gap-2 transition-colors"
          >
            <span className="material-symbols-outlined text-[16px]">clear_all</span>
            <span>Clear Breadcrumb</span>
          </button>
        </div>
      </div>

      {/* Provenance Separation: Real Hardware Airframe Presentation vs Simulator Controls */}
      {isRealHardware ? (
        <div className="p-3.5 bg-surface rounded-xl border border-success/30 text-xs flex flex-wrap items-center justify-between gap-4 font-mono shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
            <div className="flex items-center gap-2.5">
              <span className="w-2.5 h-2.5 rounded-full bg-success animate-pulse" />
              <span className="text-success font-bold tracking-wider">
                REAL HARDWARE
              </span>
              <span className="text-border hidden sm:inline">•</span>
            </div>
            <div className="flex items-center gap-2 text-text-primary">
              <span className="font-semibold text-text-primary">{hardwareStatusLabel}</span>
              <span className="text-text-muted text-[11px]">(ArduCopter v4.5.1 via ESP32 COM8)</span>
            </div>
          </div>

          {/* Actual AERON Quadcopter Photograph Replacing Simulator Pause Control */}
          <div className="flex items-center gap-3 bg-surface-elevated/90 border border-border/80 px-3 py-1.5 rounded-lg shadow-sm">
            <div className="flex flex-col items-end">
              <span className="text-[10px] font-mono font-bold tracking-wider text-accent-primary uppercase">
                AERON QUADCOPTER
              </span>
              <span className="text-[9px] font-mono text-text-muted">
                PHYSICAL AIRFRAME
              </span>
            </div>
            <div className="relative w-14 h-14 sm:w-16 sm:h-16 flex items-center justify-center p-0.5 rounded-md border border-border/60 bg-surface/80 overflow-hidden">
              <img
                src="/assets/aeron-quadcopter.png"
                alt="AERON Quadcopter (Physical Aircraft)"
                className="w-full h-full object-contain filter drop-shadow-[0_2px_6px_rgba(0,0,0,0.5)] pointer-events-none"
              />
            </div>
          </div>
        </div>
      ) : isExplicitSimulation ? (
        <SimulatorControlWidget />
      ) : (
        <div className="p-3 bg-surface rounded-xl border border-border text-xs flex items-center justify-between font-mono">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-text-muted" />
            <span className="text-text-secondary font-bold">
              PROVENANCE: {isUnknownProvenance ? 'UNKNOWN' : 'AWAITING HARDWARE'}
            </span>
            <span className="text-text-muted">|</span>
            <span className="text-text-secondary">{hardwareStatusLabel}</span>
          </div>
          <div className="flex items-center gap-3 bg-surface-elevated/70 border border-border/60 px-2.5 py-1 rounded-lg">
            <span className="text-[10px] font-mono text-text-muted uppercase">AERON QUADCOPTER</span>
            <div className="relative w-10 h-10 flex items-center justify-center p-0.5 rounded border border-border/40 bg-surface/50 overflow-hidden">
              <img
                src="/assets/aeron-quadcopter.png"
                alt="AERON Quadcopter (Standby)"
                className="w-full h-full object-contain opacity-60 pointer-events-none"
              />
            </div>
          </div>
        </div>
      )}

      {/* Main Map & Navigation HUD Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Leaflet Satellite Map (8 Columns) */}
        <div className="lg:col-span-8 bg-surface rounded-xl border border-border relative h-[620px] overflow-hidden flex flex-col shadow-sm">
          {/* Map DOM Element */}
          <div ref={mapContainerRef} className="w-full h-full z-10" />

          {/* Map Layer Selector Toolbar (Top Left) */}
          <div className="absolute top-4 left-4 z-20 bg-surface/90 backdrop-blur-md p-1 rounded-lg border border-border shadow-lg flex items-center gap-1 font-sans text-xs">
            <button
              onClick={() => setActiveLayer('satellite')}
              className={`px-2.5 py-1 rounded text-[11px] font-medium transition-all ${
                activeLayer === 'satellite'
                  ? 'bg-accent-primary text-background font-bold shadow-sm'
                  : 'text-text-muted hover:text-text-primary'
              }`}
            >
              Satellite
            </button>
            <button
              onClick={() => setActiveLayer('hybrid')}
              className={`px-2.5 py-1 rounded text-[11px] font-medium transition-all ${
                activeLayer === 'hybrid'
                  ? 'bg-accent-primary text-background font-bold shadow-sm'
                  : 'text-text-muted hover:text-text-primary'
              }`}
            >
              Hybrid + Labels
            </button>
            <button
              onClick={() => setActiveLayer('streets')}
              className={`px-2.5 py-1 rounded text-[11px] font-medium transition-all ${
                activeLayer === 'streets'
                  ? 'bg-accent-primary text-background font-bold shadow-sm'
                  : 'text-text-muted hover:text-text-primary'
              }`}
            >
              Road Map
            </button>
          </div>

          {/* Follow Status Pill (Top Right, next to zoom) */}
          <div className="absolute top-4 right-14 z-20 bg-surface/90 backdrop-blur-md px-3 py-1 rounded-lg border border-border shadow-lg flex items-center gap-2 font-mono text-[11px]">
            <span
              className={`w-2 h-2 rounded-full ${
                followMode ? 'bg-accent-primary animate-pulse' : 'bg-text-muted'
              }`}
            />
            <span className={followMode ? 'text-accent-primary font-bold' : 'text-text-muted'}>
              {followMode ? 'AUTO-FOLLOW ACTIVE' : 'FOLLOW PAUSED (MANUAL PAN)'}
            </span>
          </div>

          {/* Tile Load Error Warning Banner */}
          {tileError && (
            <div className="absolute top-16 left-4 z-20 bg-danger/90 backdrop-blur-md text-white px-3.5 py-2 rounded-lg border border-danger flex items-center gap-2.5 font-sans text-xs shadow-lg">
              <span className="material-symbols-outlined text-[18px]">wifi_off</span>
              <span>Satellite tile service experiencing network timeout. Basemap degraded.</span>
            </div>
          )}

          {/* Floating Warning If Degraded / No Fix */}
          {(!hasValidCoords || fixClassification.status !== 'LIVE') && (
            <div className="absolute bottom-16 left-4 z-20 bg-surface/90 backdrop-blur-md px-3.5 py-2 rounded-lg border border-warning/40 flex items-center gap-2.5 font-sans text-xs shadow-lg">
              <span className="material-symbols-outlined text-warning text-[18px]">
                {fixClassification.status === 'DEGRADED' ? 'warning' : 'gps_not_fixed'}
              </span>
              <span className="text-warning font-semibold">
                {fixClassification.status === 'DEGRADED'
                  ? 'Degraded 2D Fix — Inaccurate altitude, not navigation ready'
                  : isOnline
                  ? 'Pixhawk Connected — Awaiting 3D GNSS lock from U-Blox NEO-M8N'
                  : 'GNSS receiver standby (Pixhawk offline)'}
              </span>
            </div>
          )}

          {/* Floating Map Legend (Bottom Left) */}
          <div className="absolute bottom-4 left-4 z-20 bg-surface/90 backdrop-blur-md px-3.5 py-2 rounded-lg border border-border flex flex-wrap items-center gap-4 font-sans text-xs">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-accent-primary shadow-[0_0_8px_rgba(191,244,46,0.8)]" />
              <span className="text-text-primary font-medium">{ACTIVE_DRONE_ID} Aircraft</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-info shadow-[0_0_8px_rgba(59,130,246,0.8)]" />
              <span className="text-text-primary font-medium">Launch Origin</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3.5 h-0.5 bg-accent-primary border-t border-dashed border-accent-primary" />
              <span className="text-text-secondary">500m Geofence</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3.5 h-1 bg-[#38BDF8] rounded-full" />
              <span className="text-text-secondary">Breadcrumb Trail</span>
            </div>
          </div>
        </div>

        {/* Tactical GNSS Diagnostics Sidebar (4 Columns) */}
        <div className="lg:col-span-4 space-y-4">
          {/* GNSS Operational Status Card */}
          <div className="bg-surface p-5 rounded-xl border border-border space-y-3 font-sans text-xs">
            <div className="flex items-center justify-between border-b border-border/60 pb-3">
              <span className="font-bold text-sm text-text-primary">
                GNSS Receiver Diagnostics
              </span>
              <span className={`px-2 py-0.5 rounded font-bold text-[10px] uppercase border ${gnssBadgeClass}`}>
                {gnssStatusText}
              </span>
            </div>

            <div className="space-y-2.5 pt-1">
              <div className="flex justify-between items-center">
                <span className="text-text-muted">Flight Controller:</span>
                <span className={`font-mono font-bold ${isOnline ? 'text-success' : 'text-text-muted'}`}>
                  {hardwareStatusLabel}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-text-muted">Satellites in view:</span>
                <span className="text-accent-primary font-mono font-bold text-sm">{satsStr}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-text-muted">Horizontal dilution (HDOP):</span>
                <span className="font-mono">
                  <span className="text-text-primary font-bold">
                    {typeof latestTelemetry?.hdop === 'number' ? latestTelemetry.hdop.toFixed(2) : '—'}
                  </span>{' '}
                  <span className={`text-[11px] ${hdopClassification.color}`}>
                    ({hdopClassification.rating})
                  </span>
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-text-muted">GPS Fix Type:</span>
                <span className="font-mono font-bold text-text-primary">
                  {latestTelemetry?.gpsFixType || (hasValidCoords ? '3D Lock' : 'Searching')}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-text-muted">Receiver Hardware:</span>
                <span className="text-text-primary">U-Blox NEO-M8N GNSS</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-text-muted">Navigation Readiness:</span>
                <span className={`font-semibold ${fixClassification.isNavReady ? 'text-success' : 'text-warning'}`}>
                  {fixClassification.isNavReady ? `${latestTelemetry?.gpsFixType || '3D Fix'} (Nav Ready)` : 'Degraded / Searching'}
                </span>
              </div>
            </div>
          </div>

          {/* Positional Coordinates Card */}
          <div className="bg-surface p-5 rounded-xl border border-border space-y-3 font-sans text-xs">
            <div className="flex items-center justify-between border-b border-border/60 pb-3">
              <span className="font-bold text-sm text-text-primary">
                Live Geodetic Vector
              </span>
              <span className="text-[11px] font-mono text-text-muted">
                {hasValidCoords ? 'Valid Position' : 'Awaiting Position'}
              </span>
            </div>

            <div className="space-y-2.5">
              <div className="flex justify-between items-center">
                <span className="text-text-muted">Latitude:</span>
                <span className="text-text-primary font-mono font-bold">{latStr}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-text-muted">Longitude:</span>
                <span className="text-text-primary font-mono font-bold">{lonStr}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-text-muted">Relative Alt (Launch Ref):</span>
                <span className="text-accent-primary font-mono font-bold">{altRelStr}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-text-muted">Altitude MSL (Baro/EKF):</span>
                <span className="text-text-secondary font-mono">{altMslStr}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-text-muted">Ground speed:</span>
                <span className="text-text-primary font-mono font-bold">{speedStr}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-text-muted">Heading azimuth:</span>
                <span className="text-text-primary font-mono font-bold">{headingStr}</span>
              </div>
            </div>
          </div>

          {/* Mission Reference & Geofence Card */}
          <div className="bg-surface p-5 rounded-xl border border-border space-y-3 font-sans text-xs">
            <div className="flex items-center justify-between border-b border-border/60 pb-3">
              <span className="font-bold text-sm text-text-primary">
                Launch Origin & Geofence
              </span>
              {launchOrigin && (
                <button
                  onClick={handleClearLaunchOrigin}
                  className="text-[10px] text-danger hover:underline font-mono"
                  title="Clear launch origin"
                >
                  Clear Origin
                </button>
              )}
            </div>

            <div className="space-y-2.5">
              <div className="flex justify-between items-center">
                <span className="text-text-muted">Launch Origin:</span>
                <span className="font-mono text-text-primary font-medium">
                  {launchOrigin
                    ? `${formatCoordinate(launchOrigin.lat, true)}, ${formatCoordinate(launchOrigin.lon, false)}`
                    : 'Not Set (Click Set Launch Origin)'}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-text-muted">Distance from Origin:</span>
                <span className="font-mono font-bold text-accent-primary">
                  {distToLaunchOrigin !== null ? `${Math.round(distToLaunchOrigin)} meters` : '—'}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-text-muted">Geofence Perimeter:</span>
                <span className="font-bold text-text-primary">500 meters radius (Visual Reference)</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-text-muted">Boundary Containment:</span>
                <span
                  className={`font-semibold ${
                    !launchOrigin
                      ? 'text-text-muted'
                      : isInsideGeofence
                      ? 'text-success'
                      : 'text-danger font-bold animate-pulse'
                  }`}
                >
                  {!launchOrigin
                    ? 'No Origin Set'
                    : isInsideGeofence
                    ? 'Within Boundary (Safe)'
                    : 'PERIMETER EXCEEDED'}
                </span>
              </div>
            </div>
          </div>

          {/* Breadcrumb Buffer Info Card */}
          <div className="bg-surface p-5 rounded-xl border border-border space-y-2.5 font-sans text-xs text-text-secondary">
            <div className="flex justify-between items-center">
              <span className="text-text-muted">Track samples:</span>
              <span className="text-accent-primary font-mono font-bold">
                {breadcrumbs.length} points
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-text-muted">Ground distance covered:</span>
              <span className="text-text-primary font-mono font-bold">
                {trackStats.totalDistanceMeters >= 1000
                  ? `${(trackStats.totalDistanceMeters / 1000).toFixed(2)} km`
                  : `${Math.round(trackStats.totalDistanceMeters)} m`}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-text-muted">Track duration:</span>
              <span className="text-text-primary font-mono font-bold">
                {formatDuration(trackStats.durationSeconds)}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-text-muted">Last GPS packet:</span>
              <span className="text-text-secondary font-mono text-[11px]">
                {latestTelemetry?.recordedAt
                  ? `${new Date(latestTelemetry.recordedAt).toLocaleTimeString()} (${elapsedSincePacketSec.toFixed(1)}s ago)`
                  : 'Awaiting packets'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
