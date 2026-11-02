import { describe, expect, it } from "vitest";
import { parseSchwabMappingCsv, validMappingBatch, validMappingShape, canReviewSchwabMappings } from "@/lib/schwab/review";
import { resolveSchwabAccounts, schwabAccountId, type SchwabAccountBalanceItem, type SchwabDirectory } from "@/lib/ingest/schwab-account-balance";

const CLIENT = "003288867315530AAA";
const OTHER = "003092155893454AAA";
const HOUSEHOLD = "001288867315530AAA";
const OTHER_HOUSEHOLD = "001092155893454AAA";
const csv = `12345678,${HOUSEHOLD},${CLIENT},CLIENT`;
const mapping = { ...parseSchwabMappingCsv(csv)![0]!, version: 1 };
const directory: SchwabDirectory = {
  clients: [
    { sfId: CLIENT, householdSfId: HOUSEHOLD, name: "Alex Example", nameEligible: false },
    { sfId: OTHER, householdSfId: OTHER_HOUSEHOLD, name: "Alex Example", nameEligible: true },
  ],
  households: [
    { sfId: HOUSEHOLD, name: "Example Household", nameEligible: false },
    { sfId: OTHER_HOUSEHOLD, name: "Example Household", nameEligible: true },
  ],
};
const item: SchwabAccountBalanceItem = {
  account_number: "12345678", account_name: "Example Revocable Trust",
  registration_type: "TR", account_type: null, account_cash: 0, account_securities: 0,
  account_aum: 0, balance_as_of: "2026-09-17", authoritative_client_sf_id: null,
  authoritative_household_sf_id: null, authoritative_match_source: null,
};

describe("reviewed Schwab crosswalk input", () => {
  it("hashes exact account numbers and returns only masked identity", () => {
    const rows = parseSchwabMappingCsv(`account_number,household_sf_id,client_sf_id,scope\n${csv}`)!;
    expect(rows[0]).toEqual({ ...mapping, version: 0 });
    expect(JSON.stringify(rows)).not.toContain("12345678");
    expect(rows[0]?.accountId).toBe(schwabAccountId("00012345678"));
  });
  it.each([
    `${csv}\n${csv}`, `1234,${HOUSEHOLD},${CLIENT},CLIENT`,
    `********5678,${HOUSEHOLD},${CLIENT},CLIENT`, `12345678,,,CLIENT`,
    `12345678,${HOUSEHOLD},,FIRM_OPERATING`, `12345678,,,CORPORATE`,
    Array(101).fill(csv).join("\n"), "",
  ])("rejects malformed or duplicate mappings without partial output", (input) => {
    expect(parseSchwabMappingCsv(input)).toBeNull();
  });
  it("allows household-only and firm mappings but not a firm-to-client link", () => {
    expect(parseSchwabMappingCsv(`12345678,${HOUSEHOLD},,CLIENT`)).not.toBeNull();
    expect(parseSchwabMappingCsv("12345678,,,FIRM_OPERATING")).not.toBeNull();
    expect(validMappingShape({ ...mapping, accountScope: "FIRM_OPERATING" })).toBe(false);
  });
  it("validates save payloads and requires Admin/Operations", () => {
    expect(validMappingBatch([mapping])).toBe(true);
    expect(validMappingBatch([mapping, mapping])).toBe(false);
    for (const invalid of [null, [], [{ ...mapping, version: -1 }], [{ ...mapping, accountNumberLast4: 5678 }]]) {
      expect(validMappingBatch(invalid)).toBe(false);
    }
    expect(canReviewSchwabMappings("OPERATIONS")).toBe(true);
    expect(canReviewSchwabMappings("ADMIN")).toBe(true);
    for (const role of ["ADVISOR", "CLIENT_SERVICE", "VIEWER", null, "INGEST"]) {
      expect(canReviewSchwabMappings(role)).toBe(false);
    }
  });
});

describe("Operations evidence stays separate from CRM evidence", () => {
  it("links an explicitly reviewed lost-stage person without picking the same-name active person", () => {
    expect(resolveSchwabAccounts([item], directory, [mapping])).toMatchObject({
      ok: true, summary: { authoritative: 0, operations_reviewed: 1, firm_operating: 0 },
      accounts: [{ clientSfId: CLIENT, householdSfId: HOUSEHOLD, account_aum: 0,
        resolutionMethod: "OPERATIONS_REVIEWED", resolutionState: "CONFIRMED", reviewedMappingVersion: 1 }],
    });
  });
  it("does not broaden automatic name matching to lost-stage records", () => {
    const result = resolveSchwabAccounts([{ ...item, account_name: "Alex Example" }], directory);
    expect(result).toMatchObject({ ok: true, accounts: [{ candidateClientSfId: OTHER, clientSfId: null }] });
  });
  it("keeps joint accounts household-only", () => {
    expect(resolveSchwabAccounts([item], directory, [{ ...mapping, clientSfId: null }]))
      .toMatchObject({ ok: true, accounts: [{ clientSfId: null, householdSfId: HOUSEHOLD, accountScope: "CLIENT" }] });
  });
  it("explicitly separates firm operating from client-owned corporations", () => {
    const firm = { ...mapping, clientSfId: null, householdSfId: null, accountScope: "FIRM_OPERATING" as const };
    expect(resolveSchwabAccounts([item], directory, [firm])).toMatchObject({
      ok: true, summary: { operations_reviewed: 1, firm_operating: 1 },
      accounts: [{ clientSfId: null, householdSfId: null, accountScope: "FIRM_OPERATING" }],
    });
    expect(resolveSchwabAccounts([{ ...item, account_name: "Example Corporation" }], directory, [mapping]))
      .toMatchObject({ ok: true, accounts: [{ accountScope: "CLIENT" }] });
  });
  it.each([
    { ...mapping, clientSfId: OTHER }, { ...mapping, householdSfId: OTHER_HOUSEHOLD },
    { ...mapping, accountNumberLast4: "9999" }, { ...mapping, version: 0 },
  ])("fails closed on changed membership or invalid reviewed evidence", (invalid) => {
    expect(resolveSchwabAccounts([item], directory, [invalid])).toEqual({
      ok: false, rejected: [{ index: 0, reason: "reviewed_mapping_invalid" }],
    });
  });
  it("fails closed if incoming CRM evidence contradicts a reviewed decision", () => {
    expect(resolveSchwabAccounts([{ ...item, authoritative_client_sf_id: OTHER,
      authoritative_household_sf_id: OTHER_HOUSEHOLD, authoritative_match_source: "CRM_ACCOUNT_NUMBER" }], directory, [mapping]))
      .toEqual({ ok: false, rejected: [{ index: 0, reason: "reviewed_mapping_conflict" }] });
  });
});
