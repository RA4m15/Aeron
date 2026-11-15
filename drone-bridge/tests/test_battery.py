import unittest
from src.mavlink.battery import (
    estimate_lipo_percentage,
    resolve_battery_telemetry,
    calculate_remaining_capacity_mah,
    is_fc_percentage_plausible,
    LIPO_CELL_DISCHARGE_TABLE,
    RATED_CAPACITY_MAH
)

class TestBatteryEstimation(unittest.TestCase):
    def test_lipo_lookup_boundary_values(self):
        # Upper boundary: 4.20V / cell = 12.6V for 3S
        self.assertEqual(estimate_lipo_percentage(12.6, 3), 100.0)
        self.assertEqual(estimate_lipo_percentage(12.8, 3), 100.0)

        # Lower boundary: 3.30V / cell = 9.9V for 3S
        self.assertEqual(estimate_lipo_percentage(9.9, 3), 0.0)
        self.assertEqual(estimate_lipo_percentage(9.5, 3), 0.0)

    def test_lipo_lookup_interpolation(self):
        # 3.84V per cell = 11.52V for 3S should be 50.0%
        pct_50 = estimate_lipo_percentage(11.52, 3)
        self.assertIsNotNone(pct_50)
        self.assertAlmostEqual(pct_50, 50.0, places=1)

        # 3.70V per cell = 11.10V for 3S should be 20.0%
        pct_20 = estimate_lipo_percentage(11.10, 3)
        self.assertIsNotNone(pct_20)
        self.assertAlmostEqual(pct_20, 20.0, places=1)

        # 3.80V per cell = 11.40V for 3S should be 40.0%
        pct_40 = estimate_lipo_percentage(11.40, 3)
        self.assertIsNotNone(pct_40)
        self.assertAlmostEqual(pct_40, 40.0, places=1)

        # Bench test voltage: 10.46V (3.487V per cell, between 3.30V [0%] and 3.50V [2%])
        pct_bench = estimate_lipo_percentage(10.46, 3)
        self.assertIsNotNone(pct_bench)
        self.assertTrue(1.0 <= pct_bench <= 2.0)

    def test_invalid_voltages(self):
        self.assertIsNone(estimate_lipo_percentage(None))
        self.assertIsNone(estimate_lipo_percentage(0.0))
        self.assertIsNone(estimate_lipo_percentage(-12.0))
        self.assertIsNone(estimate_lipo_percentage(4.5)) # Unplugged / too low for 3S

    def test_fc_plausibility_detects_ardupilot_99_default(self):
        # ArduPilot sends 99% placeholder when on bench with discharged pack
        self.assertFalse(is_fc_percentage_plausible(99, 10.46))
        self.assertFalse(is_fc_percentage_plausible(99, 10.8))
        self.assertFalse(is_fc_percentage_plausible(95, 11.1))

        # Real full pack (12.5V) with 99% is plausible
        self.assertTrue(is_fc_percentage_plausible(99, 12.55))

        # Legitimate intermediate percentage is plausible
        self.assertTrue(is_fc_percentage_plausible(45, 11.4))
        self.assertTrue(is_fc_percentage_plausible(15, 10.9))

        # Out-of-bounds or negative is not plausible
        self.assertFalse(is_fc_percentage_plausible(-1, 11.5))
        self.assertFalse(is_fc_percentage_plausible(105, 12.6))
        self.assertFalse(is_fc_percentage_plausible(None, 12.0))

    def test_source_priority_fc_first(self):
        # Priority 1: Genuine FC percentage takes precedence
        state = resolve_battery_telemetry(raw_pct=65, voltage=11.75, current=2.1)
        self.assertEqual(state["batteryPercentage"], 65)
        self.assertEqual(state["batteryPercentageSource"], "FC_ESTIMATE")
        self.assertEqual(state["batteryRemainingRaw"], 65)
        self.assertTrue(state["batteryDataValid"])

    def test_source_priority_voltage_fallback(self):
        # Priority 2: ArduPilot 99% placeholder on 10.46V pack falls back to voltage estimate
        state = resolve_battery_telemetry(raw_pct=99, voltage=10.46, current=0.0)
        self.assertEqual(state["batteryPercentageSource"], "VOLTAGE_ESTIMATE")
        self.assertNotEqual(state["batteryPercentage"], 99)
        self.assertTrue(1 <= state["batteryPercentage"] <= 3)
        self.assertEqual(state["batteryRemainingRaw"], 99) # Raw preserved
        self.assertTrue(state["batteryDataValid"])

        # Priority 2: Pixhawk reporting -1 (unsupported monitor) falls back to voltage
        state_neg1 = resolve_battery_telemetry(raw_pct=-1, voltage=11.10, current=None)
        self.assertEqual(state_neg1["batteryPercentageSource"], "VOLTAGE_ESTIMATE")
        self.assertEqual(state_neg1["batteryPercentage"], 20)
        self.assertTrue(state_neg1["batteryDataValid"])

    def test_source_priority_unknown(self):
        # Priority 3: Neither valid FC percentage nor valid voltage
        state_none = resolve_battery_telemetry(raw_pct=None, voltage=None, current=None)
        self.assertIsNone(state_none["batteryPercentage"])
        self.assertEqual(state_none["batteryPercentageSource"], "UNKNOWN")
        self.assertFalse(state_none["batteryDataValid"])

        # Voltage zero and raw_pct -1
        state_zero = resolve_battery_telemetry(raw_pct=-1, voltage=0.0, current=None)
        self.assertIsNone(state_zero["batteryPercentage"])
        self.assertEqual(state_zero["batteryPercentageSource"], "UNKNOWN")
        self.assertFalse(state_zero["batteryDataValid"])

    def test_remaining_capacity_calculation(self):
        # 5200 mAh pack capacity
        self.assertEqual(calculate_remaining_capacity_mah(100.0, 5200), 5200.0)
        self.assertEqual(calculate_remaining_capacity_mah(50.0, 5200), 2600.0)
        self.assertEqual(calculate_remaining_capacity_mah(20.0, 5200), 1040.0)
        self.assertAlmostEqual(calculate_remaining_capacity_mah(1.9, 5200), 98.8, places=1)
        self.assertIsNone(calculate_remaining_capacity_mah(None))

if __name__ == "__main__":
    unittest.main()

