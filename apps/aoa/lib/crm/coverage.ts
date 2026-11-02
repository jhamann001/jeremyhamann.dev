import "server-only";

import { Prisma } from "@prisma/client";
import { crmReconcilerClient } from "@/lib/crm/reconciler-db";

export type CrmIdentityCoverageRow = {
  identity_type: string;
  source_system: string;
  source_namespace: string;
  source_rows: number;
  mapped_sources: number;
  unmapped_sources: number;
  stale_mappings: number;
  inactive_mappings: number;
  open_exceptions: number;
  newest_source_at: string | null;
  oldest_unmapped_at: string | null;
};

export type CrmIdentityCoverageDiagnostics = {
  summary: {
    source_rows: number;
    mapped_sources: number;
    unmapped_sources: number;
    stale_mappings: number;
    inactive_mappings: number;
    open_exceptions: number;
    coverage_percent: number;
    newest_source_at: string | null;
    oldest_unmapped_at: string | null;
  };
  by_source: CrmIdentityCoverageRow[];
};

type RawCoverageRow = {
  identity_type: string;
  source_system: string;
  source_namespace: string;
  source_rows: bigint;
  mapped_sources: bigint;
  unmapped_sources: bigint;
  stale_mappings: bigint;
  inactive_mappings: bigint;
  open_exceptions: bigint;
  newest_source_at: Date | null;
  oldest_unmapped_at: Date | null;
};

// This intentionally mirrors the approved reconciliation source coordinates.
// It reads keys only to perform exact joins and returns aggregate counts only.
// Parent-feed rows are included because they can be the authoritative source
// for a household/contact identity even when the richer mirror row is absent.
const COVERAGE_SQL = Prisma.sql`
WITH source_rows_raw AS MATERIALIZED (
  SELECT 'HOUSEHOLD'::text AS identity_type,
         'CRM'::text AS source_system,
         'household'::text AS source_namespace,
         h.sf_id::text AS source_key,
         h.synced_at AS seen_at
    FROM mirror.household h
   WHERE nullif(btrim(h.sf_id), '') IS NOT NULL

  UNION ALL

  SELECT p.parent_type,
         'CRM',
         CASE p.parent_type WHEN 'HOUSEHOLD' THEN 'household' ELSE 'contact' END,
         p.source_key,
         p.synced_at
    FROM mirror.crm_parent_source p

  UNION ALL

  SELECT 'CONTACT', 'CRM', 'contact', c.sf_id, c.synced_at
    FROM mirror.client c
   WHERE nullif(btrim(c.sf_id), '') IS NOT NULL
     AND (c.household_id IS NULL OR c.sf_id <> c.household_id)

  UNION ALL

  SELECT 'DEAL', 'AOA', 'deal', d.id, d.updated_at
    FROM app.deal d
   WHERE nullif(btrim(d.id), '') IS NOT NULL

  UNION ALL

  SELECT 'DEAL', 'CRM', 'opportunity', d.sf_deal_id, d.updated_at
    FROM app.deal d
   WHERE nullif(btrim(d.sf_deal_id), '') IS NOT NULL

  UNION ALL

  SELECT 'TRANSFER', 'AOA', 'transfer', t.id, t.updated_at
    FROM app.transfer t
   WHERE nullif(btrim(t.id), '') IS NOT NULL

  UNION ALL

  SELECT 'EMAIL', 'CRM', 'email', e.sf_id, e.synced_at
    FROM mirror.email e
   WHERE nullif(btrim(e.sf_id), '') IS NOT NULL

  UNION ALL

  SELECT 'ACTIVITY', 'CRM', 'activity', a.sf_id, a.synced_at
    FROM mirror.activity a
   WHERE nullif(btrim(a.sf_id), '') IS NOT NULL

  UNION ALL

  SELECT 'TASK', 'CRM', 'task', t.sf_id, t.synced_at
    FROM mirror.task t
   WHERE nullif(btrim(t.sf_id), '') IS NOT NULL

  UNION ALL

  SELECT 'APPOINTMENT', 'CALENDAR', 'appointment', a.external_key, a.synced_at
    FROM mirror.appointment a
   WHERE nullif(btrim(a.external_key), '') IS NOT NULL
), source_rows AS MATERIALIZED (
  SELECT identity_type, source_system, source_namespace, source_key,
         max(seen_at) AS seen_at
    FROM source_rows_raw
   GROUP BY identity_type, source_system, source_namespace, source_key
), exception_counts AS MATERIALIZED (
  SELECT source_mapping_id, count(*)::bigint AS open_exceptions
    FROM app.crm_identity_exception
   WHERE exception_state = 'OPEN'
   GROUP BY source_mapping_id
), coverage_rows AS MATERIALIZED (
  SELECT s.identity_type, s.source_system, s.source_namespace, s.seen_at,
         m.id AS mapping_id, m.mapping_state, m.last_seen_at,
         coalesce(e.open_exceptions, 0::bigint) AS open_exceptions
    FROM source_rows s
    LEFT JOIN app.crm_source_mapping m
      ON m.source_system = s.source_system
     AND m.source_namespace = s.source_namespace
     AND m.source_key = s.source_key
    LEFT JOIN exception_counts e ON e.source_mapping_id = m.id
)
SELECT identity_type, source_system, source_namespace,
       count(*)::bigint AS source_rows,
       count(mapping_id)::bigint AS mapped_sources,
       count(*) FILTER (WHERE mapping_id IS NULL)::bigint AS unmapped_sources,
       count(*) FILTER (
         WHERE mapping_id IS NOT NULL AND seen_at > last_seen_at
       )::bigint AS stale_mappings,
       count(*) FILTER (
         WHERE mapping_id IS NOT NULL AND mapping_state <> 'ACTIVE'
       )::bigint AS inactive_mappings,
       coalesce(sum(open_exceptions), 0::numeric)::bigint AS open_exceptions,
       max(seen_at) AS newest_source_at,
       min(seen_at) FILTER (WHERE mapping_id IS NULL) AS oldest_unmapped_at
  FROM coverage_rows
 GROUP BY identity_type, source_system, source_namespace
 ORDER BY identity_type, source_system, source_namespace`;

