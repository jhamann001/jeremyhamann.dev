import "server-only";

import { Prisma } from "@prisma/client";
import { crmReconcilerClient } from "@/lib/crm/reconciler-db";

type CountBySource = {
  identity_type: string;
  source_system: string;
  source_namespace: string;
  exception_action: string;
  parent_issue: string;
  records: number;
  distinct_household_keys: number;
  distinct_contact_keys: number;
};

type KeyFinding = {
  exception_action: string;
  finding: string;
  records: number;
  distinct_keys: number;
};

type FreshnessFinding = {
  exception_action: string;
  freshness: string;
  records: number;
};

type CrossDomainFinding = {
  exception_action: string;
  coverage: string;
  records: number;
  distinct_keys: number;
};

type OrphanClassification = {
  parent_type: string;
  classification: string;
  exception_action: string;
  freshness: string;
  records: number;
  distinct_keys: number;
};

export type CrmMissingParentDiagnostics = {
  summary: {
    unresolved_records: number;
    would_open: number;
    would_reopen: number;
    already_open: number;
    would_resolve: number;
    no_parent_key_records: number;
    distinct_unresolved_household_keys: number;
    distinct_unresolved_contact_keys: number;
  };
  by_source: CountBySource[];
  household_key_findings: KeyFinding[];
  contact_key_findings: KeyFinding[];
  freshness: FreshnessFinding[];
  household_cross_domain: CrossDomainFinding[];
  orphan_classification: OrphanClassification[];
};

type RawResult = { result: unknown };
type UnknownRecord = Record<string, unknown>;

// This uses the same ceiling as a full reconciliation preview. It performs one
// read-only statement, emits aggregate reason codes/counts only, and stays below
// Cloud Run's five-minute request limit.
export const CRM_PARENT_DIAGNOSTICS_TIMEOUT_MS = 240_000;

