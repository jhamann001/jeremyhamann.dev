import { describe, expect, it } from "vitest";
import {
  normalizeSchwabIdentityName,
  resolveSchwabAccounts,
  schwabAccountId,
  validateSchwabSnapshot,
  type SchwabAccountBalanceItem,
  type SchwabDirectory,
} from "@/lib/ingest/schwab-account-balance";

const CLIENT = "003288867315530AAA";
const CLIENT_2 = "003092155893454AAA";
const HOUSEHOLD = "001288867315530AAA";
const HOUSEHOLD_2 = "001092155893454AAA";

function item(over: Record<string, unknown> = {}) {
  return {
    account_number: "00012345678",
    account_name: "Daniel Chen",
    registration_type: "IN",
    account_type: "INDIVIDUAL",
    account_cash: 250,
    account_securities: 750,
    account_aum: 1000,
    balance_as_of: "2026-09-15",
    authoritative_client_sf_id: null,
    authoritative_household_sf_id: null,
    authoritative_match_source: null,
    ...over,
  };
}

function payload(items: unknown[] = [item()], over: Record<string, unknown> = {}) {
  return {
    source: "schwab-s3",
    run_id: "RUN-SCHWAB-SYNTHETIC-1",
    as_of_date: "2026-09-15",
    source_key: "schwab/master=synthetic/year=2026/month=09/day=15/CRS20260915.RPS",
    source_etag: "synthetic-etag",
    source_sha256: "a".repeat(64),
    expected_account_count: items.length,
    items,
    ...over,
  };
}

const directory: SchwabDirectory = {
  clients: [{ sfId: CLIENT, householdSfId: HOUSEHOLD, name: "Daniel Chen" }],
  households: [
    { sfId: HOUSEHOLD, name: "Chen Household" },
    { sfId: HOUSEHOLD_2, name: "Analytical Engine Trust" },
  ],
};

describe("validateSchwabSnapshot", () => {
  it("accepts a complete reconciled snapshot and normalizes the account number", () => {
    const result = validateSchwabSnapshot(payload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.items[0]?.account_number).toBe("12345678");
  });

  it("rejects incomplete, duplicate, mixed-date, and non-reconciling snapshots", () => {
    expect(validateSchwabSnapshot(payload([item()], { expected_account_count: 2 })))
      .toMatchObject({ ok: false, error: "snapshot_incomplete" });
    expect(validateSchwabSnapshot(payload([item(), item()])))
      .toMatchObject({
        ok: false,
        error: "snapshot_invalid",
        rejected: [{ index: 1, reason: "account_number_duplicate" }],
      });
    expect(validateSchwabSnapshot(payload([item({ balance_as_of: "2026-09-14" })])))
      .toMatchObject({
        ok: false,
        rejected: [{ index: 0, reason: "balance_as_of_mixed" }],
      });
    expect(validateSchwabSnapshot(payload([item({ account_aum: 999 })])))
      .toMatchObject({
        ok: false,
        rejected: [{ index: 0, reason: "balance_not_reconciled" }],
      });
  });

  it("requires a dated RPS source key and a complete CRM authority tuple", () => {
    expect(validateSchwabSnapshot(payload(undefined, { source_key: "wrong.RPS" })))
      .toMatchObject({ ok: false, error: "source_invalid" });
    expect(validateSchwabSnapshot(payload([item({
      authoritative_client_sf_id: CLIENT,
      authoritative_match_source: null,
    })])))
      .toMatchObject({
        ok: false,
        rejected: [{ index: 0, reason: "authoritative_match_invalid" }],
      });
  });
});

