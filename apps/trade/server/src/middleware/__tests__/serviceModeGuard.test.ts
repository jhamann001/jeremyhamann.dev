import { describe, it, expect, vi, beforeEach } from 'vitest';

const { readStateMock, loggerMock } = vi.hoisted(() => ({
  readStateMock: vi.fn(),
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../services/serviceMode.js', () => ({ readServiceState: readStateMock }));
vi.mock('../../lib/logger.js', () => ({ default: loggerMock }));

import express from 'express';
import request from 'supertest';
import { errorHandler } from '../errorHandler.js';
import { FROZEN_MESSAGE, serviceModeDecision, serviceModeGuard, serviceModeRoute } from '../serviceModeGuard.js';

function app() {
  const a = express();
  a.use(serviceModeGuard);
  a.use((_req, res) => {
    res.status(204).end();
  });
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  readStateMock.mockReset();
});

describe('serviceModeDecision', () => {
  it('allows everything while active', () => {
    expect(serviceModeDecision('active', 'POST', '/api/requests')).toBe('allow');
    expect(serviceModeDecision('active', 'GET', '/api/users')).toBe('allow');
  });

  it('frozen: refuses Trade Request writes and keeps reads', () => {
    expect(serviceModeDecision('frozen', 'POST', '/api/requests')).toBe('frozen');
    expect(serviceModeDecision('frozen', 'PUT', '/api/ops-portal/requests/REQ-1/status')).toBe('frozen');
    expect(serviceModeDecision('frozen', 'PATCH', '/auth/preferences')).toBe('frozen');
    expect(serviceModeDecision('frozen', 'GET', '/api/requests')).toBe('allow');
    expect(serviceModeDecision('frozen', 'GET', '/api/ops-portal/requests')).toBe('allow');
  });

  it('frozen: keeps sign-in, Connected Apps, MCP sign-in, jobs and the machine surface writable', () => {
    for (const [method, path] of [
      ['POST', '/auth/logout'],
      ['POST', '/auth/extend-session'],
      ['DELETE', '/api/me/mcp-tokens/t-1'],
      ['DELETE', '/api/me/mcp-sessions'],
      ['POST', '/token'],
      ['POST', '/register'],
      ['POST', '/mcp'],
      ['POST', '/api/internal/digest/daily'],
      ['PUT', '/api/machine/service-mode'],
    ]) {
      expect([method, path, serviceModeDecision('frozen', method, path)]).toEqual([method, path, 'allow']);
    }
  });

  it('MCP-only: refuses every screen and action except MCP, sign-in, Connected Apps and the static client', () => {
    expect(serviceModeDecision('mcp-only', 'GET', '/api/requests')).toBe('mcp-only');
    expect(serviceModeDecision('mcp-only', 'GET', '/api/ops-portal/requests')).toBe('mcp-only');
    expect(serviceModeDecision('mcp-only', 'GET', '/api/docs')).toBe('mcp-only');
    expect(serviceModeDecision('mcp-only', 'POST', '/auth/demo')).toBe('mcp-only');
    expect(serviceModeDecision('mcp-only', 'GET', '/connected-apps')).toBe('allow');
    expect(serviceModeDecision('mcp-only', 'GET', '/assets/index-abc123.js')).toBe('allow');
    expect(serviceModeDecision('mcp-only', 'GET', '/auth/me')).toBe('allow');
    expect(serviceModeDecision('mcp-only', 'GET', '/auth/google/callback')).toBe('allow');
    expect(serviceModeDecision('mcp-only', 'GET', '/api/me/mcp-sessions')).toBe('allow');
    expect(serviceModeDecision('mcp-only', 'POST', '/mcp')).toBe('allow');
    expect(serviceModeDecision('mcp-only', 'GET', '/.well-known/oauth-authorization-server')).toBe('allow');
  });

  it('matches paths the way Express routes them: any letter case, optional trailing slash', () => {
    expect(serviceModeDecision('frozen', 'post', '/API/Requests/')).toBe('frozen');
    expect(serviceModeDecision('mcp-only', 'GET', '/API/MACHINE/service-mode')).toBe('allow');
    expect(serviceModeDecision('mcp-only', 'GET', '/api/me/mcp-tokens-extra')).toBe('mcp-only');
  });
});

describe('serviceModeGuard', () => {
  it('answers a frozen write with 423 and the read-only message', async () => {
    readStateMock.mockResolvedValue({ mode: 'frozen' });
    const res = await request(app()).post('/api/requests').send({});
    expect(res.status).toBe(423);
    expect(res.body).toMatchObject({ error: FROZEN_MESSAGE, code: 'service_frozen' });
  });

  it('answers an MCP-only screen request with 403', async () => {
    readStateMock.mockResolvedValue({ mode: 'mcp-only' });
    const res = await request(app()).get('/api/requests');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('service_mcp_only');
  });

  it('refuses with 503 when the mode cannot be read, and never reads it for a request every mode allows', async () => {
    readStateMock.mockRejectedValue(new Error('db down'));
    const refused = await request(app()).put('/api/requests/REQ-1/status').send({});
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe('service_mode_unavailable');
    readStateMock.mockClear();
    const asset = await request(app()).get('/assets/app.js');
    expect(asset.status).toBe(204);
    expect(readStateMock).not.toHaveBeenCalled();
  });

  it('passes every request through while active', async () => {
    readStateMock.mockResolvedValue({ mode: 'active' });
    const res = await request(app()).post('/api/requests').send({});
    expect(res.status).toBe(204);
    expect(readStateMock).toHaveBeenCalledTimes(1);
  });

  it('GET /api/service-mode answers the effective mode from the record, uncached, and fails without a mode', async () => {
    const route = express();
    route.get('/api/service-mode', serviceModeRoute);
    route.use(errorHandler);
    readStateMock.mockResolvedValue({ mode: 'frozen' });
    const res = await request(route).get('/api/service-mode');
    expect([res.status, res.body, res.headers['cache-control']]).toEqual([200, { mode: 'frozen' }, 'no-store']);
    readStateMock.mockResolvedValue({ mode: 'mcp-only' });
    expect((await request(route).get('/api/service-mode')).body).toEqual({ mode: 'mcp-only' });
    readStateMock.mockRejectedValue(new Error('db down'));
    expect((await request(route).get('/api/service-mode')).status).toBe(500);
  });
});
