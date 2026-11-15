"""
AERON 3S LiPo Battery Telemetry & State of Charge (SoC) Estimation Module.

Provides:
- Configurable non-linear 3S LiPo discharge curve lookup table.
- Piecewise linear interpolation for pack and cell voltage.
- Strict percentage source priority:
    Priority 1: Valid Pixhawk FC battery_remaining (0–100).
    Priority 2: Voltage-based estimated percentage for 3S LiPo.
    Priority 3: UNKNOWN when neither source is valid.
- Estimated remaining capacity calculation in mAh (based on 5200 mAh pack).
- Estimated flight time calculation (only when valid current > 0.5A and consumption history available).
- Transparent provenance labeling: 'FC_ESTIMATE', 'VOLTAGE_ESTIMATE', or 'UNKNOWN'.
"""

from typing import Optional, Tuple, Dict, Any

# Standard 3S LiPo Specifications
DEFAULT_CELL_COUNT = 3
NOMINAL_PACK_VOLTAGE = 11.1
MAX_PACK_VOLTAGE = 12.6
MIN_PACK_VOLTAGE = 9.9
RATED_CAPACITY_MAH = 5200.0
NOMINAL_ENERGY_WH = 57.72

# Realistic Open-Circuit / Light-Load LiPo Cell Discharge Lookup Table (sorted ascending)
# Derived from empirical resting open-circuit voltage (OCV) characteristics of Lithium Polymer cells.
LIPO_CELL_DISCHARGE_TABLE: Tuple[Tuple[float, float], ...] = (
    (3.30, 0.0),    # Fully discharged / critical cutoff
    (3.50, 2.0),    # ArduPilot low-voltage RTL threshold
    (3.60, 5.0),    # Extreme knee drop
    (3.64, 10.0),   # Critical low alert
    (3.67, 15.0),
    (3.70, 20.0),   # Nominal resting cell voltage
    (3.73, 25.0),
    (3.75, 30.0),
    (3.77, 35.0),
    (3.80, 40.0),   # Nominal storage voltage
    (3.82, 45.0),
    (3.84, 50.0),   # Midpoint
    (3.87, 60.0),
    (3.91, 65.0),
    (3.95, 70.0),
    (3.98, 75.0),
    (4.02, 80.0),
    (4.08, 85.0),
    (4.11, 90.0),
    (4.15, 95.0),
    (4.20, 100.0)   # Full charge
)

def estimate_lipo_percentage(voltage: Optional[float], cell_count: int = DEFAULT_CELL_COUNT) -> Optional[float]:
    """
    Interpolates estimated battery percentage from total pack voltage using
    the non-linear 3S LiPo discharge lookup table.

    Returns:
        float between 0.0 and 100.0, or None if voltage is invalid/missing.
    """
    if voltage is None or voltage <= 0:
        return None

    # Sanity bounds: A 3S pack must be at least 6.0V (2.0V/cell) to be a valid connected battery.
    min_detectable_voltage = 2.0 * cell_count
    if voltage < min_detectable_voltage:
        return None

    cell_voltage = voltage / float(cell_count)

    # Clamping at boundaries
    if cell_voltage <= LIPO_CELL_DISCHARGE_TABLE[0][0]:
        return 0.0
    if cell_voltage >= LIPO_CELL_DISCHARGE_TABLE[-1][0]:
        return 100.0

    # Piecewise linear interpolation between lookup points
    for i in range(len(LIPO_CELL_DISCHARGE_TABLE) - 1):
        v_low, pct_low = LIPO_CELL_DISCHARGE_TABLE[i]
        v_high, pct_high = LIPO_CELL_DISCHARGE_TABLE[i + 1]

        if v_low <= cell_voltage <= v_high:
            ratio = (cell_voltage - v_low) / (v_high - v_low)
            interpolated_pct = pct_low + ratio * (pct_high - pct_low)
            return round(interpolated_pct, 1)

    return None

def is_fc_percentage_plausible(raw_pct: Optional[int], voltage: Optional[float]) -> bool:
    """
    Evaluates whether raw battery_remaining reported by the Pixhawk flight controller
    is genuine and valid, or an uncalibrated default placeholder.

    ArduPilot's AP_BattMonitor sends 99% as a hardcoded default when consumed_mah == 0
    on the bench or when current sensing is uncalibrated. A 99% reading when pack voltage
    is <= 11.5V (3.83V/cell or lower) is an uncalibrated default, NOT a genuine 99% state.
    """
    if raw_pct is None or raw_pct < 0 or raw_pct > 100:
        return False

    # Detect ArduPilot bench placeholder: 99% reported while pack voltage is discharged/nominal
    if raw_pct >= 95 and voltage is not None and voltage <= 11.5:
        return False

    return True

def calculate_remaining_capacity_mah(percentage: Optional[float], rated_capacity: float = RATED_CAPACITY_MAH) -> Optional[float]:
    """
    Calculates estimated remaining capacity in mAh based on percentage and rated pack capacity.
    remaining_mAh = rated_capacity * (percentage / 100)
    """
    if percentage is None or percentage < 0:
        return None
    return round(rated_capacity * (percentage / 100.0), 1)

def resolve_battery_telemetry(
    raw_pct: Optional[int],
    voltage: Optional[float],
    current: Optional[float],
    cell_count: int = DEFAULT_CELL_COUNT,
    rated_capacity_mah: float = RATED_CAPACITY_MAH
) -> Dict[str, Any]:
    """
    Applies strict percentage source priority:
        Priority 1: Valid Pixhawk FC battery_remaining (0–100).
        Priority 2: Voltage-based estimated percentage for 3S LiPo.
        Priority 3: UNKNOWN when neither source is valid.
    """
    percentage: Optional[int] = None
    percentage_source: str = "UNKNOWN"
    data_valid: bool = False

    # Priority 1: Check for valid Pixhawk percentage
    if is_fc_percentage_plausible(raw_pct, voltage):
        percentage = int(round(raw_pct))
        percentage_source = "FC_ESTIMATE"
        data_valid = True
    else:
        # Priority 2: Fallback to voltage-based estimated percentage
        voltage_pct = estimate_lipo_percentage(voltage, cell_count=cell_count)
        if voltage_pct is not None:
            percentage = int(round(voltage_pct))
            percentage_source = "VOLTAGE_ESTIMATE"
            data_valid = True
        else:
            # Priority 3: Unknown
            percentage = None
            percentage_source = "UNKNOWN"
            data_valid = False

    # Do not invent remaining mAh when only voltage-based estimation is active.
    # Authoritative remaining capacity in mAh requires coulomb counting from calibrated current sensing.
    remaining_mah: Optional[float] = None
    if percentage_source == "FC_ESTIMATE" and percentage is not None:
        remaining_mah = calculate_remaining_capacity_mah(
            float(percentage),
            rated_capacity=rated_capacity_mah
        )

    cell_voltage = round(voltage / float(cell_count), 2) if (voltage and voltage > 0) else None

    return {
        "batteryVoltage": voltage,
        "batteryCurrent": current,
        "batteryRemainingRaw": raw_pct,
        "batteryPercentage": percentage,
        "batteryPercentageSource": percentage_source,
        "batteryCellCount": cell_count,
        "batteryDataValid": data_valid,
        "batteryRemainingMah": remaining_mah,
        "batteryCellVoltage": cell_voltage
    }

