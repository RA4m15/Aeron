import React from 'react';
import { useHardware } from '../context/HardwareContext';

interface AdminGamificationProps {
  verifiedChecksCount?: number;
  totalChecksCount?: number;
  isOnline?: boolean;
  streakDays?: number;
  lastAuditDate?: string;
}

export const AdminGamification: React.FC<AdminGamificationProps> = ({
  verifiedChecksCount: propVerified,
  totalChecksCount: propTotal,
  isOnline: propIsOnline,
  lastAuditDate
}) => {
  const { isOnline: ctxIsOnline, latestTelemetry: tel } = useHardware();
  const isOnline = propIsOnline !== undefined ? propIsOnline : ctxIsOnline;

  const health = (tel?.sensorHealth || {}) as Record<string, boolean>;
  const imuOk = !!health.imu;
  const baroOk = !!health.barometer;
  const compassOk = !!health.compass;
  const gpsOk = !!health.gps && (tel?.satellites ?? 0) >= 4;

  const activeChecks = isOnline
    ? [imuOk, baroOk, compassOk, gpsOk].filter(Boolean).length
    : 0;
  const totalChecks = 4;

  const verifiedCount = propVerified !== undefined ? propVerified : activeChecks;
  const totalCount = propTotal !== undefined ? propTotal : totalChecks;

  const readinessPct = totalCount > 0 ? Math.round((verifiedCount / totalCount) * 100) : 0;
  const auditFormattedDate =
    lastAuditDate ||
    new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const tierLabel = isOnline
    ? tel?.isSimulated
      ? 'Bench Simulation Mode'
      : 'Physical Pixhawk 2.4.8 Linked'
    : 'Standby / Awaiting Heartbeat';

  return (
    <div className="bg-surface rounded-2xl border border-border p-6 shadow-sm space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-border/70">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent-primary/15 border border-accent-primary/30 flex items-center justify-center text-accent-primary">
            <span className="material-symbols-outlined text-[22px]">health_and_safety</span>
          </div>
          <div>
            <h3 className="font-sans text-sm font-bold text-text-primary">
              Bench Telemetry & Subsystem Readiness
            </h3>
            <p className="text-[11px] text-text-muted">Pre-flight sensor verification & link integrity</p>
          </div>
        </div>
        <span className="px-2.5 py-1 rounded-full bg-surface-elevated border border-border text-[11px] font-sans text-accent-primary font-semibold">
          {tierLabel}
        </span>
      </div>

      {/* Progress Metric */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs font-sans">
          <span className="text-text-secondary">Subsystem telemetry integrity</span>
          <span className="text-accent-primary font-mono font-bold">
            {isOnline ? `${readinessPct}% verified` : '0% (Offline)'}
          </span>
        </div>
        <div className="w-full h-2 bg-surface-elevated rounded-full overflow-hidden border border-border/60">
          <div
            className="h-full bg-gradient-to-r from-accent-soft to-accent-primary transition-all duration-500 rounded-full shadow-[0_0_8px_#BFF42E]"
            style={{ width: `${isOnline ? readinessPct : 0}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[11px] text-text-muted font-sans">
          <span>
            {isOnline
              ? `${verifiedCount} of ${totalCount} hardware checks verified`
              : 'Awaiting hardware connection'}
          </span>
          <span className="text-info font-semibold">
            {isOnline ? 'Link: MAVLink 2.0 Stream' : 'Link: Disconnected'}
          </span>
        </div>
      </div>

      {/* Verified Subsystem Badges */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-1">
        <div className="p-3 bg-surface-elevated rounded-xl border border-border/80 flex flex-col items-center text-center">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
            isOnline ? 'bg-accent-primary/15 text-accent-primary border border-accent-primary/30' : 'bg-surface-muted text-text-muted border border-border'
          }`}>
            <span className="material-symbols-outlined text-[18px]">cable</span>
          </div>
          <span className="text-[11px] font-semibold text-text-primary mt-1.5 font-sans">TELEM2 Link</span>
          <span className="text-[10px] font-mono text-accent-primary">
            {isOnline ? 'UART 57,600 baud' : 'Not Connected'}
          </span>
        </div>

        <div className="p-3 bg-surface-elevated rounded-xl border border-border/80 flex flex-col items-center text-center">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
            isOnline && imuOk ? 'bg-info/15 text-info border border-info/30' : 'bg-surface-muted text-text-muted border border-border'
          }`}>
            <span className="material-symbols-outlined text-[18px]">explore</span>
          </div>
          <span className="text-[11px] font-semibold text-text-primary mt-1.5 font-sans">IMU Sensors</span>
          <span className="text-[10px] font-mono text-info">
            {isOnline ? (imuOk ? '3D Gyro/Accel Healthy' : 'IMU Active') : 'Not Verified'}
          </span>
        </div>

        <div className="p-3 bg-surface-elevated rounded-xl border border-border/80 flex flex-col items-center text-center">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
            isOnline && tel?.batteryVoltage ? 'bg-warning/15 text-warning border border-warning/30' : 'bg-surface-muted text-text-muted border border-border'
          }`}>
            <span className="material-symbols-outlined text-[18px]">battery_charging_full</span>
          </div>
          <span className="text-[11px] font-semibold text-text-primary mt-1.5 font-sans">Power Monitor</span>
          <span className="text-[10px] font-mono text-warning">
            {isOnline && tel?.batteryVoltage ? 'Voltage Estimated' : 'Not Measured'}
          </span>
        </div>

        <div className="p-3 bg-surface-elevated rounded-xl border border-border/80 flex flex-col items-center text-center">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
            isOnline && (tel?.satellites ?? 0) >= 4 ? 'bg-accent-primary/15 text-accent-primary border border-accent-primary/30' : 'bg-surface-muted text-text-muted border border-border'
          }`}>
            <span className="material-symbols-outlined text-[18px]">satellite_alt</span>
          </div>
          <span className="text-[11px] font-semibold text-text-primary mt-1.5 font-sans">GNSS Lock</span>
          <span className="text-[10px] font-mono text-accent-primary">
            {isOnline
              ? (tel?.gpsFixType ? `${tel.gpsFixType} (${tel.satellites ?? 0} Sats)` : 'Searching')
              : 'Not Connected'}
          </span>
        </div>
      </div>

      <div className="text-[11px] text-text-muted font-sans flex items-center justify-between border-t border-border/60 pt-3">
        <span>Session verified: {auditFormattedDate} • {isOnline ? 'Bench telemetry nominal' : 'Bench standby'}</span>
        <span className="text-accent-primary font-mono font-semibold text-[10px]">Read-Only GCS Policy</span>
      </div>
    </div>
  );
};
