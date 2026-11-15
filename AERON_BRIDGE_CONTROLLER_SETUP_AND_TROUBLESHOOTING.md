# AERON — Dashboard Controlled Python Telemetry Bridge Guide

**Author:** AERON Ground Station & Avionics Engineering  
**Service:** AERON Bridge Controller (`aeron_bridge_controller.py`)  
**Interface:** React Admin Ground Control Station (GCS)  
**Target Hardware:** Pixhawk 2.4.8 (ArduCopter v4.5.1) on TELEM2 → ESP32 Wi-Fi Station Mode (TCP 5760)  

---

## 1. Architecture Overview

The **AERON Bridge Controller** replaces automatic bridge launching with an operator-controlled, secure architecture:

```
┌────────────────────────────────────────────────────────┐
│             AERON Admin Dashboard (Browser)            │
│  React 18 + Vite • http://localhost:5173              │
│  [START TELEMETRY] / [STOP TELEMETRY] Widget           │
└───────────────────────────┬────────────────────────────┘
                            │ HTTP REST + X-AERON-TOKEN
                            │ Loopback Only (127.0.0.1:8765)
                            ▼
┌────────────────────────────────────────────────────────┐
│             AERON Bridge Controller Service            │
│  Python Local Daemon (127.0.0.1:8765)                  │
│  PID Tracking • Process Tree Management • CORS/PNA     │
└───────────────────────────┬────────────────────────────┘
                            │ Spawns Managed Process Tree
                            │ powershell -File start-aeron-bridge.ps1 -Transport wifi -WifiHost auto
                            ▼
┌────────────────────────────────────────────────────────┐
│           Python MAVLink Telemetry Bridge              │
│  drone-bridge/src/main.py                              │
│  Connects to ESP32 (TCP 5760) → Ingests MAVLink 2      │
└────────────────────────────────────────────────────────┘
```

---

## 2. Security & Network Isolation Guarantees

1. **Loopback Binding Only:**
   - The Bridge Controller HTTP server binds strictly to `127.0.0.1:8765`.
   - Binding to `0.0.0.0` or external IP addresses is rejected with an explicit security violation error.
   - It is never exposed to the local network (LAN) or mobile hotspot clients.
2. **Cryptographic Token Protection:**
   - On initial setup, a 64-character hexadecimal authentication token is generated and stored locally in `.aeron-bridge-token`.
   - All state-changing operations (`POST /api/bridge/start`, `POST /api/bridge/stop`, `POST /api/bridge/restart`) strictly require the header `X-AERON-TOKEN: <token>`.
   - Unauthorized requests are rejected immediately with `HTTP 401 Unauthorized`.
3. **CORS & Chrome Private Network Access (PNA):**
   - Implements full `OPTIONS` preflight handling with `Access-Control-Allow-Private-Network: true`.
   - Allows requests from the local dashboard (`http://localhost:5173`, `http://127.0.0.1:5173`) while rejecting arbitrary unvetted origins.
4. **Zero Arbitrary Execution:**
   - The controller accepts **zero command strings, executable paths, or arbitrary shell parameters** from the browser.
   - It only launches the official, predefined script:
     `powershell.exe -NoProfile -ExecutionPolicy Bypass -File drone-bridge\start-aeron-bridge.ps1 -Transport wifi -WifiHost auto`
5. **Exact Process Tree Termination:**
   - Tracks the exact parent PID spawned.
   - When stopping, terminates only the managed process and its direct child processes using `taskkill /F /T /PID <pid>`. Unrelated Python processes on the machine are never touched.

---

## 3. Windows Startup & Installation

### One-Time Installation
To register the lightweight controller service to start automatically at Windows user login:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-aeron-controller.ps1
```

**What this does:**
1. Verifies the Python 3 runtime and detects `pythonw.exe` (windowless background execution).
2. Generates or loads the local cryptographic authentication token (`.aeron-bridge-token`).
3. Creates a background runner in `%USERPROFILE%\.aeron\run-aeron-bridge-controller.vbs`.
4. Creates a Windows Startup shortcut in the current user's Startup folder:
   `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\AERON-Bridge-Controller.lnk`
5. Starts the service immediately on `http://127.0.0.1:8765`.

