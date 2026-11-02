import { describe, expect, it } from "vitest";
import { parseLegacyFeeCreditsCsv, resolveLegacyRequest, type LegacyDirectoryClient } from "@/lib/operations/legacy-import";

// Pure synthetic resolver regression: no database, credentials or fixture writes.
const draft = parseLegacyFeeCreditsCsv([
  "id,submission_date,user_role,client_user_id,fee_type,fee_amount,account_numbers,waiver_reason,created_at,status,credited_date,client_name,apex_request,submitted_by",
  "9909160001001,2026-09-14,OPERATIONS,synthetic-bridge,Wire,20.00,SYNTHETIC-ACCOUNT,Synthetic reason,2026-09-14,Rejected,,Erik Lindqvist,,Synthetic Importer",
].join("\n")).rows[0];
const client = (id: string, canonical = id): LegacyDirectoryClient => ({ sfId: id, canonicalSfId: canonical,
  householdSfId: null, canonicalHouseholdSfId: null, name: "Erik Lindqvist", cedarRidgeUserId: "synthetic-bridge" });
const account = (id: string, owner: string) => ({ id, clientSfId: owner, apexAccountNumber: "SYNTHETIC-ACCOUNT" });

describe("legacy import client identity normalization", () => {
  it.each([
    ["DEV-DUP-CONTACT-A-20260824", "DEV-DUP-CONTACT-B-20260824"],
    ["Z".repeat(15) + "A", "Z".repeat(15) + "B"],
    ["Z".repeat(15) + "AA", "Z".repeat(15) + "BB"],
  ])("keeps non-Salesforce IDs distinct: %s / %s", (first, second) => {
    expect(resolveLegacyRequest(draft, { clients: [client(first), client(second)],
      accounts: [account("synthetic-account-a", first)] })).toMatchObject({ issue: null,
      resolved: { clientSfId: first, accountIds: ["synthetic-account-a"] } });
    expect(resolveLegacyRequest(draft, { clients: [client(first), client(second)], accounts: [
      account("synthetic-account-a", first), account("synthetic-account-b", second),
    ] })).toMatchObject({ resolved: null, issue: { code: "ambiguous_match" } });
  });
  it.each([
    ["003SYN000000001", "003SYN000000001AAA"],
    ["003SYN000000001AAA", "003SYN000000001"],
    ["003syn000000001aaa", "003SYN000000001"],
  ])("preserves genuine Salesforce 15/18-character identity: %s / %s", (member, owner) => {
    expect(resolveLegacyRequest(draft, { clients: [client(member, "003SYN000000001AAA")],
      accounts: [account("synthetic-account-a", owner)] })).toMatchObject({ issue: null,
      resolved: { clientSfId: "003SYN000000001AAA", accountIds: ["synthetic-account-a"] } });
  });
  it("preserves trimming and case normalization for full opaque IDs", () => {
    expect(resolveLegacyRequest(draft, { clients: [client("DEV-DUP-CONTACT-A-20260824")],
      accounts: [account("synthetic-account-a", " dev-dup-contact-a-20260824 ")] })).toMatchObject({ issue: null,
      resolved: { clientSfId: "DEV-DUP-CONTACT-A-20260824" } });
  });
  it("does not let an opaque prefix impersonate the full account owner", () => {
    expect(resolveLegacyRequest(draft, { clients: [client("DEV-DUP-CONTACT")],
      accounts: [account("synthetic-account-a", "DEV-DUP-CONTACT-A-20260824")] })).toMatchObject({
      resolved: null, issue: { code: "no_proven_match" },
    });
  });
});
