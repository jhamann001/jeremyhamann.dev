// Wire definitions synchronized from Tracker linkage contract v1. Server-only.
/** Server-to-server contract. Never add these identifiers to browser DTOs. */
export const TRANSFER_LINKAGE_CONTRACT_VERSION = 1 as const;
export const TRANSFER_LINKAGE_MAX_RECORDS = 5_000;
export const TRANSFER_LINKAGE_MAX_MEMBERS_PER_ACCOUNT = 100;
export const TRANSFER_LINKAGE_MAX_MEMBERS = 20_000;

export interface LinkageSource {
  system: "transfer-tracker";
  installationId: string;
  environment: "production" | "synthetic";
}

export interface LinkageDirectory {
  snapshotId: string | null;
  publishedGeneration: number;
  health: "FRESH" | "STALE" | "UNKNOWN" | "UNAVAILABLE";
  freshnessBasis: "UPSTREAM_VERIFIED" | "FETCH_SUCCESS";
  lastSuccessAt: string | null;
  sourceAsOf: string | null;
}

export interface LinkageAccountMember {
  cedarRidgeUserId: string;
  relationshipType: string | null;
  isCurrent: boolean;
  clientEligibility: "ACTIVE" | "INACTIVE" | "UNKNOWN";
  presentInSnapshot: boolean;
}

export interface LinkageReceivingAccount {
  namespace: "cedarRidge.investment_account";
  id: string | null;
  status: string | null;
  isCurrent: boolean;
  members: LinkageAccountMember[];
  holderSetComplete: boolean;
  verification: "VERIFIED" | "MISSING_IDENTITY" | "MISSING_ACCOUNT" |
    "ACCOUNT_UNRESOLVED" | "HOLDER_MISMATCH" | "HISTORICAL" | "SOURCE_UNAVAILABLE";
}

export interface LinkageRecord {
  recordId: string;
  cedarRidgeUserIds: string[];
  identityVersion: number;
  /** Valid UUIDs only, lowercase; collisions are retained across all history. */
  acatTransferId: string | null;
  controlNumber: string | null;
  /** Canonical case-insensitive 18-character form; never lowercase a 15-char ID. */
  crmDealId: string | null;
  /** Existing create paths also fill this field from tickets/UUIDs. Not proof. */
  crmDealIdProvenance: "LEGACY_UNVERIFIED" | "ABSENT";
  direction: "IN" | "OUT" | "UNKNOWN";
  transferType: "FULL" | "PARTIAL" | "UNKNOWN";
  workflow: string;
  status: string;
  deletedAt: string | null;
  createdAt: string;
  requestDate: string | null;
  receivingAccount: LinkageReceivingAccount;
  recordEvidenceDigest: string;
  accountEvidenceDigest: string;
}

export interface LinkageSnapshot {
  contractVersion: typeof TRANSFER_LINKAGE_CONTRACT_VERSION;
  source: LinkageSource;
  scope: "ALL_RECORDS_INCLUDING_DELETED";
  complete: true;
  observedAt: string;
  recordCount: number;
  /** Full substantive candidate-set proof, not a cursor or distributed lock. */
  snapshotDigest: string;
  directory: LinkageDirectory;
  records: LinkageRecord[];
}

export interface LinkagePoint {
  contractVersion: typeof TRANSFER_LINKAGE_CONTRACT_VERSION;
  source: LinkageSource;
  scope: "RECORD";
  /** Point reads cannot prove candidate-set uniqueness. */
  complete: false;
  observedAt: string;
  directory: LinkageDirectory;
  outcome: "FOUND" | "DELETED" | "MISSING";
  record: LinkageRecord | null;
}

export const LINKAGE_ERROR_CODES = ["NOT_CONFIGURED", "DIRECTORY_UNAVAILABLE",
  "SNAPSHOT_OVERFLOW", "ACCOUNT_EVIDENCE_OVERFLOW", "SOURCE_UNAVAILABLE"] as const;
