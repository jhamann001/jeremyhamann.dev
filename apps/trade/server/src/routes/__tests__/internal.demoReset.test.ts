import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// POST /api/internal/demo-reset: the demo's nightly reset, called by the Worker in front.
const { resetDemoMock } = vi.hoisted(() => ({ resetDemoMock: vi.fn() }));

vi.mock('../../db/pool.js', () => ({ default: { query: vi.fn(), connect: vi.fn(), end: vi.fn() } }));
vi.mock('../../lib/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../demo/reset.js', () => ({ resetDemo: resetDemoMock }));

import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../middleware/errorHandler.js';
import internalRoutes from '../internal.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal', internalRoutes);
  app.use(errorHandler);
  return app;
}

const TOKEN = 'reset-token-for-tests';

beforeEach(() => {
  resetDemoMock.mockReset();
  process.env.DEMO_STAND_INS = 'on';
  process.env.DEMO_RESET_TOKEN = TOKEN;
});
afterEach(() => {
  delete process.env.DEMO_STAND_INS;
  delete process.env.DEMO_RESET_TOKEN;
});

describe('POST /api/internal/demo-reset', () => {
  it('resets with the right token and returns the summary', async () => {
    resetDemoMock.mockResolvedValue({ requests: 20, driftRuns: 10 });
    const res = await request(createApp()).post('/api/internal/demo-reset').set('x-demo-reset-token', TOKEN).expect(200);
    expect(res.body.data).toEqual({ requests: 20, driftRuns: 10 });
  });

  it('refuses a missing or wrong token', async () => {
    await request(createApp()).post('/api/internal/demo-reset').expect(401);
    await request(createApp()).post('/api/internal/demo-reset').set('x-demo-reset-token', 'nope').expect(401);
    expect(resetDemoMock).not.toHaveBeenCalled();
  });

  it('does not exist without the stand-ins or without a configured token', async () => {
    delete process.env.DEMO_STAND_INS;
    await request(createApp()).post('/api/internal/demo-reset').set('x-demo-reset-token', TOKEN).expect(404);
    process.env.DEMO_STAND_INS = 'on';
    delete process.env.DEMO_RESET_TOKEN;
    await request(createApp()).post('/api/internal/demo-reset').set('x-demo-reset-token', TOKEN).expect(404);
    expect(resetDemoMock).not.toHaveBeenCalled();
  });

  it('runs one reset at a time', async () => {
    let finish: (v: unknown) => void = () => {};
    resetDemoMock.mockReturnValue(new Promise((r) => (finish = r)));
    const app = createApp();
    const first = request(app).post('/api/internal/demo-reset').set('x-demo-reset-token', TOKEN).then((r) => r);
    await vi.waitFor(() => expect(resetDemoMock).toHaveBeenCalledTimes(1));
    await request(app).post('/api/internal/demo-reset').set('x-demo-reset-token', TOKEN).expect(409);
    finish({ ok: true });
    expect((await first).status).toBe(200);
  });
});
