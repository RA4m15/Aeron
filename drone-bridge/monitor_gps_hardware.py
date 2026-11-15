import time
import math
from datetime import datetime, timezone
from pymavlink import mavutil

# ArduPilot Copter Modes
COPTER_MODES = {
    0: "STABILIZE", 1: "ACRO", 2: "ALT_HOLD", 3: "AUTO", 4: "GUIDED",
    5: "LOITER", 6: "RTL", 7: "CIRCLE", 9: "LAND", 11: "DRIFT",
    13: "SPORT", 14: "FLIP", 15: "AUTOTUNE", 16: "POSHOLD", 17: "BRAKE",
    18: "THROW", 19: "AVOID_ADSB", 20: "GUIDED_NOGPS", 21: "SMART_RTL",
    22: "FLOWHOLD", 23: "FOLLOW", 24: "ZIGZAG", 25: "SYSTEMID",
    26: "AUTOROTATE", 27: "AUTO_RTL"
}

GPS_FIX_TYPES = {
    0: "NO_GPS", 1: "NO_FIX", 2: "2D_FIX", 3: "3D_FIX",
    4: "DGPS", 5: "RTK_FLOAT", 6: "RTK_FIXED", 7: "STATIC", 8: "PPP"
}

def run_passive_monitor(port="COM9", baud=115200, max_duration_sec=180):
    print("=" * 80)
    print(f"AERON PASSIVE GPS & MAVLINK HARDWARE MONITOR")
    print(f"Port: {port} @ {baud} baud | Maximum Duration: {max_duration_sec}s")
    print("SAFETY RULE: STRICTLY PASSIVE RECEPTION — ZERO OUTBOUND TRANSMISSIONS")
    print("=" * 80)

    try:
        mav = mavutil.mavlink_connection(port, baud=baud)
    except Exception as e:
        print(f"FATAL: Unable to open {port}: {e}")
        return

    start_time = time.time()
    last_status_print = start_time

    # Tracking structures
    message_counts = {}
    message_first_seen = {}
    message_last_seen = {}
    sys_ids = set()
    comp_ids = set()

    gps_raw_records = []
    global_pos_records = []
    status_text_records = []
    sys_status_records = []
    heartbeat_records = []
    attitude_records = []

    first_fix_time = None

    print(f"[{datetime.now(timezone.utc).isoformat()}] Listening passively for incoming packets...")

    try:
        while True:
            elapsed = time.time() - start_time
            if elapsed >= max_duration_sec:
                print(f"\n[INFO] Reached maximum diagnostic duration of {max_duration_sec} seconds. Concluding session.")
                break

            msg = mav.recv_match(blocking=True, timeout=0.5)
            if not msg:
                # Periodic progress output every 10 seconds
                now = time.time()
                if (now - last_status_print) >= 10.0:
                    hb_count = message_counts.get("HEARTBEAT", 0)
                    gps_count = message_counts.get("GPS_RAW_INT", 0)
                    gpos_count = message_counts.get("GLOBAL_POSITION_INT", 0)
                    print(f"[{elapsed:.1f}s / {max_duration_sec}s] Active listen... HB: {hb_count} | GPS_RAW: {gps_count} | GLOBAL_POS: {gpos_count}")
                    last_status_print = now
                continue

            now = time.time()
            mtype = msg.get_type()

            # Record frequency & timestamps
            message_counts[mtype] = message_counts.get(mtype, 0) + 1
            if mtype not in message_first_seen:
                message_first_seen[mtype] = now
            message_last_seen[mtype] = now

            # Source IDs
            s_id = getattr(msg, "get_srcSystem", lambda: getattr(msg, "sysid", None))()
            c_id = getattr(msg, "get_srcComponent", lambda: getattr(msg, "compid", None))()
            if s_id is not None: sys_ids.add(s_id)
            if c_id is not None: comp_ids.add(c_id)

            # Specific message decoding
            if mtype == "HEARTBEAT":
                base_mode = getattr(msg, "base_mode", 0)
                custom_mode = getattr(msg, "custom_mode", 0)
                armed = bool(base_mode & 128)
                mode_str = COPTER_MODES.get(custom_mode, f"MODE_{custom_mode}")
                hb_data = {
                    "time": now,
                    "elapsed": now - start_time,
                    "sys_id": s_id,
                    "comp_id": c_id,
                    "autopilot": getattr(msg, "autopilot", None),
                    "type": getattr(msg, "type", None),
                    "armed": armed,
                    "mode": mode_str,
                    "custom_mode": custom_mode,
                    "system_status": getattr(msg, "system_status", None),
                    "mavlink_version": getattr(msg, "mavlink_version", None)
                }
                heartbeat_records.append(hb_data)

            elif mtype == "GPS_RAW_INT":
                raw_fix = getattr(msg, "fix_type", 0)
                fix_str = GPS_FIX_TYPES.get(raw_fix, f"UNKNOWN_{raw_fix}")
                raw_lat = getattr(msg, "lat", 0)
                raw_lon = getattr(msg, "lon", 0)
                raw_alt = getattr(msg, "alt", 0)
                satellites = getattr(msg, "satellites_visible", 0)
                raw_eph = getattr(msg, "eph", 65535)
                raw_epv = getattr(msg, "epv", 65535)
                raw_vel = getattr(msg, "vel", 65535)
                raw_cog = getattr(msg, "cog", 65535)

                lat = raw_lat / 1e7 if (raw_lat != 0 and raw_fix >= 2) else None
                lon = raw_lon / 1e7 if (raw_lon != 0 and raw_fix >= 2) else None
                alt = raw_alt / 1000.0 if (raw_alt != 0 and raw_fix >= 2) else None
                hdop = raw_eph / 100.0 if raw_eph != 65535 else None
                vdop = raw_epv / 100.0 if raw_epv != 65535 else None
                vel_mps = raw_vel / 100.0 if raw_vel != 65535 else None
                cog_deg = raw_cog / 100.0 if raw_cog != 65535 else None

                gps_data = {
                    "time": now,
                    "elapsed": now - start_time,
                    "fix_type_raw": raw_fix,
                    "fix_type": fix_str,
                    "satellites": satellites,
                    "lat": lat,
                    "lon": lon,
                    "alt_m": alt,
                    "hdop": hdop,
                    "vdop": vdop,
                    "vel_mps": vel_mps,
                    "cog_deg": cog_deg
                }
                gps_raw_records.append(gps_data)

                if raw_fix >= 2 and first_fix_time is None:
                    first_fix_time = now - start_time
                    print(f"\n>>> [GPS FIX ACQUIRED at +{first_fix_time:.1f}s]: Fix={fix_str}, Sats={satellites}, Pos=({lat}, {lon}), HDOP={hdop} <<<\n")

            elif mtype == "GLOBAL_POSITION_INT":
                raw_lat = getattr(msg, "lat", 0)
                raw_lon = getattr(msg, "lon", 0)
                raw_alt = getattr(msg, "alt", 0)
                raw_rel_alt = getattr(msg, "relative_alt", 0)
                vx = getattr(msg, "vx", 0)
                vy = getattr(msg, "vy", 0)
                vz = getattr(msg, "vz", 0)
                raw_hdg = getattr(msg, "hdg", 65535)

                lat = raw_lat / 1e7 if (raw_lat != 0 or raw_lon != 0) else None
                lon = raw_lon / 1e7 if (raw_lat != 0 or raw_lon != 0) else None
                alt = raw_alt / 1000.0 if raw_alt != 0 else None
                rel_alt = raw_rel_alt / 1000.0
                gnd_spd = round(math.sqrt(vx**2 + vy**2) / 100.0, 2)
                vz_mps = round(-vz / 100.0, 2) # vz is positive down
                heading = round(raw_hdg / 100.0, 1) if (raw_hdg != 65535 and 0 <= raw_hdg <= 36000) else None

                gpos_data = {
                    "time": now,
                    "elapsed": now - start_time,
                    "lat": lat,
                    "lon": lon,
                    "alt_m": alt,
                    "relative_alt_m": rel_alt,
                    "ground_speed_mps": gnd_spd,
                    "vertical_speed_mps": vz_mps,
                    "heading_deg": heading
                }
                global_pos_records.append(gpos_data)

            elif mtype == "SYS_STATUS":
                sensors_present = getattr(msg, "onboard_control_sensors_present", 0)
                sensors_enabled = getattr(msg, "onboard_control_sensors_enabled", 0)
                sensors_health = getattr(msg, "onboard_control_sensors_health", 0)
                # Bit 5 (value 32) is MAV_SYS_STATUS_SENSOR_GPS
                gps_present = bool(sensors_present & 32)
                gps_enabled = bool(sensors_enabled & 32)
                gps_healthy = bool(sensors_health & 32)

                sys_status_records.append({
                    "time": now,
                    "elapsed": now - start_time,
                    "gps_present": gps_present,
                    "gps_enabled": gps_enabled,
                    "gps_healthy": gps_healthy,
                    "voltage_mv": getattr(msg, "voltage_battery", 65535),
                    "current_ca": getattr(msg, "current_battery", -1)
                })

            elif mtype == "STATUSTEXT":
                text = getattr(msg, "text", "")
                severity = getattr(msg, "severity", 0)
                status_text_records.append({
                    "time": now,
                    "elapsed": now - start_time,
                    "severity": severity,
                    "text": text
                })
                print(f"[STATUSTEXT at +{now - start_time:.1f}s] Severity {severity}: {text}")

            elif mtype == "ATTITUDE":
                attitude_records.append({
                    "time": now,
                    "elapsed": now - start_time,
                    "roll_deg": round(math.degrees(getattr(msg, "roll", 0.0)), 2),
                    "pitch_deg": round(math.degrees(getattr(msg, "pitch", 0.0)), 2),
                    "yaw_deg": round((math.degrees(getattr(msg, "yaw", 0.0)) + 360.0) % 360.0, 2)
                })

            # Periodic progress output every 10 seconds
            if (now - last_status_print) >= 10.0:
                hb_count = message_counts.get("HEARTBEAT", 0)
                gps_count = message_counts.get("GPS_RAW_INT", 0)
                gpos_count = message_counts.get("GLOBAL_POSITION_INT", 0)
                latest_fix = gps_raw_records[-1]["fix_type"] if gps_raw_records else "NO_MESSAGES"
                latest_sats = gps_raw_records[-1]["satellites"] if gps_raw_records else 0
                print(f"[{elapsed:.1f}s / {max_duration_sec}s] HB: {hb_count} | GPS_RAW: {gps_count} (Fix: {latest_fix}, Sats: {latest_sats}) | GPOS: {gpos_count}")
                last_status_print = now

    except KeyboardInterrupt:
        print("\n[INFO] Diagnostic session aborted by operator via Ctrl+C.")
    finally:
        mav.close()

    total_duration = time.time() - start_time
    print("\n" + "=" * 80)
    print(f"AERON PASSIVE GPS DIAGNOSTIC SESSION COMPLETED")
    print(f"Total Duration: {total_duration:.2f} seconds")
    print(f"Unique System IDs: {list(sys_ids)} | Component IDs: {list(comp_ids)}")
    print("=" * 80)

    # Output detailed message summary
    print("\n--- MAVLink Message Inventory ---")
    print(f"{'MESSAGE TYPE':<25} | {'COUNT':<8} | {'FREQ (Hz)':<10} | {'FIRST SEEN':<12} | {'LAST SEEN'}")
    print("-" * 75)
    for mtype, count in sorted(message_counts.items(), key=lambda x: -x[1]):
        freq = count / total_duration if total_duration > 0 else 0
        first_s = f"+{message_first_seen[mtype] - start_time:.1f}s"
        last_s = f"+{message_last_seen[mtype] - start_time:.1f}s"
        print(f"{mtype:<25} | {count:<8} | {freq:<10.2f} | {first_s:<12} | {last_s}")

    # STATUSTEXT Findings
    if status_text_records:
        print("\n--- Captured ArduPilot STATUSTEXT Messages ---")
        for st in status_text_records:
            print(f"  [+{st['elapsed']:.1f}s] Sev {st['severity']}: {st['text']}")
    else:
        print("\n--- Captured ArduPilot STATUSTEXT Messages ---")
        print("  None received during passive listen.")

    # SYS_STATUS Sensor Health Findings
    if sys_status_records:
        latest_sys = sys_status_records[-1]
        print("\n--- SYS_STATUS Onboard Sensor Health (Bit 5 / 32 = GPS) ---")
        print(f"  GPS Sensor Present : {latest_sys['gps_present']}")
        print(f"  GPS Sensor Enabled : {latest_sys['gps_enabled']}")
        print(f"  GPS Sensor Healthy : {latest_sys['gps_healthy']}")
    else:
        print("\n--- SYS_STATUS Sensor Health ---")
        print("  SYS_STATUS not received over passive link.")

    # GPS_RAW_INT Analysis
    print("\n--- GPS_RAW_INT Analysis ---")
    if gps_raw_records:
        latest_gps = gps_raw_records[-1]
        print(f"  Total GPS_RAW_INT frames received : {len(gps_raw_records)}")
        print(f"  Latest Fix Type                   : {latest_gps['fix_type']} (raw={latest_gps['fix_type_raw']})")
        print(f"  Satellites Visible                : {latest_gps['satellites']}")
        print(f"  HDOP Estimate                     : {latest_gps['hdop']}")
        print(f"  VDOP Estimate                     : {latest_gps['vdop']}")
        print(f"  Ground Velocity                   : {latest_gps['vel_mps']} m/s")
        print(f"  Course Over Ground                : {latest_gps['cog_deg']}°")
        print(f"  Latitude                          : {latest_gps['lat']}")
        print(f"  Longitude                         : {latest_gps['lon']}")
        print(f"  Altitude MSL                      : {latest_gps['alt_m']} m")
        if first_fix_time:
            print(f"  Time to First Fix                 : {first_fix_time:.1f} seconds")
        else:
            print(f"  Time to First Fix                 : NOT ACQUIRED")
    else:
        print("  Zero GPS_RAW_INT messages received over passive link.")

    # GLOBAL_POSITION_INT Analysis
    print("\n--- GLOBAL_POSITION_INT Analysis ---")
    if global_pos_records:
        latest_gpos = global_pos_records[-1]
        print(f"  Total GLOBAL_POSITION_INT frames : {len(global_pos_records)}")
        print(f"  Fused Latitude                   : {latest_gpos['lat']}")
        print(f"  Fused Longitude                  : {latest_gpos['lon']}")
        print(f"  Fused Altitude (MSL)             : {latest_gpos['alt_m']} m")
        print(f"  Relative Altitude (AGL)          : {latest_gpos['relative_alt_m']} m")
        print(f"  Ground Speed                     : {latest_gpos['ground_speed_mps']} m/s")
        print(f"  Vertical Speed                   : {latest_gpos['vertical_speed_mps']} m/s")
        print(f"  Heading                          : {latest_gpos['heading_deg']}°")
    else:
        print("  Zero GLOBAL_POSITION_INT messages received over passive link.")

    # Classification logic
    print("\n" + "=" * 80)
    print("FINAL GPS HARDWARE & FIX CLASSIFICATION")
    print("=" * 80)

    if gps_raw_records:
        latest_gps = gps_raw_records[-1]
        raw_fix = latest_gps["fix_type_raw"]
        if raw_fix >= 2 and latest_gps["lat"] is not None and latest_gps["lon"] is not None:
            print("CLASSIFICATION: PHYSICALLY CONNECTED AND GPS FIX VERIFIED")
            print(f"Status: Module communication verified and valid {latest_gps['fix_type']} lock established.")
        else:
            print("CLASSIFICATION: GPS COMMUNICATION VERIFIED — SATELLITE FIX PENDING")
            print(f"Status: GPS_RAW_INT received, but satellite fix is {latest_gps['fix_type']} ({latest_gps['satellites']} satellites).")
    else:
        # Check if SYS_STATUS reported GPS sensor
        if sys_status_records and sys_status_records[-1]["gps_present"]:
            print("CLASSIFICATION: MAVLINK GPS STREAM NOT AVAILABLE")
            print("Status: Pixhawk SYS_STATUS indicates GPS hardware is present, but GPS_RAW_INT telemetry stream is not published over USB default parameters.")
        else:
            print("CLASSIFICATION: MAVLINK GPS STREAM NOT AVAILABLE")
            print("Status: Zero GPS messages received on passive USB connection.")
    print("=" * 80)

if __name__ == "__main__":
    run_passive_monitor(port="COM9", baud=115200, max_duration_sec=180)

