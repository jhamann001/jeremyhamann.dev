import "server-only";
import type { Prisma } from "@prisma/client";
import { Prisma as PrismaSql } from "@prisma/client";
import type { AoaAcatCandidate, LinkageRecord, LinkageSnapshot } from "../acat-link-contract";
import { historicalAcatPairBlocker, type HistoricalAcatBlocker, type HistoricalAcatIntent } from "../acat-historical-review";

export const HISTORICAL_BLOCKER_TEXT: Record<HistoricalAcatBlocker, string> = {
  already_linked: "This AOA transfer already has a linked ACAT. Historical review does not replace an existing link.",
  funding_unspecified: "Funding type is not recorded. Keep this transfer in the evidence queue; this review does not set its funding type.",
  not_acat_funding: "This transfer records another funding method. ACAT linking is not applicable; its funding method will not be changed.",
  archived_transfer: "This transfer is archived and cannot receive a historical link.",
  ineligible_target_stage: "This transfer is outside Decision, In Transfer or Funded and cannot receive a historical link.",
  ineligible_source_lifecycle: "This Tracker record is not an eligible incoming ACAT. Deleted, canceled, rejected and purged records cannot be linked here.",
  funding_type_mismatch: "The full or partial ACAT type differs between these records. Resolve that evidence before linking.",
  missing_identity: "Verified client identity or receiving-account evidence is missing. Verify the client and receiving account before linking.",
  identity_conflict: "The client or receiving-account identity evidence conflicts. Resolve the conflict before linking.",
  incomplete_joint_evidence: "Joint-account evidence is incomplete. Verify the receiving account and its complete holders before linking this pair. Selecting one person or matching a name does not establish that proof.",
  duplicate_reference: "This transaction reference appears on multiple Tracker records. Resolve the duplicate reference before linking.",
  reserved_link: "This Tracker record or transfer reference is already reserved by another link, or differs from the AOA reference. Review the existing link first.",
  prior_rejection: "This pair was previously rejected. This historical review cannot override that decision.",
  prior_unlink: "A prior link was cleared or undone. This historical review cannot override that intent.",
};

export function historicalBlockerDescription(blocker: HistoricalAcatBlocker, record: LinkageRecord): string {
  if (blocker === "missing_identity" && record.cedarRidgeUserIds.length > 0) {
    if (record.receivingAccount.verification === "MISSING_ACCOUNT") return "The Tracker receiving account is missing. Verify its receiving account and complete holders before linking; selecting a client does not supply that proof.";
    if (record.receivingAccount.verification === "ACCOUNT_UNRESOLVED") return "The Tracker receiving account could not be resolved. Resolve the account and verify its complete holders before linking.";
  }
  return HISTORICAL_BLOCKER_TEXT[blocker];
}

export const HISTORICAL_COHORT_LABELS = { all: "All funding cohorts", known_acat: "Known full or partial ACAT", evidence_needed: "Funding type not recorded", not_applicable: "Other funding method" } as const;
export type HistoricalCohort = keyof typeof HISTORICAL_COHORT_LABELS;
export const historicalCohort = (value: string): HistoricalCohort => Object.hasOwn(HISTORICAL_COHORT_LABELS, value) ? value as HistoricalCohort : "all";
export const historicalHoldScope = { archived_at: null, acat_auto_link_hold: true, acat_record_id: null, acat_transfer_id: null } as const;
export function historicalCohortWhere(cohort: Exclude<HistoricalCohort, "all">): Prisma.TransferWhereInput {
  return { ...historicalHoldScope, funding_type: cohort === "known_acat" ? { in: ["ACAT_FULL", "ACAT_PARTIAL"] }
    : cohort === "evidence_needed" ? null : { not: null, notIn: ["ACAT_FULL", "ACAT_PARTIAL"] } };
}

export function historicalFundingLane(fundingType: string | null): "known_acat" | "not_applicable" | "evidence_needed" {
  return fundingType === null ? "evidence_needed" : ["ACAT_FULL", "ACAT_PARTIAL"].includes(fundingType) ? "known_acat" : "not_applicable";
}

