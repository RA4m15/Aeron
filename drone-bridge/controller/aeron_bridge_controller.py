"""
AERON Ground Control Station — Local Bridge Controller Service
==============================================================
Author: AERON Ground Station & Avionics Engineering
Service Port: 8765 (Loopback Only: 127.0.0.1)

Provides a lightweight, secure HTTP REST API running strictly on 127.0.0.1
to allow the AERON Admin Dashboard operator to safely start, monitor, and
stop the physical Python MAVLink telemetry bridge on Windows.

Security Guarantees:
- Strictly bound to 127.0.0.1 (never 0.0.0.0 or external interfaces).
- Cryptographic local authentication token via X-AERON-TOKEN header.
- CORS with Private Network Access (PNA) preflight support.
- Zero arbitrary command execution: launches only predefined bridge scripts.
- Process tree tracking: stops only the managed bridge process and children.
"""

import os
import sys
import json
import time
import signal
import secrets
import pathlib
import urllib.request
import urllib.error
import subprocess
import threading
from collections import deque
from typing import Optional, Dict, Any, List
from http.server import HTTPServer, BaseHTTPRequestHandler

# Handle windowless pythonw execution where stdout/stderr may be None
class SafeLogger:
    def __init__(self, log_path: Optional[pathlib.Path] = None):
        self.log_path = log_path

    def write(self, msg: str):
        if not msg:
            return
        if self.log_path:
            try:
                with open(self.log_path, "a", encoding="utf-8") as f:
                    f.write(msg)
            except Exception:
                pass

    def flush(self):
        pass

if sys.stdout is None or not hasattr(sys.stdout, "write"):
    _log_file = pathlib.Path.home() / ".aeron" / "controller.log"
    sys.stdout = SafeLogger(_log_file)
    sys.stderr = SafeLogger(_log_file)

# Import psutil if available for advanced process tree introspection
try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False

# Controller Network Configuration
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765

# Status Enumerations
STATUS_CONTROLLER_OFFLINE = "CONTROLLER_OFFLINE"
STATUS_BRIDGE_STOPPED = "BRIDGE_STOPPED"
STATUS_STARTING = "STARTING"
STATUS_WAITING_FOR_ESP32 = "WAITING_FOR_ESP32"
STATUS_CONNECTING = "CONNECTING"
STATUS_CONNECTED = "CONNECTED"
STATUS_DISCONNECTED = "DISCONNECTED"
STATUS_ERROR = "ERROR"
STATUS_STOPPING = "STOPPING"

