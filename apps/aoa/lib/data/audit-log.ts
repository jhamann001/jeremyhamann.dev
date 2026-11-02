import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { withUserScope } from "@/lib/rls";
import { applyAuditReadDatabaseBounds, AUDIT_READ_TRANSACTION_OPTIONS } from "./audit-read-bounds";
import type { Identity } from "./types";

// Audit Log read seam (WO ticket — the first fully-REAL screen, zero mock).
// READ path only over the append-only audit."AuditLog" that lib/audit.ts writes
// (deal.create / deal.update / deal.stage_change today; every later write
// feature appends here). This file never writes — writeAudit stays the single
// writer, inside the caller's own withUserScope transaction.
//
// READ POLICY — enforced HERE, app-side, fail closed. The D1 grants give app_rw
// INSERT+SELECT on the audit schema, but audit."AuditLog" has NO row-level
// security enabled (verified: relrowsecurity = f), so at the DB level every app
// role could SELECT every row. The product policy (extraction §5, nav A4:
// requiredRoles on the Admin group) is ADMIN + OPERATIONS only, so the gate
// runs BEFORE any query: other roles get { ok: false } and the DB is never
// touched. If the policy ever needs to live below the app layer, add RLS to
// the audit schema — this seam's behavior would not change.
//
// SERIALIZATION TRAPS (house convention — coerce at the seam, never in
// components): `id` is BigInt and `at` is a Date at runtime; both would fail
// or drift crossing the Server → Client Component boundary (AuditTable is
// "use client"). Coerced to string / ISO string here.

export const AUDIT_READ_ROLES: ReadonlySet<string> = new Set([
  "ADMIN",
  "OPERATIONS",
]);

export function canReadAudit(role: string | null | undefined): boolean {
  return AUDIT_READ_ROLES.has(role ?? "");
}

export const AUDIT_PAGE_SIZE = 50;

// Ingest rollup (tkt-audit-events-ingest-rollup). n8n chunks a large pull into
// MANY batched POSTs and dry-run calls also log, so one logical daily ingest of
// a given type shows up as many raw audit."AuditLog" rows. The Events view
// collapses every INGEST_* action (value "ingest.%") into ONE summary row per
// (action, calendar day in UTC) — SUMming the per-run `upserted`/`rejected`
// counts and COUNTing the runs — while non-ingest events pass through
// individually and unchanged. The raw rows are never touched (writeAudit + the
// ingest routes are the single writers); this is a READ-side rollup only.
// Dry-run rows (detail.dry_run === true — only ingest actions ever set it) are
// excluded from this view entirely.
const INGEST_PREFIX = "ingest.";

export type AuditLogRow = {
  id: string; // BigInt → string at the seam (ingest-day rows carry a synthetic key)
  at: string; // Date → ISO string at the seam (ingest-day: MAX(at) that day)
  actorEmail: string | null;
  actorRole: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  detail: string | null; // JSON text as written by lib/audit.ts (or null)
  /** "event" = individual business event; "ingest_day" = collapsed daily rollup. */
  kind: "event" | "ingest_day";
  /** Runs folded into this row: 1 for an event, COUNT(*) for an ingest day. */
  runCount: number;
  /** SUM of detail.upserted across the day's runs (0 for a non-ingest event). */
  upserted: number;
  /** SUM of detail.rejected across the day's runs (0 for a non-ingest event). */
  rejected: number;
  /** Freshest source date reported by the day's ingest runs (YYYY-MM-DD). */
  sourceAsOfMax: string | null;
};

export type AuditLogQuery = {
  /** 1-based page; clamped to ≥ 1 and NaN-safe. */
  page?: number;
  pageSize?: number;
  /** Exact action filter, e.g. "deal.stage_change". */
  action?: string;
  /** Exact actor-email filter. */
  actor?: string;
};

export type AuditLogResult =
  | {
      ok: true;
      snapshot: string;
      rows: AuditLogRow[];
      /** Total rows matching the current filters (drives the count pill). */
      total: number;
      page: number;
      pageCount: number;
      pageSize: number;
      /** Unfiltered DISTINCT vocabularies for the filter dropdowns. */
      actions: string[];
      actors: string[];
    }
  | { ok: false; reason: "forbidden" };

type RawRow = {
  kind: "event" | "ingest_day";
  row_key: string; // events: id::text; ingest days: synthetic "ingest:<action>:<day>"
  at: Date;
  actorEmail: string | null;
  actorRole: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  detail: string | null;
  run_count: bigint;
  upserted: bigint;
  rejected: bigint;
  source_as_of_max: string | null;
};

