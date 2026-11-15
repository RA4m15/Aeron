/**
 * AERON Aerospace Systems — Dual-Transport MAVLink Telemetry Bridge
 * Target Hardware: ESP32 DevKit V1 (ESP-WROOM-32)
 *
 * ARCHITECTURE (Mobile Hotspot Station Mode):
 * In Station Mode (WIFI_STA), the ESP32 connects directly to your mobile phone hotspot,
 * sharing the local network with your ground control laptop. The laptop retains normal
 * cellular internet connectivity (for cloud maps, backend APIs, etc.) while receiving
 * real-time Pixhawk MAVLink telemetry from the ESP32.
 *
 * FUNCTION:
 * Receives raw MAVLink 2.0 binary telemetry stream from Pixhawk 2.4.8 on UART2 (57600 baud),
 * and duplicates the identical byte stream simultaneously into two independent output paths:
 *   - Path A (Wi-Fi Hotspot STA): TCP Server on port 5760 (DHCP IP, mDNS: aeron-esp32.local)
 *   - Path B (USB Serial): Standard USB Serial at 115200 baud (COM8 compatible)
 *
 * DIAGNOSTIC MODE:
 *   Set WIFI_DIAGNOSTIC_MODE to true to enable detailed interactive logging on USB Serial
 *   at 115200 baud. In diagnostic mode, USB MAVLink forwarding is paused so plain text
 *   can be safely inspected in Arduino Serial Monitor without corrupting MAVLink parsers.
 *   Set WIFI_DIAGNOSTIC_MODE to false for standard production telemetry forwarding.
 *
 * PIN CONNECTIONS:
 *   Pixhawk TELEM2 TX -> ESP32 GPIO16 (RX2)
 *   Pixhawk TELEM2 RX -> ESP32 GPIO17 (TX2)
 *   Pixhawk GND        -> ESP32 GND
 *   Status LED         -> ESP32 GPIO2 (Onboard Blue LED)
 *
 * POWER SAFETY:
 *   - Standby Bench: Powered via USB (TELEM2 +5V disconnected from ESP32).
 *   - Flight / Autonomous: Powered via Pixhawk 5V to ESP32 VIN (USB disconnected).
 *   - Simultaneous USB + Pixhawk: REQUIRE data-only USB cable (VBUS / 5V line cut)
 *     to prevent reverse-current backfeeding into host PC USB controller.
 *   - NEVER connect 3S LiPo battery (11.1V - 12.6V) to ESP32 VIN or 3V3 pins!
 */

#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiServer.h>
#include <WiFiUdp.h>
#include <WebServer.h>
#include <ESPmDNS.h>

// ==========================================
// OPERATION MODE: TELEMETRY vs DIAGNOSTIC
// ==========================================
// Set to true to print human-readable Wi-Fi diagnostics to USB Serial (115200 baud).
// (USB MAVLink forwarding is disabled while debugging so terminal text remains readable).
// Set to false for standard flight/bench telemetry (clean binary MAVLink forwarded on USB).
#define WIFI_DIAGNOSTIC_MODE    true

// ==========================================
// MANDATORY LOCAL WIFI CREDENTIALS
// ==========================================
// Compile-time check 1: Ensure wifi_credentials.h exists in sketch folder
#if !__has_include("wifi_credentials.h")
  #error "FATAL: 'wifi_credentials.h' is required but not found in the sketch folder! Copy 'wifi_credentials.h.example' to 'wifi_credentials.h' and configure your mobile hotspot SSID and password."
#endif

// Directly include mandatory credentials file
#include "wifi_credentials.h"

// Compile-time check 2: Verify AERON_WIFI_SSID is defined
#ifndef AERON_WIFI_SSID
  #error "CONFIGURATION ERROR: 'AERON_WIFI_SSID' is not defined in 'wifi_credentials.h'! Please add #define AERON_WIFI_SSID \"YourHotspotName\"."
#endif

// Compile-time check 3: Verify AERON_WIFI_PASSWORD is defined
#ifndef AERON_WIFI_PASSWORD
  #error "CONFIGURATION ERROR: 'AERON_WIFI_PASSWORD' is not defined in 'wifi_credentials.h'! Please add #define AERON_WIFI_PASSWORD \"YourHotspotPassword\"."
#endif

#define CREDENTIALS_SOURCE      "wifi_credentials.h (Mandatory Local)"

#define MDNS_HOSTNAME           "aeron-esp32"        // Resolves to aeron-esp32.local
#define TCP_SERVER_PORT         5760                 // Standard MAVLink TCP port
#define UDP_DISCOVERY_PORT      37020                // Beacon broadcast & probe port
#define HTTP_SERVER_PORT        80                   // Diagnostic Web Dashboard port
#define STATUS_LED_PIN          2                    // Onboard Blue LED on ESP32 DevKit V1

#define UART2_RX_PIN            16                   // Connects to Pixhawk TELEM2 TX
#define UART2_TX_PIN            17                   // Connects to Pixhawk TELEM2 RX
#define PIXHAWK_BAUD            57600                // Pixhawk SERIAL2_BAUD default
#define USB_SERIAL_BAUD         115200               // USB Serial to Laptop Ground Station

#define BUFFER_CHUNK_SIZE       512                  // Ring buffer chunk size for telemetry
#define UDP_BEACON_INTERVAL_MS  1500                 // UDP discovery broadcast interval
#define WIFI_RETRY_INTERVAL_MS  15000                // Interval before re-attempting association (15s ensures no scan/handshake abort)
#define DIAG_PRINT_INTERVAL_MS  3000                 // Diagnostic periodic status print interval

// ==========================================
// GLOBAL OBJECTS & STATE
// ==========================================
WiFiServer tcpServer(TCP_SERVER_PORT);
WiFiClient activeTcpClient;
WiFiUDP    udp;
WebServer  httpServer(HTTP_SERVER_PORT);

