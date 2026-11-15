/**
 * Authoritative Airframe & 3S LiPo Battery Configuration for AERON Admin GCS
 */

export const ACTIVE_DRONE_ID: string =
  (import.meta.env.VITE_ACTIVE_DRONE_ID as string | undefined)?.trim() || 'AERON-HEX-01';

/**
 * Image heading calibration offset for the top-down quadcopter map marker photograph.
 * If the physical aircraft points north (0 deg), this offset aligns the top of the photo to true north.
 * Default is 0 degrees (photo top is aircraft forward).
 */
export const AIRFRAME_IMAGE_HEADING_OFFSET_DEG: number = 0;

// 3S LiPo Battery Physical Specifications (Strictly 3-Cell Configuration)
export const BATTERY_CELL_COUNT = 3;
export const BATTERY_MAX_VOLTAGE = 12.6; // 4.20V / cell (Full charge)
export const BATTERY_NOMINAL_VOLTAGE = 11.1; // 3.70V / cell (Nominal)
export const BATTERY_STORAGE_VOLTAGE = 11.4; // 3.80V / cell (Storage)
export const BATTERY_WARNING_VOLTAGE = 10.5; // 3.50V / cell (Low voltage alert / RTL warning)
export const BATTERY_CRITICAL_VOLTAGE = 9.9; // 3.30V / cell (Critical threshold / auto-land)
export const BATTERY_CAPACITY_MAH = 5200;
export const BATTERY_NOMINAL_ENERGY_WH = 57.72;

/**
 * Non-linear 3S LiPo Cell Discharge Lookup Table [cellVoltage, percentage]
 * Sorted ascending by cell voltage. Models the non-linear plateau and knee curves
 * of Lithium Polymer battery chemistry.
 */
export const LIPO_CELL_DISCHARGE_TABLE: Array<[number, number]> = [
  [3.30, 0.0],
  [3.50, 2.0],
  [3.60, 5.0],
  [3.64, 10.0],
  [3.67, 15.0],
  [3.70, 20.0],
  [3.73, 25.0],
  [3.75, 30.0],
  [3.77, 35.0],
  [3.80, 40.0],
  [3.82, 45.0],
  [3.84, 50.0],
  [3.87, 60.0],
  [3.91, 65.0],
  [3.95, 70.0],
  [3.98, 75.0],
  [4.02, 80.0],
  [4.08, 85.0],
  [4.11, 90.0],
  [4.15, 95.0],
  [4.20, 100.0]
];

/**
 * Calculates average per-cell voltage for a 3S LiPo pack
 */
export const calculateAverageCellVoltage = (totalVoltage?: number | null): number | null => {
  if (totalVoltage === undefined || totalVoltage === null || totalVoltage <= 0) {
    return null;
  }
  return Number((totalVoltage / BATTERY_CELL_COUNT).toFixed(2));
};

/**
 * Interpolates estimated battery percentage from total pack voltage using
 * the non-linear 3S LiPo discharge curve.
 */
export const estimateLipoPercentage = (
  totalVoltage?: number | null,
  cellCount: number = BATTERY_CELL_COUNT
): number | null => {
  if (totalVoltage === undefined || totalVoltage === null || totalVoltage <= 0) {
    return null;
  }
  // Minimum detectable voltage for a connected 3S pack (2.0V/cell)
  if (totalVoltage < 2.0 * cellCount) {
    return null;
  }

  const cellV = totalVoltage / cellCount;
  const minV = LIPO_CELL_DISCHARGE_TABLE[0][0];
  const maxV = LIPO_CELL_DISCHARGE_TABLE[LIPO_CELL_DISCHARGE_TABLE.length - 1][0];

  if (cellV <= minV) return 0.0;
  if (cellV >= maxV) return 100.0;

  for (let i = 0; i < LIPO_CELL_DISCHARGE_TABLE.length - 1; i++) {
    const [vLow, pctLow] = LIPO_CELL_DISCHARGE_TABLE[i];
    const [vHigh, pctHigh] = LIPO_CELL_DISCHARGE_TABLE[i + 1];

    if (cellV >= vLow && cellV <= vHigh) {
      const ratio = (cellV - vLow) / (vHigh - vLow);
      const pct = pctLow + ratio * (pctHigh - pctLow);
      return Number(pct.toFixed(1));
    }
  }

  return null;
};

export type BatteryPercentageSource = 'FC_ESTIMATE' | 'VOLTAGE_ESTIMATE' | 'UNKNOWN';

export interface ResolvedBatteryState {
  voltage: number | null;
  cellVoltage: number | null;
  cellCount: number;
  current: number | null;
  percentage: number | null;
  percentageSource: BatteryPercentageSource;
  sourceLabel: string;
  sourceBadgeClass: string;
  remainingMah: number | null;
  remainingEnergyWh: number | null;
  remainingFlightTimeStr: string | null;
  isValid: boolean;
  isLowVoltage: boolean;
  isCriticalVoltage: boolean;
}

/**
 * Authoritative 3S LiPo Battery State Resolver implementing strict priority:
 * 1. Valid Pixhawk FC battery_remaining (0–100).
 * 2. Voltage-based estimated percentage for 3S LiPo.
 * 3. UNKNOWN when neither source is valid.
 *
 * NOTE: Never invents remaining capacity (mAh) from voltage estimates alone.
 * Remaining mAh requires genuine FC coulomb counting.
 */
