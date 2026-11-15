# AERON — REAL-TIME SATELLITE GPS TRACKING, AIRCRAFT POSITION & DYNAMIC BREADCRUMBS REPORT

**Document ID:** `AERON-REP-GPS-SAT-2026-01`  
**Date:** November 15, 2026  
**Status:** ACCEPTED & COMMISSIONED  
**System Classification:** Production Tactical Ground Control Station Mapping  
**Airframe Identity:** `AERON-HEX-01`  
**Flight Controller:** Pixhawk 2.4.8 (STM32F427 Autopilot, ArduCopter v4.5.1)  
**GNSS Hardware:** U-Blox NEO-M8N GNSS (UART @ 38,400 baud)  
**Telemetry Bridge:** ESP32 DevKit V1 (`COM8` @ 115,200 baud)  
**Mapping Engine:** Leaflet 1.9.4 with Esri World Imagery High-Resolution Satellite Tiles  

---

## 1. ROOT CAUSES IDENTIFIED IN PREVIOUS IMPLEMENTATION

An exhaustive technical audit of `admin/src/pages/GPSTrackingPage.tsx` identified several architectural defects:

| Defect | Previous State | Root Cause & Operational Impact |
| :--- | :--- | :--- |
| **Hardcoded Bengaluru Origin** | `BENCH_ORIGIN: [12.9716, 77.5946]` | Fixed coordinate forced the map, initial aircraft marker, and 500m geofence to Bengaluru rather than the physical location. |
| **Dark Gray Vector Basemap** | `Canvas/World_Dark_Gray_Base` | Lacked aerial/satellite photographic fidelity; tile fallback redirected to standard OpenStreetMap rather than satellite tiles. |
| **No Dynamic Follow Mode** | Static map view | Incoming telemetry updated the marker position via `marker.setLatLng()`, but never panned the map view or followed aircraft movements. |
| **Unconditional Simulator Controls** | `<SimulatorControlWidget />` displayed | Simulator bench panel rendered unconditionally even when authentic Pixhawk hardware was connected. |
| **Defective Simulation Defaulting** | `t.isSimulated ?? true` | Missing or undefined simulation flags were defaulted to `true`, falsely misclassifying genuine hardware as simulation. |
| **Fragile Coordinate Validity** | `!!lat && !!lon` | JavaScript truthiness checks rejected valid zero-valued coordinates (`0.0, 0.0`) and failed to check finite bounds. |
| **Moving Geofence Center** | Geofence lacked separate origin | 500m geofence had no persistent launch reference or origin persistence. |

---

## 2. SUMMARY OF CODE MODIFICATIONS & ARCHITECTURE

