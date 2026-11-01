import type { DirectoryFreshnessPolicy, PendingAccountPolicy } from "./client-identity-contract";

export function clientIdentityEnabled(): boolean {
  return process.env.CLIENT_IDENTITY_ENABLED === "true";
}

/** Search visibility only; retained identities keep their existing validation rules. */
export function clientSearchCrmOnly(): boolean {
  return process.env.CLIENT_SEARCH_CRM_ONLY === "true";
}

export function pendingAccountPolicy(): PendingAccountPolicy {
  return process.env.CLIENT_IDENTITY_PENDING_ACCOUNT_POLICY === "ACCOUNT_REQUIRED"
    ? "ACCOUNT_REQUIRED"
    : "PENDING_ACCOUNT_OPENING_ONLY";
}

export function allowsPendingAccount(status: string): boolean {
  return pendingAccountPolicy() === "PENDING_ACCOUNT_OPENING_ONLY" &&
    status === "PendingAccountOpening";
}

/** Jeremy accepted ongoing upstream coverage on 2026-09-25 based on the
 * existing apps. Opt in explicitly; absent/invalid settings retain strict mode. */
export function directoryFreshnessPolicy(): DirectoryFreshnessPolicy {
  return process.env.CLIENT_DIRECTORY_FRESHNESS_POLICY === "FETCH_SUCCESS"
    ? "FETCH_SUCCESS" : "UPSTREAM_VERIFIED";
}