// Operational Statistics & Diagnostic Metrics
struct TelemetryMetrics {
  unsigned long bootTimeMs;
  unsigned long lastMavlinkRxMs;
  unsigned long lastUdpBeaconMs;
  unsigned long lastWifiRetryMs;
  unsigned long lastDiagPrintMs;
  unsigned long lastLedBlinkMs;
  unsigned long uartRxBytes;
  unsigned long uartTxBytes;
  unsigned long usbTxBytes;
  unsigned long usbRxBytes;
  unsigned long wifiTxBytes;
  unsigned long wifiRxBytes;
  unsigned long tcpConnectCount;
  unsigned long tcpDisconnectCount;
  unsigned long wifiReconnectCount;
  uint8_t       lastDisconnectReason;
  char          lastDisconnectReasonStr[64];
  bool          wifiConnected;
  bool          tcpClientConnected;
  bool          mdnsStarted;
  bool          servicesStarted;
  bool          ledState;
  char          clientIp[24];
  char          assignedIp[24];
} metrics;

// Forward Declarations
void handleRoot();
void handleStatusApi();
void handleNotFound();
void checkWifiState();
void broadcastUdpBeacon();
void handleUdpProbes();
void updateStatusLed();
void onWiFiEvent(WiFiEvent_t event, WiFiEventInfo_t info);
const char* getDisconnectReasonText(uint8_t reason);
const char* getEncryptionTypeName(wifi_auth_mode_t authmode);
void performDiagnosticScan();

// ==========================================
// WIFI DISCONNECT REASON DECODER
// ==========================================
const char* getDisconnectReasonText(uint8_t reason) {
  switch (reason) {
    case 1:   return "UNSPECIFIED (General failure)";
    case 2:   return "AUTH_EXPIRE (Authentication expired)";
    case 3:   return "AUTH_LEAVE (Deauthenticated by AP)";
    case 4:   return "ASSOC_EXPIRE (Association expired)";
    case 5:   return "ASSOC_TOOMANY (Too many devices on AP)";
    case 6:   return "NOT_AUTHED (Class 2 frame from unauthenticated STA)";
    case 7:   return "NOT_ASSOCED (Class 3 frame from unassociated STA)";
    case 8:   return "ASSOC_LEAVE (Deassociated by AP)";
    case 9:   return "ASSOC_NOT_AUTHED (Association requested before auth)";
    case 10:  return "DISASSOC_PWRCAP_BAD (Power capability unacceptable)";
    case 11:  return "DISASSOC_SUPCHAN_BAD (Supported channels unacceptable)";
    case 12:  return "IE_INVALID (Invalid information element)";
    case 13:  return "MIC_FAILURE (Message integrity failure)";
    case 14:  return "4WAY_HANDSHAKE_TIMEOUT (WPA2/WPA3 handshake timeout - Check password or WPA3)";
    case 15:  return "GROUP_KEY_UPDATE_TIMEOUT (Group key timeout)";
    case 16:  return "IE_IN_4WAY_DIFFERS (Handshake IE mismatch)";
    case 17:  return "GROUP_CIPHER_INVALID (Group cipher invalid)";
    case 18:  return "PAIRWISE_CIPHER_INVALID (Pairwise cipher invalid)";
    case 19:  return "AKMP_INVALID (AKM suite invalid)";
    case 20:  return "UNSUPP_RSN_IE_VERSION (Unsupported RSN IE version)";
    case 21:  return "INVALID_RSN_IE_CAP (Invalid RSN IE capabilities)";
    case 22:  return "802_1X_AUTH_FAILED (802.1x auth failed)";
    case 23:  return "CIPHER_SUITE_REJECTED (Cipher suite rejected)";
    case 200: return "BEACON_TIMEOUT (AP beacon lost - Hotspot went to sleep or out of range)";
    case 201: return "NO_AP_FOUND (Hotspot SSID NOT FOUND! Ensure 2.4 GHz band, not 5 GHz only)";
    case 202: return "AUTH_FAIL (Authentication failed - Check password or WPA3/PMF settings)";
    case 203: return "ASSOC_FAIL (Association failed)";
    case 204: return "HANDSHAKE_TIMEOUT (Handshake failed - Check WPA2 password)";
    case 205: return "CONNECTION_FAIL (Connection failed)";
    default:  return "UNKNOWN_DISCONNECT_REASON";
  }
}

// ==========================================
// WIFI ASYNCHRONOUS EVENT HANDLER
// ==========================================
void onWiFiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_STA_START:
#if WIFI_DIAGNOSTIC_MODE
      Serial.println(F("[WIFI-EVENT] Station interface started (WIFI_STA). Initiating connection..."));
#endif
      break;

    case ARDUINO_EVENT_WIFI_STA_CONNECTED:
      metrics.wifiConnected = true;
#if WIFI_DIAGNOSTIC_MODE
      Serial.printf("[WIFI-EVENT] 802.11 Layer-2 Associated with SSID '%s' (Channel: %d)\n",
                    AERON_WIFI_SSID, WiFi.channel());
      Serial.println(F("[WIFI-EVENT] Awaiting DHCP IP lease from smartphone hotspot..."));
#endif
      break;

    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      metrics.wifiConnected = true;
      strncpy(metrics.assignedIp, WiFi.localIP().toString().c_str(), sizeof(metrics.assignedIp) - 1);
#if WIFI_DIAGNOSTIC_MODE
      Serial.println(F("=================================================="));
      Serial.println(F("  [WIFI SUCCESS] CONNECTED TO MOBILE HOTSPOT!"));
      Serial.printf("  Assigned DHCP IP: %s\n", metrics.assignedIp);
      Serial.printf("  Hotspot Gateway : %s\n", WiFi.gatewayIP().toString().c_str());
      Serial.printf("  Subnet Mask     : %s\n", WiFi.subnetMask().toString().c_str());
      Serial.printf("  Signal Strength : %d dBm\n", WiFi.RSSI());
      Serial.printf("  mDNS Hostname   : %s.local\n", MDNS_HOSTNAME);
      Serial.printf("  TCP MAVLink Port: %d (Ready for GCS)\n", TCP_SERVER_PORT);
      Serial.println(F("=================================================="));
