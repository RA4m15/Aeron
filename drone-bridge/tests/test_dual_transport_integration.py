import time
import socket
import threading
import unittest
from unittest.mock import MagicMock
from pymavlink.dialects.v20 import common as mavlink2

from src.mavlink.transport_manager import DualTransportCoordinator, TransportStats

class TestDualTransportEndToEnd(unittest.TestCase):
    def setUp(self):
        self.tcp_port = 5988
        self.stop_server = threading.Event()
        self.server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server_sock.bind(("127.0.0.1", self.tcp_port))
        self.server_sock.listen(1)

        self.mav = mavlink2.MAVLink(None)

    def tearDown(self):
        self.stop_server.set()
        try:
            self.server_sock.close()
        except Exception:
            pass

    def _pack_heartbeat(self):
        hb = self.mav.heartbeat_encode(
            type=mavlink2.MAV_TYPE_QUADROTOR,
            autopilot=mavlink2.MAV_AUTOPILOT_ARDUPILOTMEGA,
            base_mode=mavlink2.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,
            custom_mode=0,
            system_status=mavlink2.MAV_STATE_ACTIVE,
            mavlink_version=2
        )
        return hb.pack(self.mav)

    def test_dual_coordinator_receives_tcp_stream(self):
        received_packets = []

        def on_telemetry(parsed):
            received_packets.append(parsed)

        coordinator = DualTransportCoordinator(
            mode="wifi",
            primary_preference="wifi",
            wifi_host="127.0.0.1",
            wifi_port=self.tcp_port,
            on_telemetry_callback=on_telemetry
        )

        def mock_esp32_ap_server():
            try:
                conn, _ = self.server_sock.accept()
                conn.settimeout(1.0)
                hb_bytes = self._pack_heartbeat()
                for _ in range(3):
                    conn.sendall(hb_bytes)
                    time.sleep(0.05)
                time.sleep(0.2)
                conn.close()
            except Exception:
                pass

        server_thread = threading.Thread(target=mock_esp32_ap_server, daemon=True)
        server_thread.start()

        coordinator.start()
        # Wait for connection and packet reception
        time.sleep(0.4)

        self.assertTrue(coordinator.wifi_channel.stats.connected)
        self.assertGreater(coordinator.wifi_channel.stats.message_count, 0)
        self.assertGreater(len(received_packets), 0)
        self.assertEqual(coordinator.active_source, "WIFI")

        snap = coordinator.get_transport_snapshot()
        self.assertEqual(snap["activeSource"], "WIFI")
        self.assertTrue(snap["wifi"]["connected"])
        self.assertGreater(snap["wifi"]["messageCount"], 0)

        coordinator.stop()

if __name__ == "__main__":
    unittest.main()
