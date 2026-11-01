// The persisted service mode, its change history and the guard against a real Postgres with migrations
// applied (ticket). Skips when DATABASE_URL is unset. It runs in its own scratch database, created from
// the migrations and dropped afterwards, because other integration files share DATABASE_URL in parallel
// and a delegated first-time actor is refused while the shared row is not active. Synthetic data only.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import pg from 'pg';
import { runner } from 'node-pg-migrate';

const { OWN_DB } = vi.hoisted(() => {
  const OWN_DB = `ticket_mode_${process.pid}`;
  // db/pool.js reads DB_NAME when imported; it connects lazily, after beforeAll has created the database.
  if (process.env.DATABASE_URL) process.env.DB_NAME = OWN_DB;
  return { OWN_DB };
});

vi.mock('../../lib/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import pool from '../../db/pool.js';
import { changeServiceState, readServiceState } from '../serviceMode.js';
import { FROZEN_MESSAGE, serviceModeGuard } from '../../middleware/serviceModeGuard.js';

const DATABASE_URL = process.env.DATABASE_URL;
const CONTROLLER = 'ops-portal-run@ops-portal.iam.gserviceaccount.com';
const EMAIL = 'ticket.synthetic@example.test';

async function userJson(): Promise<string> {
  const { rows } = await pool.query<{ j: string }>(`SELECT to_jsonb(u)::text AS j FROM users u WHERE email = $1`, [
    EMAIL,
  ]);
  return rows[0].j;
}

async function changes() {
  const { rows } = await pool.query<{
    changed_by: string;
    changed_at: Date;
    from_mode: string;
    to_mode: string;
    reason: string;
  }>(
    `SELECT changed_by, changed_at, from_state->>'mode' AS from_mode, to_state->>'mode' AS to_mode, reason
       FROM service_mode_changes ORDER BY changed_at, id`,
  );
  return rows;
}

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'migrations');

async function admin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

describe.skipIf(!DATABASE_URL)('service mode (Postgres)', () => {
  beforeAll(async () => {
    await admin(`DROP DATABASE IF EXISTS ${OWN_DB}`);
    await admin(`CREATE DATABASE ${OWN_DB}`);
    const url = new URL(DATABASE_URL!);
    url.pathname = `/${OWN_DB}`;
    await runner({
      databaseUrl: url.toString(),
      dir: MIGRATIONS,
      direction: 'up',
      migrationsTable: 'pgmigrations',
      log: () => {},
    });
    await pool.query(
      `INSERT INTO users (email, name, role) VALUES ($1, 'Synthetic Advisor', 'advisor') ON CONFLICT (email) DO NOTHING`,
      [EMAIL],
    );
  });

  beforeEach(async () => {
    delete process.env.SERVICE_MODE_OVERRIDE;
    await pool.query(
      `UPDATE service_mode SET mode = 'active', digest_sender = 'on', drift_sender = 'on',
              mode_changed_at = NOW(), updated_at = NOW(), updated_by = 'test' WHERE id`,
    );
    await pool.query(`DELETE FROM service_mode_changes`);
  });

  afterAll(async () => {
    await pool.end();
    await admin(`DROP DATABASE IF EXISTS ${OWN_DB}`);
  });

  it('holds exactly one row, read as active with both senders on', async () => {
    const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM service_mode`);
    expect(rows[0].n).toBe(1);
    const state = await readServiceState();
    expect([state.mode, state.digestSender, state.driftSender]).toEqual(['active', 'on', 'on']);
  });

  it('records a mode change with its time, caller and reason', async () => {
    const state = await changeServiceState({ mode: 'frozen' }, CONTROLLER, 'cutover freeze');
    expect([state.mode, state.updatedBy]).toEqual(['frozen', CONTROLLER]);
    const log = await changes();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      changed_by: CONTROLLER,
      from_mode: 'active',
      to_mode: 'frozen',
      reason: 'cutover freeze',
    });
    expect(log[0].changed_at).toBeInstanceOf(Date);
  });

  it('turns sender switches off without moving the mode-change time', async () => {
    const before = (await readServiceState()).modeChangedAt;
    await changeServiceState({ digestSender: 'off' }, CONTROLLER, 'digest handoff');
    const state = await changeServiceState({ driftSender: 'off' }, CONTROLLER, 'drift handoff');
    expect([state.mode, state.digestSender, state.driftSender]).toEqual(['active', 'off', 'off']);
    expect(state.modeChangedAt).toBe(before);
    expect(await changes()).toHaveLength(2);
  });

  it('frozen, then MCP-only, then active leaves each person’s standalone access as it was', async () => {
    const before = await userJson();
    for (const mode of ['frozen', 'mcp-only', 'active'] as const) await changeServiceState({ mode }, CONTROLLER, mode);
    expect((await readServiceState()).mode).toBe('active');
    expect(await userJson()).toBe(before);
    expect((await changes()).map((c) => c.to_mode)).toEqual(['frozen', 'mcp-only', 'active']);
  });

  it('the guard follows the persisted mode', async () => {
    const app = express();
    app.use(serviceModeGuard);
    app.use((_req, res) => {
      res.status(204).end();
    });
    await changeServiceState({ mode: 'frozen' }, CONTROLLER, 'freeze');
    const frozen = await request(app).post('/api/requests').send({});
    expect([frozen.status, frozen.body.error]).toEqual([423, FROZEN_MESSAGE]);
    await changeServiceState({ mode: 'mcp-only' }, CONTROLLER, 'retire');
    expect((await request(app).get('/api/requests')).status).toBe(403);
    await changeServiceState({ mode: 'active' }, CONTROLLER, 'restore');
    expect((await request(app).post('/api/requests').send({})).status).toBe(204);
  });

  it('refuses a mode outside active, frozen and mcp-only at the database', async () => {
    await expect(pool.query(`UPDATE service_mode SET mode = 'paused' WHERE id`)).rejects.toMatchObject({
      code: '23514',
    });
  });
});
