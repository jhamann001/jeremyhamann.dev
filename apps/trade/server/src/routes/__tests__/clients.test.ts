import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthUser } from '@trade-request/shared';
import { advisorUser } from './testHelpers.js';

const { mockPool, warehouseMocks, mockLogger } = vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  process.env.SESSION_SECRET = 'test-session';
  const poolClient = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
  return {
    mockPool: {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      connect: vi.fn().mockResolvedValue(poolClient),
      end: vi.fn(),
      _client: poolClient,
    },
    warehouseMocks: {
      isConfigured: vi.fn(),
      fetchClients: vi.fn(),
      getCachedClients: vi.fn(),
      getClientAccounts: vi.fn(),
      getAccountTypeMap: vi.fn(),
    },
    mockLogger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  };
});

vi.mock('../../db/pool.js', () => ({ default: mockPool }));

vi.mock('../../middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth.js')>();
  return {
    ...actual,
    requireRole:
      (...roles: string[]) =>
      (req: any, res: any, next: any) => {
        if (!req.user) return res.status(401).json({ error: 'Authentication required' });
        if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
        next();
      },
  };
});

vi.mock('../../services/warehouse.js', () => ({
  isConfigured: () => warehouseMocks.isConfigured(),
  fetchClients: (...args: unknown[]) => warehouseMocks.fetchClients(...args),
  getCachedClients: (...args: unknown[]) => warehouseMocks.getCachedClients(...args),
  getClientAccounts: (...args: unknown[]) => warehouseMocks.getClientAccounts(...args),
  getAccountTypeMap: (...args: unknown[]) => warehouseMocks.getAccountTypeMap(...args),
}));

vi.mock('../../lib/logger.js', () => ({ default: mockLogger }));

import express from 'express';
import request from 'supertest';
import clientRoutes from '../clients.js';

function createApp(user: AuthUser, options?: { isDemo?: boolean }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = user;
    (req as any).isAuthenticated = () => true;
    if (options?.isDemo) (req as any).isDemo = true;
    next();
  });
  app.use('/api/clients', clientRoutes);
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = err.statusCode ?? 500;
    res.status(status).json({ error: err.message ?? 'Internal server error' });
  });
  return app;
}

const sampleClients = [
  {
    id: 'user-1',
    name: 'John Doe',
    accounts: [
      {
        id: 'apex-1',
        clientId: 'user-1',
        accountNumber: 'ACCT-001',
        accountType: 'Taxable' as const,
        balance: 100000,
        holdings: { cash: 100000, fixed: 0, equity: 0 },
      },
    ],
  },
];

describe('GET /api/clients', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    warehouseMocks.isConfigured.mockReset();
    warehouseMocks.getCachedClients.mockReset();
    mockPool.query.mockReset();
  });

  it('returns client data from Warehouse when configured', async () => {
    warehouseMocks.isConfigured.mockReturnValue(true);
    warehouseMocks.getCachedClients.mockResolvedValue(sampleClients);
    const res = await request(createApp(advisorUser)).get('/api/clients').expect(200);
    expect(res.body).toEqual({ data: sampleClients });
    expect(warehouseMocks.getCachedClients).toHaveBeenCalledOnce();
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('returns 502 when Warehouse fetch fails', async () => {
    warehouseMocks.isConfigured.mockReturnValue(true);
    warehouseMocks.getCachedClients.mockRejectedValue(new Error('network error'));
    await request(createApp(advisorUser)).get('/api/clients').expect(502);
  });

  it('falls back to local DB when Warehouse is not configured', async () => {
    warehouseMocks.isConfigured.mockReturnValue(false);
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'HH-001', name: 'Richardson Family' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'a1',
            client_id: 'HH-001',
            account_number: 'ACCT-1001',
            account_type: 'Taxable',
            balance: '850000',
            cash_holding: '42500',
            fixed_holding: '127500',
            equity_holding: '680000',
          },
        ],
      });

    const res = await request(createApp(advisorUser)).get('/api/clients').expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('HH-001');
    expect(res.body.data[0].accounts).toHaveLength(1);
    expect(res.body.data[0].accounts[0].balance).toBe(850000);
    expect(warehouseMocks.getCachedClients).not.toHaveBeenCalled();
  });

  it('returns empty array from local DB when no seed data exists', async () => {
    warehouseMocks.isConfigured.mockReturnValue(false);
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp(advisorUser)).get('/api/clients').expect(200);
    expect(res.body).toEqual({ data: [] });
  });

  it('returns demo fixture data when isDemo is true', async () => {
    const res = await request(createApp(advisorUser, { isDemo: true }))
      .get('/api/clients')
      .expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0].id).toMatch(/^demo-client-/);
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(warehouseMocks.getCachedClients).not.toHaveBeenCalled();
  });
});