const DIAGNOSTICS_SQL = Prisma.sql`
WITH source_rows AS MATERIALIZED (
  SELECT 'CONTACT'::text AS identity_type,
         'CRM'::text AS source_system,
         'contact'::text AS source_namespace,
         c.sf_id::text AS source_key,
         c.household_id::text AS household_parent_key,
         false AS household_parent_normalized,
         NULL::text AS contact_parent_key,
         c.synced_at AS seen_at
    FROM mirror.client c
   WHERE nullif(btrim(c.sf_id), '') IS NOT NULL
     AND (c.household_id IS NULL OR c.sf_id <> c.household_id)

  UNION ALL

  SELECT 'DEAL', 'AOA', 'deal', d.id,
         d.household_sf_id, true, d.client_sf_id, d.updated_at
    FROM app.deal d
   WHERE nullif(btrim(d.id), '') IS NOT NULL

  UNION ALL

  SELECT 'TRANSFER', 'AOA', 'transfer', t.id,
         t.household_sf_id, true, t.client_sf_id, t.updated_at
    FROM app.transfer t
   WHERE nullif(btrim(t.id), '') IS NOT NULL

  UNION ALL

  SELECT 'EMAIL', 'CRM', 'email', e.sf_id,
         e.household_sf_id, true, NULL::text, e.synced_at
    FROM mirror.email e
   WHERE nullif(btrim(e.sf_id), '') IS NOT NULL

  UNION ALL

  SELECT 'ACTIVITY', 'CRM', 'activity', a.sf_id,
         a.household_sf_id, true, NULL::text, a.synced_at
    FROM mirror.activity a
   WHERE nullif(btrim(a.sf_id), '') IS NOT NULL

  UNION ALL

  SELECT 'TASK', 'CRM', 'task', t.sf_id,
         t.household_sf_id, true, NULL::text, t.synced_at
    FROM mirror.task t
   WHERE nullif(btrim(t.sf_id), '') IS NOT NULL

  UNION ALL

  SELECT 'APPOINTMENT', 'CALENDAR', 'appointment', a.external_key,
         NULL::text, false, a.client_sf_id, a.synced_at
    FROM mirror.appointment a
   WHERE nullif(btrim(a.external_key), '') IS NOT NULL
),
household_keys AS MATERIALIZED (
  SELECT h.sf_id::text AS exact_key,
         left(h.sf_id, 15)::text AS normalized_key
    FROM mirror.household h
   WHERE nullif(btrim(h.sf_id), '') IS NOT NULL
  UNION
  SELECT m.source_key, left(m.source_key, 15)
    FROM app.crm_source_mapping m
   WHERE m.source_system = 'CRM'
     AND m.source_namespace = 'household'
     AND m.mapping_state = 'ACTIVE'
  UNION
  SELECT p.source_key, p.normalized_key
    FROM mirror.crm_parent_source p
   WHERE p.parent_type = 'HOUSEHOLD'
  UNION
  SELECT p.normalized_key, p.normalized_key
    FROM mirror.crm_parent_source p
   WHERE p.parent_type = 'HOUSEHOLD'
),
contact_keys AS MATERIALIZED (
  SELECT c.sf_id::text AS exact_key,
         left(c.sf_id, 15)::text AS normalized_key
    FROM mirror.client c
   WHERE nullif(btrim(c.sf_id), '') IS NOT NULL
     AND (c.household_id IS NULL OR c.sf_id <> c.household_id)
  UNION
  SELECT m.source_key, left(m.source_key, 15)
    FROM app.crm_source_mapping m
   WHERE m.source_system = 'CRM'
     AND m.source_namespace = 'contact'
     AND m.mapping_state = 'ACTIVE'
  UNION
  SELECT p.source_key, p.normalized_key
    FROM mirror.crm_parent_source p
   WHERE p.parent_type = 'CONTACT'
  UNION
  SELECT p.normalized_key, p.normalized_key
    FROM mirror.crm_parent_source p
   WHERE p.parent_type = 'CONTACT'
),
household_exact_keys AS MATERIALIZED (
  SELECT DISTINCT exact_key AS key FROM household_keys
),
household_normalized_keys AS MATERIALIZED (
  SELECT DISTINCT normalized_key AS key FROM household_keys
),
household_case_keys AS MATERIALIZED (
  SELECT DISTINCT lower(normalized_key) AS key FROM household_keys
),
contact_exact_keys AS MATERIALIZED (
  SELECT DISTINCT exact_key AS key FROM contact_keys
),
contact_normalized_keys AS MATERIALIZED (
  SELECT DISTINCT normalized_key AS key FROM contact_keys
),
contact_case_keys AS MATERIALIZED (
  SELECT DISTINCT lower(normalized_key) AS key FROM contact_keys
),
authoritative_household_keys AS MATERIALIZED (
  SELECT DISTINCT left(h.sf_id, 15)::text AS key
    FROM mirror.household h
   WHERE nullif(btrim(h.sf_id), '') IS NOT NULL
  UNION
  SELECT p.normalized_key
    FROM mirror.crm_parent_source p
   WHERE p.parent_type = 'HOUSEHOLD'
),
authoritative_contact_keys AS MATERIALIZED (
  SELECT DISTINCT left(c.sf_id, 15)::text AS key
    FROM mirror.client c
   WHERE nullif(btrim(c.sf_id), '') IS NOT NULL
     AND (c.household_id IS NULL OR c.sf_id <> c.household_id)
  UNION
  SELECT p.normalized_key
    FROM mirror.crm_parent_source p
   WHERE p.parent_type = 'CONTACT'
),
orphan_evidence AS MATERIALIZED (
  SELECT o.parent_type, o.normalized_key, o.evidence_type,
         o.replacement_normalized_key
    FROM mirror.crm_parent_orphan_evidence o
),
mapped AS MATERIALIZED (
  SELECT s.*, m.id AS mapping_id
    FROM source_rows s
    LEFT JOIN app.crm_source_mapping m
      ON m.source_system = s.source_system
     AND m.source_namespace = s.source_namespace
     AND m.source_key = s.source_key
),
evaluated AS MATERIALIZED (
  SELECT m.*,
         e.id AS exception_id,
         e.exception_state,
         nullif(btrim(m.household_parent_key), '') IS NOT NULL
           AS has_household_parent_key,
         nullif(btrim(m.contact_parent_key), '') IS NOT NULL
           AS has_contact_parent_key,
         (
           nullif(btrim(m.household_parent_key), '') IS NOT NULL
           AND CASE
             WHEN m.household_parent_normalized
               THEN household_raw_normalized.key IS NOT NULL
             ELSE household_raw_exact.key IS NOT NULL
           END
         ) AS household_parent_resolved,
         (
           nullif(btrim(m.contact_parent_key), '') IS NOT NULL
           AND contact_raw_exact.key IS NOT NULL
         ) AS contact_parent_resolved,
         CASE
           WHEN m.household_parent_normalized
             THEN household_trim_normalized.key IS NOT NULL
           ELSE household_trim_exact.key IS NOT NULL
         END AS household_trim_match,
         household_trim_normalized.key IS NOT NULL AS household_width_match,
         household_case.key IS NOT NULL AS household_case_match,
         contact_trim_exact.key IS NOT NULL AS contact_trim_match,
         contact_trim_normalized.key IS NOT NULL AS contact_width_match,
         contact_case.key IS NOT NULL AS contact_case_match
    FROM mapped m
    LEFT JOIN app.crm_identity_exception e
      ON e.source_mapping_id = m.mapping_id
     AND e.reason_code = 'MISSING_PARENT_MAPPING'
    LEFT JOIN household_exact_keys household_raw_exact
      ON household_raw_exact.key = m.household_parent_key
    LEFT JOIN household_exact_keys household_trim_exact
      ON household_trim_exact.key = btrim(m.household_parent_key)
    LEFT JOIN household_normalized_keys household_raw_normalized
      ON household_raw_normalized.key = left(m.household_parent_key, 15)
    LEFT JOIN household_normalized_keys household_trim_normalized
      ON household_trim_normalized.key = left(btrim(m.household_parent_key), 15)
    LEFT JOIN household_case_keys household_case
      ON household_case.key = lower(left(btrim(m.household_parent_key), 15))
    LEFT JOIN contact_exact_keys contact_raw_exact
      ON contact_raw_exact.key = m.contact_parent_key
    LEFT JOIN contact_exact_keys contact_trim_exact
      ON contact_trim_exact.key = btrim(m.contact_parent_key)
    LEFT JOIN contact_normalized_keys contact_trim_normalized
      ON contact_trim_normalized.key = left(btrim(m.contact_parent_key), 15)
    LEFT JOIN contact_case_keys contact_case
      ON contact_case.key = lower(left(btrim(m.contact_parent_key), 15))
),
classified AS MATERIALIZED (
  SELECT e.*,
         (e.household_parent_resolved OR e.contact_parent_resolved)
           AS parent_resolved,
         CASE
           WHEN e.household_parent_resolved OR e.contact_parent_resolved THEN
             CASE WHEN e.exception_state = 'OPEN'
                  THEN 'WOULD_RESOLVE' ELSE 'NO_ACTION' END
           WHEN e.exception_id IS NULL THEN 'WOULD_OPEN'
           WHEN e.exception_state = 'RESOLVED' THEN 'WOULD_REOPEN'
           ELSE 'ALREADY_OPEN'
         END AS exception_action,
         CASE
           WHEN NOT e.has_household_parent_key AND NOT e.has_contact_parent_key
             THEN 'NO_PARENT_KEY'
           WHEN e.has_household_parent_key AND NOT e.has_contact_parent_key
             THEN 'HOUSEHOLD_PARENT_UNRESOLVED'
           WHEN NOT e.has_household_parent_key AND e.has_contact_parent_key
             THEN 'CONTACT_PARENT_UNRESOLVED'
           ELSE 'BOTH_PARENT_KEYS_UNRESOLVED'
         END AS parent_issue,
         CASE
           WHEN e.household_trim_match THEN 'TRIM_NORMALIZATION_CANDIDATE'
           WHEN NOT e.household_parent_normalized AND e.household_width_match
             THEN 'WIDTH_NORMALIZATION_CANDIDATE'
           WHEN e.household_case_match THEN 'CASE_NORMALIZATION_CANDIDATE'
           WHEN btrim(e.household_parent_key) ~ '^001[[:alnum:]]{12}$'
             OR btrim(e.household_parent_key) ~ '^001[[:alnum:]]{15}$'
             THEN 'VALID_ACCOUNT_KEY_ABSENT'
           WHEN btrim(e.household_parent_key) ~ '^[[:alnum:]]{15}$'
             OR btrim(e.household_parent_key) ~ '^[[:alnum:]]{18}$'
             THEN 'NON_ACCOUNT_SALESFORCE_KEY'
           ELSE 'MALFORMED_HOUSEHOLD_KEY'
         END AS household_key_finding,
         CASE
           WHEN e.contact_trim_match THEN 'TRIM_NORMALIZATION_CANDIDATE'
           WHEN e.contact_width_match THEN 'WIDTH_NORMALIZATION_CANDIDATE'
           WHEN e.contact_case_match THEN 'CASE_NORMALIZATION_CANDIDATE'
           WHEN btrim(e.contact_parent_key) ~ '^003[[:alnum:]]{12}$'
             OR btrim(e.contact_parent_key) ~ '^003[[:alnum:]]{15}$'
             THEN 'VALID_CONTACT_KEY_ABSENT'
           WHEN btrim(e.contact_parent_key) ~ '^[[:alnum:]]{15}$'
             OR btrim(e.contact_parent_key) ~ '^[[:alnum:]]{18}$'
             THEN 'NON_CONTACT_SALESFORCE_KEY'
           ELSE 'MALFORMED_CONTACT_KEY'
         END AS contact_key_finding,
         CASE
           WHEN e.seen_at IS NULL THEN 'UNKNOWN'
           WHEN e.seen_at >= now() - interval '24 hours' THEN 'LAST_24_HOURS'
           WHEN e.seen_at >= now() - interval '7 days' THEN 'TWO_TO_SEVEN_DAYS'
           WHEN e.seen_at >= now() - interval '30 days' THEN 'EIGHT_TO_THIRTY_DAYS'
           ELSE 'OVER_THIRTY_DAYS'
         END AS freshness
    FROM evaluated e
),
unresolved AS MATERIALIZED (
  SELECT * FROM classified WHERE NOT parent_resolved
),
unresolved_parent_refs AS MATERIALIZED (
  SELECT identity_type, source_namespace, exception_action,
         'HOUSEHOLD'::text AS parent_type,
         left(btrim(household_parent_key), 15) AS parent_key,
         household_key_finding AS key_finding,
         freshness
    FROM unresolved
   WHERE has_household_parent_key

  UNION ALL

  SELECT identity_type, source_namespace, exception_action,
         'CONTACT'::text,
         left(btrim(contact_parent_key), 15),
         contact_key_finding,
         freshness
    FROM unresolved
   WHERE has_contact_parent_key
),
orphan_classified AS MATERIALIZED (
  SELECT r.*,
         CASE
           WHEN r.key_finding NOT IN (
             'VALID_ACCOUNT_KEY_ABSENT', 'VALID_CONTACT_KEY_ABSENT'
           ) THEN 'INVALID_OR_NORMALIZATION_CANDIDATE'
           WHEN o.evidence_type = 'DELETED' THEN 'DELETED_PARENT'
           WHEN o.evidence_type = 'MERGED'
             AND (
               household_replacement.key IS NOT NULL
               OR contact_replacement.key IS NOT NULL
             ) THEN 'MERGED_TO_ACTIVE_PARENT'
           WHEN o.evidence_type = 'MERGED' THEN 'MERGED_TO_MISSING_PARENT'
           WHEN r.freshness IN ('LAST_24_HOURS', 'TWO_TO_SEVEN_DAYS')
             THEN 'RECENT_UNEXPLAINED_REFERENCE'
           WHEN r.freshness = 'EIGHT_TO_THIRTY_DAYS'
             THEN 'AGING_UNEXPLAINED_REFERENCE'
           WHEN r.freshness = 'OVER_THIRTY_DAYS'
             THEN 'STALE_UNEXPLAINED_REFERENCE'
           ELSE 'UNKNOWN_FRESHNESS_REFERENCE'
         END AS orphan_classification
    FROM unresolved_parent_refs r
    LEFT JOIN orphan_evidence o
      ON o.parent_type = r.parent_type
     AND o.normalized_key = r.parent_key
    LEFT JOIN authoritative_household_keys household_replacement
      ON r.parent_type = 'HOUSEHOLD'
     AND household_replacement.key = o.replacement_normalized_key
    LEFT JOIN authoritative_contact_keys contact_replacement
      ON r.parent_type = 'CONTACT'
     AND contact_replacement.key = o.replacement_normalized_key
),
orphan_classification_breakdown AS (
  SELECT parent_type, orphan_classification AS classification,
         exception_action, freshness,
         count(*)::bigint AS records,
         count(DISTINCT parent_key)::bigint AS distinct_keys
    FROM orphan_classified
   GROUP BY parent_type, orphan_classification, exception_action, freshness
),
source_breakdown AS (
  SELECT identity_type, source_system, source_namespace,
         exception_action, parent_issue,
         count(*)::bigint AS records,
         count(DISTINCT left(btrim(household_parent_key), 15))
           FILTER (WHERE has_household_parent_key)::bigint
           AS distinct_household_keys,
         count(DISTINCT left(btrim(contact_parent_key), 15))
           FILTER (WHERE has_contact_parent_key)::bigint
           AS distinct_contact_keys
    FROM unresolved
   GROUP BY identity_type, source_system, source_namespace,
            exception_action, parent_issue
),
household_findings AS (
  SELECT exception_action, household_key_finding AS finding,
         count(*)::bigint AS records,
         count(DISTINCT left(btrim(household_parent_key), 15))::bigint
           AS distinct_keys
    FROM unresolved
   WHERE has_household_parent_key
   GROUP BY exception_action, household_key_finding
),
contact_findings AS (
  SELECT exception_action, contact_key_finding AS finding,
         count(*)::bigint AS records,
         count(DISTINCT left(btrim(contact_parent_key), 15))::bigint
           AS distinct_keys
    FROM unresolved
   WHERE has_contact_parent_key
   GROUP BY exception_action, contact_key_finding
),
freshness_findings AS (
  SELECT exception_action, freshness, count(*)::bigint AS records
    FROM unresolved
   GROUP BY exception_action, freshness
),
household_key_domains AS (
  SELECT exception_action,
         left(btrim(household_parent_key), 15) AS diagnostic_key,
         count(*)::bigint AS records,
         bool_or(source_namespace = 'email') AS has_email,
         bool_or(source_namespace = 'activity') AS has_activity,
         bool_or(source_namespace NOT IN ('email', 'activity')) AS has_other
    FROM unresolved
   WHERE has_household_parent_key
   GROUP BY exception_action, left(btrim(household_parent_key), 15)
),
household_cross_domain AS (
  SELECT exception_action,
         CASE
           WHEN has_email AND has_activity AND NOT has_other
             THEN 'EMAIL_AND_ACTIVITY'
           WHEN has_email AND NOT has_activity AND NOT has_other
             THEN 'EMAIL_ONLY'
           WHEN has_activity AND NOT has_email AND NOT has_other
             THEN 'ACTIVITY_ONLY'
           ELSE 'OTHER_OR_MIXED'
         END AS coverage,
         sum(records)::bigint AS records,
         count(*)::bigint AS distinct_keys
    FROM household_key_domains
   GROUP BY exception_action, coverage
),
summary AS (
  SELECT count(*) FILTER (WHERE NOT parent_resolved)::bigint
           AS unresolved_records,
         count(*) FILTER (WHERE exception_action = 'WOULD_OPEN')::bigint
           AS would_open,
         count(*) FILTER (WHERE exception_action = 'WOULD_REOPEN')::bigint
           AS would_reopen,
         count(*) FILTER (WHERE exception_action = 'ALREADY_OPEN')::bigint
           AS already_open,
         count(*) FILTER (WHERE exception_action = 'WOULD_RESOLVE')::bigint
           AS would_resolve,
         count(*) FILTER (
           WHERE NOT parent_resolved
             AND NOT has_household_parent_key
             AND NOT has_contact_parent_key
         )::bigint AS no_parent_key_records,
         count(DISTINCT left(btrim(household_parent_key), 15)) FILTER (
           WHERE NOT parent_resolved AND has_household_parent_key
         )::bigint AS distinct_unresolved_household_keys,
         count(DISTINCT left(btrim(contact_parent_key), 15)) FILTER (
           WHERE NOT parent_resolved AND has_contact_parent_key
         )::bigint AS distinct_unresolved_contact_keys
    FROM classified
)
SELECT jsonb_build_object(
  'summary', jsonb_build_object(
    'unresolved_records', summary.unresolved_records,
    'would_open', summary.would_open,
    'would_reopen', summary.would_reopen,
    'already_open', summary.already_open,
    'would_resolve', summary.would_resolve,
    'no_parent_key_records', summary.no_parent_key_records,
    'distinct_unresolved_household_keys',
      summary.distinct_unresolved_household_keys,
    'distinct_unresolved_contact_keys',
      summary.distinct_unresolved_contact_keys
  ),
  'by_source', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'identity_type', identity_type,
      'source_system', source_system,
      'source_namespace', source_namespace,
      'exception_action', exception_action,
      'parent_issue', parent_issue,
      'records', records,
      'distinct_household_keys', distinct_household_keys,
      'distinct_contact_keys', distinct_contact_keys
    ) ORDER BY identity_type, source_system, source_namespace,
               exception_action, parent_issue)
      FROM source_breakdown
  ), '[]'::jsonb),
  'household_key_findings', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'exception_action', exception_action,
      'finding', finding,
      'records', records,
      'distinct_keys', distinct_keys
    ) ORDER BY exception_action, finding)
      FROM household_findings
  ), '[]'::jsonb),
  'contact_key_findings', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'exception_action', exception_action,
      'finding', finding,
      'records', records,
      'distinct_keys', distinct_keys
    ) ORDER BY exception_action, finding)
      FROM contact_findings
  ), '[]'::jsonb),
  'freshness', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'exception_action', exception_action,
      'freshness', freshness,
      'records', records
    ) ORDER BY exception_action, freshness)
      FROM freshness_findings
  ), '[]'::jsonb),
  'household_cross_domain', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'exception_action', exception_action,
      'coverage', coverage,
      'records', records,
      'distinct_keys', distinct_keys
    ) ORDER BY exception_action, coverage)
      FROM household_cross_domain
  ), '[]'::jsonb),
  'orphan_classification', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'parent_type', parent_type,
      'classification', classification,
      'exception_action', exception_action,
      'freshness', freshness,
      'records', records,
      'distinct_keys', distinct_keys
    ) ORDER BY parent_type, classification, exception_action, freshness)
      FROM orphan_classification_breakdown
  ), '[]'::jsonb)
) AS result
  FROM summary
`;

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`crm_parent_diagnostics_invalid_${label}`);
  }
  return value as UnknownRecord;
}

