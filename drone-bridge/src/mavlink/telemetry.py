from datetime import datetime, timezone
from typing import Dict, Any, Optional
from ..config import config
from .health import SubsystemHealthTracker
from .battery import resolve_battery_telemetry, DEFAULT_CELL_COUNT

class TelemetryAggregator:
    """
    Maintains an authoritative normalized vehicle state by aggregating incoming
    MAVLink messages and transforming them to the backend TelemetryRecord schema.
    """

    def __init__(
        self,
        drone_id: Optional[str] = None,
        source: Optional[str] = None,
        health_tracker: Optional[SubsystemHealthTracker] = None
    ):
        self.drone_id = drone_id or config.drone_id
        self.source = (source or config.mavlink_source).upper()
        self.is_simulated = self.source != "REAL"
        self.health = health_tracker or SubsystemHealthTracker()

        # Telemetry state
        self.armed: bool = False
        self.flight_mode: str = "STANDBY"
        self.latitude: Optional[float] = None
        self.longitude: Optional[float] = None
        self.altitude: Optional[float] = None
        self.relative_altitude: Optional[float] = None
        self.ground_speed: Optional[float] = None
        self.heading: Optional[float] = None
        self.climb_rate: Optional[float] = None
        self.roll: Optional[float] = None
        self.pitch: Optional[float] = None
        self.yaw: Optional[float] = None
        self.gps_fix_type: str = "NO_FIX"
        self.satellites: Optional[int] = None
        self.hdop: Optional[float] = None
        self.battery_voltage: Optional[float] = None
        self.battery_current: Optional[float] = None
        self.battery_remaining_raw: Optional[int] = None
        self.battery_percentage: Optional[int] = None
        self.battery_percentage_source: str = "UNKNOWN"
        self.battery_cell_count: int = DEFAULT_CELL_COUNT
        self.battery_cell_voltage: Optional[float] = None
        self.battery_data_valid: bool = False
        self.battery_remaining_mah: Optional[float] = None
        self.sensor_health: Dict[str, Any] = {}
        self.last_update_iso: Optional[str] = None
        self.attitude_updated_at: Optional[str] = None
        self.position_updated_at: Optional[str] = None
        self.gps_timestamp: Optional[str] = None

    def update_from_message(self, parsed: Dict[str, Any]):
        """Integrates a parsed MAVLink message into the vehicle state."""
        msg_type = parsed.get("type")
        self.health.record_telemetry_packet()

        if msg_type == "HEARTBEAT":
            self.armed = parsed["armed"]
            self.flightMode = parsed.get("flightMode", "STANDBY")
            self.flight_mode = parsed.get("flightMode", "STANDBY")
            self.health.record_heartbeat()

        elif msg_type == "GLOBAL_POSITION_INT":
            if parsed.get("latitude") is not None:
                self.latitude = parsed["latitude"]
                self.longitude = parsed["longitude"]
            if parsed.get("altitude") is not None:
                self.altitude = parsed["altitude"]
            if parsed.get("relativeAltitude") is not None:
                self.relative_altitude = parsed["relativeAltitude"]
            if parsed.get("groundSpeed") is not None:
                self.ground_speed = parsed["groundSpeed"]
            # Fallback only when ATTITUDE hasn't provided yaw
            if self.yaw is None and parsed.get("heading") is not None:
                self.heading = parsed["heading"]
            if parsed.get("climbRate") is not None:
                self.climb_rate = parsed["climbRate"]
            self.position_updated_at = datetime.now(timezone.utc).isoformat()

        elif msg_type == "VFR_HUD":
            if parsed.get("climbRate") is not None:
                self.climb_rate = parsed["climbRate"]
            if self.yaw is None and self.heading is None and parsed.get("heading") is not None:
                self.heading = float(parsed["heading"])
            if self.ground_speed is None and parsed.get("groundSpeed") is not None:
                self.ground_speed = parsed["groundSpeed"]

        elif msg_type == "GPS_RAW_INT":
            self.gps_fix_type = parsed.get("gpsFixType", "NO_FIX")
            self.satellites = parsed.get("satellites")
            self.hdop = parsed.get("hdop")
            self.gps_timestamp = datetime.now(timezone.utc).isoformat()
            self.health.record_gps_state(self.gps_fix_type, self.satellites or 0, self.hdop)
            # If GLOBAL_POSITION_INT hasn't populated coordinates yet, use raw if valid
            if self.latitude is None and parsed.get("latitude") is not None:
                self.latitude = parsed["latitude"]
                self.longitude = parsed["longitude"]
            # Strictly do NOT substitute GPS Course Over Ground as aircraft heading

        elif msg_type in ("SYS_STATUS", "BATTERY_STATUS"):
            if parsed.get("batteryVoltage") is not None:
                self.battery_voltage = parsed["batteryVoltage"]
            if parsed.get("batteryCurrent") is not None:
                self.battery_current = parsed["batteryCurrent"]
            if "batteryRemainingRaw" in parsed and parsed.get("batteryRemainingRaw") is not None:
                self.battery_remaining_raw = parsed["batteryRemainingRaw"]
            elif parsed.get("batteryPercentage") is not None:
                self.battery_remaining_raw = parsed["batteryPercentage"]
            if parsed.get("sensorHealth"):
                self.sensor_health = parsed["sensorHealth"]

            # Resolve authoritative percentage applying strict priority:
            # 1. Valid Pixhawk FC percentage (0-100)
            # 2. Voltage-based estimated percentage for 3S LiPo
            # 3. UNKNOWN when neither source is valid
            batt_state = resolve_battery_telemetry(
                raw_pct=self.battery_remaining_raw,
                voltage=self.battery_voltage,
                current=self.battery_current,
                cell_count=self.battery_cell_count
            )
            self.battery_percentage = batt_state["batteryPercentage"]
            self.battery_percentage_source = batt_state["batteryPercentageSource"]
            self.battery_data_valid = batt_state["batteryDataValid"]
            self.battery_remaining_mah = batt_state["batteryRemainingMah"]
            self.battery_cell_voltage = batt_state["batteryCellVoltage"]

        elif msg_type == "ATTITUDE":
            if parsed.get("roll") is not None:
                self.roll = parsed["roll"]
            if parsed.get("pitch") is not None:
                self.pitch = parsed["pitch"]
            if parsed.get("yaw") is not None:
                self.yaw = parsed["yaw"]
                # Authoritative primary orientation source for real-time aircraft rotation
                self.heading = parsed["yaw"]
            self.attitude_updated_at = datetime.now(timezone.utc).isoformat()

        self.last_update_iso = datetime.now(timezone.utc).isoformat()

    def snapshot(self, transport: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Constructs a normalized telemetry record ready for backend HTTP ingestion."""
        now_iso = datetime.now(timezone.utc).isoformat()
        heartbeat_status = self.health.pixhawk_heartbeat_status

        if transport and transport.get("isAnyAlive") is not None:
            connection_status = "CONNECTED" if transport.get("isAnyAlive") else "STANDBY"
        else:
            connection_status = "CONNECTED" if heartbeat_status == "HEALTHY" else "STANDBY"

        record: Dict[str, Any] = {
            "droneId": self.drone_id,
            "recordedAt": now_iso,
            "source": self.source,
            "isSimulated": self.is_simulated,
            "latitude": self.latitude,
            "longitude": self.longitude,
            "altitude": self.altitude,
            "relativeAltitude": self.relative_altitude,
            "groundSpeed": self.ground_speed,
            "heading": self.heading,
            "roll": self.roll,
            "pitch": self.pitch,
            "yaw": self.yaw,
            "climbRate": self.climb_rate,
            "gpsFixType": self.gps_fix_type,
            "satellites": self.satellites,
            "hdop": self.hdop,
            "batteryVoltage": self.battery_voltage,
            "batteryCurrent": self.battery_current,
            "batteryRemainingRaw": self.battery_remaining_raw,
            "batteryPercentage": self.battery_percentage,
            "batteryPercentageSource": self.battery_percentage_source,
            "batteryCellCount": self.battery_cell_count,
            "batteryCellVoltage": self.battery_cell_voltage,
            "batteryDataValid": self.battery_data_valid,
            "batteryRemainingMah": self.battery_remaining_mah,
            "flightMode": self.flight_mode,
            "armed": self.armed,
            "sensorHealth": self.sensor_health,
            "connectionStatus": connection_status,
            "attitudeUpdatedAt": self.attitude_updated_at,
            "positionUpdatedAt": self.position_updated_at,
            "gpsTimestamp": self.gps_timestamp
        }

        if transport is not None:
            record["transport"] = transport

        return record