export async function listAuditLog(
  identity: Identity,
  query: AuditLogQuery = {},
): Promise<AuditLogResult> {
  // Fail closed: the role gate runs before any DB work.
  if (!canReadAudit(identity.role)) return { ok: false, reason: "forbidden" };

  const page = Math.max(1, Math.min(1_000_000, Math.floor(Number(query.page) || 1)));
  const pageSize = Math.min(200, Math.max(AUDIT_PAGE_SIZE, Math.floor(Number(query.pageSize) || AUDIT_PAGE_SIZE)));
  const action = query.action?.trim() || null;
  const actor = query.actor?.trim() || null;

  // Shared equality filters (dropdown-fed, never free text). Applied identically
  // to BOTH arms of the union — the column names are the same in each. Note the
  // actor filter selects on "actorEmail", which is NULL for every ingest run
  // (ingests log as a service identity), so an actor filter naturally leaves the
  // ingest arm empty — the intended behavior (ingests have no human actor).
  const filters = Prisma.sql`
    AND (${action}::text IS NULL OR action = ${action})
    AND (${actor}::text IS NULL OR "actorEmail" = ${actor})`;

  // Every jsonb access below is doubly guarded so NO malformed or wrong-typed
  // detail can ever abort the whole aggregate query. detail is TEXT (writeAudit
  // JSON.stringify's it):
  //   1. pg_input_is_valid(detail, 'jsonb') (PG16) gates the `::jsonb` cast — a
  //      non-JSON row degrades to 0 counts / not-a-dry-run. It is only ever
  //      evaluated inside a CASE whose WHEN gates it (CASE short-circuits its
  //      THEN, unlike a bare AND which the planner may reorder).
  //   2. The value itself is guarded BEFORE its typed cast, nested INSIDE the
  //      validity CASE: pg_input_is_valid only proves the row is valid JSON, not
  //      that these keys hold integer/boolean values. A well-formed-but-wrong
  //      value (e.g. {"upserted":"n/a"}) must degrade to 0, not throw:
  //        - counts: only cast to int when the extracted text is all-digits
  //          (counts are non-negative), else 0.
  //        - dry_run: compare the text to 'true' (case-insensitive) rather than
  //          casting to boolean; COALESCE a missing/NULL key to false so a run
  //          with no dry_run key stays INCLUDED in the rollup.
  const dryRunExpr = Prisma.sql`
    CASE WHEN pg_input_is_valid(detail, 'jsonb')
      THEN COALESCE(lower(detail::jsonb ->> 'dry_run') = 'true', false)
      ELSE false END`;
  const upsertedSum = Prisma.sql`
    COALESCE(SUM(CASE WHEN pg_input_is_valid(detail, 'jsonb') THEN
      CASE WHEN (detail::jsonb ->> 'upserted') ~ '^[0-9]+$'
        THEN (detail::jsonb ->> 'upserted')::int ELSE 0 END
      ELSE 0 END), 0)`;
  const rejectedSum = Prisma.sql`
    COALESCE(SUM(CASE WHEN pg_input_is_valid(detail, 'jsonb') THEN
      CASE WHEN (detail::jsonb ->> 'rejected') ~ '^[0-9]+$'
        THEN (detail::jsonb ->> 'rejected')::int ELSE 0 END
      ELSE 0 END), 0)`;
  const sourceAsOfMax = Prisma.sql`
    MAX(CASE WHEN pg_input_is_valid(detail, 'jsonb') THEN
      CASE WHEN (detail::jsonb ->> 'as_of_max') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
        THEN left(detail::jsonb ->> 'as_of_max', 10) ELSE NULL END
      ELSE NULL END)`;

  // The Events result set is the UNION of:
  //   (A) individual NON-ingest events (action NOT LIKE 'ingest.%'), unchanged; and
  //   (B) ONE aggregated row per (ingest action, calendar day in UTC), with
  //       dry-run runs excluded outright.
  // A uniform column shape lets one ORDER BY / LIMIT / OFFSET (and one COUNT)
  // drive pagination over the COLLAPSED set — an ingest day counts as one row.
  const unified = Prisma.sql`
    (
      SELECT
        'event'::text AS kind,
        id::text AS row_key,
        id AS sort_id,
        at,
        "actorEmail",
        "actorRole",
        action,
        "entityType",
        "entityId",
        detail,
        1::bigint AS run_count,
        0::bigint AS upserted,
        0::bigint AS rejected,
        NULL::text AS source_as_of_max
      FROM audit."AuditLog"
      WHERE action NOT LIKE ${INGEST_PREFIX + "%"}
      ${filters}
    )
    UNION ALL
    (
      SELECT
        'ingest_day'::text AS kind,
        'ingest:' || action || ':' || ((at AT TIME ZONE 'UTC')::date)::text AS row_key,
        MAX(id) AS sort_id,
        MAX(at) AS at,
        NULL::text AS "actorEmail",
        MAX("actorRole") AS "actorRole",
        action,
        'ingest_run'::text AS "entityType",
        NULL::text AS "entityId",
        NULL::text AS detail,
        COUNT(*)::bigint AS run_count,
        ${upsertedSum}::bigint AS upserted,
        ${rejectedSum}::bigint AS rejected,
        ${sourceAsOfMax}::text AS source_as_of_max
      FROM audit."AuditLog"
      WHERE action LIKE ${INGEST_PREFIX + "%"}
        AND NOT (${dryRunExpr})
      ${filters}
      GROUP BY action, (at AT TIME ZONE 'UTC')::date
    )`;

  return withUserScope(identity, async (tx) => {
    await applyAuditReadDatabaseBounds(tx);
    const [{ total, snapshot }] = await tx.$queryRaw<{ total: bigint; snapshot: string }[]>(
      // Audit is append-only. Count + maximum underlying ID binds the entire
      // filtered population, including a new run folded into an existing day.
      // Do not serialize historical detail payloads merely to version a page.
      Prisma.sql`SELECT
        COUNT(*) FILTER (WHERE action NOT LIKE ${INGEST_PREFIX + "%"})
          + COUNT(DISTINCT (action, (at AT TIME ZONE 'UTC')::date))
              FILTER (WHERE action LIKE ${INGEST_PREFIX + "%"}) AS total,
        md5(COUNT(*)::text || ':' || COALESCE(MAX(id)::text, '')) AS snapshot
        FROM audit."AuditLog"
        WHERE (action NOT LIKE ${INGEST_PREFIX + "%"} OR NOT (${dryRunExpr}))
        ${filters}`,
    );

    // Newest first; sort_id DESC tiebreak — D3 writes deal.update and
    // deal.stage_change in the same transaction (same millisecond), and the
    // stage change (higher id) is the more specific, later-logged event. For an
    // ingest day the representative timestamp is MAX(at) and sort_id is MAX(id).
    const rows = await tx.$queryRaw<RawRow[]>(
      Prisma.sql`
        SELECT kind, row_key, at, "actorEmail", "actorRole", action, "entityType",
               "entityId", detail, run_count, upserted, rejected, source_as_of_max
        FROM (${unified}) AS u
        ORDER BY at DESC, sort_id DESC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    );

    // Dropdown vocabularies stay unfiltered so a narrowed view can always be
    // widened back without dead-end option lists.
    const actionRows = await tx.$queryRaw<{ action: string }[]>(
      Prisma.sql`SELECT DISTINCT action FROM audit."AuditLog" ORDER BY action`,
    );
    const actorRows = await tx.$queryRaw<{ actorEmail: string | null }[]>(
      Prisma.sql`
        SELECT DISTINCT "actorEmail" FROM audit."AuditLog"
        WHERE "actorEmail" IS NOT NULL ORDER BY "actorEmail"`,
    );

    const totalN = Number(total); // COUNT(*) → bigint at runtime
    return {
      ok: true as const,
      snapshot: createHash("sha256").update(snapshot).update(JSON.stringify([actionRows, actorRows])).digest("hex"),
      rows: rows.map((r) => ({
        id: r.row_key, // events: id string; ingest days: synthetic stable key
        at: r.at.toISOString(), // Date → ISO string
        actorEmail: r.actorEmail,
        actorRole: r.actorRole,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        detail: r.detail,
        kind: r.kind,
        runCount: Number(r.run_count),
        upserted: Number(r.upserted),
        rejected: Number(r.rejected),
        sourceAsOfMax: r.source_as_of_max,
      })),
      total: totalN,
      page,
      pageCount: Math.max(1, Math.ceil(totalN / pageSize)),
      pageSize,
      actions: actionRows.map((r) => r.action),
      actors: actorRows.map((r) => r.actorEmail).filter((e): e is string => e != null),
    };
  }, { ...AUDIT_READ_TRANSACTION_OPTIONS, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
