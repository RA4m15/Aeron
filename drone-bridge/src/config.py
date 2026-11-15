import os
from dataclasses import dataclass

# Attempt to load dotenv if available, otherwise read standard environment
try:
    from dotenv import load_dotenv
    load_dotenv()
    local_env = os.path.join(os.path.dirname(__file__), "..", ".env")
    if os.path.exists(local_env):
        load_dotenv(local_env, override=True)
except ImportError:
    pass

@dataclass(frozen=True)
class BridgeConfig:
    # Dual-Transport MAVLink Architecture
    telemetry_transport: str = os.getenv("AERON_TELEMETRY_TRANSPORT", "dual").lower()
    primary_transport: str = os.getenv("AERON_PRIMARY_TRANSPORT", "wifi").lower()
    wifi_host: str = os.getenv("AERON_WIFI_HOST", "auto")
    wifi_port: int = int(os.getenv("AERON_WIFI_PORT", "5760"))
    wifi_fallback_ip: str = os.getenv("AERON_WIFI_FALLBACK_IP", "192.168.4.1")
    wifi_udp_port: int = int(os.getenv("AERON_WIFI_UDP_PORT", "37020"))
    usb_port: str = os.getenv("AERON_USB_PORT", os.getenv("MAVLINK_CONNECTION", "COM8"))
    usb_baud: int = int(os.getenv("AERON_USB_BAUD", os.getenv("MAVLINK_BAUD", "115200")))

    # Legacy / General Connection Fallbacks
    mavlink_connection: str = os.getenv("MAVLINK_CONNECTION", "COM8")
    mavlink_baud: int = int(os.getenv("MAVLINK_BAUD", "115200"))
    mavlink_source: str = os.getenv("MAVLINK_SOURCE", "REAL").upper()

    # Airframe Identification
    drone_id: str = os.getenv("DRONE_ID", "AERON-PX4-BENCH01")

    # Backend Transport Configuration
    aeron_backend_url: str = os.getenv("AERON_BACKEND_URL", "http://localhost:5000/api/v1")
    backend_ingest_url: str = os.getenv(
        "BACKEND_INGEST_URL",
        os.getenv("AERON_BACKEND_URL", "http://localhost:5000/api/v1").rstrip("/") + "/telemetry/ingest"
    )
    drone_bridge_token: str = os.getenv("DRONE_BRIDGE_TOKEN", "aeron_drone_bridge_secret_token_dev")

    # Rate, Queue and Freshness Tuning
    telemetry_persist_interval_ms: int = int(os.getenv("TELEMETRY_PERSIST_INTERVAL_MS", "250"))
    heartbeat_timeout_seconds: float = float(os.getenv("HEARTBEAT_TIMEOUT_SECONDS", "3.0"))
    queue_max_size: int = int(os.getenv("QUEUE_MAX_SIZE", "500"))

    # Simulation Fallback
    simulator_enabled: bool = os.getenv("SIMULATOR_ENABLED", "false").lower() in ("true", "1", "yes")
    simulator_rate_hz: float = float(os.getenv("SIMULATOR_RATE_HZ", "10.0"))

    # Logging
    log_level: str = os.getenv("LOG_LEVEL", "INFO").upper()

config = BridgeConfig()
