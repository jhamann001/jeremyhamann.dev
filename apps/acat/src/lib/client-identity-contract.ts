/** ticket wire contract v2. Browser-safe: no database or server imports. */
export const CLIENT_IDENTITY_CONTRACT_VERSION = 2 as const;
export const CLIENT_IDENTITY_MAX_CLIENTS = 10;

export type DirectoryFreshnessPolicy = "UPSTREAM_VERIFIED" | "FETCH_SUCCESS";
export type DirectoryHealth = "UNKNOWN" | "FRESH" | "STALE" | "UNAVAILABLE";
export type PendingAccountPolicy = "PENDING_ACCOUNT_OPENING_ONLY" | "ACCOUNT_REQUIRED";

export interface ClientDirectoryStatus {
  enabled: boolean;
  health: DirectoryHealth;
  writeEligible: boolean;
  pendingAccountPolicy: PendingAccountPolicy;
  lastSuccessAt: string | null;
  sourceAsOf: string | null;
  /** FETCH_SUCCESS reports cache recency; it does not attest upstream ingestion. */
  freshnessBasis?: DirectoryFreshnessPolicy;
}

export interface ClientAccountHint {
  /** Masked receiving account number; never accepted as a write identifier. */
  maskedAccountNumber: string | null;
  custodian: string;
  relationshipType: string | null;
}

export interface ClientSearchItem {
  cedarRidgeUserId: string;
  displayName: string;
  accountHints: ClientAccountHint[];
}

export interface ClientSearchRequest {
  query: string;
  limit?: number;
}

export interface ClientSearchResponse {
  items: ClientSearchItem[];
  hasMore: boolean;
  directory: ClientDirectoryStatus;
}

export interface ClientIdentityRelinkRequest {
  cedarRidgeUserIds: string[];
  expectedIdentityVersion: number;
  reason: string;
  /** Omitted preserves the current receiving account number. */
  apexAccountId?: string;
  /** False by default: historical display names are preserved. */
  replaceDisplayName?: boolean;
  acknowledgeMappingInvalidation?: boolean;
}

export const CLIENT_IDENTITY_ERROR = {
  INVALID_REQUEST: "INVALID_REQUEST",
  IDENTITY_REQUIRED: "IDENTITY_REQUIRED",
  IDENTITY_RELINK_REQUIRED: "IDENTITY_RELINK_REQUIRED",
  MAPPING_INVALIDATION_REQUIRED: "MAPPING_INVALIDATION_REQUIRED",
  CLIENT_NOT_FOUND: "CLIENT_NOT_FOUND",
  ACCOUNT_NOT_LINKED: "ACCOUNT_NOT_LINKED",
  IDENTITY_CONFLICT: "IDENTITY_CONFLICT",
  DIRECTORY_UNAVAILABLE: "DIRECTORY_UNAVAILABLE",
  DIRECTORY_STALE: "DIRECTORY_STALE",
} as const;

export type ClientIdentityErrorCode =
  (typeof CLIENT_IDENTITY_ERROR)[keyof typeof CLIENT_IDENTITY_ERROR];

export interface ClientIdentityErrorResponse {
  error: string;
  code: ClientIdentityErrorCode;
}

export const CLIENT_SEARCH_MIN_LENGTH = 2;
export const CLIENT_SEARCH_MAX_LENGTH = 120;
export const CLIENT_SEARCH_MAX_RESULTS = 20;
export const CLIENT_IDENTITY_REASON_MAX_LENGTH = 2000;