> **CRITICAL DISTINCTION:**  
> The Bridge Controller service starts automatically with Windows, but it **strictly does NOT launch the Python telemetry bridge**.  
> The Python bridge is only launched when the operator clicks **START TELEMETRY** in the dashboard.

### Uninstallation
To remove the background controller service and its startup shortcut:

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall-aeron-controller.ps1
```

---

## 4. Dashboard User Experience & State Machine

The **AERON Bridge Controller** widget is located directly on the **Drone Overview Page**:

| Bridge Status | Button Display | Subsystem States Reported | Operator Action |
| :--- | :--- | :--- | :--- |
| **`BRIDGE_STOPPED`** | `START TELEMETRY` (Lime Accent) | Process: None • ESP32: Disconnected • Heartbeat: Standby | Ready to launch telemetry link |
| **`STARTING`** | `STARTING...` (Pulsing / Disabled) | Process: Spawning • Logs: Initializing virtualenv | Background initialization |
| **`WAITING_FOR_ESP32`** | `WAITING FOR ESP32...` (Amber) | Process: Active • ESP32: Discovering via mDNS / UDP | Hotspot discovery in progress |
| **`CONNECTING`** | `CONNECTING...` (Amber Ping) | Process: Active • TCP: Port 5760 Opened | Awaiting first MAVLink heartbeat |
| **`CONNECTED`** | `STOP TELEMETRY` (Danger Red) | Process: Active • ESP32: Connected • Heartbeat: Nominal (1 Hz) • Freshness: Live (<= 3.5s) | Full real-time telemetry streaming |
| **`DISCONNECTED`** | `STOP TELEMETRY` (Warning Amber) | Process: Active • Heartbeat: Lost (> 2.0s) | Link dropped or aircraft powered off |
| **`STOPPING`** | `STOPPING...` (Pulsing / Disabled) | Process: Terminating process tree | Graceful shutdown in progress |
| **`ERROR`** | `START TELEMETRY` (Error Banner) | Process: Exited non-zero • Last Error displayed | Review error message and retry |
| **`CONTROLLER_OFFLINE`** | `START TELEMETRY` (Disabled) | Service not reachable on 127.0.0.1:8765 | Run `install-aeron-controller.ps1` |

> **Hardware Truth Enforcement:**  
> The system **never** claims `CONNECTED` based merely on process startup. It strictly requires:
> 1. Process active and TCP 5760 link established.
> 2. Valid MAVLink 2 heartbeat received from Pixhawk (`SYS_STATUS` / `HEARTBEAT`).
> 3. Verified fresh telemetry arrivals (packet age $\le 3500\text{ ms}$).

---

## 5. Troubleshooting & FAQ

### Issue: "AERON Bridge Controller is not running on this computer"
- **Cause:** The background service on port 8765 is not running.
- **Resolution:**
  1. Open PowerShell and run: `powershell -ExecutionPolicy Bypass -File .\install-aeron-controller.ps1`
  2. Verify health by opening `http://127.0.0.1:8765/health` in your browser.

### Issue: Dashboard is accessed from mobile phone or external tablet
- **Notice:** `127.0.0.1` in a phone browser refers to the phone itself, not the telemetry laptop.
- **Resolution:** Start the bridge on the Windows laptop dashboard, or configure the telemetry laptop to run the bridge controller. The mobile dashboard receives telemetry automatically via Socket.IO from the central backend.

### Issue: Bridge enters `WAITING_FOR_ESP32`
- **Cause:** ESP32 is not discovered on the phone hotspot.
- **Resolution:**
  1. Confirm your phone mobile hotspot is active and both the laptop and ESP32 are connected.
  2. In your phone's hotspot settings, ensure **"AP Isolation"** or **"Client Isolation"** is turned **OFF**.
  3. Expand the **"Bridge Logs"** toggle in the widget to inspect real-time discovery events.

