import unittest
from unittest.mock import patch, MagicMock
from src.mavlink.discovery import is_valid_ipv4, resolve_esp32_address
from src.mavlink.transport_manager import TransportStats, DualTransportCoordinator

class TestDiscoveryAndStationMode(unittest.TestCase):
    def test_is_valid_ipv4(self):
        self.assertTrue(is_valid_ipv4("192.168.4.1"))
        self.assertTrue(is_valid_ipv4("192.168.43.155"))
        self.assertTrue(is_valid_ipv4("10.0.0.1"))
        self.assertFalse(is_valid_ipv4("auto"))
        self.assertFalse(is_valid_ipv4("aeron-esp32.local"))
        self.assertFalse(is_valid_ipv4("256.0.0.1"))
        self.assertFalse(is_valid_ipv4("192.168.1"))

    def test_resolve_manual_ip(self):
        ip, method, isolation, msg = resolve_esp32_address(host="192.168.43.50")
        self.assertEqual(ip, "192.168.43.50")
        self.assertEqual(method, "MANUAL")
        self.assertFalse(isolation)

    @patch("socket.gethostbyname")
    def test_resolve_mdns_success(self, mock_gethostbyname):
        mock_gethostbyname.return_value = "192.168.43.88"
        ip, method, isolation, msg = resolve_esp32_address(host="auto")
        self.assertEqual(ip, "192.168.43.88")
        self.assertEqual(method, "MDNS")
        self.assertFalse(isolation)

    @patch("socket.gethostbyname", side_effect=Exception("mDNS not resolved"))
    @patch("src.mavlink.discovery.probe_udp_beacon")
    def test_resolve_udp_beacon_success(self, mock_beacon, mock_mdns):
        mock_beacon.return_value = {
            "device": "AERON-ESP32",
            "ip": "192.168.43.120",
            "port": 5760,
            "rssi": -55
        }
        ip, method, isolation, msg = resolve_esp32_address(host="auto")
        self.assertEqual(ip, "192.168.43.120")
        self.assertEqual(method, "UDP_BEACON")
        self.assertFalse(isolation)

    @patch("socket.gethostbyname", side_effect=Exception("mDNS failed"))
    @patch("src.mavlink.discovery.probe_udp_beacon", return_value=None)
    def test_resolve_fallback_and_isolation_suspected(self, mock_beacon, mock_mdns):
        ip, method, isolation, msg = resolve_esp32_address(host="auto", fallback_ip="192.168.4.1")
        self.assertEqual(ip, "192.168.4.1")
        self.assertEqual(method, "FALLBACK")
        self.assertTrue(isolation)
        self.assertIn("AP Isolation", msg)

    def test_transport_stats_station_metadata(self):
        stats = TransportStats(
            name="WIFI",
            endpoint="tcp:192.168.43.99:5760",
            assigned_ip="192.168.43.99",
            discovery_method="UDP_BEACON",
            client_isolation_suspected=False,
            connected=True
        )
        d = stats.to_dict()
        self.assertEqual(d["assignedIp"], "192.168.43.99")
        self.assertEqual(d["discoveryMethod"], "UDP_BEACON")
        self.assertFalse(d["clientIsolationSuspected"])

    def test_coordinator_station_mode_config(self):
        coord = DualTransportCoordinator(
            mode="dual",
            primary_preference="wifi",
            wifi_host="auto",
            wifi_port=5760,
            wifi_fallback_ip="192.168.4.1",
            wifi_udp_port=37020,
            usb_port="COM8",
            usb_baud=115200
        )
        self.assertEqual(coord.wifi_host, "auto")
        self.assertEqual(coord.wifi_port, 5760)
        self.assertEqual(coord.wifi_fallback_ip, "192.168.4.1")
        self.assertEqual(coord.wifi_udp_port, 37020)
        self.assertIsNotNone(coord.wifi_channel)
        self.assertIsNotNone(coord.usb_channel)

if __name__ == "__main__":
    unittest.main()

