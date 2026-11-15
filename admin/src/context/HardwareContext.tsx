import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { fetchOverview } from '../services/api';
import { subscribeToDroneTelemetry } from '../services/socket';
import { OverviewData, TelemetryData, HardwareDeviceData, AircraftReadiness, DroneData, AttitudeData, TransportStatusData } from '../types';
import { ACTIVE_DRONE_ID } from '../config/drone';

export type AuthoritativeHardwareState = 'CONNECTED' | 'AWAITING HARDWARE' | 'SIMULATION' | 'OFFLINE';

interface HardwareContextType {
  data: OverviewData | null;
  drone: DroneData | null;
  latestTelemetry: TelemetryData | null;
  latestAttitude: AttitudeData | null;
  transport: TransportStatusData | null;
  roll: number;
  pitch: number;
  yaw: number;
  heading: number;
  attitudeAgeMs: number;
  attitudeHz: number;
  gpsAgeMs: number;
  gpsHz: number;
  latencyEstimateMs: number;
  devices: HardwareDeviceData[];
  readiness: AircraftReadiness | null;
  protocol: OverviewData['protocol'] | null;
  isOnline: boolean;
  hardwareState: AuthoritativeHardwareState;
  hardwareStatusLabel: string;
  loading: boolean;
  refreshHardware: () => Promise<void>;
}

const HardwareContext = createContext<HardwareContextType | undefined>(undefined);