#endif
      break;

    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      metrics.wifiConnected = false;
      metrics.lastDisconnectReason = info.wifi_sta_disconnected.reason;
      strncpy(metrics.lastDisconnectReasonStr,
              getDisconnectReasonText(metrics.lastDisconnectReason),
              sizeof(metrics.lastDisconnectReasonStr) - 1);
#if WIFI_DIAGNOSTIC_MODE
      Serial.println(F("[WIFI-EVENT] Disconnected from AP."));
      Serial.printf("  Numerical Reason Code : %d\n", metrics.lastDisconnectReason);
      Serial.printf("  Diagnostic Explanation: %s\n", metrics.lastDisconnectReasonStr);
      if (metrics.lastDisconnectReason == 201) {
        Serial.println(F("  >> ACTION: Hotspot SSID not found! Ensure phone hotspot is ON and set to 2.4 GHz."));
      } else if (metrics.lastDisconnectReason == 202 || metrics.lastDisconnectReason == 14) {
        Serial.println(F("  >> ACTION: Auth failed! Check password or disable WPA3/PMF on phone."));
      }
#endif
      break;

    default:
      break;
  }
}

// ==========================================
// WIFI ENCRYPTION TYPE DECODER
// ==========================================
const char* getEncryptionTypeName(wifi_auth_mode_t authmode) {
  switch (authmode) {
    case WIFI_AUTH_OPEN:            return "OPEN (Unsecured)";
    case WIFI_AUTH_WEP:             return "WEP";
    case WIFI_AUTH_WPA_PSK:         return "WPA_PSK";
    case WIFI_AUTH_WPA2_PSK:        return "WPA2_PSK";
    case WIFI_AUTH_WPA_WPA2_PSK:    return "WPA/WPA2_MIXED";
    case WIFI_AUTH_WPA2_ENTERPRISE: return "WPA2_ENTERPRISE";
    case WIFI_AUTH_WPA3_PSK:        return "WPA3_SAE (Only)";
    case WIFI_AUTH_WPA2_WPA3_PSK:   return "WPA2/WPA3_TRANSITION";
    case WIFI_AUTH_WAPI_PSK:        return "WAPI_PSK";
    case WIFI_AUTH_OWE:             return "OWE";
    case WIFI_AUTH_WPA3_ENT_192:    return "WPA3_ENT_192";
    default:                        return "UNKNOWN";
  }
}

// ==========================================
// DETAILED 2.4 GHz SPECTRUM SCANNER
// ==========================================
void performDiagnosticScan() {
  Serial.println();
  Serial.println(F("========================================================================================="));
  Serial.println(F("  2.4 GHz AIRWAVE RF SCAN (Channels 1-13, Synchronous, Hidden Networks Enabled)"));
  Serial.println(F("========================================================================================="));
  Serial.printf("  Target Hotspot SSID : \"%s\"\n", AERON_WIFI_SSID);
  Serial.println(F("  Scanning 2.4 GHz channels... please wait ~2-3 seconds..."));

  // Ensure Station mode is active for scanning
  WiFi.mode(WIFI_STA);

  // scanNetworks(async = false, show_hidden = true)
  // Synchronous scan: blocks until all 2.4 GHz channels 1-13 are evaluated
  int16_t numNetworks = WiFi.scanNetworks(false, true);

  if (numNetworks < 0) {
    Serial.printf("  [SCAN FAILED] WiFi.scanNetworks returned error code: %d\n", numNetworks);
    Serial.println(F("========================================================================================="));
    return;
  }

  Serial.printf("  Discovered %d Wi-Fi network(s) across 2.4 GHz channels:\n", numNetworks);
  Serial.println(F("-----------------------------------------------------------------------------------------"));
  Serial.printf("  %-3s | %-4s | %-10s | %-17s | %-22s | %s\n",
                "#", "Chan", "Signal", "BSSID (MAC)", "Encryption Type", "SSID");
  Serial.println(F("-----------------------------------------------------------------------------------------"));

  bool targetFound = false;
  int targetRssi = 0;
  int targetChan = 0;
  wifi_auth_mode_t targetAuth = WIFI_AUTH_OPEN;

  for (int i = 0; i < numNetworks; ++i) {
    String ssid = WiFi.SSID(i);
    int32_t rssi = WiFi.RSSI(i);
    int32_t chan = WiFi.channel(i);
    String bssidStr = WiFi.BSSIDstr(i);
    wifi_auth_mode_t auth = WiFi.encryptionType(i);

    String displaySsid = (ssid.length() == 0) ? String("<HIDDEN SSID>") : ssid;
    bool isTarget = (ssid == AERON_WIFI_SSID);

    if (isTarget) {
      targetFound = true;
      targetRssi = rssi;
      targetChan = chan;
      targetAuth = auth;
    }

    char line[180];
    snprintf(line, sizeof(line), "  %-3d | %-4d | %-6d dBm | %-17s | %-22s | %s%s",
             i + 1,
             (int)chan,
             (int)rssi,
             bssidStr.c_str(),
             getEncryptionTypeName(auth),
             displaySsid.c_str(),
             isTarget ? " <== [TARGET HOTSPOT DETECTED!]" : "");
    Serial.println(line);
  }
  Serial.println(F("-----------------------------------------------------------------------------------------"));

  if (targetFound) {
    Serial.println(F("  >> [STATUS: REACHABLE] Target hotspot was detected in the 2.4 GHz airwaves!"));
    Serial.printf("     - Channel    : %d (2.4 GHz band)\n", targetChan);
    Serial.printf("     - Signal RSSI: %d dBm (Strong enough: %s)\n",
                  targetRssi, targetRssi > -80 ? "YES" : "WEAK - Move ESP32 closer to phone");
    Serial.printf("     - Encryption : %s\n", getEncryptionTypeName(targetAuth));
    if (targetAuth == WIFI_AUTH_WPA3_PSK) {
      Serial.println(F("     - WARNING    : Security is WPA3-SAE Only. ESP32-WROOM-32 standard station mode"));
      Serial.println(F("                    may fail handshake. Change phone hotspot security to WPA2/WPA3 Mixed."));
    }
  } else {
    Serial.printf("  >> [STATUS: NOT FOUND] Hotspot \"%s\" was NOT detected in %d nearby 2.4 GHz networks!\n",
                  AERON_WIFI_SSID, numNetworks);
    Serial.println(F("  >> ROOT CAUSE OF DISCONNECT REASON 201 (NO_AP_FOUND):"));
    Serial.println(F("     1. 5 GHz BAND ONLY (Most common):"));
    Serial.println(F("        The ESP32-WROOM-32 has a 2.4 GHz transceiver ONLY. It physically cannot receive 5 GHz."));
    Serial.println(F("        - Android: Go to Hotspot Settings > AP Band / Wi-Fi Band > Select '2.4 GHz Band'."));
    Serial.println(F("        - iPhone : Go to Settings > Personal Hotspot > Turn ON 'Maximize Compatibility'."));
    Serial.println(F("     2. PHONE HOTSPOT BROADCAST INACTIVE:"));
    Serial.println(F("        Android & iOS stop broadcasting hotspot beacons if no device connects within ~60-90s."));
    Serial.println(F("        Keep the Personal Hotspot settings screen OPEN and active on your smartphone."));
    Serial.println(F("     3. SSID TYPO / TRAILING SPACES:"));
    Serial.printf("        Looking for exact SSID: \"%s\" (Length: %d chars).\n",
                  AERON_WIFI_SSID, (int)strlen(AERON_WIFI_SSID));
  }
  Serial.println(F("========================================================================================="));

  // Free memory allocated for scan results
  WiFi.scanDelete();
}