export type LinkageErrorCode = typeof LINKAGE_ERROR_CODES[number];

/** Stable, data-free detail for operator logs (ticket). Never carries a
 * payload, token, URL or identifier; the message stays the bare code. */
export const LINKAGE_ERROR_REASONS = ["auth_timeout", "auth_failed", "request_timeout", "request_failed",
  "http_status", "invalid_body", "invalid_snapshot", "wrong_source", "stale_snapshot"] as const;
export type LinkageErrorReason = typeof LINKAGE_ERROR_REASONS[number];

export class LinkageError extends Error {
  constructor(public readonly code: LinkageErrorCode, public readonly reason?: LinkageErrorReason,
    public readonly httpStatus?: number) {
    super(code);
    this.name = "LinkageError";
  }
}

export const ACAT_MATCH_RULE_VERSION = "acat-link-v1";
export const ACAT_LINK_MAX_PROOF_AGE_MS = 5 * 60 * 1_000;

/** Resolved within the same scoped transaction that authorizes a mutation. */
export interface AoaAcatCandidate {
  transferId: string;
  linkVersion: number;
  existingRecordId: string | null;
  existingTransferUuid: string | null;
  hold: boolean;
  stage: string;
  fundingType: string | null;
  archived: boolean;
  canonicalClientUserIds: string[];
  dealUserId: string | null;
  identityState: "verified" | "missing" | "conflict";
  receivingAccount: {
    namespace: "cedarRidge.investment_account";
    id: string;
    holderIds: string[];
    complete: boolean;
  } | null;
  /** Namespace equivalence and provenance must be established, not inferred. */
  transactionReference: {
    namespace: "apex-acat-transfer" | "crm.opportunity";
    value: string;
    provenance: "EXISTING_LINK" | "VERIFIED" | "LEGACY_UNVERIFIED";
  } | null;
  evidenceDigest: string;
}

export const ACAT_MATCH_REASONS = [
  "existing_link", "legacy_enrichment", "unique_transaction_match",
  "missing_identity", "identity_conflict", "incomplete_joint_evidence",
  "missing_transaction_evidence", "unverified_transaction_evidence",
  "duplicate_reference", "multiple_candidates", "manual_hold", "pair_rejected",
  "reserved_link", "ineligible_lifecycle", "no_counterpart", "source_unavailable",
  "stale_evidence", "target_changed", "source_changed", "wrong_installation",
] as const;
export type AcatMatchReason = typeof ACAT_MATCH_REASONS[number];
export type AcatMatchAction = "preserve" | "propose" | "review" | "exclude" | "no_counterpart";

export interface AcatMatchDecision {
  transferId: string | null;
  recordId: string | null;
  reason: AcatMatchReason;
  action: AcatMatchAction;
  ruleVersion: typeof ACAT_MATCH_RULE_VERSION;
  targetVersion: number | null;
  targetDigest: string | null;
  sourceRecordDigest: string | null;
  sourceAccountDigest: string | null;
  sourceCandidateSetDigest: string;
  evidenceDigest: string;
}

export interface AcatRejectedPair {
  transferId: string;
  recordId: string;
  /** Null rejects until explicit review; otherwise binds to substantive facts. */
  evidenceDigest: string | null;
}

export type AcatLinkDisposition = "PENDING" | "ACCEPT" | "REJECT" | "HOLD" | "RESUME";
export type AcatLinkOutcome = "PENDING" | "APPLIED" | "NOOP" | "CONFLICT" | "BLOCKED" | "UNDONE";
export type AcatLinkRunMode = "PREPARE" | "APPLY" | "VERIFY" | "UNDO" | "AUTOMATIC";
export type AcatLinkRunStatus = "PREPARED" | "APPLYING" | "COMPLETED" | "PARTIAL" | "BLOCKED";

export interface AcatApplicationResult {
  outcome: Exclude<AcatLinkOutcome, "PENDING">;
  decisionId: string;
  transferId: string | null;
  recordId: string | null;
  appliedVersion: number | null;
  reason: string | null;
}
