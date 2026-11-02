import "server-only";

import { Prisma, type CrmDuplicateReviewStatus } from "@prisma/client";
import {
  applyCrmExplorerDatabaseBounds,
  CRM_EXPLORER_TRANSACTION_OPTIONS,
  readCrmNavigationState,
  readCrmWindowStats,
  type CrmExplorerStats,
} from "@/lib/data/crm-explorer";
import { buildCrmWindow, crmWindowLimit, type CrmWindowRequest } from "@/lib/data/crm-window";
import {
  CRM_DUPLICATE_FLAG,
  CRM_DUPLICATE_NOT_DUPLICATE,
  CRM_DUPLICATE_REOPEN,
  CRM_DUPLICATE_READY,
  CRM_DUPLICATE_SNOOZE,
  writeAudit,
} from "@/lib/audit";
import { crmIdentityReadsEnabled } from "@/lib/flags";
import { withUserScope, type Identity } from "@/lib/rls";
import { canViewCrmId } from "@/lib/crm/visibility";

export const CRM_DUPLICATE_EVIDENCE_CODES = [
  "SOURCE_MERGE_REPLACEMENT",
  "SHARED_CEDAR_RIDGE_USER_ID",
  "EXACT_CUSTODIAN_IDENTITY",
  "OFFICIAL_ACCOUNT_REPLACEMENT",
  "EXACT_NORMALIZED_HOUSEHOLD_NAME",
  "SAME_ADVISOR_AND_STAGE",
  "EMPTY_SHELL_WITH_POPULATED_MATCH",
  "EXACT_NORMALIZED_CONTACT_NAME",
  "SAME_CANONICAL_HOUSEHOLD",
  "SOURCE_CONTACT_DATA_CONCENTRATED",
  "OPERATOR_SUBMITTED",
] as const;
export type CrmDuplicateEvidenceCode = typeof CRM_DUPLICATE_EVIDENCE_CODES[number];

export const CRM_DUPLICATE_HARD_CONFLICT_CODES = [
  "CONFLICTING_MEMBER_IDENTITY",
  "DISTINCT_CUSTODIAN_IDENTITIES",
  "SOURCE_TYPE_MISMATCH",
  "CONFLICTING_CONTACT_IDENTITY",
] as const;
export type CrmDuplicateHardConflictCode = typeof CRM_DUPLICATE_HARD_CONFLICT_CODES[number];

export const CRM_DUPLICATE_EVIDENCE_LABELS: Record<CrmDuplicateEvidenceCode, string> = {
  SOURCE_MERGE_REPLACEMENT: "CRM reports a merged household replacement",
  SHARED_CEDAR_RIDGE_USER_ID: "The same Cedar Ridge user appears in both households",
  EXACT_CUSTODIAN_IDENTITY: "The exact same custodial account appears under both households",
  OFFICIAL_ACCOUNT_REPLACEMENT: "The custodian reports an official replacement lineage",
  EXACT_NORMALIZED_HOUSEHOLD_NAME: "The CRM household names match exactly after spacing and case normalization",
  SAME_ADVISOR_AND_STAGE: "Both households have the same lead advisor and client stage",
  EMPTY_SHELL_WITH_POPULATED_MATCH: "One household has members while the matching household is an empty shell",
  EXACT_NORMALIZED_CONTACT_NAME: "The CRM contact names match exactly after spacing and case normalization",
  SAME_CANONICAL_HOUSEHOLD: "Both contacts belong to the same AOA household",
  SOURCE_CONTACT_DATA_CONCENTRATED: "Accounts or deal history are concentrated on one of the two contact records",
  OPERATOR_SUBMITTED: "Operations flagged these CRM records for comparison",
};

export const CRM_DUPLICATE_CONFLICT_LABELS: Record<CrmDuplicateHardConflictCode, string> = {
  CONFLICTING_MEMBER_IDENTITY: "A shared email points to different Cedar Ridge users",
  DISTINCT_CUSTODIAN_IDENTITIES: "The account identifiers are different",
  SOURCE_TYPE_MISMATCH: "The source record types do not agree",
  CONFLICTING_CONTACT_IDENTITY: "The contacts carry different Cedar Ridge user identities",
};

export const CRM_DUPLICATE_CONFIRM_REASONS = [
  "SAME_RELATIONSHIP_SOURCE_DUPLICATE",
  "SAME_PERSON_SOURCE_DUPLICATE",
  "OFFICIAL_SOURCE_REPLACEMENT",
  "SHARED_IDENTIFIER_CONFIRMED",
] as const;
export type CrmDuplicateConfirmReason = typeof CRM_DUPLICATE_CONFIRM_REASONS[number];

export const CRM_DUPLICATE_REJECT_REASONS = [
  "DISTINCT_PEOPLE_OR_HOUSEHOLDS",
  "DISTINCT_ACCOUNTS",
  "SOURCE_DATA_ERROR",
] as const;
export type CrmDuplicateRejectReason = typeof CRM_DUPLICATE_REJECT_REASONS[number];
export type CrmDuplicateDecisionReason = CrmDuplicateConfirmReason | CrmDuplicateRejectReason;

export const CRM_DUPLICATE_REASON_LABELS: Record<CrmDuplicateDecisionReason, string> = {
  SAME_RELATIONSHIP_SOURCE_DUPLICATE: "Both records represent the same relationship",
  SAME_PERSON_SOURCE_DUPLICATE: "Both contact records represent the same person",
  OFFICIAL_SOURCE_REPLACEMENT: "The source confirms one record replaced the other",
  SHARED_IDENTIFIER_CONFIRMED: "The shared durable identifier is correct",
  DISTINCT_PEOPLE_OR_HOUSEHOLDS: "The records represent different people or households",
  DISTINCT_ACCOUNTS: "The account records are intentionally distinct",
  SOURCE_DATA_ERROR: "The detector is relying on incorrect source data",
};

export const CRM_DUPLICATE_VIEWS = [
  "potential", "snoozed", "confirmed", "not_duplicate", "all",
] as const;
export type CrmDuplicateView = typeof CRM_DUPLICATE_VIEWS[number];