// ==========================================
// SETUP
// ==========================================
void setup() {
  metrics.bootTimeMs = millis();
  metrics.lastMavlinkRxMs = 0;
  metrics.lastUdpBeaconMs = 0;
  metrics.lastWifiRetryMs = 0;
  metrics.lastDiagPrintMs = 0;
  metrics.lastLedBlinkMs = 0;
  metrics.uartRxBytes = 0;
  metrics.uartTxBytes = 0;
  metrics.usbTxBytes = 0;
  metrics.usbRxBytes = 0;
  metrics.wifiTxBytes = 0;
  metrics.wifiRxBytes = 0;
  metrics.tcpConnectCount = 0;
  metrics.tcpDisconnectCount = 0;
  metrics.wifiReconnectCount = 0;
  metrics.lastDisconnectReason = 0;
  metrics.wifiConnected = false;
  metrics.tcpClientConnected = false;
  metrics.mdnsStarted = false;
  metrics.servicesStarted = false;
  metrics.ledState = false;
  strncpy(metrics.lastDisconnectReasonStr, "None", sizeof(metrics.lastDisconnectReasonStr));
  strncpy(metrics.clientIp, "None", sizeof(metrics.clientIp));
  strncpy(metrics.assignedIp, "0.0.0.0", sizeof(metrics.assignedIp));

  // Initialize Status LED
  pinMode(STATUS_LED_PIN, OUTPUT);
  digitalWrite(STATUS_LED_PIN, LOW);

  // 1. Initialize USB Serial
  Serial.begin(USB_SERIAL_BAUD);

#if WIFI_DIAGNOSTIC_MODE
  delay(1000); // Allow USB-UART bridge to settle
  Serial.println();
  Serial.println(F("=================================================="));
  Serial.println(F("  AERON ESP32 TELEMETRY BRIDGE — WI-FI DIAGNOSTICS"));
  Serial.println(F("=================================================="));
  Serial.printf("  Firmware Version  : Station Mode (WIFI_STA) v2.5\n");
  Serial.printf("  Build Date & Time : %s %s\n", __DATE__, __TIME__);
  Serial.printf("  Credentials Source: %s\n", CREDENTIALS_SOURCE);
  Serial.printf("  Target Hotspot    : \"%s\"\n", AERON_WIFI_SSID);
  Serial.printf("  Password Length   : %d characters\n", (int)strlen(AERON_WIFI_PASSWORD));
  Serial.println(F("  Diagnostic Mode   : ACTIVE (USB MAVLink paused for debugging)"));
  Serial.println(F("--------------------------------------------------"));
#endif

  // 2. Initialize Pixhawk Hardware UART2 with enlarged RX buffer
  Serial2.setRxBufferSize(2048);
  Serial2.begin(PIXHAWK_BAUD, SERIAL_8N1, UART2_RX_PIN, UART2_TX_PIN);

  // Register Wi-Fi Event Handler
  WiFi.onEvent(onWiFiEvent);

  // 3. Clear any legacy SoftAP or persistent NVS state
  WiFi.persistent(false);
  WiFi.disconnect(true);
  delay(100);

#if WIFI_DIAGNOSTIC_MODE
  // Perform comprehensive 2.4 GHz airwave scan before calling WiFi.begin()
  performDiagnosticScan();
#endif

  // 4. Configure Station Mode (WIFI_STA)
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false); // Disable Wi-Fi modem sleep for minimal telemetry latency

  // Initiate connection to Mobile Hotspot
#if WIFI_DIAGNOSTIC_MODE
  Serial.printf("[CONNECT] Calling WiFi.begin(\"%s\", \"***\")...\n", AERON_WIFI_SSID);
#endif
  WiFi.begin(AERON_WIFI_SSID, AERON_WIFI_PASSWORD);

  // Allow up to 6.0s for initial association, 4-way handshake, and DHCP lease
  unsigned long startWait = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - startWait) < 6000) {
    delay(50);
  }

  // Record timestamp to give initial connection attempt sufficient time before retry
  metrics.lastWifiRetryMs = millis();

  // Check state and start network servers if connected
  checkWifiState();
}

