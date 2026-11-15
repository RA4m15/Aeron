/**
 * AERON GIS & Telemetry Navigation Utilities
 * Provides validated coordinate math, geodesic distance calculation,
 * breadcrumb deduplication, fix classification, and origin persistence.
 */

export interface Coordinate {
  lat: number;
  lon: number;
}

export interface BreadcrumbPoint {
  lat: number;
  lon: number;
  altitude?: number;
  timestamp: number; // epoch ms
}

export interface LaunchOrigin {
  lat: number;
  lon: number;
  altitude?: number;
  setAt: string;
  droneId: string;
}

export type GpsFixStatus = 'LIVE' | 'DEGRADED' | 'NO_FIX' | 'UNKNOWN';

export interface GpsFixDetails {
  status: GpsFixStatus;
  label: string;
  isNavReady: boolean;
  colorClass: string;
}

/**
 * Validates whether latitude and longitude are finite numeric values
 * within valid spherical geodetic boundaries (-90..+90 and -180..+180).
 * Note: [0, 0] is mathematically finite and valid.
 */
export const isValidCoordinate = (lat: unknown, lon: unknown): boolean => {
  if (typeof lat !== 'number' || typeof lon !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < -90 || lat > 90) return false;
  if (lon < -180 || lon > 180) return false;
  return true;
};

/**
 * Calculates geodesic distance between two geodetic coordinates using Haversine formula.
 * Returns distance in meters.
 */