export const CRM_DUPLICATE_ENTITY_TYPES = ["HOUSEHOLD", "CONTACT", "ACCOUNT"] as const;
export type CrmDuplicateEntityType = typeof CRM_DUPLICATE_ENTITY_TYPES[number];

export function normalizeCrmDuplicateView(value: string | null | undefined): CrmDuplicateView | null {
  return CRM_DUPLICATE_VIEWS.includes(value as CrmDuplicateView)
    ? value as CrmDuplicateView
    : null;
}

export function normalizeCrmDuplicateEntityType(
  value: string | null | undefined,
): CrmDuplicateEntityType | null {
  return CRM_DUPLICATE_ENTITY_TYPES.includes(value as CrmDuplicateEntityType)
    ? value as CrmDuplicateEntityType
    : null;
}

/** CRM household IDs are Salesforce IDs: 15 or 18 alphanumeric characters. */
export function normalizeCrmHouseholdId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(normalized)
    ? normalized
    : null;
}

/** CRM contacts use Salesforce Contact IDs (`003…`) at 15 or 18 characters. */
export function normalizeCrmContactId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return /^003[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(normalized)
    ? normalized
    : null;
}

export type FlagCrmDuplicateCandidateResult =
  | { status: "created" | "flagged" | "existing"; candidateId: string }
  | { status: "invalid" | "not_found" | "different_household" | "canonicalized_source" | "forbidden" };

/**
 * Create a review-only household pair from two explicit CRM IDs. The
 * database function validates current source mappings and records provenance;
 * this path never chooses a survivor or changes a source record.
 */
export async function flagCrmDuplicateCandidate(
  identity: Identity,
  input: { leftCrmId: string; rightCrmId: string },
): Promise<FlagCrmDuplicateCandidateResult> {
  if (!canViewCrmId(identity.role) || !identity.email || !crmIdentityReadsEnabled()) {
    return { status: "forbidden" };
  }
  const leftCrmId = normalizeCrmHouseholdId(input.leftCrmId);
  const rightCrmId = normalizeCrmHouseholdId(input.rightCrmId);
  if (!leftCrmId || !rightCrmId
      || leftCrmId.slice(0, 15) === rightCrmId.slice(0, 15)) {
    return { status: "invalid" };
  }

  return withUserScope(identity, async (tx) => {
    const [result] = await tx.$queryRaw<Array<{
      result_code: "CREATED" | "FLAGGED" | "EXISTING" | "INVALID" | "NOT_FOUND" | "CANONICALIZED_SOURCE";
      candidate_id: string | null;
    }>>(Prisma.sql`
      SELECT * FROM app.flag_crm_duplicate_households(
        ${leftCrmId}, ${rightCrmId}
      )
    `);
    if (!result || result.result_code === "INVALID") return { status: "invalid" as const };
    if (result.result_code === "NOT_FOUND") return { status: "not_found" as const };
    if (result.result_code === "CANONICALIZED_SOURCE") {
      return { status: "canonicalized_source" as const };
    }
    if (!result.candidate_id) return { status: "invalid" as const };
    const status = result.result_code.toLowerCase() as "created" | "flagged" | "existing";
    if (status !== "existing") {
      await writeAudit(tx, identity, {
        action: CRM_DUPLICATE_FLAG,
        entityType: "crm_duplicate_candidate",
        entityId: result.candidate_id,
        detail: {
          entityType: "HOUSEHOLD",
          origin: "CRM_EXPLORER",
        },
      });
    }
    return { status, candidateId: result.candidate_id };
  }, { timeout: 15_000, maxWait: 5_000 });
}

/**
 * Create a review-only contact pair from two explicit CRM Contact IDs.
 * Both contacts must resolve to the same canonical AOA household. This opens
 * the existing human-review workflow and never chooses a survivor or writes to
 * CRM.
 */
export async function flagCrmContactDuplicateCandidate(
  identity: Identity,
  input: { leftCrmId: string; rightCrmId: string },
): Promise<FlagCrmDuplicateCandidateResult> {
  if (!canViewCrmId(identity.role) || !identity.email || !crmIdentityReadsEnabled()) {
    return { status: "forbidden" };
  }
  const leftCrmId = normalizeCrmContactId(input.leftCrmId);
  const rightCrmId = normalizeCrmContactId(input.rightCrmId);
  if (!leftCrmId || !rightCrmId
      || leftCrmId.slice(0, 15) === rightCrmId.slice(0, 15)) {
    return { status: "invalid" };
  }

  return withUserScope(identity, async (tx) => {
    const [result] = await tx.$queryRaw<Array<{
      result_code: "CREATED" | "FLAGGED" | "EXISTING" | "INVALID" | "NOT_FOUND"
        | "DIFFERENT_HOUSEHOLD" | "CANONICALIZED_SOURCE";
      candidate_id: string | null;
    }>>(Prisma.sql`
      SELECT * FROM app.flag_crm_duplicate_contacts(
        ${leftCrmId}, ${rightCrmId}
      )
    `);
    if (!result || result.result_code === "INVALID") return { status: "invalid" as const };
    if (result.result_code === "NOT_FOUND") return { status: "not_found" as const };
    if (result.result_code === "DIFFERENT_HOUSEHOLD") {
      return { status: "different_household" as const };
    }
    if (result.result_code === "CANONICALIZED_SOURCE") {
      return { status: "canonicalized_source" as const };
    }
    if (!result.candidate_id) return { status: "invalid" as const };
    const status = result.result_code.toLowerCase() as "created" | "flagged" | "existing";
    if (status !== "existing") {
      await writeAudit(tx, identity, {
        action: CRM_DUPLICATE_FLAG,
        entityType: "crm_duplicate_candidate",
        entityId: result.candidate_id,
        detail: {
          entityType: "CONTACT",
          origin: "CRM_EXPLORER",
        },
      });
    }
    return { status, candidateId: result.candidate_id };
  }, { timeout: 15_000, maxWait: 5_000 });
}

export function isExactAccountDuplicateSignal(input: {
  leftCustodianId: string | null;
  rightCustodianId: string | null;
  officialReplacement: boolean;
}): boolean {
  const left = input.leftCustodianId?.trim() ?? "";
  const right = input.rightCustodianId?.trim() ?? "";
  return Boolean(left && right && (left === right || input.officialReplacement));
}