describe("Schwab identity resolution", () => {
  function validItems(...items: unknown[]): SchwabAccountBalanceItem[] {
    const result = validateSchwabSnapshot(payload(items));
    if (!result.ok) throw new Error("invalid synthetic fixture");
    return result.envelope.items;
  }

  it("confirms an account-number crosswalk after verifying membership", () => {
    const result = resolveSchwabAccounts(validItems(item({
      authoritative_client_sf_id: CLIENT,
      authoritative_household_sf_id: HOUSEHOLD,
      authoritative_match_source: "CRM_ACCOUNT_NUMBER",
    })), directory);
    expect(result).toMatchObject({
      ok: true,
      summary: { authoritative: 1 },
      accounts: [{
        clientSfId: CLIENT,
        householdSfId: HOUSEHOLD,
        resolutionMethod: "CRM_ACCOUNT_NUMBER",
        resolutionState: "CONFIRMED",
      }],
    });
  });

  it("rejects an authoritative crosswalk that crosses households", () => {
    const result = resolveSchwabAccounts(validItems(item({
      authoritative_client_sf_id: CLIENT,
      authoritative_household_sf_id: HOUSEHOLD_2,
      authoritative_match_source: "CRM_ACCOUNT_NUMBER",
    })), directory);
    expect(result).toEqual({
      ok: false,
      rejected: [{ index: 0, reason: "authoritative_membership_mismatch" }],
    });
  });

  it("keeps exact client and household names proposed rather than silently confirmed", () => {
    const client = resolveSchwabAccounts(validItems(item()), directory);
    expect(client).toMatchObject({
      ok: true,
      summary: { exact_client_name: 1 },
      accounts: [{
        clientSfId: null,
        householdSfId: null,
        candidateClientSfId: CLIENT,
        candidateHouseholdSfId: HOUSEHOLD,
        resolutionState: "PROPOSED",
      }],
    });

    const household = resolveSchwabAccounts(validItems(item({
      account_name: "Analytical Engine Trust",
    })), directory);
    expect(household).toMatchObject({
      ok: true,
      summary: { exact_household_name: 1 },
      accounts: [{
        candidateClientSfId: null,
        candidateHouseholdSfId: HOUSEHOLD_2,
        resolutionMethod: "EXACT_HOUSEHOLD_NAME",
        resolutionState: "PROPOSED",
      }],
    });
  });

  it("does not pick one person when an exact name is duplicated", () => {
    const duplicated: SchwabDirectory = {
      ...directory,
      clients: [
        ...directory.clients,
        { sfId: CLIENT_2, householdSfId: HOUSEHOLD_2, name: "Daniel Chen" },
      ],
    };
    const result = resolveSchwabAccounts(validItems(item()), duplicated);
    expect(result).toMatchObject({
      ok: true,
      summary: { ambiguous: 1 },
      accounts: [{
        candidateClientSfId: null,
        candidateHouseholdSfId: null,
        resolutionMethod: "AMBIGUOUS_NAME",
        resolutionState: "REVIEW_REQUIRED",
      }],
    });
  });

  it("leaves a non-match unlinked", () => {
    const result = resolveSchwabAccounts(validItems(item({ account_name: "Unknown Registration" })), directory);
    expect(result).toMatchObject({
      ok: true,
      summary: { unmatched: 1 },
      accounts: [{ resolutionMethod: "UNMATCHED", resolutionState: "UNMATCHED" }],
    });
  });
});

describe("Schwab normalization and opaque ids", () => {
  it("normalizes punctuation and diacritics without fuzzy suffix removal", () => {
    expect(normalizeSchwabIdentityName("  José & Zoë, LLC  ")).toBe("jose and zoe llc");
    expect(normalizeSchwabIdentityName("Daniel Chen IRA")).not.toBe(
      normalizeSchwabIdentityName("Daniel Chen"),
    );
  });

  it("creates a stable opaque id without embedding the account number", () => {
    const id = schwabAccountId("00012345678");
    expect(id).toBe(schwabAccountId("12345678"));
    expect(id).toMatch(/^schw_[0-9a-f]{32}$/);
    expect(id).not.toContain("12345678");
  });
});