// ==========================================
// WIFI & SERVICES INITIALIZATION
// ==========================================
void checkWifiState() {
  unsigned long now = millis();

  if (WiFi.status() == WL_CONNECTED) {
    metrics.wifiConnected = true;

    if (!metrics.servicesStarted) {
      // Record assigned DHCP IP
      String ipStr = WiFi.localIP().toString();
      strncpy(metrics.assignedIp, ipStr.c_str(), sizeof(metrics.assignedIp) - 1);

      // Start MAVLink TCP Server
      tcpServer.begin();
      tcpServer.setNoDelay(true); // Disable Nagle's algorithm for immediate low-latency packet dispatch

      // Start UDP Discovery Server & Beacon
      udp.begin(UDP_DISCOVERY_PORT);

      // Start mDNS Responder (aeron-esp32.local)
      if (MDNS.begin(MDNS_HOSTNAME)) {
        MDNS.addService("mavlink", "tcp", TCP_SERVER_PORT);
        MDNS.addService("http", "tcp", HTTP_SERVER_PORT);
        metrics.mdnsStarted = true;
      }

      // Configure & Start Diagnostic HTTP Server
      httpServer.on("/", HTTP_GET, handleRoot);
      httpServer.on("/api/status", HTTP_GET, handleStatusApi);
      httpServer.onNotFound(handleNotFound);
      httpServer.begin();

      metrics.servicesStarted = true;
    }
  } else {
    metrics.wifiConnected = false;

    // If services were previously started and Wi-Fi dropped, clean up TCP client
    if (metrics.servicesStarted) {
      metrics.servicesStarted = false;
      metrics.mdnsStarted = false;
      if (activeTcpClient) {
        activeTcpClient.stop();
        metrics.tcpClientConnected = false;
      }
      strncpy(metrics.assignedIp, "0.0.0.0", sizeof(metrics.assignedIp));
    }

    // Graceful non-blocking re-association check
    if ((now - metrics.lastWifiRetryMs) >= WIFI_RETRY_INTERVAL_MS) {
      metrics.lastWifiRetryMs = now;
      metrics.wifiReconnectCount++;
#if WIFI_DIAGNOSTIC_MODE
      Serial.println();
      Serial.printf("[RECONNECT #%lu] Hotspot '%s' not yet associated (Last Reason %d: %s).\n",
                    metrics.wifiReconnectCount,
                    AERON_WIFI_SSID,
                    metrics.lastDisconnectReason,
                    metrics.lastDisconnectReasonStr);
      // Run diagnostic scan so user can see live if phone hotspot has been turned on / switched to 2.4 GHz
      performDiagnosticScan();
      Serial.printf("[CONNECT] Re-calling WiFi.begin(\"%s\", \"***\")...\n", AERON_WIFI_SSID);
#endif
      WiFi.disconnect();
      delay(50);
      WiFi.begin(AERON_WIFI_SSID, AERON_WIFI_PASSWORD);
    }
  }
}

// ==========================================
// STATUS LED PATTERN CONTROLLER
// ==========================================
void updateStatusLed() {
  unsigned long now = millis();

  if (metrics.wifiConnected) {
    // Solid ON: Connected with valid DHCP IP
    digitalWrite(STATUS_LED_PIN, HIGH);
    metrics.ledState = true;
  } else if (metrics.lastDisconnectReason == 201 || metrics.lastDisconnectReason == 202) {
    // Slow blink (1 Hz): Error (SSID not found or Auth failed)
    if ((now - metrics.lastLedBlinkMs) >= 500) {
      metrics.lastLedBlinkMs = now;
      metrics.ledState = !metrics.ledState;
      digitalWrite(STATUS_LED_PIN, metrics.ledState ? HIGH : LOW);
    }
  } else {
    // Fast blink (5 Hz): Connecting / Scanning
    if ((now - metrics.lastLedBlinkMs) >= 100) {
      metrics.lastLedBlinkMs = now;
      metrics.ledState = !metrics.ledState;
      digitalWrite(STATUS_LED_PIN, metrics.ledState ? HIGH : LOW);
    }
  }
}

// ==========================================
// UDP DISCOVERY BEACON & PROBE HANDLER
// ==========================================
void broadcastUdpBeacon() {
  if (!metrics.wifiConnected) return;

  unsigned long now = millis();
  if ((now - metrics.lastUdpBeaconMs) < UDP_BEACON_INTERVAL_MS) return;
  metrics.lastUdpBeaconMs = now;

  unsigned long uptimeSec = (now - metrics.bootTimeMs) / 1000;
  int rssi = WiFi.RSSI();

  char beaconMsg[256];
  snprintf(
    beaconMsg,
    sizeof(beaconMsg),
    "{\"device\":\"AERON-ESP32\",\"ip\":\"%s\",\"port\":%d,\"http_port\":%d,\"mdns\":\"%s.local\",\"rssi\":%d,\"uptime\":%lu}",
    metrics.assignedIp,
    TCP_SERVER_PORT,
    HTTP_SERVER_PORT,
    MDNS_HOSTNAME,
    rssi,
    uptimeSec
  );

  // Broadcast to local subnet broadcast / 255.255.255.255
  udp.beginPacket(IPAddress(255, 255, 255, 255), UDP_DISCOVERY_PORT);
  udp.write((const uint8_t*)beaconMsg, strlen(beaconMsg));
  udp.endPacket();
}

void handleUdpProbes() {
  if (!metrics.wifiConnected) return;

  int packetSize = udp.parsePacket();
  if (packetSize > 0) {
    char packetBuffer[128];
    int len = udp.read(packetBuffer, sizeof(packetBuffer) - 1);
    if (len > 0) {
      packetBuffer[len] = '\0';
      unsigned long now = millis();
      unsigned long uptimeSec = (now - metrics.bootTimeMs) / 1000;
      char replyMsg[256];
      snprintf(
        replyMsg,
        sizeof(replyMsg),
        "{\"device\":\"AERON-ESP32\",\"ip\":\"%s\",\"port\":%d,\"http_port\":%d,\"mdns\":\"%s.local\",\"rssi\":%d,\"uptime\":%lu}",
        metrics.assignedIp,
        TCP_SERVER_PORT,
        HTTP_SERVER_PORT,
        MDNS_HOSTNAME,
        WiFi.RSSI(),
        uptimeSec
      );
      udp.beginPacket(udp.remoteIP(), udp.remotePort());
      udp.write((const uint8_t*)replyMsg, strlen(replyMsg));
      udp.endPacket();
    }
  }
}

