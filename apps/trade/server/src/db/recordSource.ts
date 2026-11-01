import { AsyncLocalStorage } from 'node:async_hooks';
import pool from './pool.js';
import type { RecordDb } from './opsPortalRecords.js';

/**
 * Which database Trade Request record reads use (ticket). MCP tool calls run inside `withRecordDb`, chosen per
 * call from OPS_PORTAL's serving state; every other caller has no scope and reads the local pool.
 */
const scope = new AsyncLocalStorage<RecordDb>();

export function recordDb(): RecordDb {
  return scope.getStore() ?? pool;
}

export function withRecordDb<T>(db: RecordDb, fn: () => Promise<T>): Promise<T> {
  return scope.run(db, fn);
}
