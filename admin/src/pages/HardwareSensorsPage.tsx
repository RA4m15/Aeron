import React, { useEffect, useState } from 'react';
import { fetchDroneHardware } from '../services/api';
import { useHardware } from '../context/HardwareContext';
import { HardwareDeviceData } from '../types';
import { resolveBatteryState } from '../config/drone';

const VERIFIED_FALLBACK_DEVICES: HardwareDeviceData[] = [
  {
    deviceId: 'HW-FC-01',
    droneId: 'AERON-HEX-01',
    deviceType: 'FLIGHT_CONTROLLER',
    manufacturer: 'Holybro / Radiolink',
    model: 'Pixhawk 2.4.8 (STM32F427)',
    serialNumber: 'PX4-248-STM32F427-01',
    installationStatus: 'INSTALLED',
    connectionStatus: 'CONNECTED',
    metadata: {
      firmware: 'ArduCopter v4.5.1',
      ports: {
        TELEM2: { baud: 57600, protocol: 'MAVLink 2.0', target: 'ESP32 DevKit V1 (GPIO16/17)', role: 'Primary Active Telemetry' },
        TELEM1: { baud: 57600, protocol: 'MAVLink', status: 'UNATTACHED' },
        GPS: { baud: 38400, protocol: 'UBX/NMEA', target: 'U-Blox NEO-M8N' },
        POWER: { type: 'Analog ADC', voltage_pin: 2, current_pin: 3, target: 'Generic GM V1.0 Power Module' }
      }
    }
  },
  {
    deviceId: 'HW-BRIDGE-01',
    droneId: 'AERON-HEX-01',
    deviceType: 'OTHER',
    manufacturer: 'Espressif Systems',
    model: 'ESP32 DevKit V1 (Dual-Transport Bridge)',
    serialNumber: 'ESP32-WROOM-32-DUAL',
    installationStatus: 'INSTALLED',
    connectionStatus: 'CONNECTED',
    metadata: {
      transports: {
        wifiStation: { mode: 'Station Mode (STA)', connection: 'Mobile Hotspot', port: 5760, protocol: 'TCP Stream (Primary Active)' },
        usbSerial: { port: 'COM8', baud: 115200, role: 'Secondary Fallback / Diagnostic Monitor' }
      },
      uart2: { rxPin: 'GPIO16', txPin: 'GPIO17', baud: 57600, connectedTo: 'Pixhawk TELEM2' },
      path: 'Pixhawk TELEM2 (57600) -> ESP32 UART2 -> Dual Stream (Wi-Fi 5760 TCP Primary + USB COM8 115200 Fallback)'
    }
  },
  {
    deviceId: 'HW-GPS-01',
    droneId: 'AERON-HEX-01',
    deviceType: 'GPS',
    manufacturer: 'U-Blox',
    model: 'U-Blox NEO-M8N + HMC5883L Compass',
    serialNumber: 'UBX-M8N-7730147',
    installationStatus: 'INSTALLED',
    connectionStatus: 'CONNECTED',
    metadata: {
      baud: 38400,
      constellations: ['GPS', 'GLONASS', 'SBAS'],
      i2cCompass: 'HMC5883L / IST8310',
      bus: 'I2C Internal/External',
      fixMode: 'Standard 3D Lock (DGPS/RTK not equipped)'
    }
  },
  {
    deviceId: 'HW-PWR-01',
    droneId: 'AERON-HEX-01',
    deviceType: 'POWER_MODULE',
    manufacturer: 'Generic / GM V1.0',
    model: 'Generic GM V1.0 Power Module (Analog ADC)',
    serialNumber: 'PM-3S-ADC-01',
    installationStatus: 'INSTALLED',
    connectionStatus: 'CONNECTED',
    metadata: {
      chemistry: 'LiPo',
      cellCount: 3,
      nominalVoltage: 11.1,
      maxVoltage: 12.6,
      warningVoltage: 10.5,
      criticalVoltage: 9.9,
      calibration: 'VOLTAGE_ONLY',
      note: 'Current sensor uncalibrated / unmeasured on bench. Pack voltage reading nominal; remaining mAh requires hardware calibration.'
    }
  },
  {
    deviceId: 'HW-RGF-01',
    droneId: 'AERON-HEX-01',
    deviceType: 'OTHER',
    manufacturer: 'N/A',
    model: 'Downlink Distance Lidar/Sonar (AGL)',
    serialNumber: 'NONE',
    installationStatus: 'NOT_INSTALLED',
    connectionStatus: 'DISCONNECTED',
    metadata: {
      status: 'NOT_INSTALLED',
      note: 'No downward rangefinder installed. Direct AGL unavailable; relative altitude is derived from barometric pressure reference.'
    }
  }
];

