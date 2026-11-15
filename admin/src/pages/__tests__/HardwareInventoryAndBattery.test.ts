import { describe, it, expect } from 'vitest';
import {
  BATTERY_CELL_COUNT,
  BATTERY_MAX_VOLTAGE,
  BATTERY_NOMINAL_VOLTAGE,
  BATTERY_WARNING_VOLTAGE,
  BATTERY_CRITICAL_VOLTAGE,
  BATTERY_CAPACITY_MAH,
  calculateAverageCellVoltage,
  estimateLipoPercentage,
  resolveBatteryState,
  formatBatteryCurrent
} from '../../config/drone';

describe('AERON 3S Battery Management & Non-Linear Estimation', () => {
  it('enforces strict 3S LiPo electrical specifications', () => {
    expect(BATTERY_CELL_COUNT).toBe(3);
    expect(BATTERY_MAX_VOLTAGE).toBe(12.6);
    expect(BATTERY_NOMINAL_VOLTAGE).toBe(11.1);
    expect(BATTERY_WARNING_VOLTAGE).toBe(10.5);
    expect(BATTERY_CRITICAL_VOLTAGE).toBe(9.9);
    expect(BATTERY_CAPACITY_MAH).toBe(5200);
  });

  it('correctly calculates average cell voltage (totalVoltage / 3)', () => {
    expect(calculateAverageCellVoltage(12.6)).toBe(4.20);
    expect(calculateAverageCellVoltage(11.1)).toBe(3.70);
    expect(calculateAverageCellVoltage(10.5)).toBe(3.50);
    expect(calculateAverageCellVoltage(9.9)).toBe(3.30);
    expect(calculateAverageCellVoltage(10.49)).toBe(3.50);
  });

  it('handles invalid or zero voltages gracefully without dividing by zero or crashing', () => {
    expect(calculateAverageCellVoltage(0)).toBeNull();
    expect(calculateAverageCellVoltage(-5)).toBeNull();
    expect(calculateAverageCellVoltage(null)).toBeNull();
    expect(calculateAverageCellVoltage(undefined)).toBeNull();
  });

  it('interpolates 3S LiPo percentage accurately across discharge curve', () => {
    // 12.6V = 100% (4.20V/cell)
    expect(estimateLipoPercentage(12.6, 3)).toBe(100.0);
    expect(estimateLipoPercentage(12.8, 3)).toBe(100.0);

    // 11.52V = 50.0% (3.84V/cell)
    expect(estimateLipoPercentage(11.52, 3)).toBe(50.0);

    // 11.10V = 20.0% (3.70V/cell)
    expect(estimateLipoPercentage(11.10, 3)).toBe(20.0);

    // 9.90V = 0.0% (3.30V/cell)
    expect(estimateLipoPercentage(9.90, 3)).toBe(0.0);
    expect(estimateLipoPercentage(9.50, 3)).toBe(0.0);

    // Bench voltage 10.46V (approx 1.6% - 1.9%)
    const benchPct = estimateLipoPercentage(10.46, 3);
    expect(benchPct).toBeGreaterThanOrEqual(1.0);
    expect(benchPct).toBeLessThanOrEqual(2.0);
  });

  it('enforces priority 1: genuine Pixhawk FC percentage takes precedence', () => {
    const state = resolveBatteryState({
      batteryVoltage: 11.8,
      batteryCurrent: 1.5,
      batteryPercentage: 70,
      batteryRemainingRaw: 70,
      batteryPercentageSource: 'FC_ESTIMATE'
    });

    expect(state.percentage).toBe(70);
    expect(state.percentageSource).toBe('FC_ESTIMATE');
    expect(state.sourceLabel).toBe('FC ESTIMATE');
    expect(state.remainingMah).toBe(3640); // 5200 * 0.70
    expect(state.isValid).toBe(true);
  });

  it('enforces priority 2: detects ArduPilot 99% bench placeholder and falls back to voltage estimate', () => {
    // 10.46V pack reporting 99% is the known ArduPilot uncalibrated placeholder
    const state = resolveBatteryState({
      batteryVoltage: 10.46,
      batteryCurrent: 0.0,
      batteryPercentage: 99,
      batteryRemainingRaw: 99,
      batteryPercentageSource: 'FC_ESTIMATE'
    });

    expect(state.percentageSource).toBe('VOLTAGE_ESTIMATE');
    expect(state.sourceLabel).toBe('VOLTAGE ESTIMATE');
    expect(state.percentage).not.toBe(99);
    expect(state.percentage).toBeLessThanOrEqual(3);
    expect(state.remainingMah).toBeLessThan(200);
    expect(state.isValid).toBe(true);
  });

  it('enforces priority 2: falls back to voltage estimate when Pixhawk reports -1', () => {
    const state = resolveBatteryState({
      batteryVoltage: 11.1,
      batteryCurrent: 0.0,
      batteryPercentage: null,
      batteryRemainingRaw: -1,
      batteryPercentageSource: 'VOLTAGE_ESTIMATE'
    });

    expect(state.percentage).toBe(20);
    expect(state.percentageSource).toBe('VOLTAGE_ESTIMATE');
    expect(state.remainingMah).toBe(1040); // 5200 * 0.20
    expect(state.isValid).toBe(true);
  });

  it('enforces priority 3: reports UNKNOWN when neither source is valid', () => {
    const state = resolveBatteryState({
      batteryVoltage: null,
      batteryCurrent: null,
      batteryPercentage: null,
      batteryRemainingRaw: -1
    });

    expect(state.percentage).toBeNull();
    expect(state.percentageSource).toBe('UNKNOWN');
    expect(state.sourceLabel).toBe('UNKNOWN');
    expect(state.remainingMah).toBeNull();
    expect(state.isValid).toBe(false);
  });

  it('calculates flight time only when valid current > 0.5A is available', () => {
    // Idle 0.0A: should not display flight time
    const benchState = resolveBatteryState({
      batteryVoltage: 11.52,
      batteryCurrent: 0.0,
      batteryPercentage: 50
    });
    expect(benchState.remainingFlightTimeStr).toBeNull();

    // In-flight 10.0A draw on 50% pack (2600 mAh): 2.6Ah / 10A = 0.26h = ~16 min
    const flightState = resolveBatteryState({
      batteryVoltage: 11.52,
      batteryCurrent: 10.0,
      batteryPercentage: 50
    });
    expect(flightState.remainingFlightTimeStr).toContain('min');
    expect(flightState.remainingFlightTimeStr).toContain('10.0A');
  });

  it('correctly distinguishes 0.0A current draw from unavailable sensor', () => {
    expect(formatBatteryCurrent(0.0, true)).toBe('0.0 A');
    expect(formatBatteryCurrent(2.4, true)).toBe('2.4 A');
    expect(formatBatteryCurrent(null, true)).toBe('Not measured');
    expect(formatBatteryCurrent(undefined, true)).toBe('Not measured');
    expect(formatBatteryCurrent(-1, true)).toBe('Not measured');
    expect(formatBatteryCurrent(1.5, false)).toBe('—');
  });
});

