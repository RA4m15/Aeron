# AERON ESP32 Dual-Transport Telemetry Bridge (Mobile Hotspot Station Mode)

High-performance, non-blocking telemetry duplicating firmware for ESP32 DevKit V1 (ESP-WROOM-32).

---

## 1. Architecture Overview (Wi-Fi Station Mode)

In **Station Mode (`WIFI_STA`)**, the ESP32 joins your mobile phone hotspot rather than creating its own isolated access point. Both the ground control laptop and the drone connect to the same hotspot:
- **Laptop** maintains cellular internet connectivity for Google/Mapbox satellite tiles, MongoDB Atlas, and remote APIs.
- **ESP32** streams real-time Pixhawk MAVLink telemetry concurrently over Wi-Fi TCP (port `5760`) and USB Serial (`COM8` @ 115200 baud).

```
                      SMARTPHONE (Mobile Hotspot)
                 [SSID: MyPhoneHotspot | 2.4 GHz Band]
                       /                       \
                      / (DHCP Client IP)        \ (DHCP Client IP)
                     ▼                           ▼
          GCS LAPTOP                          ESP32 DEVKIT V1
    ┌───────────────────────┐            ┌────────────────────────┐
    │ - Internet Active     │            │ - Mode: Station        │
    │ - Python Bridge       │◄──TCP:5760─┤ - TCP Server Port 5760 │
    │ - Backend & GCS UI    │            │ - mDNS: aeron-esp32    │
    │                       │◄──USB COM8─┤ - UDP Beacon: 37020    │
    └───────────────────────┘            └───────────▲────────────┘
                                                     │ UART2 (57600)
                                         ┌───────────┴────────────┐
                                         │  Pixhawk 2.4.8 TELEM2  │
                                         └────────────────────────┘
```

---

## 2. Physical Pinout & Interconnection

| Pixhawk 2.4.8 (TELEM2) | ESP32 DevKit V1 | Description |
|---|---|---|
| Pin 2: TX (Telemetry Out) | GPIO 16 (RX2) | MAVLink UART RX @ 57,600 baud |
| Pin 3: RX (Telemetry In)  | GPIO 17 (TX2) | Reserved for bidirectional commands |
| Pin 6: GND (Signal Ground)| GND             | Common digital reference ground |
| Pin 1: +5V (VCC Out)      | **See Safety Section Below** | Power supply |

---

## 3. Critical Power Safety Rules

> [!CAUTION]
> **SIMULTANEOUS POWER CONTENTION RISK:**
> Standard ESP32 DevKit V1 boards do NOT isolate USB $V_{BUS}$ from the $V_{IN}$ (5V) pin. Connecting both laptop USB and Pixhawk +5V simultaneously can backfeed current into the laptop's USB bus, potentially damaging your host controller.

### Safe Connection Configurations:

1. **Option A — Standby Bench Testing (USB Powered):**
   - Pixhawk TELEM2 Pin 1 (+5V) is **NOT** connected to ESP32.
   - ESP32 is powered exclusively by the laptop via standard Micro-USB.
   - Pixhawk TX, RX, and GND connect to ESP32 GPIO16, GPIO17, and GND.
2. **Option B — Flight / Autonomous Wireless (Pixhawk Powered):**
   - Micro-USB cable is **UNPLUGGED**.
   - Pixhawk TELEM2 Pin 1 (+5V) is connected to ESP32 **VIN** (5V).
   - ESP32 runs untethered, powered by the Pixhawk power module.
3. **Option C — Simultaneous Dual Transport (Wi-Fi + USB Monitoring):**
   - Pixhawk TELEM2 Pin 1 (+5V) connects to ESP32 **VIN**.
   - Use a **DATA-ONLY USB CABLE** (severed or taped +5V / $V_{BUS}$ pin).
   - Only D+, D-, and GND wires reach the laptop.

> [!WARNING]
> NEVER connect 3S LiPo battery positive ($11.1\text{V}$–$12.6\text{V}$) to any ESP32 pin.
> NEVER connect +5V to the ESP32 3V3 pin.

---

## 4. Wi-Fi & Discovery Specifications

- **Operating Mode:** 802.11 b/g/n Station Mode (`WIFI_STA`)
- **Wi-Fi Band:** 2.4 GHz (Ensure phone hotspot is set to 2.4 GHz, NOT 5 GHz-only)
- **Security:** WPA2-Personal (PSK)
- **Local Credentials:** Defined in `wifi_credentials.h` (excluded from git)
- **DHCP IP:** Assigned by smartphone hotspot DHCP server
- **mDNS Hostname:** `aeron-esp32.local` (resolves to ESP32 DHCP IP)
- **UDP Discovery Beacon:** Port `37020` (Broadcasts JSON beacon every 1.5s; responds to discovery probes)
- **MAVLink TCP Server:** Port `5760` (Raw stream duplicate)
- **HTTP Diagnostic Server:** Port `80` (`http://<esp32-ip>/` or `http://aeron-esp32.local/`)
- **JSON Telemetry API:** `http://<esp32-ip>/api/status`

---

## 5. Mobile Hotspot Compatibility & Client Isolation

> [!IMPORTANT]
> **AP / CLIENT ISOLATION CHECK:**
> Some smartphones or carrier builds have "AP Isolation" or "Client Isolation" enabled by default, which blocks connected Wi-Fi devices from communicating directly with each other.
> - If your laptop cannot ping or connect to `aeron-esp32.local` or the ESP32 DHCP IP:
>   1. Check your phone's Personal Hotspot settings for "Client Isolation", "Guest Network", or "Advanced Settings".
>   2. On Samsung/Android: ensure "Hidden network" and "Protected Management Frames" are compatible with WPA2.
>   3. If client isolation cannot be disabled on your carrier, the AERON bridge automatically falls back to USB Serial (`COM8`), or you can tether the laptop to the phone via USB and share the connection.

---

## 6. Arduino IDE Upload Instructions

1. Copy credentials template:
   ```bash
   cp esp32_dual_transport_bridge/wifi_credentials.h.example esp32_dual_transport_bridge/wifi_credentials.h
   ```
2. Edit `wifi_credentials.h` with your hotspot name and password.
3. Open Arduino IDE and open `esp32_dual_transport_bridge/esp32_dual_transport_bridge.ino`.
4. Select Board: **ESP32 Dev Module** (or **DOIT ESP32 DEVKIT V1**).
5. Settings:
   - CPU Frequency: `240MHz (WiFi/BT)`
   - Flash Frequency: `80MHz`
   - Flash Mode: `QIO`
   - Flash Size: `4MB (32Mb)`
   - Partition Scheme: `Default 4MB with spiffs (1.2MB APP/1.5MB SPIFFS)`
   - Core Debug Level: `None` (CRITICAL: prevents debug text contaminating USB serial)
   - Port: Select current ESP32 COM port (e.g., `COM8`)
6. Click **Upload**.
