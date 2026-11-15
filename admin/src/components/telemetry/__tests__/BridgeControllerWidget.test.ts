import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CONTROLLER_BASE_URL,
  TOKEN_STORAGE_KEY,
  checkControllerHealth,
  fetchBridgeStatus,
  startBridgeService,
  stopBridgeService,
  restartBridgeService,
  getStoredBridgeToken,
  setStoredBridgeToken,
  fetchBridgeTokenFromLoopback,
  BridgeStatusResponse
} from '../../../services/bridgeController';

describe('AERON Bridge Controller — Client Service Suite', () => {
  const mockStorage: Record<string, string> = {};

  beforeEach(() => {
    vi.restoreAllMocks();
    Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);

    // Polyfill localStorage in node environment
    (globalThis as any).localStorage = {
      getItem: (key: string) => mockStorage[key] || null,
      setItem: (key: string, val: string) => {
        mockStorage[key] = val;
      },
      removeItem: (key: string) => {
        delete mockStorage[key];
      },
      clear: () => {
        Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
      },
      key: () => null,
      length: 0
    };
  });

  it('validates controller base URL is strictly loopback 127.0.0.1:8765', () => {
    expect(CONTROLLER_BASE_URL).toBe('http://127.0.0.1:8765');
  });

  it('stores and retrieves token in localStorage securely', () => {
    expect(getStoredBridgeToken()).toBeNull();
    setStoredBridgeToken('test-secret-token-1234567890');
    expect(getStoredBridgeToken()).toBe('test-secret-token-1234567890');
  });

  it('checkControllerHealth returns metadata when endpoint is reachable', async () => {
    const mockHealth = {
      status: 'ok',
      service: 'aeron-bridge-controller',
      version: '1.0.0',
      host: '127.0.0.1',
      port: 8765,
      pid: 1234
    };

    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockHealth
    } as any);

    const health = await checkControllerHealth();
    expect(health).not.toBeNull();
    expect(health?.status).toBe('ok');
    expect(health?.port).toBe(8765);
    expect(health?.service).toBe('aeron-bridge-controller');
  });

  it('checkControllerHealth returns null when controller is offline', async () => {
    (globalThis as any).fetch = vi.fn().mockRejectedValue(new Error('Failed to fetch'));

    const health = await checkControllerHealth();
    expect(health).toBeNull();
  });

  it('fetchBridgeStatus returns CONTROLLER_OFFLINE status when network error occurs', async () => {
    (globalThis as any).fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await fetchBridgeStatus();
    expect(res.status).toBe('CONTROLLER_OFFLINE');
    expect(res.managed_pid).toBeNull();
    expect(res.telemetry_fresh).toBe(false);
    expect(res.esp32_state).toBe('DISCONNECTED');
    expect(res.heartbeat_state).toBe('NO_HEARTBEAT');
    expect(res.last_error).toContain('ECONNREFUSED');
  });

  it('fetchBridgeStatus parses valid active bridge response', async () => {
    const mockStatus: BridgeStatusResponse = {
      status: 'CONNECTED',
      managed_pid: 2468,
      transport: 'WIFI',
      esp32_state: 'CONNECTED',
      heartbeat_state: 'HEALTHY',
      telemetry_fresh: true,
      telemetry_age_ms: 120,
      message_rate_hz: 5.0,
      uptime_seconds: 64,
      last_error: null,
      recent_logs: ['[INFO] [ESP32-DISCOVERY] Discovered ESP32'],
      started_at: Date.now() - 64000
    };

    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockStatus
    } as any);

    const res = await fetchBridgeStatus();
    expect(res.status).toBe('CONNECTED');
    expect(res.managed_pid).toBe(2468);
    expect(res.esp32_state).toBe('CONNECTED');
    expect(res.heartbeat_state).toBe('HEALTHY');
    expect(res.telemetry_fresh).toBe(true);
  });

  it('startBridgeService includes X-AERON-TOKEN authentication header in POST', async () => {
    setStoredBridgeToken('my-secret-token');

    let capturedHeaders: any = null;
    (globalThis as any).fetch = vi.fn().mockImplementation((_url: any, options: any) => {
      capturedHeaders = options.headers;
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, message: 'Bridge process started', status: 'STARTING' })
      });
    });

    const res = await startBridgeService();
    expect(res.success).toBe(true);
    expect(res.status).toBe('STARTING');
    expect(capturedHeaders['X-AERON-TOKEN']).toBe('my-secret-token');
  });

  it('startBridgeService fails cleanly when token is missing', async () => {
    const res = await startBridgeService();
    expect(res.success).toBe(false);
    expect(res.message).toContain('Authentication token missing');
  });

  it('stopBridgeService sends POST to /api/bridge/stop with auth token', async () => {
    setStoredBridgeToken('auth-token-xyz');

    let capturedUrl = '';
    (globalThis as any).fetch = vi.fn().mockImplementation((url: any) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, message: 'Bridge stopped successfully', status: 'BRIDGE_STOPPED' })
      });
    });

    const res = await stopBridgeService();
    expect(res.success).toBe(true);
    expect(res.status).toBe('BRIDGE_STOPPED');
    expect(capturedUrl).toBe('http://127.0.0.1:8765/api/bridge/stop');
  });

  it('restartBridgeService sends POST to /api/bridge/restart', async () => {
    setStoredBridgeToken('auth-token-restart');

    let capturedUrl = '';
    (globalThis as any).fetch = vi.fn().mockImplementation((url: any) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, message: 'Bridge restarted', status: 'STARTING' })
      });
    });

    const res = await restartBridgeService();
    expect(res.success).toBe(true);
    expect(capturedUrl).toBe('http://127.0.0.1:8765/api/bridge/restart');
  });

  it('fetchBridgeTokenFromLoopback updates localStorage when token is returned', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'loopback-auto-token-abcdef' })
    } as any);

    const token = await fetchBridgeTokenFromLoopback();
    expect(token).toBe('loopback-auto-token-abcdef');
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('loopback-auto-token-abcdef');
  });
});
