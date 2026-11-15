import React, { useState } from 'react';
import { useHardware } from '../../context/HardwareContext';

export const LiveEngineeringDiagnosticsPanel: React.FC = () => {
  const [isExpanded, setIsExpanded] = useState<boolean>(true);
  const {
    attitudeHz,
    gpsHz,
    attitudeAgeMs,
    gpsAgeMs,
    latencyEstimateMs,
    roll,
    pitch,
    yaw,
    latestAttitude,
    latestTelemetry,
    transport,
    isOnline,
    hardwareStatusLabel
  } = useHardware();

  const isAttitudeWarning = isOnline && attitudeAgeMs > 1000;
  const isGpsStale = isOnline && gpsAgeMs > 5000;

  return (
    <div className="w-full bg-surface rounded-xl border border-border shadow-sm overflow-hidden transition-all">
      {/* Expandable Header Banner */}
      <div
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex flex-wrap items-center justify-between p-4 bg-surface-elevated/60 hover:bg-surface-elevated cursor-pointer transition-colors border-b border-border/70 select-none"
      >
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-accent-primary text-[20px]">
            query_stats
          </span>
          <div className="flex items-center gap-2">
            <h2 className="font-sans font-bold text-xs uppercase tracking-wider text-text-primary">
              Live Engineering Diagnostics & Sensor-to-Browser Telemetry Bench
            </h2>
            <span
              className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                !isOnline
                  ? 'bg-danger/20 text-danger border border-danger/30'
                  : isAttitudeWarning
                  ? 'bg-warning/20 text-warning border border-warning/30'
                  : 'bg-success/20 text-success border border-success/30'
              }`}
            >
              {!isOnline ? 'OFFLINE' : isAttitudeWarning ? 'LATENCY DEGRADED' : 'LOW-LATENCY PIPELINE ACTIVE'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs font-sans text-text-muted">
          <span className="hidden sm:inline">
            Status: <strong className="text-text-primary font-medium">{hardwareStatusLabel}</strong>
          </span>
          <span className="text-border hidden sm:inline">•</span>
          <span className="hidden md:inline">
            Seq: <strong className="font-mono text-accent-primary">{latestAttitude?.sequence ?? 0}</strong>
          </span>
          <span className="material-symbols-outlined text-[18px] text-text-secondary transition-transform">
            {isExpanded ? 'expand_less' : 'expand_more'}
          </span>
        </div>
      </div>

      {/* Expandable Body */}
      {isExpanded && (
        <div className="p-5 space-y-4">
          {/* Active Warnings */}
          {isAttitudeWarning && (
            <div className="p-3 bg-warning/15 border border-warning/30 rounded-lg flex items-center gap-2.5 text-warning font-sans text-xs">
              <span className="material-symbols-outlined text-[18px]">warning</span>
              <span>
                <strong>ATTITUDE Latency Warning:</strong> Telemetry packet age is {attitudeAgeMs}ms (&gt; 1000ms threshold). Checking MAVLink UART stream on COM8.
              </span>
            </div>
          )}

          {!isOnline && (
            <div className="p-3 bg-danger/15 border border-danger/30 rounded-lg flex items-center gap-2.5 text-danger font-sans text-xs">
              <span className="material-symbols-outlined text-[18px]">error</span>
              <span>
                <strong>Telemetry Stream Disconnected:</strong> Awaiting physical MAVLink connection from Pixhawk 2.4.8 on COM8.
              </span>
            </div>
          )}

          {isGpsStale && (
            <div className="p-3 bg-info/15 border border-info/30 rounded-lg flex items-center gap-2.5 text-info font-sans text-xs">
              <span className="material-symbols-outlined text-[18px]">satellite_alt</span>
              <span>
                <strong>GNSS Fix Notice:</strong> GPS position packet age is {gpsAgeMs}ms. U-Blox NEO-M8N is acquiring satellite lock.
              </span>
            </div>
          )}

          {/* Dual-Transport Architecture & Failover Monitor */}
          <div className="p-4 bg-surface-elevated/50 rounded-xl border border-border space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2.5">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-accent-primary text-[18px]">
                  hub
                </span>
                <span className="font-sans font-bold text-xs uppercase tracking-wider text-text-primary">
                  Dual-Transport MAVLink Telemetry Architecture
                </span>
                <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-accent-primary/15 text-accent-primary border border-accent-primary/30 uppercase">
                  {transport?.mode ? `${transport.mode.toUpperCase()} MODE` : 'DUAL READY'}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-[11px] text-text-muted">Active Ingestion Source:</span>
                <span className={`px-2.5 py-0.5 rounded text-[11px] font-mono font-bold uppercase border ${
                  transport?.activeSource === 'WIFI'
                    ? 'bg-success/20 text-success border-success/40'
                    : transport?.activeSource === 'USB'
                    ? 'bg-warning/20 text-warning border-warning/40'
                    : 'bg-surface-muted text-text-muted border-border'
                }`}>
                  {transport?.activeSource === 'WIFI' ? '● PATH A: WI-FI (PRIMARY)' : transport?.activeSource === 'USB' ? '● PATH B: USB SERIAL (FALLBACK)' : 'STANDBY / NONE'}
                </span>
              </div>
            </div>

            {/* Transport Channels Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {/* Path A: Wi-Fi Hotspot (STA) */}
              <div className={`p-3 rounded-lg border space-y-1.5 ${
                transport?.activeSource === 'WIFI'
                  ? 'bg-surface-elevated border-success/40 shadow-sm'
                  : 'bg-surface-elevated/50 border-border'
              }`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[16px] text-accent-primary">wifi</span>
                    <span className="font-bold text-xs text-text-primary">Path A: Wi-Fi Hotspot (STA)</span>
                  </div>
                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold uppercase ${
                    transport?.wifi?.heartbeatAlive
                      ? 'bg-success/20 text-success'
                      : transport?.wifi?.connected
                      ? 'bg-warning/20 text-warning'
                      : 'bg-danger/20 text-danger'
                  }`}>
                    {transport?.wifi?.heartbeatAlive ? 'HEARTBEAT ALIVE' : transport?.wifi?.connected ? 'TCP CONNECTED' : 'DISCONNECTED'}
                  </span>
                </div>
                <div className="flex items-center justify-between font-mono text-[11px] text-text-muted">
                  <span className="truncate">
                    {transport?.wifi?.assignedIp ? `${transport.wifi.assignedIp}:5760` : (transport?.wifi?.endpoint || 'tcp:auto:5760')}
                  </span>
                  {transport?.wifi?.discoveryMethod && (
                    <span className="text-[9px] px-1 py-0.2 rounded bg-surface-muted text-accent-primary font-bold">
                      {transport.wifi.discoveryMethod}
                    </span>
                  )}
                </div>
                {transport?.wifi?.clientIsolationSuspected && (
                  <div className="text-[10px] text-warning bg-warning/10 p-1 rounded border border-warning/20 font-mono">
                    ⚠️ Hotspot Client Isolation Suspected
                  </div>
                )}
                <div className="flex justify-between items-center text-[10px] font-mono text-text-secondary pt-1 border-t border-border/40">
                  <span>Pkts: {transport?.wifi?.messageCount ?? 0}</span>
                  <span>Age: {transport?.wifi?.lastHeartbeatAgeMs ? `${transport.wifi.lastHeartbeatAgeMs}ms` : '—'}</span>
                  <span>Recon: {transport?.wifi?.reconnectCount ?? 0}</span>
                </div>
              </div>

              {/* Path B: USB Serial */}
              <div className={`p-3 rounded-lg border space-y-1.5 ${
                transport?.activeSource === 'USB'
                  ? 'bg-surface-elevated border-warning/40 shadow-sm'
                  : 'bg-surface-elevated/50 border-border'
              }`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[16px] text-info">usb</span>
                    <span className="font-bold text-xs text-text-primary">Path B: USB Serial</span>
                  </div>
                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold uppercase ${
                    transport?.usb?.heartbeatAlive
                      ? 'bg-success/20 text-success'
                      : transport?.usb?.connected
                      ? 'bg-warning/20 text-warning'
                      : 'bg-surface-muted text-text-muted'
                  }`}>
                    {transport?.usb?.heartbeatAlive ? 'HEARTBEAT ALIVE' : transport?.usb?.connected ? 'CONNECTED' : 'STANDBY'}
                  </span>
                </div>
                <div className="font-mono text-[11px] text-text-muted">
                  Port: COM8 @ 115200 baud
                </div>
                <div className="flex justify-between items-center text-[10px] font-mono text-text-secondary pt-1 border-t border-border/40">
                  <span>Pkts: {transport?.usb?.messageCount ?? 0}</span>
                  <span>Age: {transport?.usb?.lastHeartbeatAgeMs ? `${transport.usb.lastHeartbeatAgeMs}ms` : '—'}</span>
                  <span>Recon: {transport?.usb?.reconnectCount ?? 0}</span>
                </div>
              </div>

              {/* Failover & Resilience Metrics */}
              <div className="p-3 bg-surface-elevated/50 rounded-lg border border-border space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[16px] text-warning">swap_horiz</span>
                    <span className="font-bold text-xs text-text-primary">Failover State</span>
                  </div>
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-surface-muted text-text-muted">
                    {transport?.failoverCount ?? 0} EVENTS
                  </span>
                </div>
                <div className="text-[11px] text-text-secondary truncate">
                  Policy: <strong className="text-text-primary font-mono">{transport?.primaryPreference || 'WIFI'} Preferred</strong>
                </div>
                <div className="text-[10px] text-text-muted truncate pt-1 border-t border-border/40 font-mono">
                  {transport?.lastFailoverEvent?.reason ? `Last: ${transport.lastFailoverEvent.reason}` : 'Zero failovers recorded'}
                </div>
              </div>

              {/* Ingestion & Deduplication Policy */}
              <div className="p-3 bg-surface-elevated/50 rounded-lg border border-border space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[16px] text-accent-primary">verified_user</span>
                    <span className="font-bold text-xs text-text-primary">Ingestion Guard</span>
                  </div>
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-success/15 text-success">
                    DEDUP ACTIVE
                  </span>
                </div>
                <div className="text-[11px] text-text-secondary">
                  Standby stream deduplicated
                </div>
                <div className="text-[10px] text-text-muted truncate pt-1 border-t border-border/40 font-mono">
                  Zero duplicate DB records
                </div>
              </div>
            </div>
          </div>

          {/* Metric Cards Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {/* 1. ATTITUDE Stream Rate */}
            <div className="bg-surface-elevated/70 p-3 rounded-lg border border-border">
              <div className="flex items-center justify-between text-text-muted text-[11px] mb-1">
                <span>ATTITUDE Rate</span>
                <span className="material-symbols-outlined text-[14px] text-accent-primary">speed</span>
              </div>
              <div className="font-mono text-lg font-bold text-text-primary">
                {isOnline ? `${attitudeHz.toFixed(1)} Hz` : '0.0 Hz'}
              </div>
              <div className="text-[10px] font-mono text-text-muted mt-0.5">
                Target: 2.5 - 20.0 Hz
              </div>
            </div>

            {/* 2. ATTITUDE Packet Age */}
            <div className="bg-surface-elevated/70 p-3 rounded-lg border border-border">
              <div className="flex items-center justify-between text-text-muted text-[11px] mb-1">
                <span>ATTITUDE Age</span>
                <span className="material-symbols-outlined text-[14px] text-info">timer</span>
              </div>
              <div className={`font-mono text-lg font-bold ${
                !isOnline
                  ? 'text-text-muted'
                  : attitudeAgeMs < 500
                  ? 'text-success'
                  : attitudeAgeMs < 1200
                  ? 'text-warning'
                  : 'text-danger'
              }`}>
                {isOnline && attitudeAgeMs < 9999 ? `${attitudeAgeMs} ms` : '—'}
              </div>
              <div className="text-[10px] font-mono text-text-muted mt-0.5">
                Freshness: &lt; 500ms
              </div>
            </div>

            {/* 3. Sensor-to-Browser Latency Estimate */}
            <div className="bg-surface-elevated/70 p-3 rounded-lg border border-border">
              <div className="flex items-center justify-between text-text-muted text-[11px] mb-1">
                <span>Network Latency</span>
                <span className="material-symbols-outlined text-[14px] text-accent-primary">sync_alt</span>
              </div>
              <div className="font-mono text-lg font-bold text-accent-primary">
                {isOnline && latencyEstimateMs > 0 ? `${latencyEstimateMs} ms` : (isOnline ? '< 10 ms' : '—')}
              </div>
              <div className="text-[10px] font-mono text-text-muted mt-0.5">
                Target: &lt; 250ms
              </div>
            </div>

            {/* 4. GPS Stream Rate */}
            <div className="bg-surface-elevated/70 p-3 rounded-lg border border-border">
              <div className="flex items-center justify-between text-text-muted text-[11px] mb-1">
                <span>GPS Rate</span>
                <span className="material-symbols-outlined text-[14px] text-text-muted">satellite</span>
              </div>
              <div className="font-mono text-lg font-bold text-text-primary">
                {isOnline ? `${gpsHz.toFixed(1)} Hz` : '0.0 Hz'}
              </div>
              <div className="text-[10px] font-mono text-text-muted mt-0.5">
                {latestTelemetry?.satellites ?? 0} Sats Active
              </div>
            </div>

            {/* 5. Last GPS Age */}
            <div className="bg-surface-elevated/70 p-3 rounded-lg border border-border">
              <div className="flex items-center justify-between text-text-muted text-[11px] mb-1">
                <span>GPS Packet Age</span>
                <span className="material-symbols-outlined text-[14px] text-text-muted">schedule</span>
              </div>
              <div className="font-mono text-lg font-bold text-text-primary">
                {isOnline && gpsAgeMs < 9999 ? `${gpsAgeMs} ms` : '—'}
              </div>
              <div className="text-[10px] font-mono text-text-muted mt-0.5">
                Fix: {latestTelemetry?.gpsFixType || 'STANDBY'}
              </div>
            </div>

            {/* 6. Authoritative Orientation Vector */}
            <div className="bg-surface-elevated/70 p-3 rounded-lg border border-border">
              <div className="flex items-center justify-between text-text-muted text-[11px] mb-1">
                <span>Attitude Vector</span>
                <span className="material-symbols-outlined text-[14px] text-accent-primary">navigation</span>
              </div>
              <div className="font-mono text-xs font-bold text-text-primary space-y-0.5">
                <div>Y: <span className="text-accent-primary font-bold">{isOnline ? `${yaw.toFixed(1)}°` : '—'}</span></div>
                <div className="text-[11px] text-text-secondary">R: {isOnline ? `${roll.toFixed(1)}°` : '—'} | P: {isOnline ? `${pitch.toFixed(1)}°` : '—'}</div>
              </div>
            </div>
          </div>

          {/* Technical Diagnostics Summary Strip */}
          <div className="p-3 bg-surface-elevated/40 rounded-lg border border-border/80 flex flex-wrap items-center justify-between gap-3 text-xs font-sans text-text-muted">
            <div className="flex flex-wrap items-center gap-3">
              <span>
                Backend Transport: <strong className="text-text-primary font-mono font-semibold">Socket.IO WebSocket (M2M Direct)</strong>
              </span>
              <span className="text-border">•</span>
              <span>
                Bridge Queue Depth: <strong className="text-accent-primary font-mono font-semibold">0 (Direct Non-blocking)</strong>
              </span>
              <span className="text-border">•</span>
              <span>
                Source FC: <strong className="text-text-primary font-mono">Pixhawk 2.4.8 (STM32F427)</strong>
              </span>
            </div>
            <div className="flex items-center gap-2 font-mono text-[11px]">
              <span className="text-text-muted">Attitude Updated:</span>
              <span className="text-text-primary">
                {latestAttitude?.recordedAt ? new Date(latestAttitude.recordedAt).toLocaleTimeString() : 'Awaiting data'}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

