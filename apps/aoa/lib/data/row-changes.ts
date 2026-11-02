import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { withUserScope } from "@/lib/rls";
import { canReadAudit } from "./audit-log";
import { applyAuditReadDatabaseBounds, AUDIT_READ_TRANSACTION_OPTIONS } from "./audit-read-bounds";
import type { Identity } from "./types";
import type { WindowPage } from "@/lib/navigation/window-page";
import { auditDateRange } from "@/lib/navigation/audit-date-range";

// Field-level audit read seam (tkt-audit-row-change-ui). READ path only over
// the DB-trigger trail audit.row_change that the SECURITY DEFINER
// audit.log_row_change() function writes on every INSERT/UPDATE/DELETE to the
// app.* business tables (app.deal, app.transfer today). This file never writes
// — the trigger is the single writer.
//
// This is the raw, field-level companion to the business-event trail read by
// lib/data/audit-log.ts (listAuditLog). It reuses that seam's fail-closed role
// gate (canReadAudit — ADMIN + OPERATIONS) so both /audit-log views share ONE
// gate. audit.row_change additionally HAS row-level security enabled (SELECT
// effectively restricted to ADMIN/OPERATIONS via the row_change_ops_read
// policy), so reading through withUserScope is DB-enforced too — an equal-or-
// stricter backstop beneath the app gate. (The policy's historical IN(...) list
// still names HEAD_OF_ADVISORY, but no group or stored user retains that role;
// legacy session text is normalized to OPERATIONS at the RLS boundary.)
//
// SERIALIZATION TRAPS (house convention — coerce at the seam, never in
// components): `id` is BigInt and `at` is a Date at runtime; both would fail or
// drift crossing the Server → Client Component boundary (RowChangeTable is
// "use client"). Coerced to string / ISO string here. `changed` is jsonb →
// already a plain, serializable JS object at runtime (Prisma parses it), passed
// through as Record<string, unknown>.

export const ROW_CHANGE_PAGE_SIZE = 50;

export type RowChangeRow = {
  id: string; // BigInt → string at the seam
  at: string; // Date → ISO string at the seam
  actorEmail: string | null;
  actorRole: string | null;
  dbRole: string;
  table: string; // table_name (deal | transfer)
  op: string; // INSERT | UPDATE | DELETE
  rowPk: string | null;
  // UPDATE: { col: { from, to } }; INSERT/DELETE: full row snapshot. Plain JSON.
  changed: Record<string, unknown>;
};

export type RowChangeQuery = {
  /** 1-based page; clamped to ≥ 1 and NaN-safe. */
  page?: number;
  pageSize?: number;
  /** Exact table_name filter, e.g. "deal". */
  table?: string;
  /** Exact op filter: INSERT | UPDATE | DELETE. */
  op?: string;
  /** Exact actor-email filter. */
  actor?: string;
};

export type RowChangeResult =
  | {
      ok: true;
      snapshot: string;
      rows: RowChangeRow[];
      /** Total rows matching the current filters (drives the count pill). */
      total: number;
      page: number;
      pageCount: number;
      pageSize: number;
      /** Unfiltered DISTINCT vocabularies for the filter dropdowns. */
      tables: string[];
      ops: string[];
      actors: string[];
    }
  | { ok: false; reason: "forbidden" };

type RawRow = {
  id: bigint;
  at: Date;
  actor_email: string | null;
  actor_role: string | null;
  db_role: string;
  table_name: string;
  op: string;
  row_pk: string | null;
  changed: unknown;
};

type RawMetadata = {
  total: bigint;
  snapshot: string;
  tables: string[];
  ops: string[];
  actors: string[];
};

function rowChangeWhere(query: Pick<RowChangeQuery, "table" | "op" | "actor">): Prisma.Sql {
  const table = query.table?.trim() || null;
  const op = query.op?.trim() || null;
  const actor = query.actor?.trim() || null;
  return Prisma.sql`WHERE (${table}::text IS NULL OR table_name = ${table})
    AND (${op}::text IS NULL OR op = ${op})
    AND (${actor}::text IS NULL OR actor_email = ${actor})`;
}

async function readRowChangeMetadata(tx: Prisma.TransactionClient, where: Prisma.Sql): Promise<RawMetadata> {
  const [result] = await tx.$queryRaw<RawMetadata[]>(Prisma.sql`
    WITH grouped AS MATERIALIZED (
      SELECT table_name, op, actor_email, COUNT(*) AS n, MAX(id) AS last_id
      FROM audit.row_change
      GROUP BY table_name, op, actor_email
    ), population AS (
      SELECT COALESCE(SUM(n), 0)::bigint AS total, MAX(last_id) AS last_id
      FROM grouped ${where}
    )
    SELECT total, md5(total::text || ':' || COALESCE(last_id::text, '')) AS snapshot,
      ARRAY(SELECT DISTINCT table_name FROM grouped ORDER BY table_name) AS tables,
      ARRAY(SELECT DISTINCT op FROM grouped ORDER BY op) AS ops,
      ARRAY(SELECT DISTINCT actor_email FROM grouped
        WHERE actor_email IS NOT NULL ORDER BY actor_email) AS actors
    FROM population`);
  return result;
}

