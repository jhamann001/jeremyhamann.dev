import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPool } = vi.hoisted(() => ({ mockPool: { query: vi.fn(), connect: vi.fn(), end: vi.fn() } }));
vi.mock('../../db/pool.js', () => ({ default: mockPool }));

import express from 'express';
import request from 'supertest';
import outboxRoutes from '../outbox.js';
import { errorHandler } from '../../middleware/errorHandler.js';

const ID = '3b241101-e2bb-4255-8caf-4136c566a962';

function app() {
  const a = express();
  a.use('/api/outbox', outboxRoutes);
  a.use(errorHandler);
  return a;
}

beforeEach(() => {
  mockPool.query.mockReset();
});

describe('GET /api/outbox/:id/body', () => {
  it("serves an email's HTML under a policy that lets its inline styles apply and nothing else", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ body: '<h2 style="margin:0">Welcome</h2>' }] });
    const res = await request(app()).get(`/api/outbox/${ID}/body`).expect(200);
    expect(res.text).toBe('<h2 style="margin:0">Welcome</h2>');
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    const policy = res.headers['content-security-policy'];
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("style-src 'unsafe-inline'");
    expect(policy).toContain('sandbox');
    expect(policy).not.toMatch(/script-src/);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(mockPool.query.mock.calls[0][1]).toEqual([ID]);
    expect(mockPool.query.mock.calls[0][0]).toMatch(/transport = 'email'/);
  });

  it('answers 404 for a message that is not an email or does not exist', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await request(app()).get(`/api/outbox/${ID}/body`).expect(404);
  });

  it('refuses an id that is not a UUID without asking the database', async () => {
    await request(app()).get('/api/outbox/not-an-id/body').expect(400);
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});