type CandidateRow = {
  id: string;
  entity_type: "HOUSEHOLD" | "CONTACT" | "ACCOUNT";
  left_identity_id: string;
  right_identity_id: string;
  account_fingerprint: string | null;
  evidence_codes: string[];
  hard_conflict_codes: string[];
  accepted_hard_conflict_codes: string[];
  conflict_override_at: Date | null;
  conflict_override_by: string | null;
  operator_flagged: boolean;
  review_version: number;
  source_active: boolean;
  status: CrmDuplicateReviewStatus;
  snoozed_until: Date | null;
  decision_reason: string | null;
  canonical_identity_id: string | null;
  similar_confirmed: bigint;
  similar_rejected: bigint;
  detected_at: Date;
  last_seen_at: Date;
  updated_at: Date;
  left_name: string | null;
  right_name: string | null;
};

export type CrmDuplicateCandidateSummary = {
  id: string;
  entityType: "HOUSEHOLD" | "CONTACT" | "ACCOUNT";
  leftIdentityId: string;
  rightIdentityId: string;
  leftName: string;
  rightName: string;
  evidenceCodes: CrmDuplicateEvidenceCode[];
  hardConflictCodes: CrmDuplicateHardConflictCode[];
  acceptedHardConflictCodes: CrmDuplicateHardConflictCode[];
  conflictOverrideAt: string | null;
  conflictOverrideBy: string | null;
  operatorFlagged: boolean;
  sourceActive: boolean;
  status: CrmDuplicateReviewStatus;
  snoozedUntil: string | null;
  decisionReason: CrmDuplicateDecisionReason | null;
  canonicalIdentityId: string | null;
  detectedAt: string;
  lastSeenAt: string;
  updatedAt: string;
  reviewVersion: number;
  learning: CrmDuplicateLearningSummary;
};

export type CrmDuplicateLearningSummary = {
  recommendation: "CONFIRM_DUPLICATE" | "KEEP_SEPARATE" | "REVIEW_MANUALLY";
  confidence: "HIGH" | "MEDIUM" | "EARLY" | "BLOCKED";
  similarReviewed: number;
  similarConfirmed: number;
  similarRejected: number;
  explanation: string;
};

export function isCrmContactIdentityOverrideEligible(input: {
  entityType: "HOUSEHOLD" | "CONTACT" | "ACCOUNT";
  evidenceCodes: readonly CrmDuplicateEvidenceCode[];
  hardConflictCodes: readonly CrmDuplicateHardConflictCode[];
  operatorFlagged: boolean;
}): boolean {
  return input.entityType === "CONTACT"
    && input.hardConflictCodes.length === 1
    && input.hardConflictCodes[0] === "CONFLICTING_CONTACT_IDENTITY"
    && input.evidenceCodes.includes("SAME_CANONICAL_HOUSEHOLD")
    && (
      input.evidenceCodes.includes("EXACT_NORMALIZED_CONTACT_NAME")
      || (input.operatorFlagged && input.evidenceCodes.includes("OPERATOR_SUBMITTED"))
    );
}

export function buildCrmDuplicateLearningSummary(input: {
  evidenceCodes: readonly CrmDuplicateEvidenceCode[];
  hardConflictCodes: readonly CrmDuplicateHardConflictCode[];
  similarConfirmed: number;
  similarRejected: number;
}): CrmDuplicateLearningSummary {
  const reviewed = input.similarConfirmed + input.similarRejected;
  const base = {
    similarReviewed: reviewed,
    similarConfirmed: input.similarConfirmed,
    similarRejected: input.similarRejected,
  };
  if (input.hardConflictCodes.length > 0) return {
    ...base,
    recommendation: "REVIEW_MANUALLY",
    confidence: "BLOCKED",
    explanation: "A blocking identity conflict must be resolved before this pair can be confirmed.",
  };
  if (reviewed >= 3) {
    const confirmRatio = input.similarConfirmed / reviewed;
    if (confirmRatio >= 0.8) return {
      ...base,
      recommendation: "CONFIRM_DUPLICATE",
      confidence: "HIGH",
      explanation: "At least 80% of prior reviews with this same signal pattern were confirmed duplicates.",
    };
    if (confirmRatio <= 0.2) return {
      ...base,
      recommendation: "KEEP_SEPARATE",
      confidence: "HIGH",
      explanation: "At least 80% of prior reviews with this same signal pattern were kept separate.",
    };
    return {
      ...base,
      recommendation: "REVIEW_MANUALLY",
      confidence: "EARLY",
      explanation: "Prior reviewers reached mixed outcomes for this signal pattern.",
    };
  }
  const hasStrongSourceSignal = input.evidenceCodes.some((code) => [
    "SOURCE_MERGE_REPLACEMENT",
    "EXACT_CUSTODIAN_IDENTITY",
    "OFFICIAL_ACCOUNT_REPLACEMENT",
  ].includes(code));
  const weakReviewOnly = input.evidenceCodes.some((code) => [
    "EXACT_NORMALIZED_HOUSEHOLD_NAME",
    "SAME_ADVISOR_AND_STAGE",
    "EMPTY_SHELL_WITH_POPULATED_MATCH",
    "EXACT_NORMALIZED_CONTACT_NAME",
    "SAME_CANONICAL_HOUSEHOLD",
    "SOURCE_CONTACT_DATA_CONCENTRATED",
    "OPERATOR_SUBMITTED",
  ].includes(code)) && !hasStrongSourceSignal
    && !input.evidenceCodes.includes("SHARED_CEDAR_RIDGE_USER_ID");
  if (weakReviewOnly) return {
    ...base,
    recommendation: "REVIEW_MANUALLY",
    confidence: "EARLY",
    explanation: "The records share controlled household attributes, but those attributes are not durable identity proof. A person must decide whether they are duplicates.",
  };
  return {
    ...base,
    recommendation: "CONFIRM_DUPLICATE",
    confidence: hasStrongSourceSignal ? "MEDIUM" : "EARLY",
    explanation: hasStrongSourceSignal
      ? "The current source evidence is a strong duplicate signal, but the human history is still limited."
      : "The current shared-identity signal suggests a duplicate, but more human decisions are needed.",
  };
}

