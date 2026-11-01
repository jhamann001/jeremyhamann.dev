import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockPool, mockClient, loggerMock } = vi.hoisted(() => {
  const mockClient = { query: vi.fn(), release: vi.fn() };
  return {
    mockClient,
    mockPool: { query: vi.fn(), connect: vi.fn(), end: vi.fn() },
    loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('../../db/pool.js', () => ({ default: mockPool }));
vi.mock('../../lib/logger.js', () => ({ default: loggerMock }));

import { changeServiceState, readServiceState, startServiceModeRefresh } from '../serviceMode.js';
import { messagesAllowed } from '../serviceModeState.js';

const CONTROLLER = 'ops-portal-run@ops-portal.iam.gserviceaccount.com';
const CHANGED_AT = new Date('2026-10-20T14:00:00.000Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'active',
    digest_sender: 'on',
    drift_sender: 'on',
    mode_changed_at: CHANGED_AT,
    updated_at: CHANGED_AT,
    updated_by: 'migration',
    ...overrides,
  };
}

beforeEach(() => {
  delete process.env.SERVICE_MODE_OVERRIDE;
  mockPool.query.mockReset();
  mockPool.connect.mockReset().mockResolvedValue(mockClient);
  mockClient.query.mockReset().mockResolvedValue({ rows: [] });
  mockClient.release.mockReset();
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.SERVICE_MODE_OVERRIDE;
});

describe('readServiceState', () => {
  it('maps the persisted row; an active service has no settle time', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [row({ digest_sender: 'off' })] });
    expect(await readServiceState()).toEqual({
      mode: 'active',
      persistedMode: 'active',
      override: null,
      digestSender: 'off',
      driftSender: 'on',
      modeChangedAt: '2026-10-20T14:00:00.000Z',
      writesSettledAt: null,
      updatedAt: '2026-10-20T14:00:00.000Z',
      updatedBy: 'migration',
    });
  });

  it('reports when writes admitted before a freeze have settled (300 s after the change)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [row({ mode: 'frozen' })] });
    const state = await readServiceState();
    expect(state.mode).toBe('frozen');
    expect(state.writesSettledAt).toBe('2026-10-20T14:05:00.000Z');
  });

  it('reads a missing row as active with both senders on and warns', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const state = await readServiceState();
    expect([state.mode, state.digestSender, state.driftSender]).toEqual(['active', 'on', 'on']);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'service_mode_row_missing' }),
      expect.any(String),
    );
  });

  it('lets SERVICE_MODE_OVERRIDE win over the persisted mode', async () => {
    process.env.SERVICE_MODE_OVERRIDE = 'mcp-only';
    mockPool.query.mockResolvedValueOnce({ rows: [row()] });
    const state = await readServiceState();
    expect([state.mode, state.persistedMode, state.override, state.writesSettledAt]).toEqual([
      'mcp-only',
      'active',
      'mcp-only',
      null,
    ]);
  });

  it('reads an unrecognised override as frozen and logs it', async () => {
    process.env.SERVICE_MODE_OVERRIDE = 'paused';
    mockPool.query.mockResolvedValueOnce({ rows: [row()] });
    expect((await readServiceState()).mode).toBe('frozen');
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'service_mode_override_invalid' }),
      expect.any(String),
    );
  });

  it('keeps the message gate in step with the latest read', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [row({ mode: 'frozen' })] });
    await readServiceState();
    expect(messagesAllowed()).toBe(false);
    mockPool.query.mockResolvedValueOnce({ rows: [row({ mode: 'active' })] });
    await readServiceState();
    expect(messagesAllowed()).toBe(true);
  });
});

describe('changeServiceState', () => {
  it('locks the row, updates it and appends the change with its caller and reason, in one transaction', async () => {
    mockClient.query.mockImplementation(async (sql: string) =>
      sql.includes('FOR UPDATE') ? { rows: [row()] } : { rows: [] },
    );
    mockPool.query.mockResolvedValueOnce({ rows: [row({ mode: 'frozen', updated_by: CONTROLLER })] });

    const state = await changeServiceState({ mode: 'frozen' }, CONTROLLER, 'cutover freeze');

    const sql = mockClient.query.mock.calls.map(([s]) => String(s).trim().split(/\s+/)[0]);
    expect(sql).toEqual(['BEGIN', 'SELECT', 'UPDATE', 'INSERT', 'COMMIT']);
    expect(mockClient.query.mock.calls[2][1]).toEqual(['frozen', 'on', 'on', CONTROLLER]);
    const [, params] = mockClient.query.mock.calls[3];
    expect(params[0]).toBe(CONTROLLER);
    expect(JSON.parse(params[1])).toEqual({ mode: 'active', digestSender: 'on', driftSender: 'on' });
    expect(JSON.parse(params[2])).toEqual({ mode: 'frozen', digestSender: 'on', driftSender: 'on' });
    expect(params[3]).toBe('cutover freeze');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
    expect(state.updatedBy).toBe(CONTROLLER);
  });

  it('rolls back, releases and rejects when the change cannot be recorded', async () => {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FOR UPDATE')) return { rows: [row()] };
      if (sql.includes('INSERT INTO service_mode_changes')) throw new Error('insert failed');
      return { rows: [] };
    });

    await expect(changeServiceState({ driftSender: 'off' }, CONTROLLER, 'handoff')).rejects.toThrow('insert failed');
    const sql = mockClient.query.mock.calls.map(([s]) => String(s).trim().split(/\s+/)[0]);
    expect(sql).toEqual(['BEGIN', 'SELECT', 'UPDATE', 'INSERT', 'ROLLBACK']);
    expect(mockClient.release).toHaveBeenCalledTimes(1);
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});

describe('startServiceModeRefresh', () => {
  it('reads the mode at start-up and again on every interval, keeping the message gate current', async () => {
    vi.useFakeTimers();
    try {
      mockPool.query.mockResolvedValue({ rows: [row({ mode: 'mcp-only' })] });
      startServiceModeRefresh(1_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockPool.query).toHaveBeenCalledTimes(1);
      expect(messagesAllowed()).toBe(false);
      mockPool.query.mockResolvedValue({ rows: [row({ mode: 'active' })] });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mockPool.query).toHaveBeenCalledTimes(2);
      expect(messagesAllowed()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