export const CRM_COVERAGE_TIMEOUT_MS = 240_000;

function safeCount(value: bigint, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`crm_coverage_invalid_${label}`);
  }
  return parsed;
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function earliest(values: Array<Date | null>): string | null {
  const present = values.filter((value): value is Date => value !== null);
  if (present.length === 0) return null;
  return new Date(Math.min(...present.map((value) => value.getTime()))).toISOString();
}

function latest(values: Array<Date | null>): string | null {
  const present = values.filter((value): value is Date => value !== null);
  if (present.length === 0) return null;
  return new Date(Math.max(...present.map((value) => value.getTime()))).toISOString();
}

export async function runCrmIdentityCoverageDiagnostics(): Promise<CrmIdentityCoverageDiagnostics> {
  const client = crmReconcilerClient();
  const raw = await client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return tx.$queryRaw<RawCoverageRow[]>(COVERAGE_SQL);
    },
    { timeout: CRM_COVERAGE_TIMEOUT_MS, maxWait: 15_000 },
  );

  const bySource = raw.map((row) => ({
    identity_type: row.identity_type,
    source_system: row.source_system,
    source_namespace: row.source_namespace,
    source_rows: safeCount(row.source_rows, "source_rows"),
    mapped_sources: safeCount(row.mapped_sources, "mapped_sources"),
    unmapped_sources: safeCount(row.unmapped_sources, "unmapped_sources"),
    stale_mappings: safeCount(row.stale_mappings, "stale_mappings"),
    inactive_mappings: safeCount(row.inactive_mappings, "inactive_mappings"),
    open_exceptions: safeCount(row.open_exceptions, "open_exceptions"),
    newest_source_at: iso(row.newest_source_at),
    oldest_unmapped_at: iso(row.oldest_unmapped_at),
  }));

  const sourceRows = bySource.reduce((sum, row) => sum + row.source_rows, 0);
  const mappedSources = bySource.reduce((sum, row) => sum + row.mapped_sources, 0);
  const unmappedSources = bySource.reduce((sum, row) => sum + row.unmapped_sources, 0);

  return {
    summary: {
      source_rows: sourceRows,
      mapped_sources: mappedSources,
      unmapped_sources: unmappedSources,
      stale_mappings: bySource.reduce((sum, row) => sum + row.stale_mappings, 0),
      inactive_mappings: bySource.reduce((sum, row) => sum + row.inactive_mappings, 0),
      open_exceptions: bySource.reduce((sum, row) => sum + row.open_exceptions, 0),
      coverage_percent: sourceRows === 0
        ? 100
        : Math.round((mappedSources / sourceRows) * 10_000) / 100,
      newest_source_at: latest(raw.map((row) => row.newest_source_at)),
      oldest_unmapped_at: earliest(raw.map((row) => row.oldest_unmapped_at)),
    },
    by_source: bySource,
  };
}
