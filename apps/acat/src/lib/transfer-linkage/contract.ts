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

export type LinkageErrorCode = "NOT_CONFIGURED" | "DIRECTORY_UNAVAILABLE" |
  "SNAPSHOT_OVERFLOW" | "ACCOUNT_EVIDENCE_OVERFLOW" | "SOURCE_UNAVAILABLE";

export class LinkageError extends Error {
  constructor(public readonly code: LinkageErrorCode) {
    super(code);
    this.name = "LinkageError";
  }
}
