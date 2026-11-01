import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Scheduler job routes while the service is frozen or MCP-only, or a sender switch is off (ticket).
const { mockPool, sendDailyDigestMock, sendDigestToTargetMock, runDriftCheckMock, readStateMock, loggerMock } =
  vi.hoisted(() => ({
    mockPool: { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn(), end: vi.fn() },
    sendDailyDigestMock: vi.fn(),
    sendDigestToTargetMock: vi.fn(),
    runDriftCheckMock: vi.fn(),
    readStateMock: vi.fn(),
    loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }));

vi.mock('../../db/pool.js', () => ({ default: mockPool }));
vi.mock('../../lib/logger.js', () => ({ default: loggerMock }));
vi.mock('../../middleware/schedulerAuth.js', () => ({
  requireSchedulerAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../services/digest.js', () => ({
  sendDailyDigest: sendDailyDigestMock,
  buildDailyDigest: vi.fn(),
  sendDigestToTarget: sendDigestToTargetMock,
}));
vi.mock('../../services/registryDriftRunner.js', () => ({
  runDriftCheck: runDriftCheckMock,
  previewDriftCheck: vi.fn(),
}));
vi.mock('../../services/serviceMode.js', () => ({ readServiceState: readStateMock }));

import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../middleware/errorHandler.js';

async function createApp() {
  const { default: internalRoutes } = await import('../internal.js');
  const app = express();
  app.use(express.json());
  app.use('/api/internal', internalRoutes);
  app.use(errorHandler);
  return app;
}

const state = (mode: string, digestSender = 'on', driftSender = 'on') => ({ mode, digestSender, driftSender });

beforeEach(() => {
  vi.clearAllMocks();
  readStateMock.mockReset();
  sendDailyDigestMock.mockResolvedValue({ sent: true, summary: { runDate: '2026-10-20' } });
  sendDigestToTargetMock.mockResolvedValue({ sent: true, target: 'U1', summary: { total: 0 } });
  runDriftCheckMock.mockResolvedValue({ runDateLocal: '2026-10-20', totalHouseholds: 0 });
  process.env.DRIFT_ENABLED = 'true';
});

afterEach(() => {
  delete process.env.DRIFT_ENABLED;
});

describe('digest and drift jobs follow the service mode and sender switches', () => {
  it('frozen: the daily digest posts nothing and claims nothing', async () => {
    readStateMock.mockResolvedValue(state('frozen'));
    const res = await request(await createApp()).post('/api/internal/digest/daily');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: false, reason: 'service_mode' });
    expect(sendDailyDigestMock).not.toHaveBeenCalled();
  });

  it('MCP-only: the daily digest posts nothing and claims nothing', async () => {
    readStateMock.mockResolvedValue(state('mcp-only'));
    const res = await request(await createApp()).post('/api/internal/digest/daily');
    expect(res.body).toEqual({ sent: false, reason: 'service_mode' });
    expect(sendDailyDigestMock).not.toHaveBeenCalled();
  });

  it('active with the digest sender switch off: posts nothing and claims nothing', async () => {
    readStateMock.mockResolvedValue(state('active', 'off', 'on'));
    const res = await request(await createApp()).post('/api/internal/digest/daily');
    expect(res.body).toEqual({ sent: false, reason: 'sender_off' });
    expect(sendDailyDigestMock).not.toHaveBeenCalled();
  });

  it('frozen: the digest test-send posts nothing', async () => {
    readStateMock.mockResolvedValue(state('frozen'));
    const res = await request(await createApp())
      .post('/api/internal/digest/test-send')
      .send({ target: 'U1' });
    expect(res.body).toEqual({ sent: false, reason: 'service_mode' });
    expect(sendDigestToTargetMock).not.toHaveBeenCalled();
  });

  it('frozen: the drift check posts no alert or reminder and writes no result', async () => {
    readStateMock.mockResolvedValue(state('frozen'));
    const res = await request(await createApp()).post('/api/internal/drift/check');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ran: false, reason: 'service_mode' });
    expect(runDriftCheckMock).not.toHaveBeenCalled();
  });

  it('active with the drift sender switch off: the drift check does not run', async () => {
    readStateMock.mockResolvedValue(state('active', 'on', 'off'));
    const res = await request(await createApp()).post('/api/internal/drift/check');
    expect(res.body).toEqual({ ran: false, reason: 'sender_off' });
    expect(runDriftCheckMock).not.toHaveBeenCalled();
  });

  it('active with both switches on: the digest posts and the drift check runs (today)', async () => {
    readStateMock.mockResolvedValue(state('active'));
    const app = await createApp();
    expect((await request(app).post('/api/internal/digest/daily')).body.sent).toBe(true);
    expect((await request(app).post('/api/internal/drift/check')).status).toBe(200);
    expect(sendDailyDigestMock).toHaveBeenCalledTimes(1);
    expect(runDriftCheckMock).toHaveBeenCalledTimes(1);
  });

  it('posts nothing when the mode cannot be read', async () => {
    readStateMock.mockRejectedValue(new Error('db down'));
    const res = await request(await createApp()).post('/api/internal/digest/daily');
    expect(res.status).toBe(500);
    expect(sendDailyDigestMock).not.toHaveBeenCalled();
  });
});