export const HardwareProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [data, setData] = useState<OverviewData | null>(null);
  const [latestTelemetry, setLatestTelemetry] = useState<TelemetryData | null>(null);
  const [latestAttitude, setLatestAttitude] = useState<AttitudeData | null>(null);
  const [transport, setTransport] = useState<TransportStatusData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // Live stream rate and latency tracking
  const [attitudeHz, setAttitudeHz] = useState<number>(0);
  const [gpsHz, setGpsHz] = useState<number>(0);
  const [attitudeAgeMs, setAttitudeAgeMs] = useState<number>(9999);
  const [gpsAgeMs, setGpsAgeMs] = useState<number>(9999);
  const [latencyEstimateMs, setLatencyEstimateMs] = useState<number>(0);

  // Refs to avoid stale closures in event listeners
  const latestTelemetryRef = useRef<TelemetryData | null>(null);
  const latestAttitudeRef = useRef<AttitudeData | null>(null);
  const attitudePacketTimes = useRef<number[]>([]);
  const gpsPacketTimes = useRef<number[]>([]);
  const lastGpsTimestampMsRef = useRef<number>(0);

  // Update refs on state changes
  useEffect(() => {
    latestTelemetryRef.current = latestTelemetry;
  }, [latestTelemetry]);

  useEffect(() => {
    latestAttitudeRef.current = latestAttitude;
  }, [latestAttitude]);

  // Periodic metrics calculation (1 Hz ticker for packet rate and ages)
  useEffect(() => {
    const ticker = setInterval(() => {
      const now = Date.now();

      // Clean attitude times older than 1.5 seconds
      attitudePacketTimes.current = attitudePacketTimes.current.filter((t) => now - t <= 1500);
      const attRate = attitudePacketTimes.current.length > 0
        ? Number((attitudePacketTimes.current.length / 1.5).toFixed(1))
        : 0;
      setAttitudeHz(attRate);

      // Clean GPS times older than 2.0 seconds
      gpsPacketTimes.current = gpsPacketTimes.current.filter((t) => now - t <= 2000);
      const gRate = gpsPacketTimes.current.length > 0
        ? Number((gpsPacketTimes.current.length / 2.0).toFixed(1))
        : 0;
      setGpsHz(gRate);

      // Attitude age
      if (latestAttitudeRef.current) {
        const attRec = latestAttitudeRef.current.sourceTimestamp ||
          new Date(latestAttitudeRef.current.recordedAt).getTime();
        setAttitudeAgeMs(Math.max(0, now - attRec));
      } else if (latestTelemetryRef.current?.attitudeUpdatedAt) {
        const attRec = new Date(latestTelemetryRef.current.attitudeUpdatedAt).getTime();
        setAttitudeAgeMs(Math.max(0, now - attRec));
      } else {
        setAttitudeAgeMs(9999);
      }

      // GPS age
      if (latestTelemetryRef.current?.gpsTimestamp) {
        const gpsRec = new Date(latestTelemetryRef.current.gpsTimestamp).getTime();
        setGpsAgeMs(Math.max(0, now - gpsRec));
      } else if (latestTelemetryRef.current?.recordedAt) {
        const telRec = new Date(latestTelemetryRef.current.recordedAt).getTime();
        setGpsAgeMs(Math.max(0, now - telRec));
      } else {
        setGpsAgeMs(9999);
      }
    }, 500);

    return () => clearInterval(ticker);
  }, []);

  const refreshHardware = useCallback(async () => {
    try {
      const overview = await fetchOverview();
      if (overview) {
        setData(overview);
        // Only seed latestTelemetry if no live telemetry has arrived yet or current is stale (>30s)
        const current = latestTelemetryRef.current;
        const currentAge = current
          ? Date.now() - new Date(current.recordedAt || current.receivedAt || 0).getTime()
          : Infinity;

        if (!current || currentAge > 30000) {
          if (overview.latestTelemetry) {
            setLatestTelemetry(overview.latestTelemetry);
          }
        }
      }
    } catch (err) {
      console.warn('[HardwareContext] Failed to load overview data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;

    refreshHardware();

    // High-frequency attitude packet handler
    const handleAttitude = (rawAtt: any) => {
      if (!isMounted || !rawAtt) return;
      const now = Date.now();
      attitudePacketTimes.current.push(now);

      const sourceTs = rawAtt.sourceTimestamp || (rawAtt.recordedAt ? new Date(rawAtt.recordedAt).getTime() : now);
      const serverTs = rawAtt.serverTimestamp || sourceTs;

      // Monotonic sequence check: reject out-of-order packets
      if (
        latestAttitudeRef.current?.sourceTimestamp &&
        sourceTs < latestAttitudeRef.current.sourceTimestamp
      ) {
        return;
      }

      const latencyEst = Math.max(0, now - sourceTs);
      setLatencyEstimateMs(latencyEst);

      const attData: AttitudeData = {
        droneId: rawAtt.droneId || ACTIVE_DRONE_ID,
        roll: rawAtt.roll,
        pitch: rawAtt.pitch,
        yaw: rawAtt.yaw,
        climbRate: rawAtt.climbRate,
        sourceTimestamp: sourceTs,
        serverTimestamp: serverTs,
        clientReceivedAt: now,
        recordedAt: rawAtt.recordedAt || new Date(sourceTs).toISOString(),
        bootMs: rawAtt.bootMs,
        sequence: rawAtt.sequence,
        ageMs: latencyEst
      };

      setLatestAttitude(attData);
      setAttitudeAgeMs(latencyEst);

      // Immediately merge attitude orientation into latestTelemetry without waiting for full GPS packet
      setLatestTelemetry((prev) => ({
        ...prev,
        droneId: rawAtt.droneId || prev?.droneId || ACTIVE_DRONE_ID,
        roll: rawAtt.roll,
        pitch: rawAtt.pitch,
        yaw: rawAtt.yaw,
        heading: rawAtt.yaw, // Authoritative orientation
        climbRate: rawAtt.climbRate !== undefined ? rawAtt.climbRate : prev?.climbRate,
        attitudeUpdatedAt: attData.recordedAt,
        receivedAt: new Date(now).toISOString()
      }));
    };

    // Full telemetry packet handler
    const handleTelemetry = (packet: any) => {
      if (!isMounted || !packet) return;
      const now = Date.now();

      // Track actual GPS message arrivals using receive timestamps:
      // 1. Do NOT require coordinate changes (stationary vehicle on bench receives continuous fresh GPS updates).
      // 2. Do NOT count repeated Socket.IO snapshots (reject duplicate timestamps via strict monotonic advance).
      // 3. Reject stale or out-of-order packets.
      const rawGpsTs = packet.gpsTimestamp || packet.positionUpdatedAt ||
        ((packet.satellites !== undefined || packet.latitude !== undefined) ? packet.recordedAt : null);

      if (rawGpsTs) {
        const gpsTimeMs = typeof rawGpsTs === 'number' ? rawGpsTs : new Date(rawGpsTs).getTime();
        if (Number.isFinite(gpsTimeMs) && gpsTimeMs > lastGpsTimestampMsRef.current) {
          if (now - gpsTimeMs <= 5000) {
            lastGpsTimestampMsRef.current = gpsTimeMs;
            gpsPacketTimes.current.push(now);
          }
        }
      }

      const recTime = packet.recordedAt ? new Date(packet.recordedAt).getTime() : now;
      const current = latestTelemetryRef.current;
      const currentRec = current?.recordedAt ? new Date(current.recordedAt).getTime() : 0;

      // Reject obsolete telemetry packets older than current state
      if (currentRec && recTime < currentRec) {
        return;
      }

      // If we have a newer attitude update, preserve it over historical snapshot roll/pitch/yaw
      const att = latestAttitudeRef.current;
      const attIsNewer = att && att.sourceTimestamp && att.sourceTimestamp > recTime;

      if (packet.transport) {
        setTransport(packet.transport);
      }

      setLatestTelemetry((prev) => ({
        ...prev,
        ...packet,
        roll: attIsNewer ? att.roll : (packet.roll !== undefined ? packet.roll : prev?.roll),
        pitch: attIsNewer ? att.pitch : (packet.pitch !== undefined ? packet.pitch : prev?.pitch),
        yaw: attIsNewer ? att.yaw : (packet.yaw !== undefined ? packet.yaw : prev?.yaw),
        heading: attIsNewer ? att.yaw : (packet.yaw !== undefined ? packet.yaw : (packet.heading !== undefined ? packet.heading : prev?.heading)),
        attitudeUpdatedAt: attIsNewer ? att.recordedAt : (packet.attitudeUpdatedAt || prev?.attitudeUpdatedAt),
        receivedAt: new Date(now).toISOString()
      }));
    };

    const handleTransport = (payload: any) => {
      if (!isMounted || !payload) return;
      if (payload.transport) {
        setTransport(payload.transport);
      }
    };

    // Listen to real-time telemetry and attitude packets via authenticated Socket.IO rooms
    const cleanupActive = subscribeToDroneTelemetry(ACTIVE_DRONE_ID, handleTelemetry, handleAttitude, handleTransport);

    const cleanupBench = ACTIVE_DRONE_ID !== 'AERON-PX4-BENCH01'
      ? subscribeToDroneTelemetry('AERON-PX4-BENCH01', handleTelemetry, handleAttitude, handleTransport)
      : () => {};

    // 15-second background overview refresh (for system diagnostics, devices, readiness)
    const pollInterval = setInterval(() => {
      if (isMounted) {
        refreshHardware();
      }
    }, 15000);

    return () => {
      isMounted = false;
      cleanupActive();
      cleanupBench();
      clearInterval(pollInterval);
    };
  }, [refreshHardware]);

  const tel = latestTelemetry;
  const isOnline = !!tel && (Date.now() - new Date(tel.recordedAt || tel.receivedAt || 0).getTime()) < 30000;

  // Authoritative orientation fields
  const roll = latestAttitude?.roll ?? tel?.roll ?? 0;
  const pitch = latestAttitude?.pitch ?? tel?.pitch ?? 0;
  const yaw = latestAttitude?.yaw ?? tel?.yaw ?? tel?.heading ?? 0;
  const heading = yaw;

  let hardwareState: AuthoritativeHardwareState = 'OFFLINE';
  let hardwareStatusLabel = 'Awaiting hardware';

  if (isOnline) {
    if (tel?.isSimulated) {
      hardwareState = 'SIMULATION';
      hardwareStatusLabel = 'Bench simulation active';
    } else {
      hardwareState = 'CONNECTED';
      if (transport?.mode === 'dual') {
        hardwareStatusLabel = transport.activeSource === 'WIFI'
          ? 'Pixhawk 2.4.8 connected (Wi-Fi Active)'
          : 'Pixhawk 2.4.8 connected (USB Fallback Active)';
      } else if (transport?.mode === 'wifi') {
        hardwareStatusLabel = 'Pixhawk 2.4.8 connected (Wi-Fi)';
      } else if (transport?.mode === 'usb') {
        hardwareStatusLabel = 'Pixhawk 2.4.8 connected (USB COM8)';
      } else {
        hardwareStatusLabel = 'Pixhawk 2.4.8 connected';
      }
    }
  } else {
    if (transport && !transport.isAnyAlive) {
      hardwareState = 'OFFLINE';
      hardwareStatusLabel = 'Connection Lost (Wi-Fi + USB Disconnected)';
    } else {
      hardwareState = 'AWAITING HARDWARE';
      hardwareStatusLabel = 'Awaiting hardware (Standby)';
    }
  }

  return (
    <HardwareContext.Provider
      value={{
        data,
        drone: data?.drone || null,
        latestTelemetry,
        latestAttitude,
        transport,
        roll,
        pitch,
        yaw,
        heading,
        attitudeAgeMs,
        attitudeHz,
        gpsAgeMs,
        gpsHz,
        latencyEstimateMs,
        devices: data?.hardwareDevices || [],
        readiness: data?.readiness || null,
        protocol: data?.protocol || null,
        isOnline,
        hardwareState,
        hardwareStatusLabel,
        loading,
        refreshHardware,
      }}
    >
      {children}
    </HardwareContext.Provider>
  );
};

export const useHardware = (): HardwareContextType => {
  const context = useContext(HardwareContext);
  if (!context) {
    throw new Error('useHardware must be used within a HardwareProvider');
  }
  return context;
};