export const CRM_DUPLICATE_PAGE_SIZE = 100;

export type CrmDuplicateCandidateListResult =
  | {
      ok: true; rows: CrmDuplicateCandidateSummary[]; total: number; view: CrmDuplicateView;
      page: number; pageSize: number; pageCount: number; snapshot: string; stats: CrmExplorerStats;
    }
  | { ok: false; reason: "forbidden" | "disabled" };

function candidateViewWhere(view: CrmDuplicateView): Prisma.Sql {
  if (view === "potential") return Prisma.sql`
    candidate.source_active
    AND (
      candidate.status = 'NEW'
      OR (candidate.status = 'SNOOZED' AND candidate.snoozed_until <= now())
    )`;
  if (view === "snoozed") return Prisma.sql`
    candidate.source_active AND candidate.status = 'SNOOZED'
    AND candidate.snoozed_until > now()`;
  if (view === "not_duplicate") return Prisma.sql`
    candidate.status = 'NOT_DUPLICATE'`;
  if (view === "confirmed") return Prisma.sql`
    candidate.status = 'READY_FOR_FOLLOW_UP'`;
  return Prisma.sql`true`;
}

function coerceCandidate(row: CandidateRow): CrmDuplicateCandidateSummary {
  return {
    id: row.id,
    entityType: row.entity_type,
    leftIdentityId: row.left_identity_id,
    rightIdentityId: row.right_identity_id,
    leftName: row.left_name ?? (row.entity_type === "CONTACT" ? "Contact" : "Household"),
    rightName: row.right_name ?? (row.entity_type === "CONTACT" ? "Contact" : "Household"),
    evidenceCodes: row.evidence_codes as CrmDuplicateEvidenceCode[],
    hardConflictCodes: row.hard_conflict_codes as CrmDuplicateHardConflictCode[],
    acceptedHardConflictCodes: row.accepted_hard_conflict_codes as CrmDuplicateHardConflictCode[],
    conflictOverrideAt: row.conflict_override_at?.toISOString() ?? null,
    conflictOverrideBy: row.conflict_override_by,
    operatorFlagged: row.operator_flagged,
    sourceActive: row.source_active,
    status: row.status,
    snoozedUntil: row.snoozed_until?.toISOString() ?? null,
    decisionReason: row.decision_reason as CrmDuplicateDecisionReason | null,
    canonicalIdentityId: row.canonical_identity_id,
    detectedAt: row.detected_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    reviewVersion: row.review_version,
    learning: buildCrmDuplicateLearningSummary({
      evidenceCodes: row.evidence_codes as CrmDuplicateEvidenceCode[],
      hardConflictCodes: row.hard_conflict_codes as CrmDuplicateHardConflictCode[],
      similarConfirmed: Number(row.similar_confirmed),
      similarRejected: Number(row.similar_rejected),
    }),
  };
}

export async function listCrmDuplicateCandidates(
  identity: Identity,
  requestedView: string | null | undefined,
  requestedEntityType?: string | null,
  requestedPage = 1,
): Promise<CrmDuplicateCandidateListResult> {
  return readCrmDuplicateRows(identity, requestedView, requestedEntityType, requestedPage);
}

export async function listCrmDuplicateWindow(identity: Identity, requestedView: string | null | undefined,
  requestedEntityType: string | null | undefined, window: CrmWindowRequest) {
  crmWindowLimit(window);
  const result = await readCrmDuplicateRows(identity, requestedView, requestedEntityType, window.firstPage, window);
  if (!result.ok) return result;
  return { ok: true as const, ...buildCrmWindow(window, result.rows, result.total,
    ["duplicates", identity.role ?? "", identity.email ?? "", result.view, normalizeCrmDuplicateEntityType(requestedEntityType)],
    { ...result.stats, total: result.total, pageCount: result.pageCount }) };
}