export const haversineDistance = (
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number => {
  if (!isValidCoordinate(lat1, lon1) || !isValidCoordinate(lat2, lon2)) {
    return 0;
  }
  const R = 6371000; // Mean Earth radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

/**
 * Formats a geodetic coordinate into standard aerospace notation (e.g. 23.182941° N).
 */
export const formatCoordinate = (val: number, isLatitude: boolean): string => {
  if (!Number.isFinite(val)) return '—';
  const abs = Math.abs(val).toFixed(6);
  if (isLatitude) {
    const dir = val >= 0 ? 'N' : 'S';
    return `${abs}° ${dir}`;
  } else {
    const dir = val >= 0 ? 'E' : 'W';
    return `${abs}° ${dir}`;
  }
};

/**
 * Converts a compass azimuth (0-360) into standard 16-point cardinal direction.
 */
export const getHeadingCardinal = (heading?: number | null): string => {
  if (heading === undefined || heading === null || !Number.isFinite(heading)) {
    return '—';
  }
  const normalized = ((heading % 360) + 360) % 360;
  const directions = [
    'N', 'NNE', 'NE', 'ENE',
    'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW',
    'W', 'WNW', 'NW', 'NNW'
  ];
  const index = Math.round(normalized / 22.5) % 16;
  return `${Math.round(normalized)}° ${directions[index]}`;
};

/**
 * Classifies GPS fix quality into standard UAV operational categories:
 * - LIVE: DGPS, 3D Fix, RTK Float, RTK Fixed (Navigation Ready)
 * - DEGRADED: 2D Fix (Latitude/Longitude only, no reliable altitude, NOT Nav Ready)
 * - NO_FIX: No lock, searching, or invalid
 */
export const classifyGpsFix = (fixType?: string | null): GpsFixDetails => {
  if (!fixType) {
    return { status: 'UNKNOWN', label: 'STANDBY', isNavReady: false, colorClass: 'text-text-muted bg-surface-elevated' };
  }
  const normalized = fixType.trim().toUpperCase().replace(/_/g, ' ');

  if (
    normalized.includes('DGPS') ||
    normalized.includes('3D') ||
    normalized.includes('RTK')
  ) {
    return {
      status: 'LIVE',
      label: normalized,
      isNavReady: true,
      colorClass: 'text-success bg-success/15 border-success/30'
    };
  }

  if (normalized.includes('2D')) {
    return {
      status: 'DEGRADED',
      label: '2D FIX (DEGRADED)',
      isNavReady: false,
      colorClass: 'text-warning bg-warning/15 border-warning/30'
    };
  }

  if (
    normalized.includes('NO FIX') ||
    normalized.includes('NONE') ||
    normalized.includes('NO GPS') ||
    normalized.includes('SEARCHING')
  ) {
    return {
      status: 'NO_FIX',
      label: 'NO FIX',
      isNavReady: false,
      colorClass: 'text-danger bg-danger/15 border-danger/30'
    };
  }

  return {
    status: 'UNKNOWN',
    label: normalized,
    isNavReady: false,
    colorClass: 'text-text-muted bg-surface-elevated'
  };
};

/**
 * Classifies Horizontal Dilution of Precision (HDOP).
 */
export const classifyHdop = (hdop?: number | null): { rating: string; color: string } => {
  if (hdop === undefined || hdop === null || !Number.isFinite(hdop) || hdop <= 0) {
    return { rating: 'Unknown', color: 'text-text-muted' };
  }
  if (hdop < 1.0) return { rating: 'Ideal (<1.0)', color: 'text-success font-semibold' };
  if (hdop < 2.0) return { rating: 'Excellent (<2.0)', color: 'text-success font-semibold' };
  if (hdop < 3.0) return { rating: 'Good (<3.0)', color: 'text-accent-primary' };
  if (hdop < 5.0) return { rating: 'Moderate (<5.0)', color: 'text-warning' };
  return { rating: 'Poor (>=5.0)', color: 'text-danger font-bold' };
};

/**
 * Determines whether a new breadcrumb sample should be appended to the track polyline.
 * Prevents jitter accumulation by enforcing minimum displacement (meters)
 * and minimum time elapsed (milliseconds), while enforcing chronological order.
 */
export const shouldAppendBreadcrumb = (
  lastPoint: BreadcrumbPoint | null,
  newPoint: BreadcrumbPoint,
  minDistanceMeters: number = 1.0,
  minIntervalMs: number = 500
): boolean => {
  if (!isValidCoordinate(newPoint.lat, newPoint.lon)) return false;
  if (!lastPoint) return true;

  // Strict chronological ordering: reject out-of-order packets
  if (newPoint.timestamp <= lastPoint.timestamp) return false;

  // Minimum time interval to prevent high-frequency packet flooding
  if (newPoint.timestamp - lastPoint.timestamp < minIntervalMs) return false;

  // Spatial displacement threshold
  const distance = haversineDistance(
    lastPoint.lat,
    lastPoint.lon,
    newPoint.lat,
    newPoint.lon
  );

  return distance >= minDistanceMeters;
};

/**
 * Calculates total cumulative distance and track duration for breadcrumbs.
 */
export const calculateTrackStats = (
  breadcrumbs: BreadcrumbPoint[]
): { totalDistanceMeters: number; durationSeconds: number } => {
  if (breadcrumbs.length < 2) {
    return { totalDistanceMeters: 0, durationSeconds: 0 };
  }

  let totalDistanceMeters = 0;
  for (let i = 1; i < breadcrumbs.length; i++) {
    const prev = breadcrumbs[i - 1];
    const curr = breadcrumbs[i];
    totalDistanceMeters += haversineDistance(prev.lat, prev.lon, curr.lat, curr.lon);
  }

  const firstTime = breadcrumbs[0].timestamp;
  const lastTime = breadcrumbs[breadcrumbs.length - 1].timestamp;
  const durationSeconds = Math.max(0, Math.round((lastTime - firstTime) / 1000));

  return { totalDistanceMeters, durationSeconds };
};

/**
 * Formats duration seconds into readable MM:SS or HH:MM:SS format.
 */
export const formatDuration = (seconds: number): string => {
  if (seconds <= 0) return '00:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hrs > 0) {
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

/**
 * Verifies if an incoming telemetry timestamp is newer than the recorded watermark.
 * Used for out-of-order packet rejection.
 */
export const isNewerTelemetry = (
  incomingTimestamp: string | number | undefined,
  latestWatermarkMs: number
): boolean => {
  if (!incomingTimestamp) return true;
  const incomingMs = typeof incomingTimestamp === 'number'
    ? incomingTimestamp
    : new Date(incomingTimestamp).getTime();

  if (!Number.isFinite(incomingMs) || incomingMs <= 0) return true;
  if (latestWatermarkMs <= 0) return true;

  return incomingMs >= latestWatermarkMs;
};

/**
 * Launch Origin Local Storage Management
 */
const LAUNCH_ORIGIN_KEY_PREFIX = 'aeron_launch_origin_';

export const getStoredLaunchOrigin = (droneId: string): LaunchOrigin | null => {
  try {
    const raw = localStorage.getItem(`${LAUNCH_ORIGIN_KEY_PREFIX}${droneId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LaunchOrigin;
    if (isValidCoordinate(parsed.lat, parsed.lon)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
};

export const setStoredLaunchOrigin = (droneId: string, origin: LaunchOrigin): void => {
  try {
    if (isValidCoordinate(origin.lat, origin.lon)) {
      localStorage.setItem(`${LAUNCH_ORIGIN_KEY_PREFIX}${droneId}`, JSON.stringify(origin));
    }
  } catch (err) {
    console.warn('[GIS] Failed to persist launch origin to localStorage:', err);
  }
};

export const clearStoredLaunchOrigin = (droneId: string): void => {
  try {
    localStorage.removeItem(`${LAUNCH_ORIGIN_KEY_PREFIX}${droneId}`);
  } catch (err) {
    console.warn('[GIS] Failed to clear launch origin from localStorage:', err);
  }
};

/**
 * Task 11 — Central Telemetry Validity Model
 * Telemetry validity states: LIVE, STALE, UNAVAILABLE, ESTIMATED, INVALID.
 */
export type TelemetryValidityState = 'LIVE' | 'STALE' | 'UNAVAILABLE' | 'ESTIMATED' | 'INVALID';

export interface TelemetryFieldValidity {
  state: TelemetryValidityState;
  label: string;
  badgeClass: string;
  ageMs?: number;
}

export const evaluateFieldValidity = (
  value: unknown,
  timestampMs?: number,
  options?: {
    isEstimated?: boolean;
    validator?: (v: any) => boolean;
    staleThresholdMs?: number;
    unavailableThresholdMs?: number;
  }
): TelemetryFieldValidity => {
  const staleThreshold = options?.staleThresholdMs ?? 3000;
  const unavailableThreshold = options?.unavailableThresholdMs ?? 15000;

  if (value === undefined || value === null || (typeof value === 'number' && !Number.isFinite(value))) {
    return {
      state: 'UNAVAILABLE',
      label: 'Unavailable',
      badgeClass: 'bg-surface-elevated text-text-muted border-border'
    };
  }

  if (options?.validator && !options.validator(value)) {
    return {
      state: 'INVALID',
      label: 'Invalid / Out of Bounds',
      badgeClass: 'bg-danger/15 text-danger border-danger/30'
    };
  }

  if (options?.isEstimated) {
    return {
      state: 'ESTIMATED',
      label: 'Estimated (Model)',
      badgeClass: 'bg-accent-primary/15 text-accent-primary border-accent-primary/30'
    };
  }

  if (timestampMs !== undefined && timestampMs > 0) {
    const age = Math.max(0, Date.now() - timestampMs);
    if (age > unavailableThreshold) {
      return {
        state: 'UNAVAILABLE',
        label: 'Awaiting Telemetry',
        badgeClass: 'bg-surface-elevated text-text-muted border-border',
        ageMs: age
      };
    }
    if (age > staleThreshold) {
      return {
        state: 'STALE',
        label: 'Stale Telemetry',
        badgeClass: 'bg-warning/15 text-warning border-warning/30',
        ageMs: age
      };
    }
    return {
      state: 'LIVE',
      label: 'Live Telemetry',
      badgeClass: 'bg-success/15 text-success border-success/30',
      ageMs: age
    };
  }

  return {
    state: 'LIVE',
    label: 'Live Telemetry',
    badgeClass: 'bg-success/15 text-success border-success/30'
  };
};

