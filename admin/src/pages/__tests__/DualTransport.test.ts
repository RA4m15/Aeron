import { describe, it, expect } from 'vitest';
import { TransportStatusData } from '../../types';

describe('AERON Dual-Transport Telemetry Contract & State Evaluation', () => {
  it('validates Dual-Transport metadata structure', () => {
    const transport: TransportStatusData = {
      mode: 'dual',
      activeSource: 'WIFI',
      primaryPreference: 'WIFI',
      failoverCount: 0,
      lastFailoverEvent: null,
      wifi: {
        name: 'WIFI',
        endpoint: 'tcp:192.168.4.1:5760',
        connected: true,
        heartbeatAlive: true,
        lastHeartbeatAgeMs: 120,
        lastMessageAgeMs: 25,
        messageCount: 520,
        heartbeatCount: 52,
        reconnectCount: 0
      },
      usb: {
        name: 'USB',
        endpoint: 'COM8',
        connected: true,
        heartbeatAlive: true,
        lastHeartbeatAgeMs: 110,
        lastMessageAgeMs: 24,
        messageCount: 520,
        heartbeatCount: 52,
        reconnectCount: 0
      },
      isAnyAlive: true
    };

    expect(transport.mode).toBe('dual');
    expect(transport.activeSource).toBe('WIFI');
    expect(transport.wifi?.connected).toBe(true);
    expect(transport.wifi?.heartbeatAlive).toBe(true);
    expect(transport.usb?.connected).toBe(true);
    expect(transport.usb?.heartbeatAlive).toBe(true);
    expect(transport.isAnyAlive).toBe(true);
  });

  it('correctly identifies failover state from Wi-Fi to USB', () => {
    const failoverTransport: TransportStatusData = {
      mode: 'dual',
      activeSource: 'USB',
      primaryPreference: 'WIFI',
      failoverCount: 1,
      lastFailoverEvent: {
        ageSeconds: 5,
        reason: 'Preferred WIFI lost heartbeat (> 3.0s)'
      },
      wifi: {
        name: 'WIFI',
        endpoint: 'tcp:192.168.4.1:5760',
        connected: false,
        heartbeatAlive: false,
        lastHeartbeatAgeMs: 4500,
        lastMessageAgeMs: 4500,
        messageCount: 300,
        heartbeatCount: 30,
        reconnectCount: 1
      },
      usb: {
        name: 'USB',
        endpoint: 'COM8',
        connected: true,
        heartbeatAlive: true,
        lastHeartbeatAgeMs: 80,
        lastMessageAgeMs: 20,
        messageCount: 420,
        heartbeatCount: 42,
        reconnectCount: 0
      },
      isAnyAlive: true
    };

    expect(failoverTransport.activeSource).toBe('USB');
    expect(failoverTransport.failoverCount).toBe(1);
    expect(failoverTransport.lastFailoverEvent?.reason).toContain('lost heartbeat');
    expect(failoverTransport.wifi?.heartbeatAlive).toBe(false);
    expect(failoverTransport.usb?.heartbeatAlive).toBe(true);
  });

  it('reports connection lost when both transports are disconnected', () => {
    const offlineTransport: TransportStatusData = {
      mode: 'dual',
      activeSource: 'NONE',
      primaryPreference: 'WIFI',
      failoverCount: 2,
      lastFailoverEvent: {
        ageSeconds: 20,
        reason: 'All transports disconnected'
      },
      wifi: {
        name: 'WIFI',
        endpoint: 'tcp:192.168.4.1:5760',
        connected: false,
        heartbeatAlive: false,
        lastHeartbeatAgeMs: 35000,
        messageCount: 100,
        heartbeatCount: 10,
        reconnectCount: 5
      },
      usb: {
        name: 'USB',
        endpoint: 'COM8',
        connected: false,
        heartbeatAlive: false,
        lastHeartbeatAgeMs: 35000,
        messageCount: 100,
        heartbeatCount: 10,
        reconnectCount: 3
      },
      isAnyAlive: false
    };

    expect(offlineTransport.isAnyAlive).toBe(false);
    expect(offlineTransport.activeSource).toBe('NONE');
  });

  it('handles mobile hotspot Wi-Fi station mode with dynamic DHCP IP and client isolation detection', () => {
    const staTransport: TransportStatusData = {
      mode: 'dual',
      activeSource: 'WIFI',
      primaryPreference: 'WIFI',
      failoverCount: 0,
      lastFailoverEvent: null,
      wifi: {
        name: 'WIFI',
        endpoint: 'tcp:192.168.43.155:5760',
        assignedIp: '192.168.43.155',
        discoveryMethod: 'UDP_BEACON',
        clientIsolationSuspected: false,
        connected: true,
        heartbeatAlive: true,
        lastHeartbeatAgeMs: 95,
        lastMessageAgeMs: 20,
        messageCount: 1540,
        heartbeatCount: 154,
        reconnectCount: 0
      },
      usb: {
        name: 'USB',
        endpoint: 'COM8',
        connected: true,
        heartbeatAlive: true,
        lastHeartbeatAgeMs: 90,
        lastMessageAgeMs: 18,
        messageCount: 1540,
        heartbeatCount: 154,
        reconnectCount: 0
      },
      isAnyAlive: true
    };

    expect(staTransport.wifi?.assignedIp).toBe('192.168.43.155');
    expect(staTransport.wifi?.discoveryMethod).toBe('UDP_BEACON');
    expect(staTransport.wifi?.clientIsolationSuspected).toBe(false);

    // Now test isolation detection scenario
    const isolatedTransport: TransportStatusData = {
      ...staTransport,
      activeSource: 'USB',
      failoverCount: 1,
      wifi: {
        ...staTransport.wifi!,
        connected: false,
        heartbeatAlive: false,
        clientIsolationSuspected: true,
        lastError: 'TCP connection failed to tcp:192.168.43.155:5760 (Check phone hotspot AP / Client Isolation)'
      }
    };

    expect(isolatedTransport.activeSource).toBe('USB');
    expect(isolatedTransport.wifi?.clientIsolationSuspected).toBe(true);
    expect(isolatedTransport.wifi?.lastError).toContain('Client Isolation');
  });
});

