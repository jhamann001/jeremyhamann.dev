import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { readStateMock, changeStateMock, loggerMock } = vi.hoisted(() => ({
  readStateMock: vi.fn(),
  changeStateMock: vi.fn(),
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../db/pool.js', () => ({ default: { query: vi.fn(), connect: vi.fn(), end: vi.fn() } }));
vi.mock('../../lib/logger.js', () => ({ default: loggerMock }));
vi.mock('../../services/serviceMode.js', () => ({
  SERVICE_MODES: ['active', 'frozen', 'mcp-only'],
  readServiceState: readStateMock,
  changeServiceState: changeStateMock,
}));

import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../middleware/errorHandler.js';

const OPS_PORTAL = 'ops-portal-run@ops-portal.iam.gserviceaccount.com';
const OTHER = 'other-reader@project.iam.gserviceaccount.com';
const STATE = {
  mode: 'frozen',
  persistedMode: 'frozen',
  override: null,
  digestSender: 'on',
  driftSender: 'off',
  modeChangedAt: '2026-10-20T14:00:00.000Z',
  writesSettledAt: '2026-10-20T14:05:00.000Z',
  updatedAt: '2026-10-20T14:00:00.000Z',
  updatedBy: OPS_PORTAL,
};

/** index.ts mounts the router behind requireMachineAuth, which sets req.machineCaller; this stands in for it. */
async function createApp(caller: string) {
  const { default: machineRoutes } = await import('../machine.js');
  const app = express();
  app.use(express.json());
  app.use('/api/machine', (req, _res, next) => {
    req.machineCaller = caller;
    next();
  });
  app.use('/api/machine', machineRoutes);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  readStateMock.mockResolvedValue(STATE);
  changeStateMock.mockResolvedValue(STATE);
  process.env.OPS_PORTAL_DELEGATED_CALLER_SA = OPS_PORTAL;
  delete process.env.SERVICE_MODE_CONTROLLER_SA;
});

afterEach(() => {
  delete process.env.OPS_PORTAL_DELEGATED_CALLER_SA;
  delete process.env.SERVICE_MODE_CONTROLLER_SA;
});

describe('/api/machine/service-mode', () => {
  it('GET returns the current mode and both sender switches, uncached', async () => {
    const res = await request(await createApp(OTHER)).get('/api/machine/service-mode');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STATE);
    expect(res.headers['cache-control']).toBe('no-store, private');
  });

  it('PUT from the advisor platform caller changes the mode and records its caller and reason', async () => {
    const res = await request(await createApp(OPS_PORTAL))
      .put('/api/machine/service-mode')
      .send({ mode: 'frozen', driftSender: 'off', reason: 'cutover freeze' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STATE);
    expect(changeStateMock).toHaveBeenCalledWith({ mode: 'frozen', driftSender: 'off' }, OPS_PORTAL, 'cutover freeze');
  });

  it('PUT from any other machine caller is refused', async () => {
    const res = await request(await createApp(OTHER))
      .put('/api/machine/service-mode')
      .send({ mode: 'active', reason: 'unfreeze' });
    expect(res.status).toBe(403);
    expect(changeStateMock).not.toHaveBeenCalled();
  });

  it('SERVICE_MODE_CONTROLLER_SA, when set, names the only identity that may change it', async () => {
    process.env.SERVICE_MODE_CONTROLLER_SA = OTHER;
    expect(
      (
        await request(await createApp(OTHER))
          .put('/api/machine/service-mode')
          .send({ digestSender: 'off', reason: 'r' })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(await createApp(OPS_PORTAL))
          .put('/api/machine/service-mode')
          .send({ digestSender: 'off', reason: 'r' })
      ).status,
    ).toBe(403);
    expect(changeStateMock).toHaveBeenCalledTimes(1);
  });

  it('PUT answers 503 when no controller identity is configured', async () => {
    delete process.env.OPS_PORTAL_DELEGATED_CALLER_SA;
    const res = await request(await createApp(OPS_PORTAL))
      .put('/api/machine/service-mode')
      .send({ mode: 'active', reason: 'r' });
    expect(res.status).toBe(503);
    expect(changeStateMock).not.toHaveBeenCalled();
  });

  it('PUT refuses an empty change, an unknown mode and an unknown field', async () => {
    const app = await createApp(OPS_PORTAL);
    for (const body of [{ reason: 'r' }, { mode: 'paused', reason: 'r' }, { mode: 'frozen', reason: 'r', extra: 1 }]) {
      expect((await request(app).put('/api/machine/service-mode').send(body)).status).toBe(400);
    }
    expect(changeStateMock).not.toHaveBeenCalled();
  });

  it('PUT requires a reason', async () => {
    const res = await request(await createApp(OPS_PORTAL))
      .put('/api/machine/service-mode')
      .send({ mode: 'frozen' });
    expect(res.status).toBe(400);
    expect(changeStateMock).not.toHaveBeenCalled();
  });
});