/** Exact, separately bounded metadata. A timeout must not erase a loaded row window. */
export async function getRowChangeMetadata(identity: Identity, query: RowChangeQuery = {}) {
  if (!canReadAudit(identity.role)) return { ok: false as const, reason: "forbidden" as const };
  return withUserScope(identity, async tx => {
    await applyAuditReadDatabaseBounds(tx);
    // This endpoint does not issue a whole-population snapshot: the row window
    // has its own bounded content validation. Keeping legacy MAX(id) here would
    // force wide heap reads and defeat the compact, deduplicated facet index.
    // Exact totals and unfiltered vocabularies still share one authorized scan.
    const [metadata] = await tx.$queryRaw<Omit<RawMetadata, "snapshot">[]>(Prisma.sql`
      WITH grouped AS MATERIALIZED (
        SELECT table_name, op, actor_email, COUNT(*) AS n
        FROM audit.row_change
        GROUP BY table_name, op, actor_email
      )
      SELECT (SELECT COALESCE(SUM(n), 0)::bigint FROM grouped ${rowChangeWhere(query)}) AS total,
        ARRAY(SELECT DISTINCT table_name FROM grouped ORDER BY table_name) AS tables,
        ARRAY(SELECT DISTINCT op FROM grouped ORDER BY op) AS ops,
        ARRAY(SELECT DISTINCT actor_email FROM grouped
          WHERE actor_email IS NOT NULL ORDER BY actor_email) AS actors`);
    return { ok: true as const, total: Number(metadata.total), tables: metadata.tables,
      ops: metadata.ops, actors: metadata.actors };
  }, { ...AUDIT_READ_TRANSACTION_OPTIONS, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export type RowChangeWindowQuery = RowChangeQuery & {
  loaded?: number; snapshot?: string | null; restoreRows?: number;
  /** Inclusive UTC dates. Deliberately not part of legacy RowChangeQuery. */
  from?: string; to?: string;
};
export type RowChangeWindowResult = ({ ok: true } & WindowPage<RowChangeRow, Record<string, never>>)
  | { ok: false; reason: "forbidden" | "changed" };

/**
 * Read only the requested window, never the entire history for a count/facet.
 * Each continuation reauthorizes and fingerprints the already displayed prefix
 * before returning another chunk. New/late rows, edits and deletes therefore
 * cannot silently shift a displayed window. No payload is persisted or cached.
 */
export async function listRowChangeWindow(identity: Identity, query: RowChangeWindowQuery = {}): Promise<RowChangeWindowResult> {
  if (!canReadAudit(identity.role)) return { ok: false, reason: "forbidden" };
  const firstPage = query.page ?? 1, pageSize = query.pageSize ?? 100, loaded = query.loaded ?? 0;
  if (!Number.isSafeInteger(firstPage) || firstPage < 1 || firstPage > 1_000_000
    || ![100, 200].includes(pageSize)
    || !Number.isSafeInteger(loaded) || loaded < 0 || loaded > 5_000 || loaded % pageSize !== 0
    || loaded + pageSize > 5_000 || (loaded === 0 ? query.snapshot != null : !/^[a-f0-9]{64}$/.test(query.snapshot ?? ""))) {
    throw new Error("invalid_audit_window");
  }
  // Explicit Back restoration rebuilds the remembered range in ONE fresh RLS
  // transaction. It is not a continuation and cannot carry an old snapshot.
  // Ordinary visits and append requests still return only one 100/200-row chunk.
  if (query.restoreRows !== undefined && (!Number.isSafeInteger(query.restoreRows)
    || query.restoreRows < pageSize || query.restoreRows > 5_000 || query.restoreRows % pageSize !== 0
    || loaded !== 0 || query.snapshot != null)) throw new Error("invalid_audit_window_restore");
  const take = query.restoreRows ?? loaded + pageSize;
  const { from, to } = auditDateRange(query.from, query.to);
  const filters = [query.table?.trim() || null, query.op?.trim() || null, query.actor?.trim() || null, from, to];
  const lowerBound = from ? Prisma.sql`AND at >= ${`${from}T00:00:00Z`}::timestamptz` : Prisma.empty;
  const upperBound = to ? Prisma.sql`AND at < (${`${to}T00:00:00Z`}::timestamptz + interval '24 hours')` : Prisma.empty;
  const fingerprint = (digest: string, size: number) => createHash("sha256")
    .update(JSON.stringify(["audit-field-changes-v2", filters, firstPage, pageSize, size, digest])).digest("hex");
  return withUserScope(identity, async tx => {
    await applyAuditReadDatabaseBounds(tx);
    const [result] = await tx.$queryRaw<Array<{
      rows: RowChangeRow[]; prior_digest: string; next_digest: string; observed: bigint; has_more: boolean;
    }>>(Prisma.sql`
      WITH page_ids AS MATERIALIZED (
        SELECT id, at FROM audit.row_change ${rowChangeWhere(query)}
        ${lowerBound} ${upperBound}
        ORDER BY at DESC, id DESC LIMIT ${take + 1} OFFSET ${(firstPage - 1) * pageSize}
      ), payloads AS MATERIALIZED (
        SELECT page_ids.id, page_ids.at, jsonb_build_object(
          'id', row.id::text, 'at', to_char(row.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'actorEmail', row.actor_email, 'actorRole', row.actor_role, 'dbRole', row.db_role,
          'table', row.table_name, 'op', row.op, 'rowPk', row.row_pk,
          'changed', CASE WHEN jsonb_typeof(row.changed) IN ('object', 'array') THEN row.changed ELSE '{}'::jsonb END
        ) AS rendered
        FROM page_ids JOIN audit.row_change AS row ON row.id = page_ids.id
      ), numbered AS MATERIALIZED (
        SELECT rendered, row_number() OVER (ORDER BY at DESC, id DESC) AS position,
          encode(sha256(convert_to(rendered::text, 'UTF8')), 'hex') AS content_hash
        FROM payloads
      )
      SELECT COALESCE(jsonb_agg(rendered ORDER BY position)
          FILTER (WHERE position > ${loaded} AND position <= ${take}), '[]'::jsonb) AS rows,
        encode(sha256(convert_to(COALESCE(string_agg(content_hash, ':' ORDER BY position)
          FILTER (WHERE position <= ${loaded}), ''), 'UTF8')), 'hex') AS prior_digest,
        encode(sha256(convert_to(COALESCE(string_agg(content_hash, ':' ORDER BY position)
          FILTER (WHERE position <= ${take}), ''), 'UTF8')), 'hex') AS next_digest,
        COUNT(*) AS observed, COUNT(*) > ${take} AS has_more
      FROM numbered`);
    if (loaded && (Number(result.observed) < loaded || fingerprint(result.prior_digest, loaded) !== query.snapshot)) {
      return { ok: false as const, reason: "changed" as const };
    }
    const nextLoaded = loaded + result.rows.length;
    return { ok: true as const, rows: result.rows, firstPage, pageSize, loaded: nextLoaded,
      snapshot: fingerprint(result.next_digest, nextLoaded), hasMore: result.has_more, meta: {} };
  }, { ...AUDIT_READ_TRANSACTION_OPTIONS, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function listRowChanges(
  identity: Identity,
  query: RowChangeQuery = {},
): Promise<RowChangeResult> {
  // Fail closed: the role gate runs before any DB work (shared with the events
  // view). The row_change RLS policy is a stricter backstop below this.
  if (!canReadAudit(identity.role)) return { ok: false, reason: "forbidden" };

  const page = Math.max(1, Math.min(1_000_000, Math.floor(Number(query.page) || 1)));
  const pageSize = Math.min(200, Math.max(ROW_CHANGE_PAGE_SIZE, Math.floor(Number(query.pageSize) || ROW_CHANGE_PAGE_SIZE)));
  const table = query.table?.trim() || null;
  const op = query.op?.trim() || null;
  const actor = query.actor?.trim() || null;

  // Composable WHERE — equality filters only (dropdown-fed, never free text).
  const where = Prisma.sql`
    WHERE (${table}::text IS NULL OR table_name = ${table})
      AND (${op}::text IS NULL OR op = ${op})
      AND (${actor}::text IS NULL OR actor_email = ${actor})`;

  return withUserScope(identity, async (tx) => {
    await applyAuditReadDatabaseBounds(tx);
    const { total, snapshot, tables, ops, actors } = await readRowChangeMetadata(tx, where);

    // Newest first; id DESC tiebreak — deal.update + deal.stage business events
    // can land in the same millisecond, and the higher id is the later write.
    const rows = await tx.$queryRaw<RawRow[]>(
      Prisma.sql`
        SELECT id, at, actor_email, actor_role, db_role, table_name, op, row_pk, changed
        FROM audit.row_change
        ${where}
        ORDER BY at DESC, id DESC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    );

    // Retain the prior fingerprint shape so equivalent populations produce the
    // same snapshot before/after this query optimization.
    const tableRows = tables.map(table_name => ({ table_name }));
    const opRows = ops.map(op => ({ op }));
    const actorRows = actors.map(actor_email => ({ actor_email }));

    const totalN = Number(total); // COUNT(*) → bigint at runtime
    return {
      ok: true as const,
      snapshot: createHash("sha256").update(snapshot).update(JSON.stringify([tableRows, opRows, actorRows])).digest("hex"),
      rows: rows.map((r) => ({
        id: String(r.id), // BigInt → string
        at: r.at.toISOString(), // Date → ISO string
        actorEmail: r.actor_email,
        actorRole: r.actor_role,
        dbRole: r.db_role,
        table: r.table_name,
        op: r.op,
        rowPk: r.row_pk,
        // jsonb → already a plain object at runtime; guard the null/non-object
        // edge so the type contract holds.
        changed:
          r.changed != null && typeof r.changed === "object"
            ? (r.changed as Record<string, unknown>)
            : {},
      })),
      total: totalN,
      page,
      pageCount: Math.max(1, Math.ceil(totalN / pageSize)),
      pageSize,
      tables,
      ops,
      actors,
    };
  }, { ...AUDIT_READ_TRANSACTION_OPTIONS, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