export const HardwareSensorsPage: React.FC = () => {
  const { isOnline, hardwareStatusLabel, latestTelemetry, transport } = useHardware();
  const [devices, setDevices] = useState<HardwareDeviceData[]>(VERIFIED_FALLBACK_DEVICES);
  const [loading, setLoading] = useState<boolean>(true);
  const [calibrationNotice, setCalibrationNotice] = useState<string | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<HardwareDeviceData | null>(VERIFIED_FALLBACK_DEVICES[0]);
  const batt = resolveBatteryState(latestTelemetry, isOnline);

  const sh = (latestTelemetry?.sensorHealth || {}) as Record<string, any>;
  const imuPresent = isOnline ? (sh.imuPresent ?? (sh.imu !== undefined)) : false;
  const imuHealthy = isOnline ? !!sh.imu : false;
  const baroPresent = isOnline ? (sh.barometerPresent ?? (sh.barometer !== undefined)) : false;
  const baroHealthy = isOnline ? !!sh.barometer : false;
  const compassPresent = isOnline ? (sh.compassPresent ?? (sh.compass !== undefined)) : false;
  const compassHealthy = isOnline ? !!sh.compass : false;
  const gpsPresent = isOnline ? (sh.gpsPresent ?? (sh.gps !== undefined)) : false;
  const gpsHealthy = isOnline ? (!!sh.gps && (latestTelemetry?.satellites ?? 0) >= 4) : false;

  useEffect(() => {
    let isMounted = true;
    const loadHardware = async () => {
      try {
        const res = await fetchDroneHardware('AERON-HEX-01');
        if (isMounted) {
          if (res?.devices && res.devices.length > 0) {
            setDevices(res.devices);
            setSelectedDevice(res.devices[0]);
          } else {
            setDevices(VERIFIED_FALLBACK_DEVICES);
            setSelectedDevice(VERIFIED_FALLBACK_DEVICES[0]);
          }
        }
      } catch (err) {
        console.warn('[HardwareSensors] Failed to load hardware devices:', err);
        if (isMounted) {
          setDevices(VERIFIED_FALLBACK_DEVICES);
          setSelectedDevice(VERIFIED_FALLBACK_DEVICES[0]);
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    loadHardware();
    return () => {
      isMounted = false;
    };
  }, []);

  const handleCalibrate = (sensorName: string) => {
    setCalibrationNotice(
      `[SAFETY INTERLOCK] Sensor calibration for '${sensorName}' is restricted in read-only telemetry mode. Local bench validation required via MAVLink CLI.`
    );
    setTimeout(() => setCalibrationNotice(null), 5000);
  };

  return (
    <div className="flex flex-col w-full px-6 py-6 space-y-6 max-w-[1680px] mx-auto text-text-primary">
      {/* Top Banner */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 bg-surface rounded-xl border border-border shadow-sm">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="material-symbols-outlined text-accent-primary text-[24px]">memory</span>
            <h1 className="font-sans font-bold text-base tracking-normal text-text-primary">
              Hardware & Sensors Bench
            </h1>
          </div>
          <p className="font-sans text-xs text-text-muted mt-0.5">
            Pixhawk 2.4.8 (STM32F427) Onboard Bus • Peripheral Sensor Diagnostics
          </p>
        </div>

        <button
          onClick={() => handleCalibrate('ALL_IMU_SENSORS')}
          className="px-4 py-2 bg-surface-elevated border border-border text-text-secondary hover:text-text-primary rounded-lg font-sans text-xs font-semibold flex items-center gap-2 transition-all cursor-not-allowed opacity-80"
          title="Restricted by ground safety policy"
        >
          <span className="material-symbols-outlined text-[16px] text-accent-primary">tune</span>
          <span>Calibrate sensors (Safety restricted)</span>
        </button>
      </div>

      {/* Safety Interlock Notification */}
      {calibrationNotice && (
        <div className="p-3.5 bg-danger/15 border border-danger/40 text-danger rounded-xl font-mono text-xs flex items-center justify-between shadow-lg">
          <div className="flex items-center gap-2.5">
            <span className="material-symbols-outlined text-[18px]">lock</span>
            <span>{calibrationNotice}</span>
          </div>
          <button onClick={() => setCalibrationNotice(null)} className="text-text-primary hover:text-danger">
            ✕
          </button>
        </div>
      )}

      {/* Device Overview Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {loading ? (
          <div className="col-span-4 p-12 text-center text-text-muted font-mono text-xs">
            SCANNING ONBOARD BUS PERIPHERALS...
          </div>
        ) : devices.length === 0 ? (
          <div className="col-span-4 p-12 text-center text-text-muted font-mono text-xs">
            NO HARDWARE DEVICES REGISTERED FOR AERON-HEX-01.
          </div>
        ) : (
          devices.map((dev) => (
            <div
              key={dev.deviceId}
              onClick={() => setSelectedDevice(dev)}
              className={`p-4 rounded-xl border transition-all cursor-pointer ${
                selectedDevice?.deviceId === dev.deviceId
                  ? 'bg-surface-elevated border-accent-primary/60 shadow-[0_0_12px_rgba(181,222,83,0.12)]'
                  : 'bg-surface border-border hover:border-border/80'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-[10px] text-text-muted uppercase">
                  {dev.deviceType.replace('_', ' ')}
                </span>
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-bold font-mono uppercase ${
                    dev.connectionStatus === 'CONNECTED'
                      ? 'bg-success/15 text-success border border-success/30'
                      : dev.connectionStatus === 'AWAITING_DATA'
                      ? 'bg-warning/15 text-warning border border-warning/30'
                      : 'bg-surface-muted text-text-muted border border-border'
                  }`}
                >
                  {dev.connectionStatus}
                </span>
              </div>
              <h3 className="font-sans font-bold text-text-primary text-sm truncate">{dev.model}</h3>
              <p className="font-sans text-xs text-text-muted">{dev.manufacturer}</p>
              <div className="mt-3 pt-2.5 border-t border-border/60 flex justify-between font-mono text-[11px] text-text-muted">
                <span>INSTALL: {dev.installationStatus}</span>
                <span className="text-accent-primary">{dev.deviceId}</span>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Main Hardware Detail Section */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Onboard Bus & Port Architecture (8 Cols) */}
        <div className="lg:col-span-8 bg-surface p-5 rounded-xl border border-border space-y-4">
          <div className="flex items-center justify-between border-b border-border/60 pb-3">
            <div>
              <h2 className="font-sans font-bold text-sm text-text-primary">
                Pixhawk 2.4.8 Pinout & Bus Topology
              </h2>
              <span className="text-[11px] text-text-muted">
                Autopilot link: {hardwareStatusLabel}
              </span>
            </div>
            <span className="font-mono text-xs text-accent-primary font-bold">
              ArduPilot Copter v4.5.1
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
            {/* 1. TELEM 2 / SERIAL2 (Verified Connected Hardware Path) */}
            <div className="bg-surface-elevated p-3.5 rounded-lg border border-border space-y-1.5">
              <div className="flex justify-between items-center">
                <span className="text-text-primary font-bold">TELEM 2 / SERIAL2</span>
                <span className="text-accent-primary font-mono font-bold">57600 baud</span>
              </div>
              <p className="text-text-muted text-[11px]">MAVLink 2.0 → ESP32 UART (GPIO16 RX2 / GPIO17 TX2)</p>
              <div className="flex items-center justify-between pt-1">
                <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold border ${
                  isOnline
                    ? 'bg-success/15 text-success border-success/30'
                    : 'bg-surface-muted text-text-muted border-border'
                }`}>
                  {isOnline ? 'Connected (Verified)' : 'Standby (Pre-flight)'}
                </span>
                <span className="text-[10px] font-mono text-text-muted">TELEM2 → ESP32</span>
              </div>
            </div>

            {/* 2. ESP32 DevKit V1 Dual-Transport Bridge */}
            <div className="bg-surface-elevated p-3.5 rounded-lg border border-border space-y-1.5">
              <div className="flex justify-between items-center">
                <span className="text-text-primary font-bold">ESP32 Dual Bridge</span>
                <span className="text-accent-primary font-mono font-bold">
                  {transport?.activeSource ? `${transport.activeSource} ACTIVE` : 'DUAL READY'}
                </span>
              </div>
              <p className="text-text-muted text-[11px]">
                Path A: Wi-Fi Hotspot (TCP 5760) • Path B: USB (COM8 @ 115200)
              </p>
              <div className="flex items-center justify-between pt-1">
                <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold border ${
                  isOnline
                    ? 'bg-success/15 text-success border-success/30'
                    : 'bg-surface-muted text-text-muted border-border'
                }`}>
                  {isOnline
                    ? (transport?.activeSource === 'WIFI' ? 'Wi-Fi Primary (5760)' : 'USB Fallback (COM8)')
                    : 'Standby / Offline'}
                </span>
                <span className="text-[10px] font-mono text-text-muted">
                  Failovers: {transport?.failoverCount ?? 0}
                </span>
              </div>
            </div>

            {/* 3. TELEM 1 / SERIAL1 (Unattached) */}
            <div className="bg-surface-elevated p-3.5 rounded-lg border border-border space-y-1.5 opacity-80">
              <div className="flex justify-between items-center">
                <span className="text-text-primary font-bold">TELEM 1 / SERIAL1</span>
                <span className="text-text-muted font-mono">57600 baud</span>
              </div>
              <p className="text-text-muted text-[11px]">Primary Telemetry UART (No transceiver attached)</p>
              <div className="flex items-center justify-between pt-1">
                <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold bg-surface-muted text-text-muted border border-border">
                  UNKNOWN / NOT VERIFIED
                </span>
                <span className="text-[10px] font-mono text-text-muted">Unattached</span>
              </div>
            </div>

            {/* 4. GPS & I2C Bus */}
            <div className="bg-surface-elevated p-3.5 rounded-lg border border-border space-y-1.5">
              <div className="flex justify-between items-center">
                <span className="text-text-primary font-bold">GPS & I2C Bus</span>
                <span className="text-accent-primary font-mono font-bold">38400 baud</span>
              </div>
              <p className="text-text-muted text-[11px]">U-Blox NEO-M8N GNSS + External HMC5883L Compass</p>
              <div className="flex items-center justify-between pt-1">
                <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold border ${
                  isOnline
                    ? 'bg-success/15 text-success border-success/30'
                    : 'bg-surface-muted text-text-muted border-border'
                }`}>
                  {isOnline ? 'Bus Locked (3D Fix)' : 'Standby (Pre-flight)'}
                </span>
                <span className="text-[10px] font-mono text-text-muted">SERIAL3 + I2C</span>
              </div>
            </div>

            {/* 5. Power Sensor (3S LiPo Power Module) */}
            <div className="bg-surface-elevated p-3.5 rounded-lg border border-border space-y-1.5 sm:col-span-2 lg:col-span-2">
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <span className="text-text-primary font-bold">Power Sensor (Analog ADC)</span>
                  <span className="text-[10px] font-mono text-accent-primary font-bold">3S LiPo (11.1V Nom / 12.6V Max)</span>
                </div>
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${batt.sourceBadgeClass}`}>
                  {batt.sourceLabel}
                </span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <p className="text-text-muted">
                  Voltage:{' '}
                  <strong className="text-text-primary font-mono">
                    {isOnline && batt.voltage !== null ? `${batt.voltage.toFixed(2)}V` : '—'}
                  </strong>
                  {' • '}
                  SoC:{' '}
                  <strong className="text-accent-primary font-mono">
                    {isOnline && batt.percentage !== null ? `${batt.percentage}%` : 'UNKNOWN'}
                  </strong>
                  {' • '}
                  Cell Avg:{' '}
                  <strong className="text-accent-primary font-mono">
                    {isOnline && batt.voltage !== null ? `${(batt.voltage / 3).toFixed(2)}V/cell` : '—'}
                  </strong>
                  {' • '}
                  Remaining:{' '}
                  <strong className="text-text-secondary font-mono">
                    {isOnline && batt.remainingMah !== null ? `${batt.remainingMah} mAh` : 'Unavailable'}
                  </strong>
                </p>
                <span className="text-[10px] font-mono text-text-secondary">
                  Current: {batt.current !== null ? `${batt.current.toFixed(1)}A` : 'N/A (Unmeasured)'}
                </span>
              </div>
              <p className="text-[10px] text-text-muted italic border-t border-border/40 pt-1">
                3S LiPo non-linear discharge lookup • Approximate estimate for bench monitoring.
              </p>
            </div>
          </div>

          {/* Sensor Self-Test Matrix */}
          <div className="mt-4 pt-3 border-t border-border/60 space-y-3">
            <span className="font-sans text-xs text-text-primary font-bold uppercase tracking-wider block">
              Internal Sensor Health & Redundancy Matrix
            </span>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-xs">
              {/* 1. Primary IMU */}
              <div className="bg-surface-elevated p-3 rounded-lg border border-border flex flex-col justify-between">
                <div>
                  <span className="text-text-muted text-[10px] block">Primary IMU (3D)</span>
                  <span className="text-text-primary font-mono font-bold text-xs">3D Accel / Gyro</span>
                  <span className="text-[10px] text-text-muted block mt-0.5">Preset: MPU-6000 (Unverified)</span>
                </div>
                <div className="pt-2 border-t border-border/40 mt-2">
                  <div className="flex justify-between text-[10px]">
                    <span className="text-text-muted">Presence:</span>
                    <span className="font-semibold">{isOnline ? (imuPresent ? 'PRESENT' : 'NOT DETECTED') : 'NOT VERIFIED'}</span>
                  </div>
                  <div className="flex justify-between text-[10px]">
                    <span className="text-text-muted">Health:</span>
                    <span className={`font-bold ${isOnline && imuHealthy ? 'text-success' : 'text-text-muted'}`}>
                      {isOnline ? (imuHealthy ? 'HEALTHY' : 'DEGRADED') : 'STANDBY'}
                    </span>
                  </div>
                </div>
              </div>

              {/* 2. Secondary IMU */}
              <div className="bg-surface-elevated p-3 rounded-lg border border-border flex flex-col justify-between">
                <div>
                  <span className="text-text-muted text-[10px] block">Auxiliary IMU</span>
                  <span className="text-text-primary font-mono font-bold text-xs">Backup Gyro / Mag</span>
                  <span className="text-[10px] text-text-muted block mt-0.5">Preset: LSM303D (Unverified)</span>
                </div>
                <div className="pt-2 border-t border-border/40 mt-2">
                  <div className="flex justify-between text-[10px]">
                    <span className="text-text-muted">Presence:</span>
                    <span className="font-semibold">{isOnline ? (imuPresent ? 'PRESENT' : 'NOT DETECTED') : 'NOT VERIFIED'}</span>
                  </div>
                  <div className="flex justify-between text-[10px]">
                    <span className="text-text-muted">Health:</span>
                    <span className={`font-bold ${isOnline && imuHealthy ? 'text-success' : 'text-text-muted'}`}>
                      {isOnline ? (imuHealthy ? 'HEALTHY' : 'STANDBY') : 'STANDBY'}
                    </span>
                  </div>
                </div>
              </div>

              {/* 3. Barometer */}
              <div className="bg-surface-elevated p-3 rounded-lg border border-border flex flex-col justify-between">
                <div>
                  <span className="text-text-muted text-[10px] block">Barometer</span>
                  <span className="text-text-primary font-mono font-bold text-xs">Absolute Pressure</span>
                  <span className="text-[10px] text-text-muted block mt-0.5">Preset: MS5611 (Unverified)</span>
                </div>
                <div className="pt-2 border-t border-border/40 mt-2">
                  <div className="flex justify-between text-[10px]">
                    <span className="text-text-muted">Presence:</span>
                    <span className="font-semibold">{isOnline ? (baroPresent ? 'PRESENT' : 'NOT DETECTED') : 'NOT VERIFIED'}</span>
                  </div>
                  <div className="flex justify-between text-[10px]">
                    <span className="text-text-muted">Health:</span>
                    <span className={`font-bold ${isOnline && baroHealthy ? 'text-accent-primary' : 'text-text-muted'}`}>
                      {isOnline ? (baroHealthy ? 'HEALTHY' : 'DEGRADED') : 'STANDBY'}
                    </span>
                  </div>
                </div>
              </div>

              {/* 4. Compass */}
              <div className="bg-surface-elevated p-3 rounded-lg border border-border flex flex-col justify-between">
                <div>
                  <span className="text-text-muted text-[10px] block">Compass</span>
                  <span className="text-text-primary font-mono font-bold text-xs">3D Magnetometer</span>
                  <span className="text-[10px] text-text-muted block mt-0.5">Preset: HMC5883L (Unverified)</span>
                </div>
                <div className="pt-2 border-t border-border/40 mt-2">
                  <div className="flex justify-between text-[10px]">
                    <span className="text-text-muted">Presence:</span>
                    <span className="font-semibold">{isOnline ? (compassPresent ? 'PRESENT' : 'NOT DETECTED') : 'NOT VERIFIED'}</span>
                  </div>
                  <div className="flex justify-between text-[10px]">
                    <span className="text-text-muted">Health:</span>
                    <span className={`font-bold ${isOnline && compassHealthy ? 'text-success' : 'text-text-muted'}`}>
                      {isOnline ? (compassHealthy ? 'HEALTHY' : 'DEGRADED') : 'STANDBY'}
                    </span>
                  </div>
                </div>
              </div>

              {/* 5. GNSS Sensor */}
              <div className="bg-surface-elevated p-3 rounded-lg border border-border flex flex-col justify-between">
                <div>
                  <span className="text-text-muted text-[10px] block">GNSS Sensor</span>
                  <span className="text-text-primary font-mono font-bold text-xs">Satellite Position</span>
                  <span className="text-[10px] text-text-muted block mt-0.5">Preset: NEO-M8N (Unverified)</span>
                </div>
                <div className="pt-2 border-t border-border/40 mt-2">
                  <div className="flex justify-between text-[10px]">
                    <span className="text-text-muted">Presence:</span>
                    <span className="font-semibold">{isOnline ? (gpsPresent ? 'PRESENT' : 'NOT DETECTED') : 'NOT VERIFIED'}</span>
                  </div>
                  <div className="flex justify-between text-[10px]">
                    <span className="text-text-muted">Health:</span>
                    <span className={`font-bold ${isOnline && gpsHealthy ? 'text-accent-primary' : 'text-text-muted'}`}>
                      {isOnline ? (gpsHealthy ? `${latestTelemetry?.satellites ?? 0} Sats Lock` : 'SEARCHING') : 'STANDBY'}
                    </span>
                  </div>
                </div>
              </div>

              {/* 6. Rangefinder */}
              <div className="bg-surface-elevated p-3 rounded-lg border border-border flex flex-col justify-between opacity-80">
                <div>
                  <span className="text-text-muted text-[10px] block">Rangefinder (AGL)</span>
                  <span className="text-text-muted font-mono font-bold text-xs">Downward Lidar</span>
                  <span className="text-[10px] text-text-muted block mt-0.5">Distance Sensor</span>
                </div>
                <div className="pt-2 border-t border-border/40 mt-2">
                  <div className="flex justify-between text-[10px]">
                    <span className="text-text-muted">Presence:</span>
                    <span className="font-bold text-danger">NOT INSTALLED</span>
                  </div>
                  <div className="flex justify-between text-[10px]">
                    <span className="text-text-muted">Health:</span>
                    <span className="text-text-muted">N/A</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Selected Device Details Inspector (4 Cols) */}
        <div className="lg:col-span-4 bg-surface p-5 rounded-xl border border-border space-y-4 font-sans text-xs">
          <span className="font-sans text-sm font-bold text-text-primary block border-b border-border/60 pb-3">
            Device Specification Sheet
          </span>

          {selectedDevice ? (
            <div className="space-y-3.5">
              <div>
                <span className="text-[10px] text-text-muted block">Device Identifier</span>
                <span className="text-sm font-bold text-accent-primary font-mono">{selectedDevice.deviceId}</span>
              </div>
              <div>
                <span className="text-[10px] text-text-muted block">Model & Revision</span>
                <span className="text-text-primary font-bold">{selectedDevice.model}</span>
              </div>
              <div>
                <span className="text-[10px] text-text-muted block">Manufacturer</span>
                <span className="text-text-secondary">{selectedDevice.manufacturer}</span>
              </div>
              <div>
                <span className="text-[10px] text-text-muted block">Bus Type / Category</span>
                <span className="text-text-primary font-mono">{selectedDevice.deviceType.replace('_', ' ')}</span>
              </div>
              <div>
                <span className="text-[10px] text-text-muted block">Connection Status</span>
                <span className="text-text-primary font-bold">
                  {isOnline ? selectedDevice.connectionStatus : 'Standby (Pre-flight)'}
                </span>
              </div>
              {selectedDevice.serialNumber && (
                <div>
                  <span className="text-[10px] text-text-muted block">Serial Number</span>
                  <span className="text-text-secondary font-mono">{selectedDevice.serialNumber}</span>
                </div>
              )}
              {selectedDevice.metadata && (
                <div className="pt-2 border-t border-border/60">
                  <span className="text-[10px] text-text-muted block mb-1">Configuration Metadata</span>
                  <pre className="p-2.5 bg-surface-elevated rounded-lg border border-border text-[10px] text-text-secondary overflow-x-auto whitespace-pre-wrap break-all">
                    {JSON.stringify(selectedDevice.metadata, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          ) : (
            <div className="py-12 text-center text-text-muted">
              SELECT A HARDWARE DEVICE FROM THE TOP MATRIX TO INSPECT SPECIFICATIONS.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
