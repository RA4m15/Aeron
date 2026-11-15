import time
import logging
import threading
from dataclasses import dataclass, field
from typing import Optional, Dict, Any, Callable
from pymavlink import mavutil

from ..config import config
from ..logging_config import setup_logging
from .connection import MAVLinkConnection
from .parser import MAVLinkParser
from .discovery import resolve_esp32_address, DEFAULT_UDP_PORT

logger = setup_logging("DUAL-TRANSPORT")

@dataclass
class TransportStats:
    name: str
    endpoint: str
    assigned_ip: Optional[str] = None
    discovery_method: Optional[str] = None
    client_isolation_suspected: bool = False
    connected: bool = False
    heartbeat_alive: bool = False
    last_heartbeat_time: Optional[float] = None
    last_message_time: Optional[float] = None
    raw_bytes_received: int = 0
    message_count: int = 0
    heartbeat_count: int = 0
    crc_error_count: int = 0
    bad_data_count: int = 0
    reconnect_count: int = 0
    failover_count: int = 0
    error_count: int = 0
    last_error: Optional[str] = None

    def is_alive(self, now: Optional[float] = None, timeout: float = 3.0) -> bool:
        if not self.connected or self.last_heartbeat_time is None:
            return False
        current_time = now if now is not None else time.time()
        return (current_time - self.last_heartbeat_time) <= timeout

    def to_dict(self) -> Dict[str, Any]:
        now = time.time()
        hb_age_ms = int((now - self.last_heartbeat_time) * 1000) if self.last_heartbeat_time else None
        msg_age_ms = int((now - self.last_message_time) * 1000) if self.last_message_time else None
        return {
            "name": self.name,
            "endpoint": self.endpoint,
            "assignedIp": self.assigned_ip,
            "discoveryMethod": self.discovery_method,
            "clientIsolationSuspected": self.client_isolation_suspected,
            "connected": self.connected,
            "heartbeatAlive": self.is_alive(now=now),
            "lastHeartbeatAgeMs": hb_age_ms,
            "lastMessageAgeMs": msg_age_ms,
            "rawBytesReceived": self.raw_bytes_received,
            "messageCount": self.message_count,
            "heartbeatCount": self.heartbeat_count,
            "crcErrorCount": self.crc_error_count,
            "badDataCount": self.bad_data_count,
            "reconnectCount": self.reconnect_count,
            "lastError": self.last_error
        }

