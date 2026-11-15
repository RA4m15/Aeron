import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  isValidCoordinate,
  haversineDistance,
  formatCoordinate,
  getHeadingCardinal,
  classifyGpsFix,
  classifyHdop,
  shouldAppendBreadcrumb,
  calculateTrackStats,
  isNewerTelemetry,
  getStoredLaunchOrigin,
  setStoredLaunchOrigin,
  clearStoredLaunchOrigin,
  BreadcrumbPoint,
  LaunchOrigin
} from '../../utils/gis';
import { TelemetryData } from '../../types';

describe('AERON GPS Tracking & Mission Navigation Suite', () => {
  const mockStorage: Record<string, string> = {};

  beforeEach(() => {
    for (const key in mockStorage) {
      delete mockStorage[key];
    }
    const localStorageMock = {
      getItem: (key: string) => mockStorage[key] || null,
      setItem: (key: string, value: string) => {
        mockStorage[key] = value;
      },
      removeItem: (key: string) => {
        delete mockStorage[key];
      },
      clear: () => {
        for (const key in mockStorage) {
          delete mockStorage[key];
        }
      }
    };
    vi.stubGlobal('localStorage', localStorageMock);
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. COORDINATE VALIDATION & ZERO-VALUE HANDLING
  // =========================================================================
  describe('Coordinate Validation & Edge Cases', () => {
    it('validates realistic drone coordinates (Bhopal benchmark)', () => {
      expect(isValidCoordinate(23.182941, 77.301548)).toBe(true);
    });

    it('accepts zero-valued coordinates (0.0, 0.0) without truthiness errors', () => {
      // In JavaScript, !!0 is false. The code must not use !!lat && !!lon.
      expect(isValidCoordinate(0.0, 0.0)).toBe(true);
      expect(formatCoordinate(0.0, true)).toBe('0.000000° N');
      expect(formatCoordinate(0.0, false)).toBe('0.000000° E');
    });

    it('rejects non-numeric inputs, strings, NaN, and Infinity', () => {
      expect(isValidCoordinate('23.1829' as any, 77.3015)).toBe(false);
      expect(isValidCoordinate(null, 77.3015)).toBe(false);
      expect(isValidCoordinate(undefined, 77.3015)).toBe(false);
      expect(isValidCoordinate(NaN, 77.3015)).toBe(false);
      expect(isValidCoordinate(23.1829, Infinity)).toBe(false);
    });

    it('rejects coordinates exceeding Earth geodetic spherical bounds', () => {
      expect(isValidCoordinate(90.00001, 77.3015)).toBe(false);
      expect(isValidCoordinate(-90.00001, 77.3015)).toBe(false);
      expect(isValidCoordinate(23.1829, 180.00001)).toBe(false);
      expect(isValidCoordinate(23.1829, -180.00001)).toBe(false);
    });
  });

  // =========================================================================
  // 2. GNSS FIX STATES (2D vs 3D / DGPS / RTK) & NAVIGATION READINESS
  // =========================================================================
  describe('GNSS Fix Classification & Navigation Readiness', () => {
    it('classifies DGPS as LIVE and Navigation Ready', () => {
      const fix = classifyGpsFix('DGPS');
      expect(fix.status).toBe('LIVE');
      expect(fix.isNavReady).toBe(true);
      expect(fix.label).toBe('DGPS');
    });

    it('classifies 3D FIX and RTK as LIVE and Navigation Ready', () => {
      const fix3d = classifyGpsFix('3D FIX');
      expect(fix3d.status).toBe('LIVE');
      expect(fix3d.isNavReady).toBe(true);

      const rtkFixed = classifyGpsFix('RTK_FIXED');
      expect(rtkFixed.status).toBe('LIVE');
      expect(rtkFixed.isNavReady).toBe(true);
    });

    it('classifies 2D FIX as DEGRADED and NOT Navigation Ready', () => {
      const fix2d = classifyGpsFix('2D FIX');
      expect(fix2d.status).toBe('DEGRADED');
      expect(fix2d.isNavReady).toBe(false);
      expect(fix2d.label).toContain('DEGRADED');
    });

    it('classifies NO FIX, SEARCHING, and NO GPS as NO_FIX', () => {
      const noFix = classifyGpsFix('NO FIX');
      expect(noFix.status).toBe('NO_FIX');
      expect(noFix.isNavReady).toBe(false);

      const searching = classifyGpsFix('SEARCHING');
      expect(searching.status).toBe('NO_FIX');
      expect(searching.isNavReady).toBe(false);
    });

    it('categorizes HDOP values with appropriate operational warnings', () => {
      expect(classifyHdop(0.9).rating).toContain('Ideal');
      expect(classifyHdop(1.44).rating).toContain('Excellent');
      expect(classifyHdop(2.7).rating).toContain('Good');
      expect(classifyHdop(4.2).rating).toContain('Moderate');
      expect(classifyHdop(6.5).rating).toContain('Poor');
    });
  });

  // =========================================================================
  // 3. OUT-OF-ORDER TELEMETRY REJECTION (WATERMARK)
  // =========================================================================
  describe('Out-of-Order Packet Rejection & Watermarking', () => {
    it('accepts strictly newer telemetry packets', () => {
      const t1 = '2026-11-15T12:00:00.000Z';
      const t2 = '2026-11-15T12:00:01.000Z';
      const watermark = new Date(t1).getTime();

      expect(isNewerTelemetry(t2, watermark)).toBe(true);
    });

    it('rejects stale out-of-order telemetry packets', () => {
      const tNow = '2026-11-15T12:00:10.000Z';
      const tOld = '2026-11-15T12:00:05.000Z';
      const watermark = new Date(tNow).getTime();

      expect(isNewerTelemetry(tOld, watermark)).toBe(false);
    });

    it('accepts packets when watermark is 0 (first frame)', () => {
      expect(isNewerTelemetry('2026-11-15T12:00:00.000Z', 0)).toBe(true);
    });
  });

  // =========================================================================
  // 4. BREADCRUMB DEDUPLICATION & JITTER THRESHOLD
  // =========================================================================
  describe('Breadcrumb Anti-Jitter & Chronological Appending', () => {
    const p1: BreadcrumbPoint = {
      lat: 23.182941,
      lon: 77.301548,
      timestamp: 1000
    };

    it('appends first breadcrumb point to an empty trail', () => {
      expect(shouldAppendBreadcrumb(null, p1)).toBe(true);
    });

    it('rejects GPS micro-jitter below 1.0 meter threshold', () => {
      // 0.000001 deg lat is ~0.11 meters
      const jitterPoint: BreadcrumbPoint = {
        lat: 23.182942,
        lon: 77.301548,
        timestamp: 2000
      };
      expect(shouldAppendBreadcrumb(p1, jitterPoint, 1.0, 500)).toBe(false);
    });

    it('rejects high-frequency packets arriving under minimum sample interval (500ms)', () => {
      const fastPoint: BreadcrumbPoint = {
        lat: 23.183000, // ~6.5m displacement
        lon: 77.301548,
        timestamp: 1200 // Only 200ms elapsed
      };
      expect(shouldAppendBreadcrumb(p1, fastPoint, 1.0, 500)).toBe(false);
    });

    it('accepts valid aircraft motion exceeding displacement and time limits', () => {
      const genuineFlightPoint: BreadcrumbPoint = {
        lat: 23.183000, // ~6.5m displacement
        lon: 77.301548,
        timestamp: 2500 // 1500ms elapsed
      };
      expect(shouldAppendBreadcrumb(p1, genuineFlightPoint, 1.0, 500)).toBe(true);
    });

    it('computes cumulative track distance and duration accurately', () => {
      const path: BreadcrumbPoint[] = [
        { lat: 23.182941, lon: 77.301548, timestamp: 10000 },
        { lat: 23.183041, lon: 77.301548, timestamp: 15000 }, // ~11m
        { lat: 23.183141, lon: 77.301548, timestamp: 20000 }  // ~11m
      ];
      const stats = calculateTrackStats(path);
      expect(stats.totalDistanceMeters).toBeGreaterThan(20);
      expect(stats.totalDistanceMeters).toBeLessThan(25);
      expect(stats.durationSeconds).toBe(10);
    });
  });

  // =========================================================================
  // 5. LAUNCH ORIGIN PERSISTENCE & FIXED GEOFENCE (500M)
  // =========================================================================
  describe('Launch Origin Persistence & Fixed 500m Geofence', () => {
    const launchPoint: LaunchOrigin = {
      lat: 23.182941,
      lon: 77.301548,
      altitude: 517.8,
      setAt: '2026-11-15T12:00:00.000Z',
      droneId: 'AERON-HEX-01'
    };

    it('stores and retrieves launch origin for specific airframe', () => {
      setStoredLaunchOrigin('AERON-HEX-01', launchPoint);
      const retrieved = getStoredLaunchOrigin('AERON-HEX-01');

      expect(retrieved).not.toBeNull();
      expect(retrieved?.lat).toBe(23.182941);
      expect(retrieved?.lon).toBe(77.301548);
      expect(retrieved?.droneId).toBe('AERON-HEX-01');
    });

    it('clears launch origin upon request', () => {
      setStoredLaunchOrigin('AERON-HEX-01', launchPoint);
      clearStoredLaunchOrigin('AERON-HEX-01');
      expect(getStoredLaunchOrigin('AERON-HEX-01')).toBeNull();
    });

    it('calculates aircraft distance to launch origin and checks 500m geofence', () => {
      // 100m north of launch origin
      const currentPosLat = 23.182941 + 0.0009; // ~100m
      const currentPosLon = 77.301548;

      const dist = haversineDistance(launchPoint.lat, launchPoint.lon, currentPosLat, currentPosLon);
      expect(dist).toBeGreaterThan(90);
      expect(dist).toBeLessThan(110);
      expect(dist <= 500).toBe(true); // Within safe geofence
    });

    it('detects when aircraft exceeds the 500m geofence perimeter', () => {
      // 600m north of launch origin (~0.0054 deg lat)
      const breachLat = 23.182941 + 0.0054;
      const breachLon = 77.301548;

      const dist = haversineDistance(launchPoint.lat, launchPoint.lon, breachLat, breachLon);
      expect(dist).toBeGreaterThan(500);
      expect(dist <= 500).toBe(false); // Perimeter breach detected!
    });
  });

  // =========================================================================
  // 6. REAL HARDWARE VS SIMULATION PROVENANCE SEPARATION
  // =========================================================================
  describe('Hardware vs Simulation Provenance Separation', () => {
    it('classifies genuine Pixhawk telemetry as REAL HARDWARE', () => {
      const realTelemetry: TelemetryData = {
        droneId: 'AERON-HEX-01',
        source: 'REAL',
        isSimulated: false,
        latitude: 23.182941,
        longitude: 77.301548
      };

      const isReal = realTelemetry.source === 'REAL' && realTelemetry.isSimulated === false;
      const isSim = realTelemetry.source === 'SIMULATION' || (realTelemetry.isSimulated === true && realTelemetry.source !== 'REAL');

      expect(isReal).toBe(true);
      expect(isSim).toBe(false);
    });

    it('classifies explicit simulation telemetry as SIMULATION', () => {
      const simTelemetry: TelemetryData = {
        droneId: 'AERON-HEX-01',
        source: 'SIMULATION',
        isSimulated: true,
        latitude: 12.9716,
        longitude: 77.5946
      };

      const isReal = simTelemetry.source === 'REAL' && simTelemetry.isSimulated === false;
      const isSim = simTelemetry.source === 'SIMULATION' || (simTelemetry.isSimulated === true && simTelemetry.source !== 'REAL');

      expect(isReal).toBe(false);
      expect(isSim).toBe(true);
    });

    it('does not falsely default missing provenance to simulation', () => {
      const unprovenancedTelemetry: TelemetryData = {
        droneId: 'AERON-HEX-01',
        latitude: 23.182941,
        longitude: 77.301548
        // source and isSimulated undefined
      };

      const isReal = unprovenancedTelemetry.source === 'REAL' && unprovenancedTelemetry.isSimulated === false;
      const isSim = unprovenancedTelemetry.source === 'SIMULATION' || (unprovenancedTelemetry.isSimulated === true && unprovenancedTelemetry.source !== 'REAL');

      expect(isReal).toBe(false);
      expect(isSim).toBe(false); // Must not default to simulation!
    });
  });

  // =========================================================================
  // 7. HEADING AZIMUTH & CARDINAL DISPLAY
  // =========================================================================
  describe('Heading Azimuth Rotation & Cardinal Formatting', () => {
    it('formats heading degree and cardinal direction properly', () => {
      expect(getHeadingCardinal(334)).toBe('334° NNW');
      expect(getHeadingCardinal(0)).toBe('0° N');
      expect(getHeadingCardinal(180)).toBe('180° S');
    });
  });

  // =========================================================================
  // 8. GPS FRESHNESS & STALE / OFFLINE BEHAVIOR
  // =========================================================================
  describe('GPS Freshness & Stale/Offline Detection', () => {
    it('identifies fresh telemetry (under 10 seconds)', () => {
      const now = Date.now();
      const packetTime = new Date(now - 2000).toISOString(); // 2s ago
      const elapsedSec = (now - new Date(packetTime).getTime()) / 1000;

      const isPacketStale = elapsedSec > 10;
      const isGpsOffline = elapsedSec > 30;

      expect(isPacketStale).toBe(false);
      expect(isGpsOffline).toBe(false);
    });

    it('identifies stale telemetry (between 10 and 30 seconds)', () => {
      const now = Date.now();
      const packetTime = new Date(now - 15000).toISOString(); // 15s ago
      const elapsedSec = (now - new Date(packetTime).getTime()) / 1000;

      const isPacketStale = elapsedSec > 10;
      const isGpsOffline = elapsedSec > 30;

      expect(isPacketStale).toBe(true);
      expect(isGpsOffline).toBe(false);
    });

    it('identifies offline telemetry (exceeding 30 seconds)', () => {
      const now = Date.now();
      const packetTime = new Date(now - 35000).toISOString(); // 35s ago
      const elapsedSec = (now - new Date(packetTime).getTime()) / 1000;

      const isGpsOffline = elapsedSec > 30;
      expect(isGpsOffline).toBe(true);
    });
  });
});

