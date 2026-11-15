import time
import collections
from pymavlink import mavutil

print("=== AERON HARDWARE MAVLINK MEASUREMENT BENCHMARK ===")
print("Opening COM8 @ 115200 baud...")

conn = mavutil.mavlink_connection('COM8', baud=115200)
conn.wait_heartbeat(timeout=5)
print(f"HEARTBEAT detected! System: {conn.target_system}, Component: {conn.target_component}")

# Request high-rate ATTITUDE stream: 50,000 us = 20 Hz, or 100,000 us = 10 Hz
print("Requesting message intervals from Pixhawk:")
print(" - ATTITUDE (msg 30) @ 50,000 us (20 Hz)")
conn.mav.command_long_send(
    conn.target_system,
    conn.target_component,
    mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL,
    0,
    30,      # MAVLINK_MSG_ID_ATTITUDE
    50000,   # 50,000 us = 20 Hz
    0, 0, 0, 0, 0
)

# Also request data stream rates using legacy request_data_stream if needed
conn.mav.request_data_stream_send(
    conn.target_system,
    conn.target_component,
    mavutil.mavlink.MAV_DATA_STREAM_EXTRA1, # EXTRA1 contains ATTITUDE
    20, # 20 Hz
    1   # Start
)

# Also request other standard streams
conn.mav.command_long_send(
    conn.target_system,
    conn.target_component,
    mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL,
    0,
    33, 250000, 0, 0, 0, 0, 0 # GLOBAL_POSITION_INT @ 4 Hz
)
conn.mav.command_long_send(
    conn.target_system,
    conn.target_component,
    mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL,
    0,
    24, 500000, 0, 0, 0, 0, 0 # GPS_RAW_INT @ 2 Hz
)

print("Benchmarking incoming packets over 10 seconds...")
start_time = time.time()
counts = collections.Counter()
attitude_times = []
attitude_boot_times = []
last_att_time = None
last_boot_ms = None

while time.time() - start_time < 10.0:
    msg = conn.recv_match(blocking=True, timeout=0.1)
    if not msg:
        continue
    mtype = msg.get_type()
    counts[mtype] += 1

    if mtype == "ATTITUDE":
        now = time.time()
        boot_ms = getattr(msg, "time_boot_ms", 0)
        if last_att_time is not None:
            dt = (now - last_att_time) * 1000.0
            dt_boot = boot_ms - last_boot_ms
            attitude_times.append(dt)
            attitude_boot_times.append(dt_boot)
        last_att_time = now
        last_boot_ms = boot_ms

duration = time.time() - start_time
conn.close()

print(f"\n--- Benchmark Results over {duration:.2f} seconds ---")
for mtype, count in counts.most_common():
    hz = count / duration
    print(f"  {mtype:<25}: {count:5d} packets ({hz:6.2f} Hz)")

if attitude_times:
    avg_dt = sum(attitude_times) / len(attitude_times)
    min_dt = min(attitude_times)
    max_dt = max(attitude_times)
    avg_boot_dt = sum(attitude_boot_times) / len(attitude_boot_times)
    print(f"\nATTITUDE Packet Timing (COM8 Reception):")
    print(f"  Total ATTITUDE packets : {len(attitude_times) + 1}")
    print(f"  Average interval       : {avg_dt:.2f} ms ({1000.0/avg_dt:.2f} Hz)")
    print(f"  Min / Max interval     : {min_dt:.2f} ms / {max_dt:.2f} ms")
    print(f"  Pixhawk boot_ms delta  : {avg_boot_dt:.2f} ms avg")
else:
    print("\nWARNING: No ATTITUDE packets received during benchmark!")

