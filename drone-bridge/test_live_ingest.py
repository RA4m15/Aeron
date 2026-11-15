import time
from datetime import datetime, timezone
import requests
from pymavlink import mavutil
from src.config import config
from src.mavlink.parser import MAVLinkParser
from src.mavlink.telemetry import TelemetryAggregator
from src.mavlink.health import SubsystemHealthTracker

print("=== LIVE PIXHAWK 2.4.8 + ESP32 TELEMETRY INGESTION TEST ===")
print(f"Connecting to {config.mavlink_connection} @ {config.mavlink_baud} baud...")
print(f"Target Drone ID: {config.drone_id}")

mav = mavutil.mavlink_connection(config.mavlink_connection, baud=config.mavlink_baud)
health = SubsystemHealthTracker()
health.record_port_state(True)
aggregator = TelemetryAggregator(drone_id=config.drone_id, source="REAL", health_tracker=health)

start = time.time()
received_types = set()

# Request streams
mav.mav.command_long_send(1, 0, 511, 0, 24, 500000, 0, 0, 0, 0, 0)
mav.mav.command_long_send(1, 0, 511, 0, 33, 500000, 0, 0, 0, 0, 0)
mav.mav.command_long_send(1, 0, 511, 0, 30, 250000, 0, 0, 0, 0, 0)
mav.mav.command_long_send(1, 0, 511, 0, 1, 1000000, 0, 0, 0, 0, 0)

try:
    while time.time() - start < 5.0:
        msg = mav.recv_match(blocking=True, timeout=0.5)
        if msg:
            mtype = msg.get_type()
            received_types.add(mtype)
            parsed = None

            if mtype == "HEARTBEAT":
                parsed = MAVLinkParser.parse_heartbeat(msg)
            elif mtype == "GLOBAL_POSITION_INT":
                parsed = MAVLinkParser.parse_global_position_int(msg)
            elif mtype == "GPS_RAW_INT":
                parsed = MAVLinkParser.parse_gps_raw_int(msg)
            elif mtype == "SYS_STATUS":
                parsed = MAVLinkParser.parse_sys_status(msg)
            elif mtype == "BATTERY_STATUS":
                parsed = MAVLinkParser.parse_battery_status(msg)
            elif mtype == "ATTITUDE":
                parsed = MAVLinkParser.parse_attitude(msg)
            elif mtype == "VFR_HUD":
                parsed = MAVLinkParser.parse_vfr_hud(msg)

            if parsed:
                aggregator.update_from_message(parsed)
finally:
    mav.close()

print(f"\nReceived message types: {received_types}")

snapshot = aggregator.snapshot()
print("\nGenerated Normalized Telemetry Snapshot:")
for k, v in snapshot.items():
    print(f"  {k}: {v}")

print(f"\nTransmitting to Backend: {config.backend_ingest_url}")
headers = {
    "Content-Type": "application/json",
    "x-drone-bridge-token": config.drone_bridge_token
}

try:
    response = requests.post(config.backend_ingest_url, json=snapshot, headers=headers, timeout=10)
    print(f"HTTP Status: {response.status_code}")
    print(f"Response: {response.text}")
except Exception as err:
    print(f"Ingest POST error: {err}")
