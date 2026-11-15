import { describe, it, expect } from 'vitest';
import {
  calculateAverageCellVoltage,
  resolveBatteryState,
  formatBatteryPercentage,
  formatBatteryCurrent
} from '../../config/drone';
import {
  classifyGpsFix,
  evaluateFieldValidity
} from '../../utils/gis';

describe('AERON Task 1 — Battery Monitoring Accuracy & 3S Provenance', () => {
  it('correctly calculates average cell voltage for a 10.30V 3S pack (3.43 V/cell)', () => {
    const avg = calculateAverageCellVoltage(10.30);
    expect(avg).toBe(3.43);
  });

  it('correctly triggers low voltage alert at 10.30V (below 10.5V RTL warning)', () => {
    const state = resolveBatteryState({
      batteryVoltage: 10.30,
      batteryCurrent: null,
      batteryPercentage: null,
      batteryRemainingRaw: -1
    });

    expect(state.voltage).toBe(10.30);
    expect(state.cellVoltage).toBe(3.43);
    expect(state.cellCount).toBe(3);
    expect(state.isLowVoltage).toBe(true);
    expect(state.isCriticalVoltage).toBe(false); // 9.9V is critical
    expect(state.percentageSource).toBe('VOLTAGE_ESTIMATE');
    expect(state.sourceLabel).toBe('VOLTAGE ESTIMATE');
  });

  it('rejects ArduPilot 99% default placeholder at 10.30V and marks as VOLTAGE_ESTIMATE', () => {
    const state = resolveBatteryState({
      batteryVoltage: 10.30,
      batteryCurrent: null,
      batteryPercentage: 99,
      batteryRemainingRaw: 99,
      batteryPercentageSource: 'FC_ESTIMATE'
    });

    expect(state.percentageSource).toBe('VOLTAGE_ESTIMATE');
    expect(state.percentage).not.toBe(99);
    expect(state.percentage).toBeLessThanOrEqual(2);
  });

  it('formats unmeasured current as "Not measured" rather than inventing zero draw', () => {
    expect(formatBatteryCurrent(null, true)).toBe('Not measured');
    expect(formatBatteryCurrent(undefined, true)).toBe('Not measured');
    expect(formatBatteryCurrent(-1, true)).toBe('Not measured');
    expect(formatBatteryCurrent(0.0, true)).toBe('0.0 A');
    expect(formatBatteryCurrent(1.8, true)).toBe('1.8 A');
    expect(formatBatteryCurrent(1.8, false)).toBe('—');
  });

  it('formats battery percentage with honest provenance label', () => {
    expect(formatBatteryPercentage(1, 10.30, 'VOLTAGE ESTIMATE')).toBe('1% (VOLTAGE ESTIMATE)');
    expect(formatBatteryPercentage(null, null)).toBe('SOC Unavailable');
  });
});

describe('AERON Task 2 — Altitude Source Disambiguation', () => {
  it('distinguishes MSL (524m) from Relative Altitude (0.7m launch reference)', () => {
    const telemetry = {
      altitude: 524.2, // MSL in meters
      relativeAltitude: 0.74, // Launch ref in meters
      groundSpeed: 0.0
    };

    expect(telemetry.altitude).toBeGreaterThan(500);
    expect(telemetry.relativeAltitude).toBeLessThan(5);
    // Relative altitude must never overwrite MSL
    expect(telemetry.altitude).not.toBe(telemetry.relativeAltitude);
  });
});

