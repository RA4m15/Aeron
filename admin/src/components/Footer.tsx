import React from 'react';
import { useHardware } from '../context/HardwareContext';
import { resolveBatteryState } from '../config/drone';

export const Footer: React.FC = () => {
  const { hardwareState, hardwareStatusLabel, latestTelemetry, protocol, transport, isOnline } = useHardware();
  const batt = resolveBatteryState(latestTelemetry, isOnline);

  const getHardwareStatusClass = () => {
    if (hardwareState === 'CONNECTED') return 'text-aeron-lime';
    if (hardwareState === 'SIMULATION') return 'text-caution-amber';
    return 'text-text-muted';
  };

  const lat = latestTelemetry?.latitude;
  const lon = latestTelemetry?.longitude;
  const agl = latestTelemetry?.relativeAltitude;
  const msl = latestTelemetry?.altitude;

  return (
    <footer className="fixed bottom-0 left-72 right-0 h-10 bg-surface/95 backdrop-blur-md border-t border-border z-40 px-6 flex items-center justify-between text-xs font-sans text-text-secondary">
      <div className="flex items-center gap-5">
        <div className="flex items-center gap-2">
          <span className="text-text-muted">Transport:</span>
          <span className="text-telemetry-cyan font-mono font-semibold">
            {transport?.mode === 'dual'
              ? `Dual [${transport.activeSource === 'WIFI' ? 'Wi-Fi' : transport.activeSource === 'USB' ? 'USB' : 'Standby'}]`
              : transport?.mode === 'wifi'
              ? 'Wi-Fi (5760)'
              : 'USB (COM8)'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-text-muted">Protocol:</span>
          <span className="text-text-secondary font-mono">
            MAVLink {protocol?.mavlinkVersion || '2.0'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-text-muted">Hardware:</span>
          <span className={`font-semibold ${getHardwareStatusClass()}`}>
            {hardwareStatusLabel}
          </span>
        </div>
        <div className="flex items-center gap-2 border-l border-border/60 pl-4">
          <span className="text-text-muted">3S LiPo:</span>
          <span className="font-mono font-semibold text-text-primary">
            {batt.voltage !== null ? `${batt.voltage.toFixed(2)}V` : '—'}
          </span>
          <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded border ${batt.sourceBadgeClass}`}>
            {batt.percentage !== null ? `${batt.percentage}% • ${batt.sourceLabel}` : 'UNKNOWN'}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-5 font-mono text-xs">
        <div className="flex items-center gap-1.5">
          <span className="text-text-muted font-sans">Lat:</span>
          <span className="text-navigation-blue font-semibold">
            {isOnline && lat !== undefined && lat !== null ? `${lat.toFixed(5)}°` : '—'}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-text-muted font-sans">Lon:</span>
          <span className="text-navigation-blue font-semibold">
            {isOnline && lon !== undefined && lon !== null ? `${lon.toFixed(5)}°` : '—'}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-text-muted font-sans">Rel Alt:</span>
          <span className="text-aeron-lime font-semibold" title="Barometer Relative Altitude above launch origin">
            {isOnline && agl !== undefined && agl !== null ? `${agl.toFixed(1)}m` : 'N/A'}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-text-muted font-sans">MSL:</span>
          <span className="text-text-primary font-semibold" title="Baro/EKF Altitude above Mean Sea Level">
            {isOnline && msl !== undefined && msl !== null ? `${msl.toFixed(1)}m` : 'N/A'}
          </span>
        </div>
      </div>
    </footer>
  );
};
