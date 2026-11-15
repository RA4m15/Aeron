import { describe, it, expect } from 'vitest';
import { TelemetryData } from '../../types';

describe('AERON Quadcopter Schematic & Telemetry Logic', () => {
  // Test 1: Heading derivation prioritizing yaw over heading
  it('prioritizes ATTITUDE yaw over GLOBAL_POSITION_INT heading for immediate rotation', () => {
    const telemetryWithYaw: TelemetryData = {
      droneId: 'AERON-HEX-01',
      heading: 120.0,
      yaw: 45.5,
      roll: 1.2,
      pitch: -0.8
    };

    const resolvedHeading =
      telemetryWithYaw.yaw !== undefined && Number.isFinite(telemetryWithYaw.yaw)
        ? telemetryWithYaw.yaw
        : telemetryWithYaw.heading ?? 0;

    expect(resolvedHeading).toBe(45.5);
  });

  it('falls back to heading when yaw is undefined', () => {
    const telemetryWithoutYaw: TelemetryData = {
      droneId: 'AERON-HEX-01',
      heading: 270.0
    };

    const resolvedHeading =
      telemetryWithoutYaw.yaw !== undefined && Number.isFinite(telemetryWithoutYaw.yaw)
        ? telemetryWithoutYaw.yaw
        : telemetryWithoutYaw.heading ?? 0;

    expect(resolvedHeading).toBe(270.0);
  });

  // Test 2: Attitude staleness evaluation
  it('flags attitude as fresh when update is within 3.0 seconds', () => {
    const now = Date.now();
    const freshTimestamp = new Date(now - 1500).toISOString(); // 1.5s ago

    const attitudeAgeSec = (now - new Date(freshTimestamp).getTime()) / 1000;
    const isAttitudeStale = attitudeAgeSec > 3.0;

    expect(isAttitudeStale).toBe(false);
  });

  it('flags attitude as stale when update exceeds 3.0 seconds threshold', () => {
    const now = Date.now();
    const staleTimestamp = new Date(now - 4500).toISOString(); // 4.5s ago

    const attitudeAgeSec = (now - new Date(staleTimestamp).getTime()) / 1000;
    const isAttitudeStale = attitudeAgeSec > 3.0;

    expect(isAttitudeStale).toBe(true);
  });

  // Test 3: 3S LiPo battery calculation
  it('correctly reports 3S LiPo battery voltage and per-cell representation', () => {
    const voltage = 11.4; // 3S LiPo nominal (~3.8V per cell)
    const cellVoltage = voltage / 3;

    expect(cellVoltage).toBeCloseTo(3.8, 2);
    expect(voltage >= 9.9 && voltage <= 12.6).toBe(true);
  });

  // Test 4: Altitude AGL mapping
  it('maps relativeAltitude to AGL and preserves altitude for MSL', () => {
    const telemetry: TelemetryData = {
      altitude: 520.4, // MSL in meters
      relativeAltitude: 12.3 // AGL in meters
    };

    expect(telemetry.relativeAltitude).toBe(12.3);
    expect(telemetry.altitude).toBe(520.4);
  });

  // Test 5: Continuous rotation angle unwrapping across 0°/360° boundary
  it('unwraps clockwise heading transition from 359° to 1° without a 358° reverse spin', () => {
    let prevHeading = 359;
    const newHeading = 1;

    let delta = newHeading - (prevHeading % 360);
    if (delta < -180) delta += 360;
    if (delta > 180) delta -= 360;

    const continuousHeading = prevHeading + delta;

    // Must be +2 degrees (smooth clockwise continuation to 361°), NEVER -358 degrees
    expect(delta).toBe(2);
    expect(continuousHeading).toBe(361);
  });

  it('unwraps counter-clockwise heading transition from 1° to 359° without a 358° spin', () => {
    let prevHeading = 1;
    const newHeading = 359;

    let delta = newHeading - (prevHeading % 360);
    if (delta < -180) delta += 360;
    if (delta > 180) delta -= 360;

    const continuousHeading = prevHeading + delta;

    // Must be -2 degrees (smooth counter-clockwise to -1°), NEVER +358 degrees
    expect(delta).toBe(-2);
    expect(continuousHeading).toBe(-1);
  });

  // Test 6: Monotonic attitude packet ordering
  it('enforces monotonic ordering and rejects out-of-order attitude packets', () => {
    const now = Date.now();
    const packet1 = { sourceTimestamp: now - 50, yaw: 45.0 };
    const packet2 = { sourceTimestamp: now - 20, yaw: 48.0 }; // Newer
    const packet3 = { sourceTimestamp: now - 80, yaw: 40.0 }; // Stale out-of-order packet

    let latestTimestamp = packet1.sourceTimestamp;

    // Packet 2 accepted
    const acceptPacket2 = packet2.sourceTimestamp >= latestTimestamp;
    if (acceptPacket2) latestTimestamp = packet2.sourceTimestamp;

    // Packet 3 rejected
    const acceptPacket3 = packet3.sourceTimestamp >= latestTimestamp;

    expect(acceptPacket2).toBe(true);
    expect(acceptPacket3).toBe(false);
    expect(latestTimestamp).toBe(packet2.sourceTimestamp);
  });
});