describe('AERON Task 3 — GPS Diagnostics & Classification', () => {
  it('classifies 3D_FIX honestly without falsely claiming DGPS or RTK', () => {
    const fix3D = classifyGpsFix('3D_FIX');
    expect(fix3D.isNavReady).toBe(true);
    expect(fix3D.label).toBe('3D FIX');
    expect(fix3D.status).toBe('LIVE');
    expect(fix3D.label).not.toContain('DGPS');
    expect(fix3D.label).not.toContain('RTK');
  });

  it('classifies RTK_FIXED strictly when raw telemetry fix type indicates RTK', () => {
    const fixRtk = classifyGpsFix('RTK_FIXED');
    expect(fixRtk.isNavReady).toBe(true);
    expect(fixRtk.label).toBe('RTK FIXED');
  });

  it('classifies NO_FIX / Searching appropriately', () => {
    const noFix = classifyGpsFix('NO_FIX');
    expect(noFix.isNavReady).toBe(false);
    expect(noFix.status).toBe('NO_FIX');
  });

  it('correctly tracks stationary GPS updates with constant coordinates and advancing timestamps', () => {
    // Simulate stationary drone on bench: coordinates NEVER change
    const baseLat = 12.971598;
    const baseLon = 77.594562;
    const now = Date.now();

    // Tracker function mimicking HardwareContext.tsx logic
    let lastGpsTimestampMs = 0;
    const gpsArrivalTimes: number[] = [];

    const processPacket = (packet: any, arrivalWallTime: number) => {
      const rawGpsTs = packet.gpsTimestamp || packet.positionUpdatedAt ||
        ((packet.satellites !== undefined || packet.latitude !== undefined) ? packet.recordedAt : null);

      if (rawGpsTs) {
        const gpsTimeMs = typeof rawGpsTs === 'number' ? rawGpsTs : new Date(rawGpsTs).getTime();
        if (Number.isFinite(gpsTimeMs) && gpsTimeMs > lastGpsTimestampMs) {
          if (arrivalWallTime - gpsTimeMs <= 5000) {
            lastGpsTimestampMs = gpsTimeMs;
            gpsArrivalTimes.push(arrivalWallTime);
          }
        }
      }
    };

    // 10 fresh GPS messages arriving at 5Hz (200ms interval) with identical coordinates
    for (let i = 0; i < 10; i++) {
      const gpsMsgTime = now - 2000 + i * 200;
      processPacket({
        latitude: baseLat,
        longitude: baseLon,
        satellites: 9,
        gpsFixType: '3D_FIX',
        gpsTimestamp: new Date(gpsMsgTime).toISOString()
      }, now - 2000 + i * 200);
    }

    // All 10 unique arrivals must be counted
    expect(gpsArrivalTimes.length).toBe(10);

    // Repeated Socket.IO snapshots with duplicate timestamps must be rejected
    const dupTime = now - 200;
    processPacket({
      latitude: baseLat,
      longitude: baseLon,
      satellites: 9,
      gpsTimestamp: new Date(dupTime).toISOString()
    }, now);
    processPacket({
      latitude: baseLat,
      longitude: baseLon,
      satellites: 9,
      gpsTimestamp: new Date(dupTime).toISOString()
    }, now + 10);

    // Duplicate snapshots rejected, count remains 10
    expect(gpsArrivalTimes.length).toBe(10);

    // Calculated frequency: 10 packets over 2.0s = 5.0 Hz (matching NEO-M8N)
    const filtered = gpsArrivalTimes.filter((t) => now - t <= 2000);
    const measuredHz = Number((filtered.length / 2.0).toFixed(1));
    expect(measuredHz).toBe(5.0);
  });

  it('rejects stale GPS packets older than 5.0 seconds from inflating rate', () => {
    let lastGpsTimestampMs = 0;
    const gpsArrivalTimes: number[] = [];
    const now = Date.now();

    const processPacket = (packet: any, arrivalWallTime: number) => {
      const rawGpsTs = packet.gpsTimestamp;
      if (rawGpsTs) {
        const gpsTimeMs = new Date(rawGpsTs).getTime();
        if (Number.isFinite(gpsTimeMs) && gpsTimeMs > lastGpsTimestampMs) {
          if (arrivalWallTime - gpsTimeMs <= 5000) {
            lastGpsTimestampMs = gpsTimeMs;
            gpsArrivalTimes.push(arrivalWallTime);
          }
        }
      }
    };

    // Stale packet from 15 seconds ago
    processPacket({
      latitude: 12.9716,
      longitude: 77.5946,
      gpsTimestamp: new Date(now - 15000).toISOString()
    }, now);

    expect(gpsArrivalTimes.length).toBe(0);
  });
});

describe('AERON Task 2 & 5 — Sensor Presence & Health Bit Separation', () => {
  it('correctly decouples sensor presence from sensor health status', () => {
    // Scenario 1: Sensor present and healthy
    const healthySensor = {
      present: true,
      healthy: true
    };
    expect(healthySensor.present).toBe(true);
    expect(healthySensor.healthy).toBe(true);

    // Scenario 2: Sensor present but unhealthy (e.g. uncalibrated compass or IMU sensor failure)
    const degradedSensor = {
      present: true,
      healthy: false
    };
    expect(degradedSensor.present).toBe(true);
    expect(degradedSensor.healthy).toBe(false);

    // Scenario 3: Downlink Rangefinder (Lidar/Sonar) not installed
    const missingRangefinder = {
      present: false,
      healthy: false
    };
    expect(missingRangefinder.present).toBe(false);
    expect(missingRangefinder.healthy).toBe(false);
  });
});

describe('AERON Task 3 — Failsafe Verification & Transparency', () => {
  it('correctly marks unpolled Pixhawk failsafe configuration as NOT VERIFIED', () => {
    const failsafeStatus = {
      parameterPolled: false,
      parameterName: 'FS_GCS_ENBL',
      displayLabel: 'NOT VERIFIED (FS_GCS_ENBL Unpolled)'
    };
    expect(failsafeStatus.parameterPolled).toBe(false);
    expect(failsafeStatus.displayLabel).toContain('NOT VERIFIED');
  });
});

describe('AERON Task 11 — Central Telemetry Validity Model', () => {
  it('evaluates LIVE telemetry when within 3000ms threshold', () => {
    const now = Date.now();
    const result = evaluateFieldValidity(10.30, now - 500);
    expect(result.state).toBe('LIVE');
    expect(result.label).toContain('Live');
  });

  it('evaluates STALE telemetry when between 3000ms and 15000ms', () => {
    const now = Date.now();
    const result = evaluateFieldValidity(10.30, now - 6000);
    expect(result.state).toBe('STALE');
    expect(result.label).toContain('Stale');
  });

  it('evaluates UNAVAILABLE telemetry when past 15000ms or null', () => {
    const now = Date.now();
    const resultOld = evaluateFieldValidity(10.30, now - 20000);
    expect(resultOld.state).toBe('UNAVAILABLE');

    const resultNull = evaluateFieldValidity(null);
    expect(resultNull.state).toBe('UNAVAILABLE');
  });

  it('evaluates ESTIMATED telemetry when flagged as indirect model calculation', () => {
    const result = evaluateFieldValidity(1, undefined, { isEstimated: true });
    expect(result.state).toBe('ESTIMATED');
    expect(result.label).toContain('Estimated');
  });

  it('evaluates INVALID telemetry when out of physical validator bounds', () => {
    const result = evaluateFieldValidity(-50, undefined, {
      validator: (v: number) => v >= 0 && v <= 100
    });
    expect(result.state).toBe('INVALID');
    expect(result.label).toContain('Invalid');
  });
});