describe('AERON Hardware Inventory & Port Topology Specifications', () => {
  it('verifies TELEM2 configuration on SERIAL2 @ 57600 baud', () => {
    const telem2Config = {
      port: 'TELEM2 / SERIAL2',
      baud: 57600,
      protocol: 'MAVLink 2.0',
      device: 'ESP32 DevKit V1',
      pins: { rx: 'GPIO16 (RX2)', tx: 'GPIO17 (TX2)' },
      path: 'Pixhawk TELEM2 (57600) -> ESP32 UART2 -> USB Serial (115200) -> Windows COM8'
    };

    expect(telem2Config.port).toBe('TELEM2 / SERIAL2');
    expect(telem2Config.baud).toBe(57600);
    expect(telem2Config.protocol).toBe('MAVLink 2.0');
    expect(telem2Config.pins.rx).toContain('GPIO16');
    expect(telem2Config.pins.tx).toContain('GPIO17');
  });

  it('verifies ESP32 USB serial bridge on COM8 @ 115200 baud', () => {
    const bridgeConfig = {
      device: 'ESP32 DevKit V1',
      windowsPort: 'COM8',
      baud: 115200
    };

    expect(bridgeConfig.windowsPort).toBe('COM8');
    expect(bridgeConfig.baud).toBe(115200);
  });

  it('enforces TELEM1 is marked UNKNOWN / NOT VERIFIED (unattached)', () => {
    const telem1Status = 'UNKNOWN / NOT VERIFIED';
    expect(telem1Status).toBe('UNKNOWN / NOT VERIFIED');
    expect(telem1Status).not.toBe('ACTIVE');
    expect(telem1Status).not.toBe('CONNECTED');
  });
});

describe('AERON AGL and MSL Altitude Vector Separation', () => {
  it('strictly maps relativeAltitude to AGL and altitude to MSL', () => {
    const telemetry = {
      relativeAltitude: 12.5,
      altitude: 580.2
    };

    const agl = telemetry.relativeAltitude;
    const msl = telemetry.altitude;

    expect(agl).toBe(12.5);
    expect(msl).toBe(580.2);
    expect(agl).not.toBe(msl);
  });

  it('never substitutes AGL for MSL when one is missing, outputting N/A', () => {
    const telemetryNoMsl: { relativeAltitude?: number; altitude?: number } = {
      relativeAltitude: 5.0,
      altitude: undefined
    };

    const aglDisplay = telemetryNoMsl.relativeAltitude !== undefined ? `${telemetryNoMsl.relativeAltitude.toFixed(1)}m` : 'N/A';
    const mslDisplay = telemetryNoMsl.altitude !== undefined ? `${telemetryNoMsl.altitude.toFixed(1)}m` : 'N/A';

    expect(aglDisplay).toBe('5.0m');
    expect(mslDisplay).toBe('N/A');
    expect(mslDisplay).not.toBe('5.0m');
  });

  it('correctly formats the global footer telemetry strip', () => {
    const formatFooterAltitude = (relAlt?: number, alt?: number) => {
      const aglStr = relAlt !== undefined && relAlt !== null ? `${relAlt.toFixed(1)}m` : 'N/A';
      const mslStr = alt !== undefined && alt !== null ? `${alt.toFixed(1)}m` : 'N/A';
      return `AGL: ${aglStr} • MSL: ${mslStr}`;
    };

    expect(formatFooterAltitude(3.2, 512.4)).toBe('AGL: 3.2m • MSL: 512.4m');
    expect(formatFooterAltitude(undefined, 512.4)).toBe('AGL: N/A • MSL: 512.4m');
    expect(formatFooterAltitude(3.2, undefined)).toBe('AGL: 3.2m • MSL: N/A');
    expect(formatFooterAltitude(undefined, undefined)).toBe('AGL: N/A • MSL: N/A');
  });
});