class SingleTransportChannel:
    """
    Dedicated worker thread managing a single MAVLink transport channel (Wi-Fi TCP or USB Serial).
    Handles non-blocking frame reception, auto-reconnect backoff, stream parsing, and statistics tracking.
    """

    def __init__(
        self,
        name: str,
        connection_string: str,
        baud: int = 115200,
        heartbeat_timeout: float = 3.0,
        on_packet_callback: Optional[Callable[[str, Any, Optional[Dict[str, Any]]], None]] = None,
        wifi_host: Optional[str] = None,
        wifi_port: int = 5760,
        wifi_fallback_ip: str = "192.168.4.1",
        wifi_udp_port: int = DEFAULT_UDP_PORT
    ):
        self.name = name.upper()
        self.connection_string = connection_string
        self.baud = baud
        self.heartbeat_timeout = heartbeat_timeout
        self.on_packet_callback = on_packet_callback
        self.wifi_host = wifi_host
        self.wifi_port = wifi_port
        self.wifi_fallback_ip = wifi_fallback_ip
        self.wifi_udp_port = wifi_udp_port

        self.stats = TransportStats(name=self.name, endpoint=connection_string)
        self.conn: Optional[MAVLinkConnection] = None
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._intervals_requested = False
        self._reconnect_backoff_sec = 2.0

    def start(self):
        """Starts the transport reception worker thread."""
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._worker_loop,
            name=f"Channel-{self.name}",
            daemon=True
        )
        self._thread.start()
        logger.info(f"[{self.name}] Transport worker thread started for {self.connection_string}")

    def stop(self):
        """Stops the transport worker thread and closes the connection."""
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.5)
        self._close_conn()
        self.stats.connected = False
        logger.info(f"[{self.name}] Transport worker stopped.")

    def _close_conn(self):
        if self.conn:
            try:
                self.conn.close()
            except Exception:
                pass
            self.conn = None
        self.stats.connected = False
        self.stats.heartbeat_alive = False
        self._intervals_requested = False

    def _try_connect(self) -> bool:
        """Attempts to open the connection cleanly without raising uncaught exceptions."""
        current_endpoint = self.connection_string

        # Dynamic ESP32 Wi-Fi Station Discovery on mobile hotspot
        if self.name == "WIFI" and self.wifi_host:
            try:
                resolved_ip, method, isolation_suspected, details = resolve_esp32_address(
                    host=self.wifi_host,
                    fallback_ip=self.wifi_fallback_ip,
                    udp_port=self.wifi_udp_port,
                    timeout=1.8
                )
                self.stats.assigned_ip = resolved_ip
                self.stats.discovery_method = method
                self.stats.client_isolation_suspected = isolation_suspected
                current_endpoint = f"tcp:{resolved_ip}:{self.wifi_port}"
                self.connection_string = current_endpoint
                self.stats.endpoint = current_endpoint
            except Exception as disc_err:
                logger.debug(f"[WIFI] Dynamic discovery error: {disc_err}")
                current_endpoint = f"tcp:{self.wifi_fallback_ip}:{self.wifi_port}"
                self.connection_string = current_endpoint
                self.stats.endpoint = current_endpoint

        try:
            self.conn = MAVLinkConnection(
                connection_string=current_endpoint,
                baud=self.baud,
                heartbeat_timeout=self.heartbeat_timeout
            )
            success = self.conn.connect()
            self.stats.connected = success
            if success:
                method_tag = f" (via {self.stats.discovery_method})" if self.stats.discovery_method else ""
                logger.info(f"[{self.name}] Successfully opened {current_endpoint}{method_tag}")
                self.stats.last_error = None
                return True
            else:
                extra_hint = " (Check phone hotspot AP / Client Isolation)" if self.stats.client_isolation_suspected else ""
                self.stats.last_error = f"Failed to open {current_endpoint}{extra_hint}"
                return False
        except Exception as err:
            self.stats.connected = False
            extra_hint = " (Check phone hotspot AP / Client Isolation)" if self.stats.client_isolation_suspected else ""
            self.stats.last_error = f"{err}{extra_hint}"
            self.stats.error_count += 1
            logger.debug(f"[{self.name}] Connection attempt exception: {err}")
            return False

    def _worker_loop(self):
        last_connect_attempt = 0.0

        while not self._stop_event.is_set():
            now = time.time()

            # Attempt connection / reconnection if not currently connected
            if not self.conn or not self.stats.connected:
                if (now - last_connect_attempt) >= self._reconnect_backoff_sec:
                    last_connect_attempt = now
                    if self._try_connect():
                        self.stats.reconnect_count += 1
                    else:
                        time.sleep(0.1)
                        continue
                else:
                    time.sleep(0.05)
                    continue

            # Check heartbeat expiration
            self.stats.heartbeat_alive = self.stats.is_alive(self.heartbeat_timeout)

            # Drain available MAVLink packets
            drained_any = False
            try:
                # Update raw socket/serial bytes received counter
                if self.conn and self.conn.mav and hasattr(self.conn.mav, "mav"):
                    self.stats.raw_bytes_received = getattr(self.conn.mav.mav, "total_bytes_received", 0)

                while not self._stop_event.is_set():
                    try:
                        msg = self.conn.receive_message()
                    except Exception as rx_err:
                        # Transport error (e.g. TCP socket closed or USB unplugged)
                        logger.warning(f"[{self.name}] Transport read error: {rx_err}")
                        self.stats.last_error = str(rx_err)
                        self.stats.error_count += 1
                        self._close_conn()
                        break

                    # Update raw byte counter after receive attempt
                    if self.conn and self.conn.mav and hasattr(self.conn.mav, "mav"):
                        self.stats.raw_bytes_received = getattr(self.conn.mav.mav, "total_bytes_received", 0)

                    if not msg:
                        break

                    drained_any = True
                    msg_time = time.time()
                    self.stats.last_message_time = msg_time
                    msg_type = msg.get_type()

                    # Diagnostic tracking for corrupted frames, framing noise, or CRC failures
                    if msg_type == "BAD_DATA":
                        self.stats.bad_data_count += 1
                        reason = str(getattr(msg, "reason", ""))
                        if "CRC" in reason or "checksum" in reason.lower():
                            self.stats.crc_error_count += 1
                        logger.debug(f"[{self.name}] Received BAD_DATA ({reason}): {getattr(msg, 'data', b'')[:20]}")
                        continue

                    # Increment valid MAVLink message count
                    self.stats.message_count += 1

                    parsed: Optional[Dict[str, Any]] = None

                    if msg_type == "HEARTBEAT":
                        self.conn.record_heartbeat(msg)
                        self.stats.last_heartbeat_time = msg_time
                        self.stats.heartbeat_count += 1
                        self.stats.heartbeat_alive = True
                        parsed = MAVLinkParser.parse_heartbeat(msg)

                        # Request telemetry stream rates on first valid heartbeat
                        if not self._intervals_requested:
                            self.conn.request_message_interval(30, 100000)   # ATTITUDE (10 Hz)
                            self.conn.request_message_interval(33, 250000)   # GLOBAL_POSITION_INT (4 Hz)
                            self.conn.request_message_interval(74, 250000)   # VFR_HUD (4 Hz)
                            self.conn.request_message_interval(24, 500000)   # GPS_RAW_INT (2 Hz)
                            self.conn.request_message_interval(1, 1000000)   # SYS_STATUS (1 Hz)
                            self._intervals_requested = True
                            logger.info(f"[{self.name}] Requested telemetry intervals from FC via {self.name}")

                    elif msg_type == "GLOBAL_POSITION_INT":
                        parsed = MAVLinkParser.parse_global_position_int(msg)
                    elif msg_type == "GPS_RAW_INT":
                        parsed = MAVLinkParser.parse_gps_raw_int(msg)
                    elif msg_type == "SYS_STATUS":
                        parsed = MAVLinkParser.parse_sys_status(msg)
                    elif msg_type == "BATTERY_STATUS":
                        parsed = MAVLinkParser.parse_battery_status(msg)
                    elif msg_type == "ATTITUDE":
                        parsed = MAVLinkParser.parse_attitude(msg)
                    elif msg_type == "VFR_HUD":
                        parsed = MAVLinkParser.parse_vfr_hud(msg)

                    # Dispatch to coordinator
                    if self.on_packet_callback:
                        self.on_packet_callback(self.name, msg, parsed)

                if not drained_any:
                    time.sleep(0.002)

            except Exception as fatal_loop_err:
                logger.error(f"[{self.name}] Unexpected channel loop error: {fatal_loop_err}")
                self._close_conn()
                time.sleep(0.1)


