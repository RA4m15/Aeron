import sys
import time
import math
from datetime import datetime, timezone
from pymavlink import mavutil

COMMAND_ACK_RESULTS = {
    0: "ACCEPTED",
    1: "TEMPORARILY_REJECTED",
    2: "DENIED",
    3: "UNSUPPORTED",
    4: "FAILED",
    5: "IN_PROGRESS",
    6: "CANCELLED"
}

GPS_FIX_TYPES = {
    0: "NO_GPS",
    1: "NO_FIX",
    2: "2D_FIX",
    3: "3D_FIX",
    4: "DGPS",
    5: "RTK_FLOAT",
    6: "RTK_FIXED",
    7: "STATIC",
    8: "PPP"
}

COPTER_MODES = {
    0: "STABILIZE", 1: "ACRO", 2: "ALT_HOLD", 3: "AUTO", 4: "GUIDED",
    5: "LOITER", 6: "RTL", 7: "CIRCLE", 9: "LAND", 11: "DRIFT",
    13: "SPORT", 14: "FLIP", 15: "AUTOTUNE", 16: "POSHOLD", 17: "BRAKE",
    18: "THROW", 19: "AVOID_ADSB", 20: "GUIDED_NOGPS", 21: "SMART_RTL",
    22: "FLOWHOLD", 23: "FOLLOW", 24: "ZIGZAG", 25: "SYSTEMID",
    26: "AUTOROTATE", 27: "AUTO_RTL"
}