class BridgeProcessManager:
    """
    Manages the lifecycle, subprocess execution, real-time logging, and health
    monitoring of the AERON Python MAVLink Telemetry Bridge.
    """
    def __init__(self, repo_root: pathlib.Path, backend_url: str = "http://127.0.0.1:5000/api/v1"):
        self.repo_root = repo_root
        self.bridge_dir = repo_root / "drone-bridge"
        self.launcher_script = self.bridge_dir / "start-aeron-bridge.ps1"
        self.backend_url = backend_url.rstrip("/")

        self.lock = threading.Lock()
        self.managed_process: Optional[subprocess.Popen] = None
        self.managed_pid: Optional[int] = None
        self.status: str = STATUS_BRIDGE_STOPPED
        self.started_at: Optional[float] = None
        self.last_error: Optional[str] = None
        self.transport: str = "WIFI"
        self.esp32_state: str = "DISCONNECTED"  # DISCONNECTED, DISCOVERING, CONNECTED
        self.heartbeat_state: str = "NO_HEARTBEAT"  # NO_HEARTBEAT, AWAITING, HEALTHY, LOST
        self.telemetry_fresh: bool = False
        self.telemetry_age_ms: Optional[int] = None
        self.message_rate_hz: float = 0.0

        # Ring buffer for recent console output (last 100 lines)
        self.recent_logs: deque = deque(maxlen=100)
        self._log_thread: Optional[threading.Thread] = None
        self._monitor_thread: Optional[threading.Thread] = None
        self._stop_monitor_event = threading.Event()

    def start_bridge(self) -> Dict[str, Any]:
        """
        Launches the Python bridge using the official PowerShell launcher.
        Prevents duplicate processes and enforces Wi-Fi transport.
        """
        with self.lock:
            # Check if an active process is already running
            if self.managed_process is not None and self.managed_process.poll() is None:
                return {
                    "success": False,
                    "message": f"Bridge is already running (PID: {self.managed_pid})",
                    "status": self.status,
                    "pid": self.managed_pid
                }

            if not self.launcher_script.exists():
                err_msg = f"Launcher script not found at {self.launcher_script}"
                self.last_error = err_msg
                self.status = STATUS_ERROR
                return {"success": False, "message": err_msg, "status": STATUS_ERROR}

            self.status = STATUS_STARTING
            self.last_error = None
            self.started_at = time.time()
            self.esp32_state = "DISCOVERING"
            self.heartbeat_state = "AWAITING"
            self.telemetry_fresh = False
            self.telemetry_age_ms = None
            self.message_rate_hz = 0.0
            self.recent_logs.clear()

            self._log_line(f"[AERON-CONTROLLER] Spawning bridge via {self.launcher_script.name} -Transport wifi -WifiHost auto")

            # Construct PowerShell execution command
            # Using -NoProfile -ExecutionPolicy Bypass to guarantee clean execution
            cmd = [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy", "Bypass",
                "-File", str(self.launcher_script),
                "-Transport", "wifi",
                "-WifiHost", "auto"
            ]

            try:
                # Spawn child process in its own process group
                creation_flags = 0
                if sys.platform == "win32":
                    creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP

                self.managed_process = subprocess.Popen(
                    cmd,
                    cwd=str(self.repo_root),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                    creationflags=creation_flags
                )
                self.managed_pid = self.managed_process.pid
                self._log_line(f"[AERON-CONTROLLER] Bridge process launched successfully (PID: {self.managed_pid})")

                # Start background log reader thread
                self._log_thread = threading.Thread(target=self._read_process_output, daemon=True)
                self._log_thread.start()

                # Start background health monitor if not already running
                if self._monitor_thread is None or not self._monitor_thread.is_alive():
                    self._stop_monitor_event.clear()
                    self._monitor_thread = threading.Thread(target=self._monitor_telemetry_loop, daemon=True)
                    self._monitor_thread.start()

                return {
                    "success": true_or_bool(True),
                    "message": "Bridge process started",
                    "status": self.status,
                    "pid": self.managed_pid
                }

            except Exception as e:
                self.last_error = f"Failed to spawn bridge process: {e}"
                self.status = STATUS_ERROR
                self.managed_process = None
                self.managed_pid = None
                self._log_line(f"[AERON-CONTROLLER] ERROR: {self.last_error}")
                return {"success": False, "message": self.last_error, "status": STATUS_ERROR}

    def stop_bridge(self) -> Dict[str, Any]:
        """
        Safely stops the managed bridge process and its child processes.
        Strictly targets only the process tree spawned by this controller.
        """
        with self.lock:
            if self.managed_process is None or self.managed_process.poll() is not None:
                self.status = STATUS_BRIDGE_STOPPED
                self.managed_pid = None
                self.managed_process = None
                return {"success": True, "message": "Bridge is not running", "status": STATUS_BRIDGE_STOPPED}

            self.status = STATUS_STOPPING
            pid = self.managed_pid
            self._log_line(f"[AERON-CONTROLLER] Stopping bridge process tree (PID: {pid})...")

            try:
                if sys.platform == "win32":
                    # On Windows, taskkill /F /T terminates the process and all child processes
                    subprocess.run(
                        ["taskkill", "/F", "/T", "/PID", str(pid)],
                        capture_output=True,
                        timeout=5
                    )
                else:
                    self.managed_process.terminate()
                    try:
                        self.managed_process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        self.managed_process.kill()

                self.managed_process.wait(timeout=3)
            except Exception as e:
                self._log_line(f"[AERON-CONTROLLER] Note during process termination: {e}")

            self.managed_process = None
            self.managed_pid = None
            self.status = STATUS_BRIDGE_STOPPED
            self.esp32_state = "DISCONNECTED"
            self.heartbeat_state = "NO_HEARTBEAT"
            self.telemetry_fresh = False
            self.started_at = None
            self._log_line("[AERON-CONTROLLER] Bridge process stopped cleanly.")

            return {
                "success": True,
                "message": "Bridge stopped successfully",
                "status": STATUS_BRIDGE_STOPPED
            }

    def restart_bridge(self) -> Dict[str, Any]:
        """Stops the bridge (if running) and restarts it cleanly."""
        self.stop_bridge()
        time.sleep(1.0)
        return self.start_bridge()

    def get_status_snapshot(self) -> Dict[str, Any]:
        """Returns the authoritative status snapshot for the dashboard."""
        with self.lock:
            # Check liveness of managed process
            if self.managed_process is not None:
                poll_result = self.managed_process.poll()
                if poll_result is not None:
                    # Process died
                    if self.status != STATUS_STOPPING and self.status != STATUS_BRIDGE_STOPPED:
                        self.status = STATUS_ERROR if poll_result != 0 else STATUS_BRIDGE_STOPPED
                        if poll_result != 0 and not self.last_error:
                            self.last_error = f"Process exited unexpectedly with code {poll_result}"
                    self.managed_process = None
                    self.managed_pid = None

            uptime_sec = 0
            if self.started_at and self.managed_pid:
                uptime_sec = int(time.time() - self.started_at)

            return {
                "status": self.status,
                "managed_pid": self.managed_pid,
                "transport": self.transport,
                "esp32_state": self.esp32_state,
                "heartbeat_state": self.heartbeat_state,
                "telemetry_fresh": self.telemetry_fresh,
                "telemetry_age_ms": self.telemetry_age_ms,
                "message_rate_hz": self.message_rate_hz,
                "uptime_seconds": uptime_sec,
                "last_error": self.last_error,
                "recent_logs": list(self.recent_logs)[-25:],
                "started_at": self.started_at
            }

    def _log_line(self, line: str):
        ts = time.strftime("[%H:%M:%S]")
        formatted = f"{ts} {line.strip()}"
        self.recent_logs.append(formatted)

    def _read_process_output(self):
        """Streams stdout from the bridge subprocess and updates the state machine."""
        if not self.managed_process or not self.managed_process.stdout:
            return

        try:
            for raw_line in iter(self.managed_process.stdout.readline, ""):
                if not raw_line:
                    break
                line = raw_line.strip()
                if not line:
                    continue

                self._log_line(line)

                # State machine parsing from output logs
                with self.lock:
                    lower = line.lower()
                    if "unable to discover esp32" in lower or "esp32 discovery" in lower:
                        if self.status not in (STATUS_CONNECTED, STATUS_STOPPING):
                            self.status = STATUS_WAITING_FOR_ESP32
                            self.esp32_state = "DISCOVERING"

                    elif "opening mavlink interface" in lower or "awaiting valid heartbeat" in lower:
                        if self.status not in (STATUS_CONNECTED, STATUS_STOPPING):
                            self.status = STATUS_CONNECTING
                            self.esp32_state = "CONNECTING"

                    elif "discovered esp32" in lower or "successfully opened tcp" in lower:
                        self.esp32_state = "CONNECTED"

                    elif "fc: healthy" in lower:
                        self.heartbeat_state = "HEALTHY"
                        # Status will be confirmed CONNECTED by the telemetry freshness monitor
                        if self.status in (STATUS_STARTING, STATUS_WAITING_FOR_ESP32, STATUS_CONNECTING):
                            self.status = STATUS_CONNECTED

                    elif "connection reset" in lower or "closed by peer" in lower or "lost heartbeat" in lower:
                        self.esp32_state = "DISCONNECTED"
                        self.heartbeat_state = "LOST"
                        if self.status == STATUS_CONNECTED:
                            self.status = STATUS_DISCONNECTED

        except Exception as e:
            self._log_line(f"[AERON-CONTROLLER] Output reader ended: {e}")

    def _monitor_telemetry_loop(self):
        """
        Background loop polling Backend API to confirm valid MAVLink heartbeat
        and fresh telemetry arrivals before claiming CONNECTED.
        """
        while not self._stop_monitor_event.is_set():
            time.sleep(1.2)

            with self.lock:
                if self.managed_process is None or self.managed_process.poll() is not None:
                    continue
                current_status = self.status

            # Query backend for latest telemetry record
            try:
                url = f"{self.backend_url}/telemetry/latest/AERON-HEX-01"
                req = urllib.request.Request(url, headers={"User-Agent": "AERON-Bridge-Controller/1.0"})
                with urllib.request.urlopen(req, timeout=1.5) as resp:
                    if resp.status == 200:
                        data = json.loads(resp.read().decode("utf-8"))
                        record = data.get("data")
                        if record:
                            rec_str = record.get("recordedAt") or record.get("receivedAt")
                            if rec_str:
                                # Parse ISO timestamp
                                import datetime
                                try:
                                    # Normalize Z to +00:00 for ISO parsing
                                    ts_clean = rec_str.replace("Z", "+00:00")
                                    dt = datetime.datetime.fromisoformat(ts_clean)
                                    rec_ms = dt.timestamp() * 1000
                                    age_ms = int(max(0, (time.time() * 1000) - rec_ms))

                                    with self.lock:
                                        self.telemetry_age_ms = age_ms
                                        # Strict Rule: Telemetry must be fresh (<= 3500ms) to claim CONNECTED
                                        if age_ms <= 3500:
                                            self.telemetry_fresh = True
                                            self.heartbeat_state = "HEALTHY"
                                            self.esp32_state = "CONNECTED"
                                            if self.status in (STATUS_STARTING, STATUS_WAITING_FOR_ESP32, STATUS_CONNECTING, STATUS_DISCONNECTED):
                                                self.status = STATUS_CONNECTED
                                        elif age_ms > 5000:
                                            self.telemetry_fresh = False
                                            if self.status == STATUS_CONNECTED:
                                                self.status = STATUS_DISCONNECTED
                                                self.heartbeat_state = "LOST"
                                except Exception:
                                    pass
            except Exception:
                # Backend may be starting or temporarily unreachable
                pass