async function readCrmDuplicateRows(identity: Identity, requestedView: string | null | undefined,
  requestedEntityType?: string | null, requestedPage = 1, window?: CrmWindowRequest,
): Promise<CrmDuplicateCandidateListResult> {
  if (!canViewCrmId(identity.role)) return { ok: false, reason: "forbidden" };
  if (!crmIdentityReadsEnabled()) return { ok: false, reason: "disabled" };
  const view = normalizeCrmDuplicateView(requestedView) ?? "potential";
  const viewWhere = candidateViewWhere(view);
  const entityType = normalizeCrmDuplicateEntityType(requestedEntityType);
  const page = Math.min(1_000_000, Math.max(1, Math.floor(Number(requestedPage) || 1)));
  const where = requestedEntityType && !entityType
    ? Prisma.sql`false`
    : entityType
      ? Prisma.sql`(${viewWhere}) AND candidate.entity_type::text = ${entityType}`
      : viewWhere;
  return withUserScope(identity, async (tx) => {
    await applyCrmExplorerDatabaseBounds(tx);
    const [rows, counts] = await Promise.all([
      tx.$queryRaw<CandidateRow[]>(Prisma.sql`
        SELECT candidate.id, candidate.entity_type, candidate.left_identity_id,
               candidate.right_identity_id, candidate.account_fingerprint,
               candidate.evidence_codes,
               candidate.hard_conflict_codes, candidate.accepted_hard_conflict_codes,
               candidate.conflict_override_at, candidate.conflict_override_by,
               candidate.operator_flagged,
               candidate.review_version, candidate.source_active,
               candidate.status, candidate.snoozed_until, candidate.decision_reason,
               candidate.canonical_identity_id,
               (SELECT count(*)::bigint
                  FROM app.crm_duplicate_candidate learned
                 WHERE learned.id <> candidate.id
                   AND learned.entity_type = candidate.entity_type
                   AND learned.evidence_codes = candidate.evidence_codes
                   AND learned.hard_conflict_codes = candidate.hard_conflict_codes
                   AND learned.status = 'READY_FOR_FOLLOW_UP'
                   AND learned.decision_reason IS NOT NULL) AS similar_confirmed,
               (SELECT count(*)::bigint
                  FROM app.crm_duplicate_candidate learned
                 WHERE learned.id <> candidate.id
                   AND learned.entity_type = candidate.entity_type
                   AND learned.evidence_codes = candidate.evidence_codes
                   AND learned.hard_conflict_codes = candidate.hard_conflict_codes
                   AND learned.status = 'NOT_DUPLICATE'
                   AND learned.decision_reason IS NOT NULL) AS similar_rejected,
               candidate.detected_at,
               candidate.last_seen_at, candidate.updated_at,
               COALESCE(
                 (SELECT household.name
                  FROM app.crm_source_mapping mapping
                  JOIN mirror.household household
                    ON left(household.sf_id, 15) = left(mapping.source_key, 15)
                 WHERE mapping.identity_id = candidate.left_identity_id
                   AND mapping.source_system = 'CRM'
                   AND mapping.source_namespace = 'household'
                   AND mapping.mapping_state = 'ACTIVE'
                 ORDER BY mapping.first_seen_at, mapping.id LIMIT 1),
                 (SELECT trim(coalesce(client.first_name, '') || ' ' || coalesce(client.last_name, ''))
                    FROM app.crm_source_mapping mapping
                    JOIN mirror.client client
                      ON left(client.sf_id, 15) = left(mapping.source_key, 15)
                   WHERE mapping.identity_id = candidate.left_identity_id
                     AND mapping.source_system = 'CRM'
                     AND mapping.source_namespace = 'contact'
                     AND mapping.mapping_state = 'ACTIVE'
                   ORDER BY mapping.first_seen_at, mapping.id LIMIT 1)
               ) AS left_name,
               COALESCE(
                 (SELECT household.name
                  FROM app.crm_source_mapping mapping
                  JOIN mirror.household household
                    ON left(household.sf_id, 15) = left(mapping.source_key, 15)
                 WHERE mapping.identity_id = candidate.right_identity_id
                   AND mapping.source_system = 'CRM'
                   AND mapping.source_namespace = 'household'
                   AND mapping.mapping_state = 'ACTIVE'
                 ORDER BY mapping.first_seen_at, mapping.id LIMIT 1),
                 (SELECT trim(coalesce(client.first_name, '') || ' ' || coalesce(client.last_name, ''))
                    FROM app.crm_source_mapping mapping
                    JOIN mirror.client client
                      ON left(client.sf_id, 15) = left(mapping.source_key, 15)
                   WHERE mapping.identity_id = candidate.right_identity_id
                     AND mapping.source_system = 'CRM'
                     AND mapping.source_namespace = 'contact'
                     AND mapping.mapping_state = 'ACTIVE'
                   ORDER BY mapping.first_seen_at, mapping.id LIMIT 1)
               ) AS right_name
          FROM app.crm_duplicate_candidate candidate
         WHERE ${where}
         ORDER BY candidate.detected_at DESC, candidate.id
         LIMIT ${window ? crmWindowLimit(window) : CRM_DUPLICATE_PAGE_SIZE}
        OFFSET ${(page - 1) * (window?.pageSize ?? CRM_DUPLICATE_PAGE_SIZE)}`),
      tx.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`
        SELECT count(*)::bigint AS total
          FROM app.crm_duplicate_candidate candidate
         WHERE ${where}`),
    ]);
    const navigation = window
      ? { stats: await readCrmWindowStats(tx), snapshot: "" }
      : await readCrmNavigationState(tx);
    const total = Number(counts[0]?.total ?? 0);
    return {
      ok: true as const,
      rows: rows.map(coerceCandidate),
      total,
      view,
      page,
      pageSize: window?.pageSize ?? CRM_DUPLICATE_PAGE_SIZE,
      pageCount: Math.max(1, Math.ceil(total / (window?.pageSize ?? CRM_DUPLICATE_PAGE_SIZE))),
      snapshot: navigation.snapshot,
      stats: navigation.stats,
    };
  }, { ...CRM_EXPLORER_TRANSACTION_OPTIONS, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

type SideRow = {
  crm_identity_id: string;
  crm_id: string | null;
  name: string | null;
  status: string | null;
  lead_advisor_email: string | null;
  source_freshness: Date | null;
  member_count: bigint;
  open_account_count: bigint;
  closed_account_count: bigint;
  account_aum: Prisma.Decimal | null;
  deal_count: bigint;
  transfer_count: bigint;
  task_count: bigint;
  activity_count: bigint;
  email_count: bigint;
  appointment_count: bigint;
};

type ContactSideRow = {
  crm_identity_id: string;
  crm_id: string | null;
  name: string | null;
  household_name: string | null;
  source_freshness: Date | null;
  has_email: boolean;
  has_cedar_ridge_user_id: boolean;
  open_account_count: bigint;
  closed_account_count: bigint;
  account_aum: Prisma.Decimal | null;
  deal_count: bigint;
  appointment_count: bigint;
};

export type CrmDuplicateHouseholdSide = {
  entityType: "HOUSEHOLD" | "CONTACT";
  crmIdentityId: string;
  crmId: string | null;
  name: string;
  status: string | null;
  leadAdvisorEmail: string | null;
  sourceFreshness: string | null;
  memberCount: number;
  openAccountCount: number;
  closedAccountCount: number;
  accountAum: string | null;
  dealCount: number;
  transferCount: number;
  taskCount: number;
  activityCount: number;
  emailCount: number;
  appointmentCount: number;
  householdName: string | null;
  hasEmail: boolean;
  hasCedarRidgeUserId: boolean;
};

export type CrmDuplicateCandidateDetail = CrmDuplicateCandidateSummary & {
  left: CrmDuplicateHouseholdSide;
  right: CrmDuplicateHouseholdSide;
  accountEnding: string | null;
  events: Array<{
    action: string;
    actorEmail: string | null;
    fromStatus: CrmDuplicateReviewStatus | null;
    toStatus: CrmDuplicateReviewStatus | null;
    reason: CrmDuplicateDecisionReason | null;
    canonicalSide: "LEFT" | "RIGHT" | null;
    at: string;
  }>;
};

export type CrmDuplicateCandidateDetailResult =
  | { ok: true; detail: CrmDuplicateCandidateDetail | null }
  | { ok: false; reason: "forbidden" | "disabled" };

/**
 * Resolve a suppressed household or contact CRM identity to the human-selected survivor.
 * This is an AOA route overlay only: neither identity nor either CRM
 * mapping is rewritten. Ambiguous targets and cycles fail closed.
 */
export async function resolveCrmDuplicateCanonicalIdentity(
  identity: Identity,
  crmIdentityId: string,
): Promise<string> {
  if (!canViewCrmId(identity.role) || !crmIdentityReadsEnabled()) return crmIdentityId;
  return withUserScope(identity, async (tx) => {
    const original = crmIdentityId;
    let current = crmIdentityId;
    const seen = new Set([current]);
    for (let depth = 0; depth < 8; depth += 1) {
      const rows = await tx.$queryRaw<Array<{ canonical_identity_id: string }>>(Prisma.sql`
        SELECT DISTINCT candidate.canonical_identity_id
          FROM app.crm_duplicate_candidate candidate
         WHERE candidate.entity_type IN ('HOUSEHOLD', 'CONTACT')
           AND candidate.status = 'READY_FOR_FOLLOW_UP'
           AND candidate.canonical_identity_id IS NOT NULL
           AND candidate.canonical_identity_id <> ${current}
           AND ${current} IN (candidate.left_identity_id, candidate.right_identity_id)
         ORDER BY candidate.canonical_identity_id`);
      if (rows.length === 0) return current;
      if (rows.length !== 1 || seen.has(rows[0].canonical_identity_id)) return original;
      current = rows[0].canonical_identity_id;
      seen.add(current);
    }
    return original;
  }, { timeout: 15_000, maxWait: 5_000 });
}

async function readHouseholdSide(
  tx: Prisma.TransactionClient,
  crmIdentityId: string,
): Promise<CrmDuplicateHouseholdSide> {
  const [row] = await tx.$queryRaw<SideRow[]>(Prisma.sql`
    WITH source AS MATERIALIZED (
      SELECT mapping.identity_id, mapping.source_key
        FROM app.crm_source_mapping mapping
       WHERE mapping.identity_id = ${crmIdentityId}
         AND mapping.source_system = 'CRM'
         AND mapping.source_namespace = 'household'
         AND mapping.mapping_state = 'ACTIVE'
       ORDER BY mapping.first_seen_at, mapping.id
       LIMIT 1
    )
    SELECT ${crmIdentityId}::text AS crm_identity_id,
           source.source_key AS crm_id, household.name, household.status,
           household.lead_advisor_email,
           greatest(household.synced_at, (SELECT max(client.synced_at)
             FROM mirror.client client
             WHERE left(client.household_id, 15) = left(source.source_key, 15)))
             AS source_freshness,
           (SELECT count(*)::bigint FROM mirror.client client
             WHERE left(client.household_id, 15) = left(source.source_key, 15))
             AS member_count,
           (SELECT count(DISTINCT aum.custodian_account_id)::bigint
              FROM mirror.client_account_aum aum
             WHERE left(aum.household_sf_id, 15) = left(source.source_key, 15)
               AND upper(coalesce(aum.account_status, '')) = 'OPEN') AS open_account_count,
           (SELECT count(DISTINCT aum.custodian_account_id)::bigint
              FROM mirror.client_account_aum aum
             WHERE left(aum.household_sf_id, 15) = left(source.source_key, 15)
               AND upper(coalesce(aum.account_status, '')) = 'CLOSED') AS closed_account_count,
           (SELECT sum(aum.account_aum)
              FROM mirror.client_account_aum aum
             WHERE left(aum.household_sf_id, 15) = left(source.source_key, 15)) AS account_aum,
           (SELECT count(*)::bigint FROM app.deal deal
             WHERE left(deal.household_sf_id, 15) = left(source.source_key, 15)) AS deal_count,
           (SELECT count(*)::bigint FROM app.transfer transfer
             WHERE left(transfer.household_sf_id, 15) = left(source.source_key, 15)) AS transfer_count,
           (SELECT count(*)::bigint FROM mirror.task task
             WHERE left(task.household_sf_id, 15) = left(source.source_key, 15)) AS task_count,
           (SELECT count(*)::bigint FROM mirror.activity activity
             WHERE left(activity.household_sf_id, 15) = left(source.source_key, 15)) AS activity_count,
           (SELECT count(*)::bigint FROM mirror.email email
             WHERE left(email.household_sf_id, 15) = left(source.source_key, 15)) AS email_count,
           (SELECT count(*)::bigint
              FROM mirror.appointment appointment
              JOIN mirror.client appointment_client
                ON appointment_client.sf_id = appointment.client_sf_id
             WHERE left(appointment_client.household_id, 15) = left(source.source_key, 15))
             AS appointment_count
      FROM source
      LEFT JOIN mirror.household household
        ON left(household.sf_id, 15) = left(source.source_key, 15)
     LIMIT 1`);
  return {
    entityType: "HOUSEHOLD",
    crmIdentityId,
    crmId: row?.crm_id ?? null,
    name: row?.name ?? "Household",
    status: row?.status ?? null,
    leadAdvisorEmail: row?.lead_advisor_email ?? null,
    sourceFreshness: row?.source_freshness?.toISOString() ?? null,
    memberCount: Number(row?.member_count ?? 0),
    openAccountCount: Number(row?.open_account_count ?? 0),
    closedAccountCount: Number(row?.closed_account_count ?? 0),
    accountAum: row?.account_aum?.toString() ?? null,
    dealCount: Number(row?.deal_count ?? 0),
    transferCount: Number(row?.transfer_count ?? 0),
    taskCount: Number(row?.task_count ?? 0),
    activityCount: Number(row?.activity_count ?? 0),
    emailCount: Number(row?.email_count ?? 0),
    appointmentCount: Number(row?.appointment_count ?? 0),
    householdName: row?.name ?? null,
    hasEmail: false,
    hasCedarRidgeUserId: false,
  };
}

async function readContactSide(
  tx: Prisma.TransactionClient,
  crmIdentityId: string,
): Promise<CrmDuplicateHouseholdSide> {
  const [row] = await tx.$queryRaw<ContactSideRow[]>(Prisma.sql`
    WITH source AS MATERIALIZED (
      SELECT mapping.source_key
        FROM app.crm_source_mapping mapping
       WHERE mapping.identity_id = ${crmIdentityId}
         AND mapping.source_system = 'CRM'
         AND mapping.source_namespace = 'contact'
         AND mapping.mapping_state = 'ACTIVE'
       ORDER BY mapping.first_seen_at, mapping.id
       LIMIT 1
    )
    SELECT ${crmIdentityId}::text AS crm_identity_id,
           client.sf_id AS crm_id,
           trim(coalesce(client.first_name, '') || ' ' || coalesce(client.last_name, '')) AS name,
           household.name AS household_name,
           client.synced_at AS source_freshness,
           nullif(btrim(client.email), '') IS NOT NULL AS has_email,
           nullif(btrim(client.cedar_ridge_user_id), '') IS NOT NULL AS has_cedar_ridge_user_id,
           count(DISTINCT account.custodian_account_id)
             FILTER (WHERE upper(coalesce(account.account_status, '')) <> 'CLOSED')::bigint
             AS open_account_count,
           count(DISTINCT account.custodian_account_id)
             FILTER (WHERE upper(coalesce(account.account_status, '')) = 'CLOSED')::bigint
             AS closed_account_count,
           sum(account.account_aum) FILTER (WHERE account.balance_current) AS account_aum,
           (SELECT count(*)::bigint FROM app.deal deal
             WHERE left(deal.client_sf_id, 15) = left(client.sf_id, 15)
               AND deal.archived_at IS NULL) AS deal_count,
           (SELECT count(*)::bigint FROM mirror.appointment appointment
             WHERE left(appointment.client_sf_id, 15) = left(client.sf_id, 15))
             AS appointment_count
      FROM source
      JOIN mirror.client client
        ON left(client.sf_id, 15) = left(source.source_key, 15)
      LEFT JOIN mirror.household household
        ON left(household.sf_id, 15) = left(client.household_id, 15)
      LEFT JOIN mirror.client_account_aum account
        ON left(account.client_sf_id, 15) = left(client.sf_id, 15)
       AND account.source_present
     GROUP BY client.sf_id, client.first_name, client.last_name, client.email,
              client.cedar_ridge_user_id, client.synced_at, household.name
     LIMIT 1`);
  return {
    entityType: "CONTACT",
    crmIdentityId,
    crmId: row?.crm_id ?? null,
    name: row?.name || "Contact",
    status: null,
    leadAdvisorEmail: null,
    sourceFreshness: row?.source_freshness?.toISOString() ?? null,
    memberCount: 0,
    openAccountCount: Number(row?.open_account_count ?? 0),
    closedAccountCount: Number(row?.closed_account_count ?? 0),
    accountAum: row?.account_aum?.toString() ?? null,
    dealCount: Number(row?.deal_count ?? 0),
    transferCount: 0,
    taskCount: 0,
    activityCount: 0,
    emailCount: 0,
    appointmentCount: Number(row?.appointment_count ?? 0),
    householdName: row?.household_name ?? null,
    hasEmail: row?.has_email ?? false,
    hasCedarRidgeUserId: row?.has_cedar_ridge_user_id ?? false,
  };
}

export async function getCrmDuplicateCandidateDetail(
  identity: Identity,
  candidateId: string,
): Promise<CrmDuplicateCandidateDetailResult> {
  if (!canViewCrmId(identity.role)) return { ok: false, reason: "forbidden" };
  if (!crmIdentityReadsEnabled()) return { ok: false, reason: "disabled" };
  return withUserScope(identity, async (tx) => {
    const rows = await tx.$queryRaw<CandidateRow[]>(Prisma.sql`
      SELECT candidate.id, candidate.entity_type, candidate.left_identity_id,
             candidate.right_identity_id, candidate.account_fingerprint,
             candidate.evidence_codes,
             candidate.hard_conflict_codes, candidate.accepted_hard_conflict_codes,
             candidate.conflict_override_at, candidate.conflict_override_by,
             candidate.operator_flagged,
             candidate.review_version, candidate.source_active,
             candidate.status, candidate.snoozed_until, candidate.decision_reason,
             candidate.canonical_identity_id,
             (SELECT count(*)::bigint
                FROM app.crm_duplicate_candidate learned
               WHERE learned.id <> candidate.id
                 AND learned.entity_type = candidate.entity_type
                 AND learned.evidence_codes = candidate.evidence_codes
                 AND learned.hard_conflict_codes = candidate.hard_conflict_codes
                 AND learned.status = 'READY_FOR_FOLLOW_UP'
                 AND learned.decision_reason IS NOT NULL) AS similar_confirmed,
             (SELECT count(*)::bigint
                FROM app.crm_duplicate_candidate learned
               WHERE learned.id <> candidate.id
                 AND learned.entity_type = candidate.entity_type
                 AND learned.evidence_codes = candidate.evidence_codes
                 AND learned.hard_conflict_codes = candidate.hard_conflict_codes
                 AND learned.status = 'NOT_DUPLICATE'
                 AND learned.decision_reason IS NOT NULL) AS similar_rejected,
             candidate.detected_at,
             candidate.last_seen_at, candidate.updated_at,
             NULL::text AS left_name, NULL::text AS right_name
        FROM app.crm_duplicate_candidate candidate
       WHERE candidate.id = ${candidateId}
       LIMIT 1`);
    const candidate = rows[0];
    if (!candidate) return { ok: true as const, detail: null };
    const readSide = candidate.entity_type === "CONTACT" ? readContactSide : readHouseholdSide;
    const [left, right, events, accountRows] = await Promise.all([
      readSide(tx, candidate.left_identity_id),
      readSide(tx, candidate.right_identity_id),
      tx.crmDuplicateCandidateEvent.findMany({
        where: { candidate_id: candidate.id },
        orderBy: [{ at: "desc" }, { id: "desc" }],
        take: 20,
      }),
      candidate.entity_type === "ACCOUNT"
        ? tx.$queryRaw<Array<{ ending: string }>>(Prisma.sql`
            WITH household_accounts AS (
              SELECT DISTINCT mapping.identity_id, holder.custodian_account_id
                FROM app.crm_source_mapping mapping
                JOIN mirror.client client
                  ON left(client.household_id, 15) = left(mapping.source_key, 15)
                JOIN mirror.account_holder holder
                  ON nullif(lower(btrim(holder.cedar_ridge_user_id)), '')
                   = nullif(lower(btrim(client.cedar_ridge_user_id)), '')
               WHERE mapping.identity_id IN (
                 ${candidate.left_identity_id}, ${candidate.right_identity_id}
               )
                 AND mapping.source_system = 'CRM'
                 AND mapping.source_namespace = 'household'
                 AND mapping.mapping_state = 'ACTIVE'
            )
            SELECT right(left_side.custodian_account_id, 4) AS ending
              FROM household_accounts left_side
              JOIN household_accounts right_side
                ON right_side.custodian_account_id = left_side.custodian_account_id
               AND left_side.identity_id < right_side.identity_id
             WHERE app.crm_duplicate_fingerprint(
                     'ACCOUNT:' || left_side.custodian_account_id
                   ) = ${candidate.account_fingerprint}
             LIMIT 1`)
        : Promise.resolve([]),
    ]);
    const summary = coerceCandidate({
      ...candidate,
      left_name: left.name,
      right_name: right.name,
    });
    return {
      ok: true as const,
      detail: {
        ...summary,
        left,
        right,
        accountEnding: accountRows[0]?.ending ?? null,
        events: events.map((event) => ({
          action: event.action,
          actorEmail: event.actor_email,
          fromStatus: event.from_status,
          toStatus: event.to_status,
          reason: event.detail && typeof event.detail === "object" && !Array.isArray(event.detail)
            && typeof event.detail.reason === "string"
            ? event.detail.reason as CrmDuplicateDecisionReason
            : null,
          canonicalSide: event.detail && typeof event.detail === "object" && !Array.isArray(event.detail)
            && (event.detail.canonicalSide === "LEFT" || event.detail.canonicalSide === "RIGHT")
            ? event.detail.canonicalSide
            : null,
          at: event.at.toISOString(),
        })),
      },
    };
  }, { timeout: 15_000, maxWait: 5_000 });
}

export type CrmDuplicateDecision =
  | "NEW"
  | "NOT_DUPLICATE"
  | "SNOOZED"
  | "READY_FOR_FOLLOW_UP";
export type UpdateCrmDuplicateReviewResult = "updated" | "conflict" | "invalid" | "forbidden";

const DECISION_AUDIT_ACTION: Record<CrmDuplicateDecision, string> = {
  NEW: CRM_DUPLICATE_REOPEN,
  NOT_DUPLICATE: CRM_DUPLICATE_NOT_DUPLICATE,
  SNOOZED: CRM_DUPLICATE_SNOOZE,
  READY_FOR_FOLLOW_UP: CRM_DUPLICATE_READY,
};

export async function updateCrmDuplicateReview(
  identity: Identity,
  input: {
    candidateId: string;
    expectedReviewVersion: number;
    decision: CrmDuplicateDecision;
    snoozedUntil: Date | null;
    decisionReason: CrmDuplicateDecisionReason | null;
    canonicalIdentityId: string | null;
    acceptContactIdentityConflict?: boolean;
  },
): Promise<UpdateCrmDuplicateReviewResult> {
  if (!canViewCrmId(identity.role) || !identity.email) return "forbidden";
  if (!crmIdentityReadsEnabled()) return "forbidden";
  if (!/^dup_c[0-9a-f]{24}$/.test(input.candidateId)) return "invalid";
  if (!Number.isSafeInteger(input.expectedReviewVersion) || input.expectedReviewVersion < 0) {
    return "invalid";
  }
  const now = new Date();
  const maxSnooze = new Date(now.getTime() + 366 * 24 * 60 * 60 * 1000);
  if (input.decision === "SNOOZED") {
    if (!input.snoozedUntil
      || input.snoozedUntil <= now
      || input.snoozedUntil > maxSnooze) return "invalid";
  } else if (input.snoozedUntil) return "invalid";
  if (input.decision === "READY_FOR_FOLLOW_UP") {
    if (!input.decisionReason
      || !CRM_DUPLICATE_CONFIRM_REASONS.includes(input.decisionReason as CrmDuplicateConfirmReason)
      || !input.canonicalIdentityId) return "invalid";
  } else if (input.decision === "NOT_DUPLICATE") {
    if (!input.decisionReason
      || !CRM_DUPLICATE_REJECT_REASONS.includes(input.decisionReason as CrmDuplicateRejectReason)
      || input.canonicalIdentityId) return "invalid";
  } else if (input.decisionReason || input.canonicalIdentityId
    || input.acceptContactIdentityConflict) return "invalid";

  return withUserScope(identity, async (tx) => {
    const [saved] = await tx.$queryRaw<Array<{
      result_code: "UPDATED" | "CONFLICT" | "INVALID";
      previous_status: string | null;
      entity_type: string | null;
      evidence_count: number | null;
      hard_conflict_count: number | null;
    }>>(Prisma.sql`
      SELECT * FROM app.review_crm_duplicate_candidate_v5(
        ${input.candidateId},
        ${input.expectedReviewVersion}::integer,
        ${input.decision},
        ${input.snoozedUntil}::timestamptz,
        ${input.decisionReason},
        ${input.canonicalIdentityId},
        ${input.acceptContactIdentityConflict ?? false}
      )
    `);
    if (!saved || saved.result_code === "CONFLICT") return "conflict";
    if (saved.result_code === "INVALID") return "invalid";
    await writeAudit(tx, identity, {
      action: DECISION_AUDIT_ACTION[input.decision],
      entityType: "crm_duplicate_candidate",
      entityId: input.candidateId,
      detail: {
        from: saved.previous_status,
        to: input.decision,
        entityType: saved.entity_type,
        evidenceCount: saved.evidence_count,
        hardConflictCount: saved.hard_conflict_count,
        reason: input.decisionReason,
        canonicalSide: input.canonicalIdentityId ? "SELECTED" : null,
        acceptedHardConflictCodes: input.acceptContactIdentityConflict
          ? ["CONFLICTING_CONTACT_IDENTITY"]
          : [],
      },
    });
    return "updated";
  }, { timeout: 15_000, maxWait: 5_000 });
}