// ==========================================
// MAIN LOOP
// ==========================================
void loop() {
  unsigned long now = millis();

  // 1. Maintain Wi-Fi state & status LED
  checkWifiState();
  updateStatusLed();

  // 2. Service Network Tasks when Connected
  if (metrics.servicesStarted) {
    httpServer.handleClient();
    broadcastUdpBeacon();
    handleUdpProbes();

    // Manage TCP Client Connections
    if (tcpServer.hasClient()) {
      WiFiClient newClient = tcpServer.available();
      if (!activeTcpClient || !activeTcpClient.connected()) {
        if (activeTcpClient) {
          activeTcpClient.stop();
          metrics.tcpDisconnectCount++;
        }
        activeTcpClient = newClient;
        activeTcpClient.setNoDelay(true);
        metrics.tcpClientConnected = true;
        metrics.tcpConnectCount++;
        strncpy(metrics.clientIp, activeTcpClient.remoteIP().toString().c_str(), sizeof(metrics.clientIp) - 1);
#if WIFI_DIAGNOSTIC_MODE
        Serial.printf("[TCP-SERVER] GCS client connected from IP: %s\n", metrics.clientIp);
#endif
      } else {
        newClient.stop(); // Reject extra clients to prevent telemetry stream fragmentation
      }
    }

    if (metrics.tcpClientConnected && (!activeTcpClient || !activeTcpClient.connected())) {
      activeTcpClient.stop();
      metrics.tcpClientConnected = false;
      metrics.tcpDisconnectCount++;
      strncpy(metrics.clientIp, "Disconnected", sizeof(metrics.clientIp) - 1);
#if WIFI_DIAGNOSTIC_MODE
      Serial.println(F("[TCP-SERVER] GCS client disconnected. Listening for reconnect..."));
#endif
    }
  }

  // 3. Read UART2 (Pixhawk) and Forward
  int availableBytes = Serial2.available();
  if (availableBytes > 0) {
    uint8_t buffer[BUFFER_CHUNK_SIZE];
    int toRead = availableBytes < BUFFER_CHUNK_SIZE ? availableBytes : BUFFER_CHUNK_SIZE;
    int bytesRead = Serial2.readBytes(buffer, toRead);

    if (bytesRead > 0) {
      metrics.lastMavlinkRxMs = millis();
      metrics.uartRxBytes += bytesRead;

      // Path B: Output over USB Serial
#if !WIFI_DIAGNOSTIC_MODE
      // In normal telemetry mode: forward clean binary MAVLink onto USB
      Serial.write(buffer, bytesRead);
      metrics.usbTxBytes += bytesRead;
#endif

      // Path A: Output over Wi-Fi TCP (if client connected)
      if (metrics.servicesStarted && metrics.tcpClientConnected && activeTcpClient.connected()) {
        size_t written = activeTcpClient.write(buffer, bytesRead);
        if (written > 0) {
          metrics.wifiTxBytes += written;
        }
      }
    }
  }

  // 4. Read Wi-Fi TCP (GCS Uplink Commands/Heartbeats) and Forward to Pixhawk UART2
  if (metrics.servicesStarted && metrics.tcpClientConnected && activeTcpClient.connected()) {
    int tcpAvail = activeTcpClient.available();
    if (tcpAvail > 0) {
      uint8_t tcpBuf[BUFFER_CHUNK_SIZE];
      int toRead = tcpAvail < BUFFER_CHUNK_SIZE ? tcpAvail : BUFFER_CHUNK_SIZE;
      int tcpBytesRead = activeTcpClient.read(tcpBuf, toRead);
      if (tcpBytesRead > 0) {
        Serial2.write(tcpBuf, tcpBytesRead);
        metrics.wifiRxBytes += tcpBytesRead;
        metrics.uartTxBytes += tcpBytesRead;
      }
    }
  }

#if !WIFI_DIAGNOSTIC_MODE
  // 5. Read USB Serial (USB GCS Uplink Commands/Heartbeats) and Forward to Pixhawk UART2
  int usbAvail = Serial.available();
  if (usbAvail > 0) {
    uint8_t usbBuf[BUFFER_CHUNK_SIZE];
    int toRead = usbAvail < BUFFER_CHUNK_SIZE ? usbAvail : BUFFER_CHUNK_SIZE;
    int usbBytesRead = Serial.readBytes(usbBuf, toRead);
    if (usbBytesRead > 0) {
      Serial2.write(usbBuf, usbBytesRead);
      metrics.usbRxBytes += usbBytesRead;
      metrics.uartTxBytes += usbBytesRead;
    }
  }
#endif

#if WIFI_DIAGNOSTIC_MODE
  // 6. Periodic Diagnostic Heartbeat Print to USB Serial (every 3 seconds)
  if ((now - metrics.lastDiagPrintMs) >= DIAG_PRINT_INTERVAL_MS) {
    metrics.lastDiagPrintMs = now;
    unsigned long uptimeSec = (now - metrics.bootTimeMs) / 1000;
    unsigned long lastMavlinkAge = metrics.lastMavlinkRxMs > 0 ? (now - metrics.lastMavlinkRxMs) : 999999;

    Serial.printf("[DIAG @ %lus] Wi-Fi: %s | IP: %s | TCP-Client: %s (%s) | UART2 RX(from FC): %lu B | TCP TX(to GCS): %lu B | TCP RX(from GCS): %lu B | Activity: %s\n",
                  uptimeSec,
                  metrics.wifiConnected ? "CONNECTED" : "DISCONNECTED",
                  metrics.assignedIp,
                  metrics.tcpClientConnected ? "CONNECTED" : "NO_CLIENT",
                  metrics.clientIp,
                  metrics.uartRxBytes,
                  metrics.wifiTxBytes,
                  metrics.wifiRxBytes,
                  lastMavlinkAge < 2000 ? "ACTIVE (<2s)" : (metrics.uartRxBytes == 0 ? "ZERO BYTES (Check Wiring/Baud)" : "STALE (>2s)"));

    if (metrics.uartRxBytes == 0) {
      Serial.println(F("  >> ZERO BYTES RECEIVED ON UART2 (GPIO16 RX2 / GPIO17 TX2 @ 57600 baud):"));
      Serial.println(F("     1. Check wiring: Pixhawk TELEM2 TX -> ESP32 GPIO16 (RX2), Pixhawk TELEM2 RX -> ESP32 GPIO17 (TX2)."));
      Serial.println(F("     2. Ensure Pixhawk GND is connected to ESP32 GND (common ground is mandatory)."));
      Serial.println(F("     3. Check Pixhawk parameter SERIAL2_BAUD: must be 57 (57600 baud)."));
      Serial.println(F("     4. Check Pixhawk parameter SERIAL2_PROTOCOL: must be 1 (MAVLink1) or 2 (MAVLink2)."));
    }

    if (!metrics.wifiConnected && metrics.lastDisconnectReason > 0) {
      Serial.printf("  >> Last Wi-Fi Disconnect Reason: %d (%s)\n",
                    metrics.lastDisconnectReason,
                    metrics.lastDisconnectReasonStr);
    }
  }
#endif

  // Yield for RTOS scheduler & Wi-Fi background tasks
  yield();
}