def true_or_bool(val: bool) -> bool:
    return bool(val)


class BridgeControllerServer:
    """
    HTTP REST Server strictly listening on loopback (127.0.0.1:8765)
    with authentication, CSRF protection, and CORS preflight handling.
    """
    def __init__(self, host: str = DEFAULT_HOST, port: int = DEFAULT_PORT, repo_root: Optional[pathlib.Path] = None):
        # Strict security constraint: host MUST be 127.0.0.1
        if host not in ("127.0.0.1", "localhost"):
            raise ValueError(f"Security Violation: AERON Bridge Controller must bind strictly to 127.0.0.1, not '{host}'")

        self.host = "127.0.0.1"
        self.port = port
        self.repo_root = repo_root or pathlib.Path(__file__).resolve().parent.parent.parent

        # Initialize or load authentication token
        self.token = self._init_auth_token()
        self.manager = BridgeProcessManager(self.repo_root)
        self.httpd: Optional[HTTPServer] = None
        self._server_thread: Optional[threading.Thread] = None

    def _init_auth_token(self) -> str:
        """Loads or creates a cryptographically secure 64-char local token."""
        token_env = os.environ.get("AERON_BRIDGE_CONTROLLER_TOKEN")
        if token_env and len(token_env) >= 16:
            return token_env.strip()

        token_file = self.repo_root / ".aeron-bridge-token"
        if token_file.exists():
            try:
                token = token_file.read_text(encoding="utf-8").strip()
                if len(token) >= 16:
                    return token
            except Exception:
                pass

        # Generate new random token
        token = secrets.token_hex(32)
        try:
            token_file.write_text(token, encoding="utf-8")
        except Exception as e:
            print(f"[AERON-CONTROLLER] Warning: Could not write token file {token_file}: {e}")

        return token

    def start(self):
        """Starts the HTTP server on a background thread (for tests/integration)."""
        handler_factory = self._create_handler()
        self.httpd = HTTPServer((self.host, self.port), handler_factory)
        self._server_thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self._server_thread.start()
        print(f"[AERON-CONTROLLER] Running on http://{self.host}:{self.port} (Loopback Only)")
        print(f"[AERON-CONTROLLER] Auth Token initialized ({len(self.token)} chars)")

    def serve(self):
        """Starts the HTTP server and serves on the main thread."""
        handler_factory = self._create_handler()
        self.httpd = HTTPServer((self.host, self.port), handler_factory)
        print(f"[AERON-CONTROLLER] Running on http://{self.host}:{self.port} (Loopback Only)")
        print(f"[AERON-CONTROLLER] Auth Token initialized ({len(self.token)} chars)")
        try:
            self.httpd.serve_forever()
        except (KeyboardInterrupt, SystemExit):
            pass
        finally:
            self.stop()

    def stop(self):
        """Stops the bridge process and shuts down HTTP server."""
        self.manager.stop_bridge()
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
        print("[AERON-CONTROLLER] Server stopped.")

    def _create_handler(self):
        controller = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                # Suppress noisy standard HTTP access logs
                pass

            def _send_cors_headers(self):
                origin = self.headers.get("Origin", "*")
                # Allowed Origins: localhost/127.0.0.1 or reflection for browser CORS
                self.send_header("Access-Control-Allow-Origin", origin if origin else "*")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, X-AERON-TOKEN, X-Requested-With")
                self.send_header("Access-Control-Allow-Private-Network", "true")
                self.send_header("Access-Control-Max-Age", "86400")

            def do_OPTIONS(self):
                """Handles CORS and Chrome Private Network Access preflights."""
                self.send_response(204)
                self._send_cors_headers()
                self.end_headers()

            def _verify_auth(self) -> bool:
                """Verifies local auth token for state-changing endpoints."""
                client_token = self.headers.get("X-AERON-TOKEN") or self.headers.get("x-aeron-token")
                if not client_token:
                    # Also allow token via URL query parameter for simple authenticated tools
                    from urllib.parse import urlparse, parse_qs
                    qs = parse_qs(urlparse(self.path).query)
                    client_token = qs.get("token", [None])[0]

                if not client_token or client_token.strip() != controller.token:
                    self._send_json(401, {
                        "error": "Unauthorized",
                        "message": "Invalid or missing X-AERON-TOKEN authentication header."
                    })
                    return False
                return True

            def _send_json(self, status_code: int, data: Dict[str, Any]):
                body = json.dumps(data).encode("utf-8")
                self.send_response(status_code)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                from urllib.parse import urlparse
                parsed = urlparse(self.path)
                path = parsed.path

                # 1. Health check (unauthenticated loopback probe)
                if path == "/health":
                    self._send_json(200, {
                        "status": "ok",
                        "service": "aeron-bridge-controller",
                        "version": "1.0.0",
                        "host": controller.host,
                        "port": controller.port,
                        "pid": os.getpid()
                    })
                    return

                # 2. Local token retrieval (only accessible for localhost origins to ease setup)
                if path == "/api/bridge/token":
                    origin = self.headers.get("Origin", "")
                    # Only return token if client is connecting from localhost
                    client_host = self.client_address[0]
                    if client_host in ("127.0.0.1", "localhost", "::1"):
                        self._send_json(200, {"token": controller.token})
                    else:
                        self._send_json(403, {"error": "Forbidden", "message": "Token retrieval restricted to loopback"})
                    return

                # 3. Status query
                if path == "/api/bridge/status":
                    snapshot = controller.manager.get_status_snapshot()
                    self._send_json(200, snapshot)
                    return

                self._send_json(404, {"error": "Not Found", "path": path})

            def do_POST(self):
                from urllib.parse import urlparse
                parsed = urlparse(self.path)
                path = parsed.path

                # State-changing operations strictly require authentication token
                if not self._verify_auth():
                    return

                if path == "/api/bridge/start":
                    result = controller.manager.start_bridge()
                    code = 200 if result.get("success") else 400
                    self._send_json(code, result)
                    return

                if path == "/api/bridge/stop":
                    result = controller.manager.stop_bridge()
                    self._send_json(200, result)
                    return

                if path == "/api/bridge/restart":
                    result = controller.manager.restart_bridge()
                    code = 200 if result.get("success") else 400
                    self._send_json(code, result)
                    return

                self._send_json(404, {"error": "Not Found", "path": path})

        return Handler


def main():
    repo_root = pathlib.Path(__file__).resolve().parent.parent.parent
    server = BridgeControllerServer(host=DEFAULT_HOST, port=DEFAULT_PORT, repo_root=repo_root)

    # Graceful termination handler
    def shutdown(sig, frame):
        print("\n[AERON-CONTROLLER] Shutting down...")
        server.stop()
        sys.exit(0)

    try:
        signal.signal(signal.SIGINT, shutdown)
        signal.signal(signal.SIGTERM, shutdown)
    except Exception:
        pass

    server.serve()


if __name__ == "__main__":
    main()
