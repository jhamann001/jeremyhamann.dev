import crypto from "crypto";
import type { SchwabAccountScope, SchwabReviewedMapping } from "@/lib/schwab/review";

export const SCHWAB_SNAPSHOT_SOURCE = "schwab-s3";
export const SCHWAB_BALANCE_TOLERANCE = 0.01;

const SALESFORCE_ACCOUNT_ID_RE = /^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const SALESFORCE_CONTACT_ID_RE = /^003[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const ACCOUNT_NUMBER_RE = /^[A-Za-z0-9*-]{4,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;

export type SchwabResolutionMethod =
  | "CRM_ACCOUNT_NUMBER"
  | "OPERATIONS_REVIEWED"
  | "EXACT_CLIENT_NAME"
  | "EXACT_HOUSEHOLD_NAME"
  | "AMBIGUOUS_NAME"
  | "UNMATCHED";

export type SchwabResolutionState = "CONFIRMED" | "PROPOSED" | "REVIEW_REQUIRED" | "UNMATCHED";

export type SchwabAccountBalanceItem = {
  account_number: string;
  account_name: string;
  registration_type: string | null;
  account_type: string | null;
  account_cash: number;
  account_securities: number;
  account_aum: number;
  balance_as_of: string;
  authoritative_client_sf_id: string | null;
  authoritative_household_sf_id: string | null;
  authoritative_match_source: "CRM_ACCOUNT_NUMBER" | null;
};

export type SchwabSnapshotEnvelope = {
  source: typeof SCHWAB_SNAPSHOT_SOURCE;
  run_id: string;
  as_of_date: string;
  source_key: string;
  source_etag: string | null;
  source_sha256: string;
  expected_account_count: number;
  items: SchwabAccountBalanceItem[];
};

export type SchwabSnapshotRejectReason =
  | "item_malformed"
  | "account_number_invalid"
  | "account_number_duplicate"
  | "account_name_invalid"
  | "registration_type_invalid"
  | "account_type_invalid"
  | "balance_invalid"
  | "balance_not_reconciled"
  | "balance_as_of_invalid"
  | "balance_as_of_mixed"
  | "authoritative_match_invalid"
  | "authoritative_client_not_found"
  | "authoritative_household_not_found"
  | "authoritative_membership_mismatch"
  | "reviewed_mapping_invalid"
  | "reviewed_mapping_conflict";

export type SchwabSnapshotRejection = { index: number; reason: SchwabSnapshotRejectReason };

export type SchwabSnapshotValidation =
  | { ok: true; envelope: SchwabSnapshotEnvelope }
  | {
    ok: false;
    error:
      | "bad_request"
      | "too_large"
      | "source_invalid"
      | "snapshot_incomplete"
      | "snapshot_invalid";
    rejected: SchwabSnapshotRejection[];
  };

export type SchwabDirectoryClient = {
  sfId: string;
  householdSfId: string | null;
  name: string;
  nameEligible?: boolean;
};

export type SchwabDirectoryHousehold = { sfId: string; name: string; nameEligible?: boolean };

export type SchwabDirectory = {
  clients: SchwabDirectoryClient[];
  households: SchwabDirectoryHousehold[];
};

export type ResolvedSchwabAccount = SchwabAccountBalanceItem & {
  accountId: string;
  accountNumberLast4: string;
  clientSfId: string | null;
  householdSfId: string | null;
  candidateClientSfId: string | null;
  candidateHouseholdSfId: string | null;
  resolutionMethod: SchwabResolutionMethod;
  resolutionState: SchwabResolutionState;
  accountScope: SchwabAccountScope | "UNCLASSIFIED";
  reviewedMappingVersion: number | null;
};

export type SchwabMatchSummary = {
  authoritative: number;
  operations_reviewed: number;
  firm_operating: number;
  exact_client_name: number;
  exact_household_name: number;
  ambiguous: number;
  unmatched: number;
};

export type SchwabResolutionResult =
  | { ok: true; accounts: ResolvedSchwabAccount[]; summary: SchwabMatchSummary }
  | { ok: false; rejected: SchwabSnapshotRejection[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRealDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nullableBoundedString(value: unknown, max: number): value is string | null | undefined {
  return value == null || (typeof value === "string" && value.trim().length > 0 && value.length <= max);
}

function nullableSfId(value: unknown, pattern: RegExp): value is string | null | undefined {
  return value == null || (typeof value === "string" && pattern.test(value));
}

function normalizeAccountNumber(value: string): string {
  return value.trim().replace(/^0+(?=[0-9])/, "").toUpperCase();
}

/** Conservative identity key. It removes presentation punctuation but does not
 * drop trust/IRA/joint words or perform edit-distance matching. */
export function normalizeSchwabIdentityName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function schwabAccountId(accountNumber: string): string {
  const digest = crypto
    .createHash("sha256")
    .update(`SCHWAB\0${normalizeAccountNumber(accountNumber)}`)
    .digest("hex")
    .slice(0, 32);
  return `schw_${digest}`;
}

export function validateSchwabSnapshot(
  body: unknown,
  maxItems = 5000,
): SchwabSnapshotValidation {
  if (!isPlainObject(body)) return { ok: false, error: "bad_request", rejected: [] };
  if (
    body.source !== SCHWAB_SNAPSHOT_SOURCE ||
    typeof body.run_id !== "string" || body.run_id.trim() === "" || body.run_id.length > 256 ||
    !isRealDate(body.as_of_date) ||
    typeof body.source_key !== "string" || body.source_key.length > 1024 ||
    !nullableBoundedString(body.source_etag, 256) ||
    typeof body.source_sha256 !== "string" || !SHA256_RE.test(body.source_sha256) ||
    !Number.isInteger(body.expected_account_count) || Number(body.expected_account_count) < 1 ||
    !Array.isArray(body.items)
  ) {
    return { ok: false, error: "bad_request", rejected: [] };
  }
  if (body.items.length > maxItems) return { ok: false, error: "too_large", rejected: [] };
  if (body.items.length !== body.expected_account_count) {
    return { ok: false, error: "snapshot_incomplete", rejected: [] };
  }

  const fileMatch = /(?:^|\/)CRS(\d{8})\.RPS$/i.exec(body.source_key);
  const sourceCompact = String(body.as_of_date).replace(/-/g, "");
  if (!fileMatch || fileMatch[1] !== sourceCompact) {
    return { ok: false, error: "source_invalid", rejected: [] };
  }

  const rejected: SchwabSnapshotRejection[] = [];
  const items: SchwabAccountBalanceItem[] = [];
  const seen = new Set<string>();
  const allowed = new Set([
    "account_number", "account_name", "registration_type", "account_type",
    "account_cash", "account_securities", "account_aum", "balance_as_of",
    "authoritative_client_sf_id", "authoritative_household_sf_id",
    "authoritative_match_source",
  ]);

  body.items.forEach((raw, index) => {
    if (!isPlainObject(raw) || Object.keys(raw).some((key) => !allowed.has(key))) {
      rejected.push({ index, reason: "item_malformed" });
      return;
    }
    if (typeof raw.account_number !== "string") {
      rejected.push({ index, reason: "account_number_invalid" });
      return;
    }
    const accountNumber = normalizeAccountNumber(raw.account_number);
    if (!ACCOUNT_NUMBER_RE.test(accountNumber)) {
      rejected.push({ index, reason: "account_number_invalid" });
      return;
    }
    if (seen.has(accountNumber)) {
      rejected.push({ index, reason: "account_number_duplicate" });
      return;
    }
    seen.add(accountNumber);
    if (typeof raw.account_name !== "string" || raw.account_name.trim() === "" || raw.account_name.length > 256) {
      rejected.push({ index, reason: "account_name_invalid" });
      return;
    }
    if (!nullableBoundedString(raw.registration_type, 64)) {
      rejected.push({ index, reason: "registration_type_invalid" });
      return;
    }
    if (!nullableBoundedString(raw.account_type, 128)) {
      rejected.push({ index, reason: "account_type_invalid" });
      return;
    }
    if (![raw.account_cash, raw.account_securities, raw.account_aum].every(finiteNumber)) {
      rejected.push({ index, reason: "balance_invalid" });
      return;
    }
    const accountCash = raw.account_cash as number;
    const accountSecurities = raw.account_securities as number;
    const accountAum = raw.account_aum as number;
    if (Math.abs(accountCash + accountSecurities - accountAum) > SCHWAB_BALANCE_TOLERANCE) {
      rejected.push({ index, reason: "balance_not_reconciled" });
      return;
    }
    if (!isRealDate(raw.balance_as_of)) {
      rejected.push({ index, reason: "balance_as_of_invalid" });
      return;
    }
    if (raw.balance_as_of !== body.as_of_date) {
      rejected.push({ index, reason: "balance_as_of_mixed" });
      return;
    }
    if (!nullableSfId(raw.authoritative_client_sf_id, SALESFORCE_CONTACT_ID_RE) ||
        !nullableSfId(raw.authoritative_household_sf_id, SALESFORCE_ACCOUNT_ID_RE)) {
      rejected.push({ index, reason: "authoritative_match_invalid" });
      return;
    }
    const hasAuthority = raw.authoritative_client_sf_id != null || raw.authoritative_household_sf_id != null;
    if (hasAuthority && raw.authoritative_match_source !== "CRM_ACCOUNT_NUMBER") {
      rejected.push({ index, reason: "authoritative_match_invalid" });
      return;
    }
    if (!hasAuthority && raw.authoritative_match_source != null) {
      rejected.push({ index, reason: "authoritative_match_invalid" });
      return;
    }
    items.push({
      account_number: accountNumber,
      account_name: raw.account_name.trim().replace(/\s+/g, " "),
      registration_type: raw.registration_type == null ? null : raw.registration_type.trim(),
      account_type: raw.account_type == null ? null : raw.account_type.trim(),
      account_cash: accountCash,
      account_securities: accountSecurities,
      account_aum: accountAum,
      balance_as_of: raw.balance_as_of,
      authoritative_client_sf_id: raw.authoritative_client_sf_id ?? null,
      authoritative_household_sf_id: raw.authoritative_household_sf_id ?? null,
      authoritative_match_source: hasAuthority ? "CRM_ACCOUNT_NUMBER" : null,
    });
  });

  if (rejected.length > 0) return { ok: false, error: "snapshot_invalid", rejected };
  return {
    ok: true,
    envelope: {
      source: SCHWAB_SNAPSHOT_SOURCE,
      run_id: body.run_id,
      as_of_date: body.as_of_date,
      source_key: body.source_key,
      source_etag: body.source_etag == null ? null : body.source_etag.trim(),
      source_sha256: body.source_sha256.toLowerCase(),
      expected_account_count: Number(body.expected_account_count),
      items,
    },
  };
}

function groupedByName<T extends { name: string }>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = normalizeSchwabIdentityName(row.name);
    if (!key) continue;
    const current = grouped.get(key) ?? [];
    current.push(row);
    grouped.set(key, current);
  }
  return grouped;
}

export function resolveSchwabAccounts(
  items: readonly SchwabAccountBalanceItem[],
  directory: SchwabDirectory,
  reviewedMappings: readonly SchwabReviewedMapping[] = [],
): SchwabResolutionResult {
  const clientById = new Map(directory.clients.map((client) => [client.sfId, client]));
  const householdById = new Map(directory.households.map((household) => [household.sfId, household]));
  const clientsByName = groupedByName(directory.clients.filter((client) =>
    client.nameEligible !== false && client.householdSfId
      && householdById.get(client.householdSfId)?.nameEligible !== false
      && householdById.has(client.householdSfId)));
  const householdsByName = groupedByName(directory.households.filter((household) => household.nameEligible !== false));
  const reviewedById = new Map(reviewedMappings.map((mapping) => [mapping.accountId, mapping]));
  const accounts: ResolvedSchwabAccount[] = [];
  const rejected: SchwabSnapshotRejection[] = [];
  const summary: SchwabMatchSummary = {
    authoritative: 0,
    operations_reviewed: 0,
    firm_operating: 0,
    exact_client_name: 0,
    exact_household_name: 0,
    ambiguous: 0,
    unmatched: 0,
  };

  items.forEach((item, index) => {
    const base = {
      ...item,
      accountId: schwabAccountId(item.account_number),
      accountNumberLast4: item.account_number.slice(-4),
      accountScope: "UNCLASSIFIED" as const,
      reviewedMappingVersion: null,
    };
    const reviewed = reviewedById.get(base.accountId);
    if (reviewed) {
      const client = reviewed.clientSfId ? clientById.get(reviewed.clientSfId) : null;
      const household = reviewed.householdSfId ? householdById.get(reviewed.householdSfId) : null;
      if (reviewed.accountNumberLast4 !== base.accountNumberLast4 || reviewed.version < 1
          || (reviewed.accountScope === "CLIENT" && (!household
            || (reviewed.clientSfId && (!client || client.householdSfId !== household.sfId))))
          || (reviewed.accountScope === "FIRM_OPERATING" && (reviewed.clientSfId || reviewed.householdSfId))) {
        rejected.push({ index, reason: "reviewed_mapping_invalid" });
        return;
      }
      if (item.authoritative_match_source && (reviewed.accountScope === "FIRM_OPERATING"
          || (item.authoritative_client_sf_id && item.authoritative_client_sf_id !== reviewed.clientSfId)
          || (item.authoritative_household_sf_id && item.authoritative_household_sf_id !== reviewed.householdSfId))) {
        rejected.push({ index, reason: "reviewed_mapping_conflict" });
        return;
      }
      summary.operations_reviewed += 1;
      if (reviewed.accountScope === "FIRM_OPERATING") summary.firm_operating += 1;
      accounts.push({ ...base, clientSfId: reviewed.clientSfId, householdSfId: reviewed.householdSfId,
        candidateClientSfId: null, candidateHouseholdSfId: null,
        resolutionMethod: "OPERATIONS_REVIEWED", resolutionState: "CONFIRMED",
        accountScope: reviewed.accountScope, reviewedMappingVersion: reviewed.version });
      return;
    }
    if (item.authoritative_match_source === "CRM_ACCOUNT_NUMBER") {
      const client = item.authoritative_client_sf_id
        ? clientById.get(item.authoritative_client_sf_id)
        : null;
      const requestedHousehold = item.authoritative_household_sf_id
        ? householdById.get(item.authoritative_household_sf_id)
        : null;
      if (item.authoritative_client_sf_id && (!client || client.nameEligible === false)) {
        rejected.push({ index, reason: "authoritative_client_not_found" });
        return;
      }
      if (item.authoritative_household_sf_id && (!requestedHousehold || requestedHousehold.nameEligible === false)) {
        rejected.push({ index, reason: "authoritative_household_not_found" });
        return;
      }
      const householdSfId = item.authoritative_household_sf_id ?? client?.householdSfId ?? null;
      if (!householdSfId || !householdById.has(householdSfId)
          || householdById.get(householdSfId)?.nameEligible === false
          || (client && client.householdSfId !== householdSfId)) {
        rejected.push({ index, reason: "authoritative_membership_mismatch" });
        return;
      }
      summary.authoritative += 1;
      accounts.push({
        ...base,
        clientSfId: client?.sfId ?? null,
        householdSfId,
        candidateClientSfId: null,
        candidateHouseholdSfId: null,
        resolutionMethod: "CRM_ACCOUNT_NUMBER",
        resolutionState: "CONFIRMED",
        accountScope: "CLIENT",
      });
      return;
    }

    const key = normalizeSchwabIdentityName(item.account_name);
    const clientCandidates = clientsByName.get(key) ?? [];
    if (clientCandidates.length === 1 && clientCandidates[0]?.householdSfId) {
      const client = clientCandidates[0];
      summary.exact_client_name += 1;
      accounts.push({
        ...base,
        clientSfId: null,
        householdSfId: null,
        candidateClientSfId: client.sfId,
        candidateHouseholdSfId: client.householdSfId,
        resolutionMethod: "EXACT_CLIENT_NAME",
        resolutionState: "PROPOSED",
      });
      return;
    }
    if (clientCandidates.length > 1) {
      summary.ambiguous += 1;
      accounts.push({
        ...base,
        clientSfId: null,
        householdSfId: null,
        candidateClientSfId: null,
        candidateHouseholdSfId: null,
        resolutionMethod: "AMBIGUOUS_NAME",
        resolutionState: "REVIEW_REQUIRED",
      });
      return;
    }
    const householdCandidates = householdsByName.get(key) ?? [];
    if (householdCandidates.length === 1) {
      summary.exact_household_name += 1;
      accounts.push({
        ...base,
        clientSfId: null,
        householdSfId: null,
        candidateClientSfId: null,
        candidateHouseholdSfId: householdCandidates[0]!.sfId,
        resolutionMethod: "EXACT_HOUSEHOLD_NAME",
        resolutionState: "PROPOSED",
      });
      return;
    }
    if (householdCandidates.length > 1) {
      summary.ambiguous += 1;
      accounts.push({
        ...base,
        clientSfId: null,
        householdSfId: null,
        candidateClientSfId: null,
        candidateHouseholdSfId: null,
        resolutionMethod: "AMBIGUOUS_NAME",
        resolutionState: "REVIEW_REQUIRED",
      });
      return;
    }
    summary.unmatched += 1;
    accounts.push({
      ...base,
      clientSfId: null,
      householdSfId: null,
      candidateClientSfId: null,
      candidateHouseholdSfId: null,
      resolutionMethod: "UNMATCHED",
      resolutionState: "UNMATCHED",
    });
  });

  return rejected.length > 0 ? { ok: false, rejected } : { ok: true, accounts, summary };
}