// ==========================================
// HTTP DIAGNOSTIC ENDPOINTS
// ==========================================
void handleStatusApi() {
  unsigned long now = millis();
  unsigned long uptimeSec = (now - metrics.bootTimeMs) / 1000;
  unsigned long lastActivityAgeMs = metrics.lastMavlinkRxMs > 0 ? (now - metrics.lastMavlinkRxMs) : 999999;
  bool wifiConnected = (WiFi.status() == WL_CONNECTED);

  char json[1024];
  snprintf(
    json,
    sizeof(json),
    "{"
      "\"system\":\"AERON-ESP32-BRIDGE\","
      "\"mode\":\"STA\","
      "\"diagnostic_mode\":%s,"
      "\"uptime_sec\":%lu,"
      "\"free_heap\":%u,"
      "\"wifi_sta\":{"
        "\"ssid\":\"%s\","
        "\"status\":\"%s\","
        "\"ip\":\"%s\","
        "\"gateway\":\"%s\","
        "\"subnet\":\"%s\","
        "\"rssi\":%d,"
        "\"mac\":\"%s\","
        "\"reconnect_count\":%lu,"
        "\"last_disconnect_reason_code\":%u,"
        "\"last_disconnect_reason\":\"%s\""
      "},"
      "\"discovery\":{"
        "\"udp_port\":%d,"
        "\"mdns_hostname\":\"%s.local\","
        "\"mdns_active\":%s"
      "},"
      "\"tcp_server\":{"
        "\"port\":%d,"
        "\"client_connected\":%s,"
        "\"client_ip\":\"%s\","
        "\"connect_count\":%lu,"
        "\"disconnect_count\":%lu"
      "},"
      "\"telemetry\":{"
        "\"uart_rx_bytes\":%lu,"
        "\"uart_tx_bytes\":%lu,"
        "\"usb_tx_bytes\":%lu,"
        "\"usb_rx_bytes\":%lu,"
        "\"wifi_tx_bytes\":%lu,"
        "\"wifi_rx_bytes\":%lu,"
        "\"last_mavlink_age_ms\":%lu,"
        "\"rx_active\":%s"
      "}"
    "}",
    WIFI_DIAGNOSTIC_MODE ? "true" : "false",
    uptimeSec,
    ESP.getFreeHeap(),
    AERON_WIFI_SSID,
    wifiConnected ? "CONNECTED" : "DISCONNECTED",
    wifiConnected ? WiFi.localIP().toString().c_str() : "0.0.0.0",
    wifiConnected ? WiFi.gatewayIP().toString().c_str() : "0.0.0.0",
    wifiConnected ? WiFi.subnetMask().toString().c_str() : "0.0.0.0",
    wifiConnected ? WiFi.RSSI() : 0,
    WiFi.macAddress().c_str(),
    metrics.wifiReconnectCount,
    metrics.lastDisconnectReason,
    metrics.lastDisconnectReasonStr,
    UDP_DISCOVERY_PORT,
    MDNS_HOSTNAME,
    metrics.mdnsStarted ? "true" : "false",
    TCP_SERVER_PORT,
    metrics.tcpClientConnected ? "true" : "false",
    metrics.clientIp,
    metrics.tcpConnectCount,
    metrics.tcpDisconnectCount,
    metrics.uartRxBytes,
    metrics.uartTxBytes,
    metrics.usbTxBytes,
    metrics.usbRxBytes,
    metrics.wifiTxBytes,
    metrics.wifiRxBytes,
    lastActivityAgeMs,
    (lastActivityAgeMs < 2000) ? "true" : "false"
  );

  httpServer.sendHeader("Access-Control-Allow-Origin", "*");
  httpServer.send(200, "application/json", json);
}