type HistoricalCandidateRow = { record: LinkageRecord; blocker: HistoricalAcatBlocker | null; message: string | null };
export function historicalCandidatePresentation(snapshot: LinkageSnapshot, targets: readonly AoaAcatCandidate[],
  target: AoaAcatCandidate | undefined, intent: HistoricalAcatIntent | null, options: { page?: number; selectedRecordId?: string } = {}) {
  const empty = (message: string) => ({ records: [] as HistoricalCandidateRow[], selected: undefined as HistoricalCandidateRow | undefined, total: 0, page: 1, message });
  if (!target) return empty("This AOA transfer is no longer available. Prepare a fresh review.");
  if (target.existingRecordId) return empty(HISTORICAL_BLOCKER_TEXT.already_linked);
  if (target.fundingType === null) return empty(HISTORICAL_BLOCKER_TEXT.funding_unspecified);
  if (historicalFundingLane(target.fundingType) === "not_applicable") return empty(HISTORICAL_BLOCKER_TEXT.not_acat_funding);
  if (target.archived) return empty(HISTORICAL_BLOCKER_TEXT.archived_transfer);
  if (!["DECISION", "IN_TRANSFER", "FUNDED"].includes(target.stage)) return empty(HISTORICAL_BLOCKER_TEXT.ineligible_target_stage);
  if (target.identityState !== "verified" || target.canonicalClientUserIds.length !== 1) {
    return empty(HISTORICAL_BLOCKER_TEXT[target.identityState === "conflict" ? "identity_conflict" : "missing_identity"]);
  }
  if (!intent) return empty("Prior review and unlink history could not be verified. Historical linking is blocked until that evidence is available.");
  // Same-client records are comparison leads, not matches. The policy helper
  // alone decides selectable pairs, including complete joint holders and intent.
  const related = snapshot.records.filter((record) => record.cedarRidgeUserIds.some((id) => target.canonicalClientUserIds.includes(id)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.recordId.localeCompare(b.recordId));
  if (!related.length) return empty("No Tracker records in the fresh complete snapshot share this verified client identity. Check the source records; a name match alone is not sufficient.");
  const requestedPage = Number.isFinite(options.page) ? Math.max(1, Math.floor(options.page!)) : 1;
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(related.length / 20)));
  const classify = (record: LinkageRecord): HistoricalCandidateRow => {
    // Every classification still sees the complete populations. Only display
    // work is bounded; no matching or reservation proof is truncated.
    const blocker = historicalAcatPairBlocker(snapshot, targets, target, record, intent);
    return { record, blocker, message: blocker ? historicalBlockerDescription(blocker, record) : null };
  };
  const records = related.slice((page - 1) * 20, page * 20).map(classify);
  const selected = records.find((row) => row.record.recordId === options.selectedRecordId)
    ?? (() => { const record = related.find((row) => row.recordId === options.selectedRecordId); return record ? classify(record) : undefined; })();
  return { records, selected, total: related.length, page, message: "" };
}

/** Presentation only: exact Cedar Ridge identity -> visible mirror names. Ambiguous
 * contact/name rows never become guessed display names or matching authority.
 * Raw identity keys stay on the server and are discarded from the returned DTO. */
export async function readTrackerDirectoryLabels(tx: Prisma.TransactionClient, records: readonly LinkageRecord[]): Promise<Map<string, string>> {
  const ids = [...new Set(records.flatMap((record) => record.cedarRidgeUserIds))];
  if (!ids.length || ids.length > 1000) return new Map();
  const rows = await tx.$queryRaw<Array<{ user_id: string; contact_key: string; name: string }>>(PrismaSql.sql`
    SELECT btrim(cedar_ridge_user_id) AS user_id,
      CASE WHEN sf_id ~ '^[A-Za-z0-9]{15}([A-Z0-5]{3})?$' THEN left(sf_id, 15) ELSE sf_id END AS contact_key,
      btrim(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) AS name
    FROM mirror.client WHERE btrim(cedar_ridge_user_id) IN (${PrismaSql.join(ids)})
      AND (household_id IS NULL OR sf_id <> household_id)
    ORDER BY sf_id LIMIT 1001`);
  if (rows.length > 1000) return new Map();
  const labels = new Map<string, string>();
  for (const record of records) {
    const names: string[] = [];
    let conflict = false;
    let missing = false;
    for (const userId of record.cedarRidgeUserIds) {
      const found = rows.filter((row) => row.user_id === userId);
      const contacts = new Set(found.map((row) => row.contact_key));
      const values = new Set(found.map((row) => row.name.trim()).filter(Boolean));
      if (contacts.size > 1 || values.size > 1) conflict = true;
      else if (!found.length || values.size !== 1 || [...values][0].length > 200) missing = true;
      else names.push([...values][0]);
    }
    labels.set(record.recordId, conflict ? "Client directory: conflicting entries" : missing || !names.length
      ? "Client directory: name unavailable" : `Client directory: ${names.join(" / ")}`);
  }
  return labels;
}