class DualTransportCoordinator:
    """
    Central coordinator orchestrating dual-transport MAVLink telemetry (Wi-Fi + USB).
    Guarantees:
      - Independent ingestion and health tracking for each transport path.
      - Single active source selected at any moment to prevent duplicate DB writes or socket broadcasts.
      - Transparent failover: automatically falls back to secondary when primary drops heartbeats.
      - Hysteresis recovery: requires primary to stabilize for N seconds before switching back.
      - Exposes transport metrics and active ingestion provenance.
    """

    def __init__(
        self,
        mode: str = "dual",
        primary_preference: str = "wifi",
        wifi_host: str = "auto",
        wifi_port: int = 5760,
        wifi_fallback_ip: str = "192.168.4.1",
        wifi_udp_port: int = DEFAULT_UDP_PORT,
        usb_port: str = "COM8",
        usb_baud: int = 115200,
        heartbeat_timeout: float = 3.0,
        hysteresis_duration_sec: float = 2.0,
        on_telemetry_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
        on_attitude_callback: Optional[Callable[[Dict[str, Any], Any], None]] = None
    ):
        self.mode = mode.lower()  # "usb", "wifi", or "dual"
        self.primary_preference = primary_preference.upper()  # "WIFI" or "USB"
        self.wifi_host = wifi_host
        self.wifi_port = wifi_port
        self.wifi_fallback_ip = wifi_fallback_ip
        self.wifi_udp_port = wifi_udp_port
        self.wifi_endpoint = f"tcp:{wifi_host}:{wifi_port}"
        self.usb_port = usb_port
        self.usb_baud = usb_baud
        self.heartbeat_timeout = heartbeat_timeout
        self.hysteresis_duration_sec = hysteresis_duration_sec

        self.on_telemetry_callback = on_telemetry_callback
        self.on_attitude_callback = on_attitude_callback

        # State tracking
        self.active_source: str = "NONE"
        self.last_failover_time: Optional[float] = None
        self.last_failover_reason: Optional[str] = None
        self.failover_count: int = 0
        self.primary_healthy_since: Optional[float] = None

        self._lock = threading.Lock()
        self.wifi_channel: Optional[SingleTransportChannel] = None
        self.usb_channel: Optional[SingleTransportChannel] = None

        self._init_channels()

    def _init_channels(self):
        """Initializes the requested transport channels."""
        if self.mode in ("wifi", "dual"):
            self.wifi_channel = SingleTransportChannel(
                name="WIFI",
                connection_string=self.wifi_endpoint,
                baud=115200,
                heartbeat_timeout=self.heartbeat_timeout,
                on_packet_callback=self._handle_channel_packet,
                wifi_host=self.wifi_host,
                wifi_port=self.wifi_port,
                wifi_fallback_ip=self.wifi_fallback_ip,
                wifi_udp_port=self.wifi_udp_port
            )

        if self.mode in ("usb", "dual"):
            self.usb_channel = SingleTransportChannel(
                name="USB",
                connection_string=self.usb_port,
                baud=self.usb_baud,
                heartbeat_timeout=self.heartbeat_timeout,
                on_packet_callback=self._handle_channel_packet
            )

    def start(self):
        """Starts the configured transport channels."""
        logger.info(
            f"[COORDINATOR] Starting Dual-Transport Coordinator (Mode: {self.mode.upper()}, "
            f"Primary Preference: {self.primary_preference})"
        )
        if self.wifi_channel:
            self.wifi_channel.start()
        if self.usb_channel:
            self.usb_channel.start()

    def stop(self):
        """Stops all transport channels cleanly."""
        logger.info("[COORDINATOR] Stopping all transport channels...")
        if self.wifi_channel:
            self.wifi_channel.stop()
        if self.usb_channel:
            self.usb_channel.stop()

    def _handle_channel_packet(self, channel_name: str, raw_msg: Any, parsed: Optional[Dict[str, Any]]):
        """
        Receives packet from an individual channel.
        Applies active-source filtering: ONLY packets from the authoritative active source
        are passed to the central application callbacks.
        """
        now = time.time()

        # Update active source selection under lock
        with self._lock:
            self._evaluate_active_source(now)
            is_active = (channel_name == self.active_source)

        if not is_active:
            # Drop from downstream ingestion to prevent duplicate DB writes & Socket broadcasts
            return

        # Deliver to central callbacks
        if parsed and self.on_telemetry_callback:
            try:
                self.on_telemetry_callback(parsed)
            except Exception as err:
                logger.debug(f"[COORDINATOR] Error in telemetry callback: {err}")

        if raw_msg.get_type() == "ATTITUDE" and parsed and self.on_attitude_callback:
            try:
                self.on_attitude_callback(parsed, raw_msg)
            except Exception as err:
                logger.debug(f"[COORDINATOR] Error in attitude callback: {err}")

    def _evaluate_active_source(self, now: float):
        """
        Authoritative source selection with hysteresis.
        Evaluates health of both channels and performs seamless failover / recovery.
        """
        wifi_alive = self.wifi_channel.stats.is_alive(now=now, timeout=self.heartbeat_timeout) if self.wifi_channel else False
        usb_alive = self.usb_channel.stats.is_alive(now=now, timeout=self.heartbeat_timeout) if self.usb_channel else False

        if self.mode == "usb":
            target = "USB" if usb_alive else ("USB" if self.usb_channel and self.usb_channel.stats.connected else "NONE")
        elif self.mode == "wifi":
            target = "WIFI" if wifi_alive else ("WIFI" if self.wifi_channel and self.wifi_channel.stats.connected else "NONE")
        else:
            # Dual mode
            primary_name = self.primary_preference  # "WIFI" or "USB"
            secondary_name = "USB" if primary_name == "WIFI" else "WIFI"

            primary_alive = wifi_alive if primary_name == "WIFI" else usb_alive
            secondary_alive = usb_alive if primary_name == "WIFI" else wifi_alive

            if primary_alive:
                # Track stabilization time of primary for hysteresis
                if self.primary_healthy_since is None:
                    self.primary_healthy_since = now

                time_stable = now - self.primary_healthy_since

                if self.active_source == secondary_name:
                    # Currently on secondary fallback: check hysteresis before failing back to primary
                    if time_stable >= self.hysteresis_duration_sec:
                        target = primary_name
                        self._record_failover(
                            from_source=secondary_name,
                            to_source=primary_name,
                            reason=f"Preferred {primary_name} stabilized for {time_stable:.1f}s"
                        )
                    else:
                        target = secondary_name  # Hold on secondary until hysteresis period passes
                else:
                    target = primary_name

            elif secondary_alive:
                # Primary is dead or timed out, but secondary is healthy -> Failover!
                self.primary_healthy_since = None
                if self.active_source != secondary_name:
                    target = secondary_name
                    self._record_failover(
                        from_source=self.active_source,
                        to_source=secondary_name,
                        reason=f"Preferred {primary_name} lost heartbeat (> {self.heartbeat_timeout}s)"
                    )
                else:
                    target = secondary_name

            else:
                # Neither transport has alive heartbeats
                self.primary_healthy_since = None
                target = "NONE"

        self.active_source = target

    def _record_failover(self, from_source: str, to_source: str, reason: str):
        self.failover_count += 1
        self.last_failover_time = time.time()
        self.last_failover_reason = reason
        logger.warning(
            f"[FAILOVER #{self.failover_count}] Active telemetry source changed: "
            f"{from_source} -> {to_source} | Reason: {reason}"
        )

    def get_transport_snapshot(self) -> Dict[str, Any]:
        """Returns structured transport metadata for telemetry snapshots & database persistence."""
        with self._lock:
            now = time.time()
            self._evaluate_active_source(now)

            wifi_dict = self.wifi_channel.stats.to_dict() if self.wifi_channel else None
            usb_dict = self.usb_channel.stats.to_dict() if self.usb_channel else None

            failover_age_sec = (now - self.last_failover_time) if self.last_failover_time else None

            return {
                "mode": self.mode,
                "activeSource": self.active_source,
                "primaryPreference": self.primary_preference,
                "failoverCount": self.failover_count,
                "lastFailoverEvent": {
                    "ageSeconds": round(failover_age_sec, 1) if failover_age_sec is not None else None,
                    "reason": self.last_failover_reason
                } if self.last_failover_time else None,
                "wifi": wifi_dict,
                "usb": usb_dict,
                "channels": {
                    "WIFI": wifi_dict,
                    "USB": usb_dict
                },
                "isAnyAlive": (
                    (wifi_dict.get("heartbeatAlive", False) if wifi_dict else False) or
                    (usb_dict.get("heartbeatAlive", False) if usb_dict else False)
                )
            }
