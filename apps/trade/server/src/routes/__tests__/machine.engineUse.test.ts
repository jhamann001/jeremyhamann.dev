import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPool, loggerMock, reportMock, fixedReport } = vi.hoisted(() => {
  const fixedReport = {
    planGeneration: 'off',
    windowDays: 7,
    coveredDays: 3,
    countingStarted: '2026-10-01',
    planGenerationOffSince: '2026-10-20',
    days: [],
    today: { day: '2026-10-28', mcp: { ran: 1, refused: 0 }, service: { ran: 0, refused: 0 } },
  };
  return {
    mockPool: { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn(), end: vi.fn() },
    loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    reportMock: vi.fn().mockResolvedValue(fixedReport),
    fixedReport,
  };
});

vi.mock('../../db/pool.js', () => ({ default: mockPool }));
vi.mock('../../lib/logger.js', () => ({ default: loggerMock }));
vi.mock('../../services/engineUse.js', () => ({ engineUseReport: reportMock }));

import express from 'express';
import request from 'supertest';
import machineRoutes from '../machine.js';
import { errorHandler } from '../../middleware/errorHandler.js';

function createApp() {
  const app = express();
  // Auth is applied at mount time in index.ts (requireMachineAuth); mounted bare here.
  app.use('/api/machine', machineRoutes);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  reportMock.mockClear();
});

describe('GET /api/machine/engine-use', () => {
  it('returns the report with no-store caching', async () => {
    const res = await request(createApp()).get('/api/machine/engine-use?days=7');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(fixedReport);
    expect(res.headers['cache-control']).toBe('no-store, private');
  });

  it('rejects a zero-day window without building the report', async () => {
    const res = await request(createApp()).get('/api/machine/engine-use?days=0');
    expect(res.status).toBe(400);
    expect(reportMock).not.toHaveBeenCalled();
  });

  it('defaults the window to seven days', async () => {
    await request(createApp()).get('/api/machine/engine-use');
    expect(reportMock).toHaveBeenCalledWith(7);
  });

  it('rejects a window longer than 31 days', async () => {
    const res = await request(createApp()).get('/api/machine/engine-use?days=32');
    expect(res.status).toBe(400);
  });
});