def run_activation_session(port="COM9", baud=115200, passive_timeout=180):
    print("=" * 80)
    print("AERON MAVLINK GPS STREAM ACTIVATION & SATELLITE FIX VERIFICATION")
    print(f"Port: {port} @ {baud} baud | Maximum Passive Listen: {passive_timeout}s")
    print("SAFETY INTERLOCK: READ-ONLY FLIGHT OPERATION.")
    print("ONLY AUTHORIZED OUTBOUND COMMAND: MAV_CMD_SET_MESSAGE_INTERVAL (511) FOR MSG 24 & 33")
    print("=" * 80)

    # 1. Connect
    try:
        print(f"\n[1/5] Opening serial interface on {port}...")
        mav = mavutil.mavlink_connection(port, baud=baud)
    except Exception as e:
        print(f"FATAL: Unable to open {port}: {e}")
        return

    # 2. Await initial Heartbeat to discover System ID & Component ID
    print("[2/5] Listening passively for initial HEARTBEAT to discover System ID...")
    sys_id = None
    comp_id = None
    autopilot_type = None
    flight_mode = None
    is_armed = None

    t0 = time.time()
    while time.time() - t0 < 6.0:
        msg = mav.recv_match(type="HEARTBEAT", blocking=True, timeout=1.0)
        if msg:
            sys_id = getattr(msg, "get_srcSystem", lambda: getattr(msg, "sysid", 1))()
            comp_id = getattr(msg, "get_srcComponent", lambda: getattr(msg, "compid", 1))()
            autopilot_type = getattr(msg, "autopilot", 3)
            base_mode = getattr(msg, "base_mode", 0)
            custom_mode = getattr(msg, "custom_mode", 0)
            is_armed = bool(base_mode & 128)
            flight_mode = COPTER_MODES.get(custom_mode, f"MODE_{custom_mode}")
            print(f"  OK: Fresh HEARTBEAT received! Discovered System ID: {sys_id}, Component ID: {comp_id}")
            print(f"      Autopilot: {autopilot_type} (ArduPilot), Mode: {flight_mode}, Armed: {is_armed}")
            break

    if sys_id is None:
        print("FATAL: No HEARTBEAT received within 6 seconds. Aborting activation.")
        mav.close()
        return

    # 3. Transmit authorized SET_MESSAGE_INTERVAL requests
    print("\n[3/5] Transmitting authorized MAV_CMD_SET_MESSAGE_INTERVAL (511) requests...")
    ack_results = {}

    # Target component 0 specifies broadcast to all autopilot components
    target_comp = 0

    # Permitted Request A: GPS_RAW_INT (Message ID 24) at 500,000 us (2 Hz)
    print("  -> Sending MAV_CMD_SET_MESSAGE_INTERVAL: msgId=24 (GPS_RAW_INT), interval=500,000us (2 Hz)...")
    mav.mav.command_long_send(
        sys_id,         # target_system
        target_comp,    # target_component
        511,            # command: MAV_CMD_SET_MESSAGE_INTERVAL
        0,              # confirmation
        24.0,           # param1: Message ID (GPS_RAW_INT)
        500000.0,       # param2: Interval in microseconds (2 Hz)
        0.0, 0.0, 0.0, 0.0, 0.0 # param3-7: unused
    )

    # Listen for COMMAND_ACK for command 511
    ack_gps = "NO_ACK"
    ack_gps_raw = None
    t_ack = time.time()
    while time.time() - t_ack < 3.0:
        ack_msg = mav.recv_match(type="COMMAND_ACK", blocking=True, timeout=0.5)
        if ack_msg and getattr(ack_msg, "command", 0) == 511:
            res_code = getattr(ack_msg, "result", -1)
            ack_gps = COMMAND_ACK_RESULTS.get(res_code, f"UNKNOWN_{res_code}")
            ack_gps_raw = res_code
            break
    ack_results["GPS_RAW_INT_24"] = {"status": ack_gps, "raw_code": ack_gps_raw}
    print(f"     COMMAND_ACK for GPS_RAW_INT (24): {ack_gps} (result code {ack_gps_raw})")

    # Brief delay between single requests
    time.sleep(0.1)

    # Permitted Request B: GLOBAL_POSITION_INT (Message ID 33) at 500,000 us (2 Hz)
    print("  -> Sending MAV_CMD_SET_MESSAGE_INTERVAL: msgId=33 (GLOBAL_POSITION_INT), interval=500,000us (2 Hz)...")
    mav.mav.command_long_send(
        sys_id,         # target_system
        target_comp,    # target_component
        511,            # command: MAV_CMD_SET_MESSAGE_INTERVAL
        0,              # confirmation
        33.0,           # param1: Message ID (GLOBAL_POSITION_INT)
        500000.0,       # param2: Interval in microseconds (2 Hz)
        0.0, 0.0, 0.0, 0.0, 0.0 # param3-7: unused
    )

    ack_gpos = "NO_ACK"
    ack_gpos_raw = None
    t_ack2 = time.time()
    while time.time() - t_ack2 < 3.0:
        ack_msg = mav.recv_match(type="COMMAND_ACK", blocking=True, timeout=0.5)
        if ack_msg and getattr(ack_msg, "command", 0) == 511:
            res_code = getattr(ack_msg, "result", -1)
            ack_gpos = COMMAND_ACK_RESULTS.get(res_code, f"UNKNOWN_{res_code}")
            ack_gpos_raw = res_code
            break
    ack_results["GLOBAL_POSITION_INT_33"] = {"status": ack_gpos, "raw_code": ack_gpos_raw}
    print(f"     COMMAND_ACK for GLOBAL_POSITION_INT (33): {ack_gpos} (result code {ack_gpos_raw})")

    # 4. Check if commands were blocked or rejected
    if ack_gps in ("DENIED", "UNSUPPORTED") and ack_gpos in ("DENIED", "UNSUPPORTED"):
        print(f"\n[BLOCKED] Message interval requests were rejected/unsupported: GPS={ack_gps}, GPOS={ack_gpos}.")
        print("Stopping stream activation per safety requirements. Parameter writes strictly prohibited.")

    # 5. Passive verification session up to 180 seconds
    print(f"\n[4/5] Commencing passive verification listen (up to {passive_timeout}s)...")
    start_passive = time.time()
    last_print = start_passive

    counts = {"HEARTBEAT": 0, "GPS_RAW_INT": 0, "GLOBAL_POSITION_INT": 0, "COMMAND_ACK": 0}
    first_seen = {}
    last_seen = {}
    gps_raw_history = []
    gpos_history = []
    first_3d_fix_time = None

    try:
        while True:
            elapsed = time.time() - start_passive
            if elapsed >= passive_timeout:
                print(f"\n[INFO] Reached {passive_timeout}s diagnostic timeout. Concluding session.")
                break

            msg = mav.recv_match(blocking=True, timeout=0.5)
            now = time.time()

            if msg:
                mtype = msg.get_type()
                counts[mtype] = counts.get(mtype, 0) + 1
                if mtype not in first_seen:
                    first_seen[mtype] = now
                last_seen[mtype] = now

                if mtype == "GPS_RAW_INT":
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

                    lat = round(raw_lat / 1e7, 7) if (raw_lat != 0 and raw_fix >= 2) else None
                    lon = round(raw_lon / 1e7, 7) if (raw_lon != 0 and raw_fix >= 2) else None
                    alt = round(raw_alt / 1000.0, 2) if (raw_alt != 0 and raw_fix >= 2) else None
                    hdop = round(raw_eph / 100.0, 2) if raw_eph != 65535 else None
                    vdop = round(raw_epv / 100.0, 2) if raw_epv != 65535 else None
                    vel_mps = round(raw_vel / 100.0, 2) if raw_vel != 65535 else None
                    cog_deg = round(raw_cog / 100.0, 1) if raw_cog != 65535 else None

                    entry = {
                        "elapsed": elapsed,
                        "time": now,
                        "fix_type_raw": raw_fix,
                        "fix_type": fix_str,
                        "satellites": satellites,
                        "hdop": hdop,
                        "vdop": vdop,
                        "lat": lat,
                        "lon": lon,
                        "alt_m": alt,
                        "vel_mps": vel_mps,
                        "cog_deg": cog_deg
                    }
                    gps_raw_history.append(entry)

                    if raw_fix >= 3 and first_3d_fix_time is None:
                        first_3d_fix_time = elapsed
                        print(f"\n>>> [3D SATELLITE FIX ACQUIRED at +{elapsed:.1f}s]: Fix={fix_str}, Sats={satellites}, Pos=({lat}, {lon}), HDOP={hdop} <<<\n")

                elif mtype == "GLOBAL_POSITION_INT":
                    raw_lat = getattr(msg, "lat", 0)
                    raw_lon = getattr(msg, "lon", 0)
                    raw_alt = getattr(msg, "alt", 0)
                    raw_rel = getattr(msg, "relative_alt", 0)
                    vx = getattr(msg, "vx", 0)
                    vy = getattr(msg, "vy", 0)
                    vz = getattr(msg, "vz", 0)
                    raw_hdg = getattr(msg, "hdg", 65535)

                    lat = round(raw_lat / 1e7, 7) if (raw_lat != 0 or raw_lon != 0) else None
                    lon = round(raw_lon / 1e7, 7) if (raw_lat != 0 or raw_lon != 0) else None
                    alt = round(raw_alt / 1000.0, 2) if raw_alt != 0 else None
                    rel_alt = round(raw_rel / 1000.0, 2)
                    spd = round(math.sqrt(vx**2 + vy**2) / 100.0, 2)
                    hdg = round(raw_hdg / 100.0, 1) if (raw_hdg != 65535 and 0 <= raw_hdg <= 36000) else None

                    gpos_history.append({
                        "elapsed": elapsed,
                        "time": now,
                        "lat": lat,
                        "lon": lon,
                        "alt_m": alt,
                        "relative_alt_m": rel_alt,
                        "ground_speed_mps": spd,
                        "heading_deg": hdg
                    })

            # Print status update every 10 seconds
            if (now - last_print) >= 10.0:
                hb = counts.get("HEARTBEAT", 0)
                gps = counts.get("GPS_RAW_INT", 0)
                gpos = counts.get("GLOBAL_POSITION_INT", 0)
                cur_fix = gps_raw_history[-1]["fix_type"] if gps_raw_history else "NO_PACKETS"
                cur_sats = gps_raw_history[-1]["satellites"] if gps_raw_history else 0
                cur_hdop = gps_raw_history[-1]["hdop"] if gps_raw_history else "--"
                print(f"[{elapsed:.1f}s / {passive_timeout}s] HB: {hb} | GPS_RAW: {gps} (Fix: {cur_fix}, Sats: {cur_sats}, HDOP: {cur_hdop}) | GPOS: {gpos}")
                last_print = now

    except KeyboardInterrupt:
        print("\n[INFO] Session interrupted by operator.")
    finally:
        mav.close()

    total_listen = time.time() - start_passive

    # 6. Evaluation and Classification
    print("\n" + "=" * 80)
    print("SESSION SUMMARY & EMPIRICAL EVIDENCE")
    print(f"Listen Duration: {total_listen:.2f} seconds")
    print("=" * 80)

    print("\n--- Command Acknowledgment Summary ---")
    for req_name, d in ack_results.items():
        print(f"  {req_name:<25}: Status = {d['status']} (Code: {d['raw_code']})")

    print("\n--- MAVLink Message Inventory ---")
    print(f"{'MESSAGE':<22} | {'COUNT':<7} | {'FREQ (Hz)':<10} | {'FIRST SEEN':<12} | {'LAST SEEN'}")
    print("-" * 75)
    for mtype in ["HEARTBEAT", "GPS_RAW_INT", "GLOBAL_POSITION_INT", "COMMAND_ACK"]:
        c = counts.get(mtype, 0)
        freq = c / total_listen if total_listen > 0 else 0
        f_str = f"+{first_seen[mtype] - start_passive:.1f}s" if mtype in first_seen else "--"
        l_str = f"+{last_seen[mtype] - start_passive:.1f}s" if mtype in last_seen else "--"
        print(f"{mtype:<22} | {c:<7} | {freq:<10.2f} | {f_str:<12} | {l_str}")

    # Decoded GPS findings
    print("\n--- GPS_RAW_INT Decoded State ---")
    if gps_raw_history:
        latest = gps_raw_history[-1]
        print(f"  Total Packets Received     : {len(gps_raw_history)}")
        print(f"  Latest Fix Type            : {latest['fix_type']} (Raw: {latest['fix_type_raw']})")
        print(f"  Satellites Visible         : {latest['satellites']}")
        print(f"  HDOP Estimate              : {latest['hdop']}")
        print(f"  VDOP Estimate              : {latest['vdop']}")
        print(f"  Ground Velocity            : {latest['vel_mps']} m/s")
        print(f"  Course Over Ground         : {latest['cog_deg']}°")
        print(f"  Decoded Latitude           : {latest['lat']}")
        print(f"  Decoded Longitude          : {latest['lon']}")
        print(f"  Altitude MSL               : {latest['alt_m']} m")
        if first_3d_fix_time is not None:
            print(f"  Time to 3D Fix (TTFF)      : +{first_3d_fix_time:.1f} seconds")
        else:
            print(f"  Time to 3D Fix (TTFF)      : NOT ACQUIRED (Current fix: {latest['fix_type']})")
    else:
        print("  Zero GPS_RAW_INT packets received.")

    # Decoded Fused Global Position
    print("\n--- GLOBAL_POSITION_INT Decoded State ---")
    if gpos_history:
        latest_gp = gpos_history[-1]
        print(f"  Total Packets Received     : {len(gpos_history)}")
        print(f"  Fused Latitude             : {latest_gp['lat']}")
        print(f"  Fused Longitude            : {latest_gp['lon']}")
        print(f"  Fused Altitude (MSL)       : {latest_gp['alt_m']} m")
        print(f"  Relative Altitude (AGL)    : {latest_gp['relative_alt_m']} m")
        print(f"  Ground Speed               : {latest_gp['ground_speed_mps']} m/s")
        print(f"  Heading                    : {latest_gp['heading_deg']}°")
    else:
        print("  Zero GLOBAL_POSITION_INT packets received.")

    # Determine Classification
    print("\n" + "=" * 80)
    print("FINAL CLASSIFICATION DETERMINATION")
    print("=" * 80)

    has_gps_raw = len(gps_raw_history) > 0
    has_gpos = len(gpos_history) > 0
    latest_fix_raw = gps_raw_history[-1]["fix_type_raw"] if has_gps_raw else 0
    ack_gps_ok = ack_results.get("GPS_RAW_INT_24", {}).get("status") == "ACCEPTED"
    ack_gpos_ok = ack_results.get("GLOBAL_POSITION_INT_33", {}).get("status") == "ACCEPTED"

    if has_gps_raw and latest_fix_raw >= 3:
        classification = "CASE A: GPS COMMUNICATION VERIFIED. GPS 3D OR BETTER FIX VERIFIED."
        overall_status = "PHYSICALLY VERIFIED"
    elif has_gps_raw and latest_fix_raw < 3:
        classification = "CASE B: GPS COMMUNICATION VERIFIED. SATELLITE FIX NOT ESTABLISHED."
        overall_status = "PARTIALLY VERIFIED"
    elif (ack_gps_ok or ack_gpos_ok) and not has_gps_raw:
        classification = "CASE C: STREAM REQUEST ACCEPTED. GPS MESSAGES NOT RECEIVED."
        overall_status = "BLOCKED"
    elif not ack_gps_ok and not ack_gpos_ok and (ack_gps in ("DENIED", "UNSUPPORTED") or ack_gpos in ("DENIED", "UNSUPPORTED")):
        classification = "CASE D: MAVLINK GPS STREAM ACTIVATION BLOCKED."
        overall_status = "BLOCKED"
    else:
        classification = "CASE E: GPS STREAM REQUEST UNCONFIRMED."
        overall_status = "BLOCKED"

    print(f"RESULT: {classification}")
    print(f"OVERALL STATUS: {overall_status}")
    print("=" * 80)

if __name__ == "__main__":
    run_activation_session(port="COM9", baud=115200, passive_timeout=180)

