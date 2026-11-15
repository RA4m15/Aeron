import time
import unittest
from unittest.mock import MagicMock

from src.mavlink.transport_manager import (
    TransportStats,
    DualTransportCoordinator
)

class TestTransportManager(unittest.TestCase):
    def test_transport_stats_is_alive(self):
        stats = TransportStats(name="WIFI", endpoint="tcp:192.168.4.1:5760")
        self.assertFalse(stats.is_alive())

        stats.connected = True
        self.assertFalse(stats.is_alive())

        stats.last_heartbeat_time = time.time()
        self.assertTrue(stats.is_alive(timeout=3.0))

        stats.last_heartbeat_time = time.time() - 4.0
        self.assertFalse(stats.is_alive(timeout=3.0))

    def test_coordinator_usb_only_mode(self):
        coord = DualTransportCoordinator(
            mode="usb",
            usb_port="COM8",
            usb_baud=115200
        )
        self.assertIsNone(coord.wifi_channel)
        self.assertIsNotNone(coord.usb_channel)

        # Mock USB state
        coord.usb_channel.stats.connected = True
        coord.usb_channel.stats.last_heartbeat_time = time.time()
        coord._evaluate_active_source(time.time())

        self.assertEqual(coord.active_source, "USB")
        snap = coord.get_transport_snapshot()
        self.assertEqual(snap["mode"], "usb")
        self.assertEqual(snap["activeSource"], "USB")
        self.assertTrue(snap["isAnyAlive"])

    def test_coordinator_wifi_only_mode(self):
        coord = DualTransportCoordinator(
            mode="wifi",
            wifi_host="192.168.4.1",
            wifi_port=5760
        )
        self.assertIsNotNone(coord.wifi_channel)
        self.assertIsNone(coord.usb_channel)

        coord.wifi_channel.stats.connected = True
        coord.wifi_channel.stats.last_heartbeat_time = time.time()
        coord._evaluate_active_source(time.time())

        self.assertEqual(coord.active_source, "WIFI")
        snap = coord.get_transport_snapshot()
        self.assertEqual(snap["mode"], "wifi")
        self.assertEqual(snap["activeSource"], "WIFI")

    def test_coordinator_dual_failover_and_hysteresis(self):
        telemetry_cb = MagicMock()
        attitude_cb = MagicMock()

        coord = DualTransportCoordinator(
            mode="dual",
            primary_preference="wifi",
            heartbeat_timeout=2.0,
            hysteresis_duration_sec=1.0,
            on_telemetry_callback=telemetry_cb,
            on_attitude_callback=attitude_cb
        )

        now = 1000.0

        # Both channels connected with valid heartbeats
        coord.wifi_channel.stats.connected = True
        coord.wifi_channel.stats.last_heartbeat_time = now

        coord.usb_channel.stats.connected = True
        coord.usb_channel.stats.last_heartbeat_time = now

        coord._evaluate_active_source(now)
        self.assertEqual(coord.active_source, "WIFI")
        self.assertEqual(coord.failover_count, 0)

        # 1. Wi-Fi drops heartbeats (age 3.0s > timeout 2.0s), USB remains alive
        now = 1003.0
        coord.usb_channel.stats.last_heartbeat_time = now  # USB alive

        coord._evaluate_active_source(now)
        self.assertEqual(coord.active_source, "USB")
        self.assertEqual(coord.failover_count, 1)
        self.assertIn("lost heartbeat", coord.last_failover_reason)

        # 2. Wi-Fi reconnects and sends first heartbeat at now=1004.0
        now = 1004.0
        coord.wifi_channel.stats.last_heartbeat_time = now
        coord.usb_channel.stats.last_heartbeat_time = now

        # Immediately evaluating should HOLD on USB due to hysteresis (duration = 1.0s)
        coord._evaluate_active_source(now + 0.2)
        self.assertEqual(coord.active_source, "USB", "Must hold on USB during hysteresis window")

        # 3. After hysteresis duration passes (now + 1.2s), Wi-Fi should become active again
        coord._evaluate_active_source(now + 1.2)
        self.assertEqual(coord.active_source, "WIFI", "Must restore to Wi-Fi after stabilization")
        self.assertEqual(coord.failover_count, 2)

    def test_coordinator_packet_filtering_deduplication(self):
        telemetry_cb = MagicMock()
        coord = DualTransportCoordinator(
            mode="dual",
            primary_preference="wifi",
            on_telemetry_callback=telemetry_cb
        )

        now = time.time()
        coord.wifi_channel.stats.connected = True
        coord.wifi_channel.stats.last_heartbeat_time = now
        coord.usb_channel.stats.connected = True
        coord.usb_channel.stats.last_heartbeat_time = now
        coord._evaluate_active_source(now)

        self.assertEqual(coord.active_source, "WIFI")

        # Mock MAVLink message
        mock_msg = MagicMock()
        mock_msg.get_type.return_value = "GLOBAL_POSITION_INT"

        # Packet arriving from STANDBY (USB) -> Should be dropped
        coord._handle_channel_packet("USB", mock_msg, {"lat": 23.18, "lon": 77.30})
        self.assertEqual(telemetry_cb.call_count, 0)

        # Packet arriving from ACTIVE (WIFI) -> Should be delivered
        coord._handle_channel_packet("WIFI", mock_msg, {"lat": 23.18, "lon": 77.30})
        self.assertEqual(telemetry_cb.call_count, 1)

if __name__ == "__main__":
    unittest.main()