void handleRoot() {
  unsigned long now = millis();
  unsigned long uptimeSec = (now - metrics.bootTimeMs) / 1000;
  unsigned long lastActivityAgeMs = metrics.lastMavlinkRxMs > 0 ? (now - metrics.lastMavlinkRxMs) : 999999;
  bool wifiConnected = (WiFi.status() == WL_CONNECTED);
  int rssi = wifiConnected ? WiFi.RSSI() : 0;

  String html = "<!DOCTYPE html><html><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'>";
  html += "<title>AERON ESP32 Telemetry Bridge (Station Mode)</title>";
  html += "<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0b1120;color:#f8fafc;padding:20px;max-width:680px;margin:auto}";
  html += ".card{background:#1e293b;border-radius:12px;padding:16px;margin-bottom:16px;border:1px solid #334155;box-shadow:0 4px 6px -1px rgba(0,0,0,0.2)}";
  html += "h1{color:#38bdf8;font-size:20px;margin-top:0;display:flex;align-items:center;gap:8px}h2{color:#94a3b8;font-size:12px;letter-spacing:0.05em;text-transform:uppercase;margin:0 0 10px}";
  html += ".row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #334155;font-size:13px}";
  html += ".row:last-child{border-bottom:none}";
  html += ".badge{padding:3px 8px;border-radius:4px;font-weight:700;font-size:11px;font-family:monospace}";
  html += ".online{background:rgba(16,185,129,0.2);color:#34d399;border:1px solid rgba(16,185,129,0.4)}";
  html += ".offline{background:rgba(239,68,68,0.2);color:#f87171;border:1px solid rgba(239,68,68,0.4)}";
  html += ".warn{background:rgba(245,158,11,0.2);color:#fbbf24;border:1px solid rgba(245,158,11,0.4)}";
  html += ".mono{font-family:monospace;color:#e2e8f0}";
  html += "</style><meta http-equiv='refresh' content='2'></head><body>";

  html += "<h1><span style='color:#bff42e'>&#9889;</span> AERON ESP32 Dual-Transport Bridge</h1>";

  // Diagnostic Mode Warning Banner if enabled
#if WIFI_DIAGNOSTIC_MODE
  html += "<div style='background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.4);border-radius:8px;padding:12px;margin-bottom:16px;font-size:12px;color:#fbbf24;'>";
  html += "<strong>&#9888; DIAGNOSTIC MODE ACTIVE:</strong> USB Serial is operating as an interactive debug console at 115200 baud. USB MAVLink forwarding is paused while debugging. Set <code>WIFI_DIAGNOSTIC_MODE false</code> for production telemetry.";
  html += "</div>";
#endif

  // Airframe Link Card
  html += "<div class='card'><h2>Airframe MAVLink Link</h2>";
  html += "<div class='row'><span>MAVLink Ingest</span><span class='badge " + String(lastActivityAgeMs < 2000 ? "online'>ACTIVE RECEIVING" : "offline'>IDLE / WAITING") + "</span></div>";
  html += "<div class='row'><span>Last Packet Arrival</span><span class='mono'>" + String(lastActivityAgeMs < 99999 ? String(lastActivityAgeMs) + " ms ago" : "None yet") + "</span></div>";
  html += "<div class='row'><span>Pixhawk UART2 (57600)</span><span class='mono'>" + String(metrics.uartRxBytes) + " bytes</span></div>";
  html += "<div class='row'><span>USB Serial Egress (115200)</span><span class='mono'>" + String(metrics.usbTxBytes) + " bytes</span></div>";
  html += "</div>";

  // Wi-Fi Station Card
  html += "<div class='card'><h2>Wi-Fi Mobile Hotspot (Station Mode)</h2>";
  html += "<div class='row'><span>Operating Mode</span><span class='badge online'>STATION (WIFI_STA)</span></div>";
  html += "<div class='row'><span>Hotspot SSID</span><strong class='mono' style='color:#38bdf8'>" + String(AERON_WIFI_SSID) + "</strong></div>";
  html += "<div class='row'><span>Wi-Fi Connection</span><span class='badge " + String(wifiConnected ? "online'>CONNECTED" : "offline'>CONNECTING / RETRYING") + "</span></div>";
  html += "<div class='row'><span>Assigned DHCP IP</span><strong class='mono' style='color:#bff42e'>" + (wifiConnected ? WiFi.localIP().toString() : "0.0.0.0") + "</strong></div>";
  html += "<div class='row'><span>Gateway & Subnet</span><span class='mono'>" + (wifiConnected ? WiFi.gatewayIP().toString() + " (" + WiFi.subnetMask().toString() + ")" : "—") + "</span></div>";
  html += "<div class='row'><span>Signal Strength (RSSI)</span><span class='mono'>" + String(rssi) + " dBm</span></div>";
  html += "<div class='row'><span>mDNS Hostname</span><span class='mono'>" + String(MDNS_HOSTNAME) + ".local</span></div>";
  html += "<div class='row'><span>UDP Discovery Port</span><span class='mono'>" + String(UDP_DISCOVERY_PORT) + " (Beacon Active)</span></div>";
  if (!wifiConnected && metrics.lastDisconnectReason > 0) {
    html += "<div class='row'><span style='color:#f87171'>Disconnect Reason</span><span class='badge offline'>" + String(metrics.lastDisconnectReason) + ": " + String(metrics.lastDisconnectReasonStr) + "</span></div>";
  }
  html += "</div>";

  // TCP Server Card
  html += "<div class='card'><h2>MAVLink TCP Stream Server</h2>";
  html += "<div class='row'><span>TCP Port</span><span class='mono'>" + String(TCP_SERVER_PORT) + "</span></div>";
  html += "<div class='row'><span>Client State</span><span class='badge " + String(metrics.tcpClientConnected ? "online'>CLIENT CONNECTED" : "offline'>LISTENING FOR GCS") + "</span></div>";
  html += "<div class='row'><span>GCS Laptop IP</span><span class='mono'>" + String(metrics.clientIp) + "</span></div>";
  html += "<div class='row'><span>Wi-Fi TCP Egress</span><span class='mono'>" + String(metrics.wifiTxBytes) + " bytes</span></div>";
  html += "</div>";

  // Diagnostics Card
  html += "<div class='card'><h2>System Diagnostics</h2>";
  html += "<div class='row'><span>Uptime</span><span class='mono'>" + String(uptimeSec) + " s</span></div>";
  html += "<div class='row'><span>Free Heap Memory</span><span class='mono'>" + String(ESP.getFreeHeap()) + " bytes</span></div>";
  html += "<div class='row'><span>Raw JSON Telemetry</span><a href='/api/status' style='color:#38bdf8' class='mono'>/api/status</a></div>";
  html += "</div>";

  html += "</body></html>";

  httpServer.send(200, "text/html", html);
}

void handleNotFound() {
  httpServer.send(404, "text/plain", "AERON ESP32 Bridge: Endpoint Not Found");
}