### 2.1 GIS & Navigation Utilities Module
Created **[admin/src/utils/gis.ts](file:///c:/Shiva/MORE/Projects/Aeron/admin/src/utils/gis.ts)** providing modular geodetic math:
- `isValidCoordinate(lat, lon)`: Verifies numeric, finite, spherical geodetic bounds ($-90..+90, -180..+180$). Correctly handles `[0, 0]`.
- `haversineDistance(lat1, lon1, lat2, lon2)`: Calculates geodesic distance across Earth radius ($R = 6,371,000\text{ m}$).
- `formatCoordinate(val, isLatitude)`: Standard aerospace formatting (e.g. `23.182940° N`, `77.301471° E`).
- `getHeadingCardinal(heading)`: 16-point cardinal compass azimuth mapping (e.g. `329° NNW`).
- `classifyGpsFix(fixType)`: Operational categorization:
  - `LIVE`: DGPS, 3D Fix, RTK Float/Fixed (`isNavReady = true`).
  - `DEGRADED`: 2D Fix (`isNavReady = false`, warning banner).
  - `NO_FIX`: Searching, None, No GPS.
- `classifyHdop(hdop)`: Precision rating (Ideal $<1.0$, Excellent $<2.0$, Good $<3.0$, Moderate $<5.0$, Poor $\ge 5.0$).
- `shouldAppendBreadcrumb(lastPoint, newPoint, minDistanceMeters = 1.0, minIntervalMs = 500)`: Rejects GPS micro-jitter below $1.0\text{ meter}$, rate-limits samples to $\ge 500\text{ ms}$, and enforces strict chronological order.
- `calculateTrackStats(breadcrumbs)`: Cumulative ground distance and track duration.
- `isNewerTelemetry(incomingTime, watermark)`: Watermark check rejecting out-of-order telemetry packets.
- `getStoredLaunchOrigin` / `setStoredLaunchOrigin` / `clearStoredLaunchOrigin`: Manages airframe-specific launch coordinates in `localStorage`.

### 2.2 Transformed GPS Tracking Page
Rebuilt **[admin/src/pages/GPSTrackingPage.tsx](file:///c:/Shiva/MORE/Projects/Aeron/admin/src/pages/GPSTrackingPage.tsx)**:
- **Satellite Map Tile Layer**: Integrated Esri World Imagery as the default layer with proper attribution.
- **Interactive Layer Switcher**: Direct one-click selection between **Satellite**, **Hybrid + Labels**, and **Road Map**.
- **Tile Error Monitoring**: Listens to `tileerror` and surfaces a prominent warning banner without silently swapping basemaps.
- **Dynamic Auto-Follow Engine**:
  - Automatically centers map on first valid real GPS frame at zoom level 17.
  - Smoothly pans with `map.panTo([lat, lon], { animate: true, duration: 0.5 })` without altering user zoom.
  - Automatically pauses follow mode when operator drags or pans the map (`map.on('dragstart')`).
  - `FOLLOW: ON / FOLLOW: OFF` toggle and `Center Vehicle` button seamlessly restore active tracking.
- **Live Aircraft Marker**:
  - High-visibility tactical disc with outer ping animation and inner heading delta arrow.
  - Rotates dynamically with `transform: rotate(${heading}deg)`.
  - Color-coded: AERON Lime (`#BFF42E`) for Real Hardware; Amber (`#F2B95F`) for Simulation.
  - Detailed popup containing Airframe ID, Lat/Lon, AGL/MSL altitude, ground speed, heading, GNSS fix, and packet timestamp.
- **Launch Origin & Fixed Geofence**:
  - `Set Launch Origin` captures current valid GPS coordinates and saves them persistently.
  - `Launch Origin Marker` rendered with blue helipad icon `⌂`.
  - Fixed 500m radius perimeter circle remains locked at the launch origin and does not drift as the aircraft flies.
  - Real-time containment diagnostics: displays distance to origin and perimeter containment status (`Within Boundary` vs `PERIMETER EXCEEDED`).
- **Provenance Separation**:
  - When `source === 'REAL'` and `isSimulated === false`: Renders green `DATA SOURCE: REAL HARDWARE` badge and completely hides simulator bench controls.
  - When explicitly simulated: Displays `SimulatorControlWidget`.
  - When awaiting data: Displays `PROVENANCE: AWAITING HARDWARE / STANDBY`.
- **Live GNSS Diagnostics Sidebar**:
  - GNSS Receiver Diagnostics (Status, Satellites count, HDOP with qualitative rating, Receiver type, Nav readiness).
  - Live Geodetic Vector (Latitude, Longitude, AGL/MSL Altitude, Ground Speed, Heading azimuth).
  - Launch Origin & Geofence (Origin coordinates, Distance, 500m Boundary status).
  - Breadcrumb Buffer (Sample count, Ground distance covered, Track duration, Packet latency).

---

## 3. SATELLITE MAP TILE SERVICE SPECIFICATION

| Layer | Tile Service URL | Native Zoom | Attribution |
| :--- | :--- | :--- | :--- |
| **Satellite (Default)** | `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}` | 0 – 19 (Max: 20) | Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community |
| **Labels Overlay (Hybrid)** | `https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}` | 0 – 19 (Max: 20) | Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community |
| **Road Map** | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | 0 – 19 (Max: 20) | © OpenStreetMap contributors |

---

## 4. REAL HARDWARE BROWSER ACCEPTANCE VERIFICATION

Browser acceptance testing was executed against the live application running on `http://localhost:5173/gps-tracking` with physical Pixhawk 2.4.8 hardware streaming over `COM8`:

```
=== PHYSICAL PIXHAWK 2.4.8 BROWSER AUDIT ===
Target Airframe: AERON-HEX-01
Basemap Tiles: Esri World Imagery (20 tiles loaded in DOM)
Leaflet Attribution: Leaflet | Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community

Live Physical Coordinates Captured:
  Latitude: 23.182940° N
  Longitude: 77.301471° E
  Altitude (AGL): 5.0 m AGL
  Altitude (MSL): 520.0 m MSL
  Ground Speed: 0.1 m/s (0.4 km/h)
  Heading Azimuth: 329° NNW
  GNSS Fix: DGPS (Fix Type 4)
  Constellation: 8 Satellites in view
  HDOP: 1.27 (Excellent (<2.0))
  Navigation Readiness: Navigation Ready (3D/DGPS)
  Data Source Badge: DATA SOURCE: REAL HARDWARE (Green)
  Simulator Bench Controls: HIDDEN (Verified)

Interactive Testing Log:
1. Auto-Follow Initial State: FOLLOW: ON (Centered on 23.182940° N, 77.301471° E)
2. Layer Switcher: Switched to Hybrid + Labels overlay. Tiles rendered cleanly.
3. Manual Pan: Mouse drag initiated. Follow status immediately switched to FOLLOW: OFF.
4. Center Vehicle: Clicked button. Map panned back to aircraft and follow resumed (FOLLOW: ON).
5. Set Launch Origin: Clicked button. Origin saved at 23.182930° N, 77.301472° E.
6. Geofence: 500m circle drawn around origin. Distance: 1 meter (Within Boundary).
7. Breadcrumbs: Real GPS jitter/movement produced 4 points, 3m ground distance, 13s duration.
```

### Visual Verification Artifacts
- **Primary Satellite Map with Live Aircraft Marker**:  
  [admin_gps_satellite_map_live.png](file:///C:/Users/shiva/.gemini/antigravity/brain/8049cc0e-fc38-4462-861c-876c394ebd4e/screenshots/admin_gps_satellite_map_live.png)
- **Hybrid Satellite Map with Road & Place Labels Overlay**:  
  [admin_gps_hybrid_layer.png](file:///C:/Users/shiva/.gemini/antigravity/brain/8049cc0e-fc38-4462-861c-876c394ebd4e/screenshots/admin_gps_hybrid_layer.png)
- **Commissioned Tracking Screen with Fixed 500m Geofence & Breadcrumb Trail**:  
  [admin_gps_tracking_satellite_commissioned.png](file:///C:/Users/shiva/.gemini/antigravity/brain/8049cc0e-fc38-4462-861c-876c394ebd4e/screenshots/admin_gps_tracking_satellite_commissioned.png)

---

## 5. FULL TEST SUITE & REGRESSION VERIFICATION

| Subsystem | Suite | Total Tests | Result | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Admin GCS** | `npm --prefix admin test` (`vitest`) | **58 / 58 Passed** | **100% Pass** | GIS utilities (30 tests) + GPS Tracking suite (28 tests). |
| **Admin GCS Build** | `npm --prefix admin run build` (`tsc && vite`) | Clean Exit 0 | **Success** | Production bundle compiled without errors. |
| **Backend API** | `npm --prefix Backend test` (`vitest`) | **214 / 214 Passed** | **100% Pass** | 15 test suites passed. |
| **Backend Build** | `npm --prefix Backend run build` (`tsc`) | Clean Exit 0 | **Success** | TypeScript compilation clean. |
| **Citizen App** | `flutter test` | **23 / 23 Passed** | **100% Pass** | Zero mobile regressions. |
| **drone-bridge** | `python -m unittest` | **26 / 26 Passed** | **100% Pass** | MAVLink parsing and telemetry tests pass. |
| **Manager App** | `npm --prefix manager run build` (`tsc && vite`) | Clean Exit 0 | **Success** | Production bundle compiled without errors. |

---

## 6. REPOSITORY REFERENCE ARTIFACTS
- GPS Tracking Page: [admin/src/pages/GPSTrackingPage.tsx](file:///c:/Shiva/MORE/Projects/Aeron/admin/src/pages/GPSTrackingPage.tsx)
- GIS & Navigation Utilities: [admin/src/utils/gis.ts](file:///c:/Shiva/MORE/Projects/Aeron/admin/src/utils/gis.ts)
- GIS Unit Tests: [admin/src/utils/__tests__/gis.test.ts](file:///c:/Shiva/MORE/Projects/Aeron/admin/src/utils/__tests__/gis.test.ts)
- GPS Tracking Integration Tests: [admin/src/pages/__tests__/GPSTracking.test.ts](file:///c:/Shiva/MORE/Projects/Aeron/admin/src/pages/__tests__/GPSTracking.test.ts)
- Telemetry Config: [admin/src/config/drone.ts](file:///c:/Shiva/MORE/Projects/Aeron/admin/src/config/drone.ts)

