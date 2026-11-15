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
  formatDuration,
  isNewerTelemetry,
  getStoredLaunchOrigin,
  setStoredLaunchOrigin,
  clearStoredLaunchOrigin,
  BreadcrumbPoint,
  LaunchOrigin
} from '../gis';

describe('AERON GIS & Navigation Utilities', () => {
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

  describe('isValidCoordinate', () => {
    it('accepts valid coordinates across quadrants', () => {
      expect(isValidCoordinate(23.1830, 77.3014)).toBe(true);
      expect(isValidCoordinate(-34.6037, -58.3816)).toBe(true);
      expect(isValidCoordinate(90, 180)).toBe(true);
      expect(isValidCoordinate(-90, -180)).toBe(true);
    });

    it('accepts zero-valued coordinates (0, 0) as mathematically valid', () => {
      expect(isValidCoordinate(0, 0)).toBe(true);
      expect(isValidCoordinate(0, 77.3)).toBe(true);
      expect(isValidCoordinate(23.1, 0)).toBe(true);
    });

    it('rejects coordinates exceeding valid geodetic bounds', () => {
      expect(isValidCoordinate(90.1, 0)).toBe(false);
      expect(isValidCoordinate(-90.1, 0)).toBe(false);
      expect(isValidCoordinate(0, 180.1)).toBe(false);
      expect(isValidCoordinate(0, -180.1)).toBe(false);
    });

    it('rejects non-numeric, null, undefined, NaN, and Infinite inputs', () => {
      expect(isValidCoordinate(null, 77.3)).toBe(false);
      expect(isValidCoordinate(23.1, undefined)).toBe(false);
      expect(isValidCoordinate('23.1' as any, 77.3)).toBe(false);
      expect(isValidCoordinate(NaN, 77.3)).toBe(false);
      expect(isValidCoordinate(23.1, Infinity)).toBe(false);
    });
  });

  describe('haversineDistance', () => {
    it('computes accurate geodesic distance between known geographic points', () => {
      // Bhopal (23.1830, 77.3014) to 100m north (~0.0009 deg lat)
      const d = haversineDistance(23.1830, 77.3014, 23.1839, 77.3014);
      expect(d).toBeGreaterThan(95);
      expect(d).toBeLessThan(105);
    });

    it('returns 0 for identical points or invalid coordinates', () => {
      expect(haversineDistance(23.1830, 77.3014, 23.1830, 77.3014)).toBe(0);
      expect(haversineDistance(NaN, 77.3, 23.1, 77.3)).toBe(0);
    });
  });

  describe('formatCoordinate', () => {
    it('formats latitude and longitude in standard aerospace notation', () => {
      expect(formatCoordinate(23.182941, true)).toBe('23.182941° N');
      expect(formatCoordinate(-12.9716, true)).toBe('12.971600° S');
      expect(formatCoordinate(77.301548, false)).toBe('77.301548° E');
      expect(formatCoordinate(-122.4194, false)).toBe('122.419400° W');
    });

    it('handles zero coordinates correctly', () => {
      expect(formatCoordinate(0, true)).toBe('0.000000° N');
      expect(formatCoordinate(0, false)).toBe('0.000000° E');
    });

    it('returns dash for non-finite values', () => {
      expect(formatCoordinate(NaN, true)).toBe('—');
      expect(formatCoordinate(Infinity, false)).toBe('—');
    });
  });

  describe('getHeadingCardinal', () => {
    it('maps heading angles to 16-point cardinal azimuths', () => {
      expect(getHeadingCardinal(0)).toBe('0° N');
      expect(getHeadingCardinal(90)).toBe('90° E');
      expect(getHeadingCardinal(180)).toBe('180° S');
      expect(getHeadingCardinal(270)).toBe('270° W');
      expect(getHeadingCardinal(315)).toBe('315° NW');
      expect(getHeadingCardinal(334)).toBe('334° NNW');
      expect(getHeadingCardinal(45)).toBe('45° NE');
    });

    it('normalizes angles outside 0-360', () => {
      expect(getHeadingCardinal(-10)).toBe('350° N');
      expect(getHeadingCardinal(370)).toBe('10° N');
    });

    it('handles null/undefined gracefully', () => {
      expect(getHeadingCardinal(null)).toBe('—');
      expect(getHeadingCardinal(undefined)).toBe('—');
    });
  });

  describe('classifyGpsFix', () => {
    it('classifies DGPS, 3D Fix, and RTK as navigation-ready LIVE states', () => {
      const dgps = classifyGpsFix('DGPS');
      expect(dgps.status).toBe('LIVE');
      expect(dgps.isNavReady).toBe(true);

      const fix3d = classifyGpsFix('3D FIX');
      expect(fix3d.status).toBe('LIVE');
      expect(fix3d.isNavReady).toBe(true);

      const rtk = classifyGpsFix('RTK_FIXED');
      expect(rtk.status).toBe('LIVE');
      expect(rtk.isNavReady).toBe(true);
    });

    it('classifies 2D Fix as DEGRADED and NOT navigation-ready', () => {
      const fix2d = classifyGpsFix('2D FIX');
      expect(fix2d.status).toBe('DEGRADED');
      expect(fix2d.isNavReady).toBe(false);
      expect(fix2d.label).toContain('DEGRADED');
    });

    it('classifies NO FIX and SEARCHING as NO_FIX', () => {
      const noFix = classifyGpsFix('NO FIX');
      expect(noFix.status).toBe('NO_FIX');
      expect(noFix.isNavReady).toBe(false);

      const searching = classifyGpsFix('SEARCHING');
      expect(searching.status).toBe('NO_FIX');
      expect(searching.isNavReady).toBe(false);
    });

    it('handles empty or unknown fix gracefully', () => {
      expect(classifyGpsFix(null).status).toBe('UNKNOWN');
      expect(classifyGpsFix('').status).toBe('UNKNOWN');
    });
  });

  describe('classifyHdop', () => {
    it('rates HDOP levels accurately', () => {
      expect(classifyHdop(0.8).rating).toContain('Ideal');
      expect(classifyHdop(1.4).rating).toContain('Excellent');
      expect(classifyHdop(2.5).rating).toContain('Good');
      expect(classifyHdop(4.0).rating).toContain('Moderate');
      expect(classifyHdop(6.2).rating).toContain('Poor');
      expect(classifyHdop(null).rating).toBe('Unknown');
    });
  });

  describe('shouldAppendBreadcrumb', () => {
    const basePoint: BreadcrumbPoint = {
      lat: 23.183000,
      lon: 77.301400,
      timestamp: 1000
    };

    it('appends first point when history is empty', () => {
      expect(shouldAppendBreadcrumb(null, basePoint)).toBe(true);
    });

    it('rejects points with invalid coordinates', () => {
      expect(shouldAppendBreadcrumb(basePoint, { lat: NaN, lon: 77.3, timestamp: 2000 })).toBe(false);
    });

    it('rejects out-of-order points (older or equal timestamp)', () => {
      const olderPoint: BreadcrumbPoint = {
        lat: 23.183100,
        lon: 77.301400,
        timestamp: 900 // Before basePoint (1000)
      };
      expect(shouldAppendBreadcrumb(basePoint, olderPoint)).toBe(false);
    });

    it('rejects points arriving faster than minimum time interval (500ms)', () => {
      const tooFast: BreadcrumbPoint = {
        lat: 23.183100,
        lon: 77.301400,
        timestamp: 1200 // Only 200ms elapsed
      };
      expect(shouldAppendBreadcrumb(basePoint, tooFast, 1.0, 500)).toBe(false);
    });

    it('rejects points with displacement below minimum distance threshold (1m)', () => {
      const stationaryJitter: BreadcrumbPoint = {
        lat: 23.18300005, // Tiny jitter: ~0.005 meters
        lon: 77.30140005,
        timestamp: 2000
      };
      expect(shouldAppendBreadcrumb(basePoint, stationaryJitter, 1.0, 500)).toBe(false);
    });

    it('accepts points meeting both time and displacement thresholds', () => {
      const validMovedPoint: BreadcrumbPoint = {
        lat: 23.183050, // ~5.5 meters north
        lon: 77.301400,
        timestamp: 2000 // 1000ms later
      };
      expect(shouldAppendBreadcrumb(basePoint, validMovedPoint, 1.0, 500)).toBe(true);
    });
  });

  describe('calculateTrackStats & formatDuration', () => {
    it('computes cumulative track distance and duration', () => {
      const points: BreadcrumbPoint[] = [
        { lat: 23.183000, lon: 77.301400, timestamp: 10000 },
        { lat: 23.183100, lon: 77.301400, timestamp: 15000 }, // ~11.1 meters, 5s
        { lat: 23.183200, lon: 77.301400, timestamp: 20000 }  // ~11.1 meters, 5s
      ];

      const stats = calculateTrackStats(points);
      expect(stats.totalDistanceMeters).toBeGreaterThan(20);
      expect(stats.totalDistanceMeters).toBeLessThan(25);
      expect(stats.durationSeconds).toBe(10);
      expect(formatDuration(stats.durationSeconds)).toBe('00:10');
    });

    it('formats longer durations into HH:MM:SS', () => {
      expect(formatDuration(3665)).toBe('01:01:05');
      expect(formatDuration(0)).toBe('00:00');
    });
  });

  describe('isNewerTelemetry (Watermark check)', () => {
    it('accepts strictly newer timestamps', () => {
      expect(isNewerTelemetry('2026-11-15T12:00:05.000Z', 1763208000000)).toBe(true);
    });

    it('rejects stale out-of-order timestamps', () => {
      const watermark = new Date('2026-11-15T12:00:10.000Z').getTime();
      const olderTime = '2026-11-15T12:00:05.000Z';
      expect(isNewerTelemetry(olderTime, watermark)).toBe(false);
    });
  });

  describe('Launch Origin Local Storage', () => {
    const origin: LaunchOrigin = {
      lat: 23.182941,
      lon: 77.301548,
      altitude: 517.8,
      setAt: '2026-11-15T12:00:00.000Z',
      droneId: 'AERON-HEX-01'
    };

    it('persists and retrieves valid launch origin for specific airframe', () => {
      expect(getStoredLaunchOrigin('AERON-HEX-01')).toBeNull();
      setStoredLaunchOrigin('AERON-HEX-01', origin);

      const retrieved = getStoredLaunchOrigin('AERON-HEX-01');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.lat).toBe(23.182941);
      expect(retrieved?.lon).toBe(77.301548);
      expect(retrieved?.droneId).toBe('AERON-HEX-01');
    });

    it('clears launch origin from storage', () => {
      setStoredLaunchOrigin('AERON-HEX-01', origin);
      expect(getStoredLaunchOrigin('AERON-HEX-01')).not.toBeNull();

      clearStoredLaunchOrigin('AERON-HEX-01');
      expect(getStoredLaunchOrigin('AERON-HEX-01')).toBeNull();
    });

    it('does not leak between different airframe IDs', () => {
      setStoredLaunchOrigin('AERON-HEX-01', origin);
      expect(getStoredLaunchOrigin('OTHER-DRONE-99')).toBeNull();
    });
  });
});
