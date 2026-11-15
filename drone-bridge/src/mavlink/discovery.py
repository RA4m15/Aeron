import time
import json
import socket
import logging
from typing import Tuple, Optional, Dict, Any
from ..logging_config import setup_logging

logger = setup_logging("ESP32-DISCOVERY")

MDNS_HOSTNAME = "aeron-esp32.local"
DEFAULT_UDP_PORT = 37020

def is_valid_ipv4(ip_str: str) -> bool:
    """Checks whether a string is a valid IPv4 address."""
    parts = ip_str.strip().split(".")
    if len(parts) != 4:
        return False
    for p in parts:
        if not p.isdigit() or not 0 <= int(p) <= 255:
            return False
    return True

def probe_udp_beacon(udp_port: int = DEFAULT_UDP_PORT, timeout: float = 1.8) -> Optional[Dict[str, Any]]:
    """
    Broadcasts an AERON_DISCOVER probe and listens for UDP beacon announcements from the ESP32.
    Returns the parsed beacon JSON payload if discovered, or None if timed out.
    """
    sock = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.settimeout(timeout)

        # Broadcast active probe
        probe_payload = b'{"cmd":"AERON_DISCOVER","client":"AERON-GCS"}'
        try:
            sock.sendto(probe_payload, ("255.255.255.255", udp_port))
        except Exception as send_err:
            logger.debug(f"Broadcast probe send exception: {send_err}")

        # Listen for beacon or reply
        start_t = time.time()
        while (time.time() - start_t) < timeout:
            try:
                data, (sender_ip, sender_port) = sock.recvfrom(1024)
                if not data:
                    continue
                try:
                    payload = json.loads(data.decode("utf-8", errors="ignore"))
                    if payload.get("device") == "AERON-ESP32":
                        # Validate IP: fallback to sender_ip if payload IP is blank
                        reported_ip = payload.get("ip") or sender_ip
                        payload["ip"] = reported_ip
                        payload["discovered_from"] = sender_ip
                        return payload
                except json.JSONDecodeError:
                    continue
            except socket.timeout:
                break
    except Exception as err:
        logger.debug(f"UDP probe exception: {err}")
    finally:
        if sock:
            try:
                sock.close()
            except Exception:
                pass
    return None

def resolve_esp32_address(
    host: str = "auto",
    fallback_ip: str = "192.168.4.1",
    udp_port: int = DEFAULT_UDP_PORT,
    timeout: float = 2.0
) -> Tuple[str, str, bool, str]:
    """
    Discovers and resolves the ESP32's current IP address in Station Mode on a mobile hotspot.
    Priority order:
      1. Explicit IPv4 passed by user (Manual)
      2. mDNS lookup: aeron-esp32.local (Native DNS-SD)
      3. UDP Discovery Beacon: port 37020 broadcast listener
      4. Fallback IP (Configured default)

    Returns:
      (resolved_ip, method, client_isolation_suspected, diagnostic_message)
    """
    clean_host = host.strip()

    # 1. Manual explicit IP
    if clean_host != "auto" and clean_host != MDNS_HOSTNAME and is_valid_ipv4(clean_host):
        return clean_host, "MANUAL", False, f"Using explicitly configured ESP32 IP: {clean_host}"

    # 2. Try mDNS resolution
    try:
        resolved = socket.gethostbyname(MDNS_HOSTNAME)
        if resolved and not resolved.startswith("127."):
            logger.info(f"Discovered ESP32 via mDNS ({MDNS_HOSTNAME} -> {resolved})")
            return resolved, "MDNS", False, f"Resolved via mDNS: {MDNS_HOSTNAME} -> {resolved}"
    except Exception as mdns_err:
        logger.debug(f"mDNS resolution failed for {MDNS_HOSTNAME}: {mdns_err}")

    # 3. Try UDP Discovery Beacon
    beacon = probe_udp_beacon(udp_port=udp_port, timeout=timeout)
    if beacon and beacon.get("ip"):
        esp_ip = beacon["ip"]
        rssi = beacon.get("rssi", "N/A")
        logger.info(f"Discovered ESP32 via UDP Beacon on port {udp_port} (IP: {esp_ip}, RSSI: {rssi} dBm)")
        return esp_ip, "UDP_BEACON", False, f"Discovered via UDP Beacon on port {udp_port} ({esp_ip})"

    # 4. Fallback
    target_ip = fallback_ip if is_valid_ipv4(fallback_ip) else "192.168.4.1"
    msg = (
        f"Unable to discover ESP32 automatically via mDNS or UDP beacon. "
        f"Falling back to {target_ip}. "
        f"NOTE: If laptop and ESP32 are on a phone hotspot, ensure 'AP Isolation / Client Isolation' is disabled in phone settings."
    )
    logger.warning(msg)
    return target_ip, "FALLBACK", True, msg

