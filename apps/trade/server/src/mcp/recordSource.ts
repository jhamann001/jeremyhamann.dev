import type { AuthUser } from '@trade-request/shared';
import pool from '../db/pool.js';
import { opsPortalRecordsConfigured, opsPortalRecordsDb, OpsPortalRecordsUnavailableError, type RecordDb } from '../db/opsPortalRecords.js';
import logger from '../lib/logger.js';
import { AppError } from '../middleware/errorHandler.js';

export const MCP_ACCESS_REFUSED =
  'Your Ops Portal role does not include Trade Request access, so Trade Request tools are unavailable to you.';

export class McpAccessRefusedError extends AppError {
  constructor() {
    super(403, MCP_ACCESS_REFUSED);
  }
}

export interface McpRecordContext {
  source: 'local' | 'opsPortal';
  db: RecordDb;
  /** The caller as MCP tools see them. While OPS-PORTAL-served, id comes from OPS_PORTAL's Trade Request identity, role from OPS_PORTAL. */
  user: AuthUser;
}

interface SelectionRow {
  serving_source: string;
  has_access: boolean;
  ops_portal_trader: boolean;
  tr_user_id: string | null;
}

/**
 * Chooses where this MCP call reads Trade Request records (ticket). Unconfigured: the local database, no query.
 * Configured: one read of OPS_PORTAL's serving state, the caller's access row and their Trade Request identity; OPS-PORTAL-served
 * reads Ops Portal and refuses a caller whose Ops Portal role grants no Trade Request access; standalone-served reads locally.
 * Any failure to read Ops Portal refuses the call (never a silent fallback to local records).
 *
 * While OPS-PORTAL-served the caller's role follows the epic's mapping of the current Ops Portal role (ADMIN or OPERATIONS →
 * trader, anything else → advisor), read from `mcp_access.trader_role` (OPS_PORTAL migration
 * 20261101120000_trade_request_schema).
 */
export async function selectMcpRecordSource(user: AuthUser): Promise<McpRecordContext> {
  if (!opsPortalRecordsConfigured()) return { source: 'local', db: pool, user };
  const email = user.email.trim().toLowerCase();
  const { rows } = await opsPortalRecordsDb.query<SelectionRow>(
    `SELECT s.serving_source,
            COALESCE(a.has_access, FALSE) AS has_access,
            COALESCE(a.trader_role, FALSE) AS ops_portal_trader,
            u.id::text AS tr_user_id
       FROM serving_state s
       LEFT JOIN mcp_access a ON a.email = $1
       LEFT JOIN LATERAL (
         SELECT id FROM users WHERE lower(btrim(email)) = $1 ORDER BY is_active DESC, created_at ASC LIMIT 1
       ) u ON TRUE
      WHERE s.id`,
    [email],
  );
  const row = rows[0];
  if (!row || (row.serving_source !== 'standalone' && row.serving_source !== 'opsPortal')) {
    logger.warn({ event: 'mcp_ops_portal_records_unavailable', code: row ? 'serving_state_value' : 'serving_state_missing' });
    throw new OpsPortalRecordsUnavailableError();
  }
  if (row.serving_source === 'standalone') {
    logger.info({ event: 'mcp_record_source', source: 'local', configured: true }, 'MCP record source');
    return { source: 'local', db: pool, user };
  }
  if (!row.has_access) {
    logger.info({ event: 'mcp_access_refused', userId: user.id }, 'MCP caller has no Trade Request access in OPS_PORTAL');
    throw new McpAccessRefusedError();
  }
  logger.info({ event: 'mcp_record_source', source: 'opsPortal', configured: true }, 'MCP record source');
  return {
    source: 'opsPortal',
    db: opsPortalRecordsDb,
    user: { ...user, id: row.tr_user_id ?? user.id, role: row.ops_portal_trader ? 'trader' : 'advisor' },
  };
}
