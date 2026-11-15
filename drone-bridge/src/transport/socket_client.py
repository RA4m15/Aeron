import time
import threading
from typing import Optional, Dict, Any
import socketio
from ..config import config
from ..logging_config import setup_logging

logger = setup_logging("BRIDGE-SOCKET")

class BridgeSocketClient:
    """
    Dedicated high-frequency Socket.IO client for the AERON Drone Bridge.
    Delivers real-time attitude updates directly to the backend over a persistent
    WebSocket connection without database persistence latency.
    """

    def __init__(
        self,
        server_url: Optional[str] = None,
        bridge_token: Optional[str] = None,
        drone_id: Optional[str] = None
    ):
        raw_url = server_url or config.aeron_backend_url
        # Strip /api/v1 to get server root for Socket.IO
        self.server_url = raw_url.replace("/api/v1", "").rstrip("/")
        self.bridge_token = bridge_token or config.drone_bridge_token
        self.drone_id = drone_id or config.drone_id

        self.sio = socketio.Client(
            reconnection=True,
            reconnection_attempts=0, # Infinite retries
            reconnection_delay=1,
            reconnection_delay_max=5,
            request_timeout=3
        )

        self.is_connected = False
        self.total_attitudes_sent = 0
        self.total_telemetries_sent = 0
        self.last_sent_time = 0.0
        self.sequence_number = 0
        self._lock = threading.Lock()
        self._last_warn_time = 0.0

        self._register_handlers()

    def _register_handlers(self):
        @self.sio.event
        def connect():
            self.is_connected = True
            logger.info(f"[Socket.IO] Connected to backend at {self.server_url}")

        @self.sio.event
        def connect_error(data):
            self.is_connected = False
            now = time.time()
            if now - self._last_warn_time > 5.0:
                logger.warning(f"[Socket.IO] Connection error to {self.server_url}: {data}")
                self._last_warn_time = now

        @self.sio.event
        def disconnect():
            self.is_connected = False
            logger.info("[Socket.IO] Disconnected from backend")

    def connect(self):
        """Connects asynchronously to the backend Socket.IO server."""
        try:
            auth_payload = {
                "token": self.bridge_token,
                "bridgeToken": self.bridge_token
            }
            headers = {
                "x-drone-bridge-token": self.bridge_token
            }
            self.sio.connect(
                self.server_url,
                auth=auth_payload,
                headers=headers,
                transports=["websocket", "polling"],
                wait=False
            )
        except Exception as err:
            logger.warning(f"[Socket.IO] Failed to initiate connection: {err}")

    def emit_attitude(
        self,
        drone_id: str,
        roll: float,
        pitch: float,
        yaw: float,
        climb_rate: float = 0.0,
        boot_ms: int = 0
    ) -> bool:
        """
        Immediately transmits a high-frequency attitude sample to the backend.
        Runs completely non-blocking; does not block the MAVLink reader loop.
        """
        if not self.is_connected:
            return False

        with self._lock:
            self.sequence_number += 1
            seq = self.sequence_number

        now = time.time()
        payload = {
            "droneId": drone_id,
            "roll": roll,
            "pitch": pitch,
            "yaw": yaw,
            "climbRate": climb_rate,
            "sourceTimestamp": int(now * 1000),
            "bootMs": boot_ms,
            "sequence": seq
        }

        try:
            self.sio.emit("bridge:attitude", payload)
            self.total_attitudes_sent += 1
            self.last_sent_time = now
            return True
        except Exception as err:
            now = time.time()
            if now - self._last_warn_time > 5.0:
                logger.warning(f"[Socket.IO] Failed to emit attitude: {err}")
                self._last_warn_time = now
            return False

    def emit_telemetry(self, snapshot: Dict[str, Any]) -> bool:
        """Transmits a live telemetry snapshot over Socket.IO."""
        if not self.is_connected:
            return False

        try:
            self.sio.emit("bridge:telemetry", snapshot)
            self.total_telemetries_sent += 1
            return True
        except Exception:
            return False

    def disconnect(self):
        """Disconnects cleanly from the server."""
        try:
            if self.sio.connected:
                self.sio.disconnect()
        except Exception:
            pass
        self.is_connected = False