export const resolveBatteryState = (
  telemetry?: {
    batteryVoltage?: number | null;
    batteryCurrent?: number | null;
    batteryPercentage?: number | null;
    batteryRemainingRaw?: number | null;
    batteryPercentageSource?: string | null;
    batteryCellCount?: number | null;
    batteryCellVoltage?: number | null;
    batteryRemainingMah?: number | null;
    batteryDataValid?: boolean | null;
  } | null,
  isOnline: boolean = true
): ResolvedBatteryState => {
  const voltage = telemetry?.batteryVoltage ?? null;
  const cellCount = telemetry?.batteryCellCount || BATTERY_CELL_COUNT;
  const cellVoltage = telemetry?.batteryCellVoltage ?? (voltage && voltage > 0 ? Number((voltage / cellCount).toFixed(2)) : null);
  const current =
    telemetry?.batteryCurrent !== undefined &&
    telemetry?.batteryCurrent !== null &&
    telemetry.batteryCurrent >= 0
      ? telemetry.batteryCurrent
      : null;

  const isLowVoltage = voltage !== null && voltage < BATTERY_WARNING_VOLTAGE;
  const isCriticalVoltage = voltage !== null && voltage < BATTERY_CRITICAL_VOLTAGE;

  if (!isOnline || voltage === null || voltage <= 0) {
    return {
      voltage: null,
      cellVoltage: null,
      cellCount,
      current: null,
      percentage: null,
      percentageSource: 'UNKNOWN',
      sourceLabel: 'UNKNOWN',
      sourceBadgeClass: 'bg-surface-muted text-text-muted border-border',
      remainingMah: null,
      remainingEnergyWh: null,
      remainingFlightTimeStr: null,
      isValid: false,
      isLowVoltage: false,
      isCriticalVoltage: false
    };
  }

  let pct: number | null = null;
  let source: BatteryPercentageSource = 'UNKNOWN';

  const rawPct = telemetry?.batteryRemainingRaw ?? telemetry?.batteryPercentage;

  // Check Priority 1: Valid Pixhawk FC percentage (0-100)
  // Ensure we don't fall for ArduPilot's bench placeholder (99% when pack is low <= 11.5V)
  const isFcPlausible =
    rawPct !== undefined &&
    rawPct !== null &&
    rawPct >= 0 &&
    rawPct <= 100 &&
    !(rawPct >= 95 && voltage <= 11.5);

  if (telemetry?.batteryPercentageSource === 'FC_ESTIMATE' && isFcPlausible) {
    pct = telemetry.batteryPercentage!;
    source = 'FC_ESTIMATE';
  } else if (isFcPlausible && telemetry?.batteryPercentageSource !== 'VOLTAGE_ESTIMATE') {
    pct = Math.round(rawPct);
    source = 'FC_ESTIMATE';
  } else {
    // Priority 2: Voltage-based estimated percentage for 3S LiPo
    const estPct = estimateLipoPercentage(voltage, cellCount);
    if (estPct !== null) {
      pct = Math.round(estPct);
      source = 'VOLTAGE_ESTIMATE';
    } else {
      pct = null;
      source = 'UNKNOWN';
    }
  }

  const remainingMah = pct !== null ? Math.round(BATTERY_CAPACITY_MAH * (pct / 100)) : null;
  const remainingEnergyWh = remainingMah !== null && voltage ? Number(((remainingMah * voltage) / 1000).toFixed(1)) : null;

  // Remaining flight time: only calculate when valid current measurement > 0.5A is available
  let remainingFlightTimeStr: string | null = null;
  if (remainingMah !== null && current !== null && current > 0.5) {
    const hours = (remainingMah / 1000) / current;
    const minutes = Math.round(hours * 60);
    remainingFlightTimeStr = `~${minutes} min (EST @ ${current.toFixed(1)}A)`;
  }

  let sourceLabel = 'UNKNOWN';
  let sourceBadgeClass = 'bg-surface-muted text-text-muted border-border';
  if (source === 'FC_ESTIMATE') {
    sourceLabel = 'FC ESTIMATE';
    sourceBadgeClass = 'bg-info/15 text-info border-info/30';
  } else if (source === 'VOLTAGE_ESTIMATE') {
    sourceLabel = 'VOLTAGE ESTIMATE';
    sourceBadgeClass = 'bg-accent-primary/15 text-accent-primary border-accent-primary/30';
  }

  return {
    voltage,
    cellVoltage,
    cellCount,
    current,
    percentage: pct,
    percentageSource: source,
    sourceLabel,
    sourceBadgeClass,
    remainingMah,
    remainingEnergyWh,
    remainingFlightTimeStr,
    isValid: pct !== null,
    isLowVoltage,
    isCriticalVoltage
  };
};

/**
 * Formats battery percentage string with source label (e.g. "8% [VOLTAGE ESTIMATE]")
 */
export const formatBatteryPercentage = (
  reportedPct?: number | null,
  _voltage?: number | null,
  sourceLabel?: string
): string => {
  if (reportedPct !== undefined && reportedPct !== null) {
    return sourceLabel ? `${reportedPct}% (${sourceLabel})` : `${reportedPct}%`;
  }
  return 'SOC Unavailable';
};

/**
 * Formats battery current draw, distinguishing genuine measured draw from unavailable sensor.
 */
export const formatBatteryCurrent = (
  current?: number | null,
  isOnline: boolean = false
): string => {
  if (!isOnline) return '—';
  if (current === undefined || current === null || current < 0) {
    return 'Not measured';
  }
  return `${current.toFixed(1)} A`;
};