function rows(value: unknown, label: string): UnknownRecord[] {
  if (!Array.isArray(value)) {
    throw new Error(`crm_parent_diagnostics_invalid_${label}`);
  }
  return value.map((item) => record(item, label));
}

function count(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`crm_parent_diagnostics_invalid_${label}`);
  }
  return value;
}

function dimension(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error(`crm_parent_diagnostics_invalid_${label}`);
  }
  return value;
}

function parseDiagnostics(value: unknown): CrmMissingParentDiagnostics {
  const result = record(value, "result");
  const summary = record(result.summary, "summary");

  return {
    summary: {
      unresolved_records: count(summary.unresolved_records, "unresolved_records"),
      would_open: count(summary.would_open, "would_open"),
      would_reopen: count(summary.would_reopen, "would_reopen"),
      already_open: count(summary.already_open, "already_open"),
      would_resolve: count(summary.would_resolve, "would_resolve"),
      no_parent_key_records: count(
        summary.no_parent_key_records,
        "no_parent_key_records",
      ),
      distinct_unresolved_household_keys: count(
        summary.distinct_unresolved_household_keys,
        "distinct_unresolved_household_keys",
      ),
      distinct_unresolved_contact_keys: count(
        summary.distinct_unresolved_contact_keys,
        "distinct_unresolved_contact_keys",
      ),
    },
    by_source: rows(result.by_source, "by_source").map((item) => ({
      identity_type: dimension(item.identity_type, "identity_type"),
      source_system: dimension(item.source_system, "source_system"),
      source_namespace: dimension(item.source_namespace, "source_namespace"),
      exception_action: dimension(item.exception_action, "exception_action"),
      parent_issue: dimension(item.parent_issue, "parent_issue"),
      records: count(item.records, "records"),
      distinct_household_keys: count(
        item.distinct_household_keys,
        "distinct_household_keys",
      ),
      distinct_contact_keys: count(
        item.distinct_contact_keys,
        "distinct_contact_keys",
      ),
    })),
    household_key_findings: rows(
      result.household_key_findings,
      "household_key_findings",
    ).map((item) => ({
      exception_action: dimension(item.exception_action, "exception_action"),
      finding: dimension(item.finding, "finding"),
      records: count(item.records, "records"),
      distinct_keys: count(item.distinct_keys, "distinct_keys"),
    })),
    contact_key_findings: rows(
      result.contact_key_findings,
      "contact_key_findings",
    ).map((item) => ({
      exception_action: dimension(item.exception_action, "exception_action"),
      finding: dimension(item.finding, "finding"),
      records: count(item.records, "records"),
      distinct_keys: count(item.distinct_keys, "distinct_keys"),
    })),
    freshness: rows(result.freshness, "freshness").map((item) => ({
      exception_action: dimension(item.exception_action, "exception_action"),
      freshness: dimension(item.freshness, "freshness"),
      records: count(item.records, "records"),
    })),
    household_cross_domain: rows(
      result.household_cross_domain,
      "household_cross_domain",
    ).map((item) => ({
      exception_action: dimension(item.exception_action, "exception_action"),
      coverage: dimension(item.coverage, "coverage"),
      records: count(item.records, "records"),
      distinct_keys: count(item.distinct_keys, "distinct_keys"),
    })),
    orphan_classification: rows(
      result.orphan_classification,
      "orphan_classification",
    ).map((item) => ({
      parent_type: dimension(item.parent_type, "parent_type"),
      classification: dimension(item.classification, "classification"),
      exception_action: dimension(item.exception_action, "exception_action"),
      freshness: dimension(item.freshness, "freshness"),
      records: count(item.records, "records"),
      distinct_keys: count(item.distinct_keys, "distinct_keys"),
    })),
  };
}

export async function runCrmMissingParentDiagnostics(): Promise<CrmMissingParentDiagnostics> {
  const client = crmReconcilerClient();
  const raw = await client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const result = await tx.$queryRaw<RawResult[]>(DIAGNOSTICS_SQL);
      return result;
    },
    { timeout: CRM_PARENT_DIAGNOSTICS_TIMEOUT_MS, maxWait: 15_000 },
  );
  const row = raw[0];
  if (!row) throw new Error("crm_parent_diagnostics_no_result");
  return parseDiagnostics(row.result);
}
