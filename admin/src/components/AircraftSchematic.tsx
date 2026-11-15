import React, { useState, useEffect, useRef } from 'react';
import { TelemetryData } from '../types';
import { getHeadingCardinal } from '../utils/gis';
import { resolveBatteryState } from '../config/drone';

interface AircraftSchematicProps {
  telemetry: TelemetryData | null;
  isOnline: boolean;
  armed?: boolean;
  flightMode?: string;
  attitudeAgeMs?: number;
}

export const AircraftSchematic: React.FC<AircraftSchematicProps> = ({
  telemetry,
  isOnline,
  armed = false,
  flightMode = 'STANDBY',
  attitudeAgeMs
}) => {
  // Use authoritative ATTITUDE yaw as primary heading, falling back to heading
  const rawHeading =
    telemetry?.yaw !== undefined && Number.isFinite(telemetry.yaw)
      ? telemetry.yaw
      : telemetry?.heading ?? 0;

  // Unwrapped continuous rotation to prevent 360° reverse flips across 0°/360° boundary
  const [continuousHeading, setContinuousHeading] = useState<number>(rawHeading);
  const prevHeadingRef = useRef<number>(rawHeading);

  useEffect(() => {
    let delta = rawHeading - (prevHeadingRef.current % 360);
    if (delta < -180) delta += 360;
    if (delta > 180) delta -= 360;
    setContinuousHeading((prev) => prev + delta);
    prevHeadingRef.current = rawHeading;
  }, [rawHeading]);

  const heading = rawHeading;
  const roll = typeof telemetry?.roll === 'number' ? telemetry.roll.toFixed(1) : '0.0';
  const pitch = typeof telemetry?.pitch === 'number' ? telemetry.pitch.toFixed(1) : '0.0';
  const isArmed = armed || !!telemetry?.armed;
  const batt = resolveBatteryState(telemetry, isOnline);

  // Check attitude data freshness
  const effectiveAgeMs = attitudeAgeMs !== undefined
    ? attitudeAgeMs
    : (telemetry?.attitudeUpdatedAt || telemetry?.recordedAt
        ? Date.now() - new Date(telemetry.attitudeUpdatedAt || telemetry.recordedAt!).getTime()
        : 9999);
  const isAttitudeStale = !isOnline || effectiveAgeMs > 3000;

  return (
    <div className="relative flex flex-col items-center justify-center p-6 bg-surface rounded-xl border border-border shadow-sm overflow-hidden">
      {/* Background Grid Pattern */}
      <div 
        className="absolute inset-0 opacity-[0.03] pointer-events-none" 
        style={{
          backgroundImage: 'radial-gradient(#F1F5EE 1px, transparent 1px)',
          backgroundSize: '20px 20px'
        }}
      />

      {/* Top HUD Metadata */}
      <div className="w-full flex items-center justify-between z-10 mb-4 pb-3 border-b border-border/60">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[18px] text-accent-primary">flight_takeoff</span>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-sans text-xs font-bold text-text-primary">
                Aircraft Overview • QUAD-01
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-surface-elevated text-accent-primary border border-accent-soft/30">
                QUADCOPTER (X-FRAME)
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 font-sans text-xs">
          <span className={`px-2.5 py-0.5 rounded text-[11px] font-semibold ${
            isArmed 
              ? 'bg-danger/20 text-danger border border-danger/40 animate-pulse' 
              : 'bg-surface-elevated text-text-secondary border border-border'
          }`}>
            {isArmed ? 'Armed' : 'Disarmed'}
          </span>
          <span className="px-2.5 py-0.5 rounded bg-surface-elevated text-text-secondary border border-border text-[11px] font-medium font-mono">
            Mode: {flightMode}
          </span>
        </div>
      </div>

      {/* Center Schematic SVG */}
      <div className="relative w-80 h-80 sm:w-96 sm:h-96 flex items-center justify-center my-2">
        {/* Compass Ring - Short 50ms linear transition for continuous orientation */}
        <div 
          className="absolute inset-0 rounded-full border border-border/80 border-dashed transition-transform duration-50 ease-linear flex items-center justify-center pointer-events-none"
          style={{ transform: `rotate(${continuousHeading}deg)`, transition: 'transform 50ms linear' }}
        >
          <span className="absolute -top-3 text-[11px] font-mono font-bold text-aeron-lime bg-surface px-1">N</span>
          <span className="absolute -bottom-3 text-[11px] font-mono text-text-muted bg-surface px-1">S</span>
          <span className="absolute -left-3 text-[11px] font-mono text-text-muted bg-surface px-1">W</span>
          <span className="absolute -right-3 text-[11px] font-mono text-text-muted bg-surface px-1">E</span>
        </div>

        {/* Tactical Airframe SVG - Top-down Quadcopter X-configuration */}
        <svg 
          viewBox="0 0 200 200" 
          className="w-72 h-72 sm:w-80 sm:h-80 transition-transform duration-50 ease-linear z-10"
          style={{ transform: `rotate(${continuousHeading}deg)`, transition: 'transform 50ms linear' }}
        >
          {/* Concentric Radar Range Rings */}
          <circle cx="100" cy="100" r="30" fill="none" stroke="#334451" strokeWidth="0.75" strokeDasharray="3 3" opacity="0.35" />
          <circle cx="100" cy="100" r="60" fill="none" stroke="#334451" strokeWidth="0.75" strokeDasharray="3 3" opacity="0.35" />
          <circle cx="100" cy="100" r="88" fill="none" stroke="#334451" strokeWidth="0.75" strokeDasharray="4 4" opacity="0.25" />

          {/* Quadcopter X-Arms (Exactly 4 Arms at 45 degree diagonals) */}
          {/* Arm 1: Center to Front-Right (M1) */}
          <line x1="100" y1="100" x2="155" y2="45" stroke="#334451" strokeWidth="5" strokeLinecap="round" />
          {/* Arm 2: Center to Rear-Left (M2) */}
          <line x1="100" y1="100" x2="45" y2="155" stroke="#334451" strokeWidth="5" strokeLinecap="round" />
          {/* Arm 3: Center to Front-Left (M3) */}
          <line x1="100" y1="100" x2="45" y2="45" stroke="#334451" strokeWidth="5" strokeLinecap="round" />
          {/* Arm 4: Center to Rear-Right (M4) */}
          <line x1="100" y1="100" x2="155" y2="155" stroke="#334451" strokeWidth="5" strokeLinecap="round" />

          {/* Carbon Fiber Arm Highlights */}
          <line x1="100" y1="100" x2="155" y2="45" stroke="#4A6072" strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />
          <line x1="100" y1="100" x2="45" y2="155" stroke="#4A6072" strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />
          <line x1="100" y1="100" x2="45" y2="45" stroke="#4A6072" strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />
          <line x1="100" y1="100" x2="155" y2="155" stroke="#4A6072" strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />

          {/* Motor Pods & Propellers (Exactly 4 Motors M1-M4) */}
          {/* M1: Front-Right (CCW) */}
          <circle cx="155" cy="45" r="15" fill="#151E27" stroke={isOnline ? "#BFF42E" : "#334451"} strokeWidth="2" />
          <circle cx="155" cy="45" r="5.5" fill={isArmed ? "#F07878" : (isOnline ? "#BFF42E" : "#334451")} />
          <text x="155" y="48.5" textAnchor="middle" fill="#FFFFFF" fontSize="7" fontWeight="bold" fontFamily="monospace">M1</text>

          {/* M2: Rear-Left (CCW) */}
          <circle cx="45" cy="155" r="15" fill="#151E27" stroke={isOnline ? "#BFF42E" : "#334451"} strokeWidth="2" />
          <circle cx="45" cy="155" r="5.5" fill={isArmed ? "#F07878" : (isOnline ? "#BFF42E" : "#334451")} />
          <text x="45" y="158.5" textAnchor="middle" fill="#FFFFFF" fontSize="7" fontWeight="bold" fontFamily="monospace">M2</text>

          {/* M3: Front-Left (CW) */}
          <circle cx="45" cy="45" r="15" fill="#151E27" stroke={isOnline ? "#BFF42E" : "#334451"} strokeWidth="2" />
          <circle cx="45" cy="45" r="5.5" fill={isArmed ? "#F07878" : (isOnline ? "#BFF42E" : "#334451")} />
          <text x="45" y="48.5" textAnchor="middle" fill="#FFFFFF" fontSize="7" fontWeight="bold" fontFamily="monospace">M3</text>

          {/* M4: Rear-Right (CW) */}
          <circle cx="155" cy="155" r="15" fill="#151E27" stroke={isOnline ? "#BFF42E" : "#334451"} strokeWidth="2" />
          <circle cx="155" cy="155" r="5.5" fill={isArmed ? "#F07878" : (isOnline ? "#BFF42E" : "#334451")} />
          <text x="155" y="158.5" textAnchor="middle" fill="#FFFFFF" fontSize="7" fontWeight="bold" fontFamily="monospace">M4</text>

          {/* Central Avionics Hub (Pixhawk 2.4.8 Autopilot) */}
          <rect x="74" y="74" width="52" height="52" rx="8" fill="#192631" stroke="#334451" strokeWidth="2" />
          {/* Heading Forward Arrow (North reference) */}
          <polygon points="100,79 91,93 109,93" fill={isOnline ? "#BFF42E" : "#84939E"} />
          <text x="100" y="107" textAnchor="middle" fill="#F0F4F6" fontSize="7.5" fontWeight="bold" fontFamily="monospace">
            AERON
          </text>
          <text x="100" y="117" textAnchor="middle" fill="#B4C0C8" fontSize="5.5" fontFamily="monospace">
            PIXHAWK 2.4.8
          </text>
        </svg>

        {/* Live Heading & Dynamic Attitude Readout Overlay */}
        <div className="absolute bottom-2 flex items-center gap-2 font-mono text-[11px] text-text-secondary bg-surface-elevated/95 px-3 py-1 rounded-lg border border-border shadow-sm">
          <span>Heading:</span>
          <span className="font-bold text-accent-primary">
            {isOnline ? `${heading.toFixed(1)}° (${getHeadingCardinal(heading)})` : '—'}
          </span>
          <span className="text-border">•</span>
          <span>R: <strong className="text-text-primary">{isOnline ? `${roll}°` : '—'}</strong></span>
          <span>P: <strong className="text-text-primary">{isOnline ? `${pitch}°` : '—'}</strong></span>
          {isAttitudeStale && isOnline && (
            <span className="px-1.5 py-0.2 rounded bg-warning/20 text-warning text-[9px] font-bold">
              STALE
            </span>
          )}
        </div>
      </div>

      {/* Bottom Instrumentation Strip */}
      <div className="w-full grid grid-cols-3 gap-3 mt-3 pt-3 border-t border-border/60 text-center font-sans text-xs">
        <div className="bg-surface-elevated p-2.5 rounded-lg border border-border">
          <span className="block text-[11px] text-text-muted">3S LiPo Battery</span>
          <span className="font-mono text-sm text-text-primary font-bold">
            {isOnline && batt.voltage ? `${batt.voltage.toFixed(2)}V` : '—'}
            {isOnline && batt.percentage !== null && (
              <span className="text-xs text-accent-primary ml-1">({batt.percentage}%)</span>
            )}
          </span>
          <span className="block text-[10px] text-accent-primary font-mono truncate">
            {isOnline && batt.percentage !== null
              ? batt.sourceLabel
              : isOnline && batt.voltage
              ? `Avg: ${(batt.voltage / 3).toFixed(2)}V/cell`
              : 'Standby'}
          </span>
        </div>
        <div className="bg-surface-elevated p-2.5 rounded-lg border border-border">
          <span className="block text-[11px] text-text-muted">Altitude Vector</span>
          <span className="font-mono text-sm text-text-primary font-bold">
            {isOnline && telemetry?.relativeAltitude !== undefined && telemetry.relativeAltitude !== null ? `${telemetry.relativeAltitude.toFixed(1)}m AGL` : 'N/A'}
          </span>
          <span className="block text-[10px] text-text-muted font-mono">
            MSL: {isOnline && telemetry?.altitude !== undefined && telemetry.altitude !== null ? `${telemetry.altitude.toFixed(1)}m` : 'N/A'}
          </span>
        </div>
        <div className="bg-surface-elevated p-2.5 rounded-lg border border-border">
          <span className="block text-[11px] text-text-muted">GPS Constellation</span>
          <span className="font-mono text-sm text-text-primary font-bold">
            {isOnline && telemetry?.satellites !== undefined && telemetry.satellites > 0 ? `${telemetry.satellites} Sats` : '—'}
          </span>
          <span className="block text-[10px] text-text-muted font-mono">
            {isOnline ? (telemetry?.gpsFixType || 'GNSS Active') : 'Standby'}
          </span>
        </div>
      </div>
    </div>
  );
};
