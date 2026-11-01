import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// requireMachineAuth hands the verified caller to the routes (ticket): the mode change accepts only
// the controller identity, so a missing req.machineCaller would refuse every change.
const { jwtVerifyMock, changeStateMock } = vi.hoisted(() => ({
  jwtVerifyMock: vi.fn(),
  changeStateMock: vi.fn(),
}));

vi.mock('jose', () => ({ jwtVerify: jwtVerifyMock, createRemoteJWKSet: vi.fn(() => () => ({})) }));
vi.mock('../../lib/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../db/pool.js', () => ({ default: { query: vi.fn(), connect: vi.fn(), end: vi.fn() } }));
vi.mock('../../services/serviceMode.js', () => ({
  SERVICE_MODES: ['active', 'frozen', 'mcp-only'],
  readServiceState: vi.fn(),
  changeServiceState: changeStateMock,
}));

import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { requireMachineAuth } from '../machineAuth.js';
import { errorHandler } from '../errorHandler.js';

const OPS_PORTAL = 'ops-portal-run@ops-portal.iam.gserviceaccount.com';
const AUDIENCE = 'https://trade-request-xxxx-uc.a.run.app';
const token = (email: string) => ({
  payload: { iss: 'https://accounts.google.com', email, email_verified: true },
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MACHINE_AUDIENCE = AUDIENCE;
  process.env.ALLOWED_MACHINE_SA = `other-reader@project.iam.gserviceaccount.com,${OPS_PORTAL}`;
  process.env.OPS_PORTAL_DELEGATED_CALLER_SA = OPS_PORTAL;
  changeStateMock.mockResolvedValue({ mode: 'frozen' });
});

afterEach(() => {
  delete process.env.MACHINE_AUDIENCE;
  delete process.env.ALLOWED_MACHINE_SA;
  delete process.env.OPS_PORTAL_DELEGATED_CALLER_SA;
});

function reqRes() {
  const req = { headers: { authorization: 'Bearer t' }, requestId: 'r1' } as unknown as Request;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), req } as unknown as Response;
  return { req, res, next: vi.fn() as unknown as NextFunction };
}

describe('requireMachineAuth and the machine caller', () => {
  it('sets req.machineCaller to the verified, lower-cased service-account email', async () => {
    jwtVerifyMock.mockResolvedValueOnce(token('OPS-PORTAL-Run@ops-portal.iam.gserviceaccount.com'));
    const { req, res, next } = reqRes();
    await requireMachineAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.machineCaller).toBe(OPS_PORTAL);
  });

  it('leaves req.machineCaller unset when the principal is refused', async () => {
    jwtVerifyMock.mockResolvedValueOnce(token('intruder@project.iam.gserviceaccount.com'));
    const { req, res, next } = reqRes();
    await requireMachineAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(req.machineCaller).toBeUndefined();
  });

  it('a PUT through the real machine auth reaches the mode change with the caller recorded', async () => {
    jwtVerifyMock.mockResolvedValue(token(OPS_PORTAL));
    const { default: machineRoutes } = await import('../../routes/machine.js');
    const app = express();
    app.use(express.json());
    app.use('/api/machine', requireMachineAuth, machineRoutes);
    app.use(errorHandler);
    const res = await request(app)
      .put('/api/machine/service-mode')
      .set('authorization', 'Bearer t')
      .send({ mode: 'frozen', reason: 'cutover freeze' });
    expect(res.status).toBe(200);
    expect(changeStateMock).toHaveBeenCalledWith({ mode: 'frozen' }, OPS_PORTAL, 'cutover freeze');
  });
});
