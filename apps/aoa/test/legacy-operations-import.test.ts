import { describe, expect, it } from "vitest";
import {
  LEGACY_BILLING_SOURCE,
  LEGACY_FEE_SOURCE,
  LEGACY_RECON_SOURCE,
  deterministicLegacyId,
  formatLegacyImportReport,
  legacyResolutionMatchesStored,
  mappingReviewCsv,
  parseLegacyBillingExceptionsCsv,
  parseLegacyFeeCreditsCsv,
  parseLegacyTradeReconciliationCsv,
  parseReviewedMappingsCsv,
  resolveLegacyRequest,
  type LegacyDirectoryAccount,
  type LegacyDirectoryClient,
  type LegacyReviewedMapping,
} from "@/lib/operations/legacy-import";

const feeHeader = "id,submission_date,user_role,client_user_id,fee_type,fee_amount,account_numbers,waiver_reason,created_at,status,credited_date,client_name,apex_request,submitted_by";
const billingHeader = "id,client_name,waiver_start_month,waiver_start_year,waiver_duration,waiver_reason,relevant_tickets,account_1,account_2,account_3,account_4,account_5,account_6,created_at,approval_status,approved_by,approval_date,exception_type,indefinite_duration";

function billingCsv({
  status = "Pending Approval",
  kind = "Billing Exception",
  reviewedBy = "",
  reviewedAt = "",
}: { status?: string; kind?: string; reviewedBy?: string; reviewedAt?: string } = {}) {
  return [
    billingHeader,
    `10,Sample Client,January,2026,6,Documented reason,https://example.invalid/ticket,ABC1234,,,,,,2026-01-02,${status},${reviewedBy},${reviewedAt},${kind},f`,
  ].join("\n");
}

describe("legacy Operations import", () => {
  it("preserves one fee request with multiple fee types and applies approved submitter rules", () => {
    const csv = [
      feeHeader,
      '4,2026-01-02,Operations Associate,user-00000000-0000-0000-0000-000000000001,"ACAT out,IRA Termination",125.25,"ABC1234,MTJ7126",,2026-01-02,Credited,2026-01-03,Sample Client,APEX-4,',
      "6,2026-01-04,Wealth Associate,user-00000000-0000-0000-0000-000000000002,Relationship Waiver,25.00,ABC1234,,2026-01-04,Rejected,,Second Client,REJECT-6,",
    ].join("\n");
    const parsed = parseLegacyFeeCreditsCsv(csv);
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      legacyId: "4",
      feeTypes: ["ACAT out", "IRA Termination"],
      feeAmount: "125.25",
      sourceAccountNumbers: ["ABC1234", "MTJ7126"],
      submittedByName: "the owner",
      status: "CREDITED",
    });
    expect(parsed.rows[1]).toMatchObject({
      feeTypes: ["Relationship Waiver"],
      submittedByName: "Remy Ostrander",
      status: "REJECTED",
      apexRequestId: null,
      legacyApexRequestText: "REJECT-6",
    });
  });

  it("keeps a rejected billing review identity and date null when both are absent", () => {
    const csv = [
      "id,client_name,waiver_start_month,waiver_start_year,waiver_duration,waiver_reason,relevant_tickets,account_1,account_2,account_3,account_4,account_5,account_6,created_at,approval_status,approved_by,approval_date,exception_type,indefinite_duration",
      "8,Sample Client,January,2026,6,Documented reason,,ABC1234,,,,,,2026-01-01,Rejected,,,Billing Exception,f",
      "9,Second Client,Feb,2026,,Another reason,https://example.invalid/ticket,MTJ7126,,,,,,2026-02-01,Approved,Reviewer Name,2026-02-02,Service Guarantee,t",
    ].join("\n");
    const parsed = parseLegacyBillingExceptionsCsv(csv);
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({
      status: "REJECTED",
      reviewedByName: null,
      reviewedAt: null,
      kind: "BILLING_EXCEPTION",
      waiverStart: "2026-01-01",
      waiverDurationMonths: 6,
    });
    expect(parsed.rows[1]).toMatchObject({
      status: "APPROVED",
      kind: "SERVICE_GUARANTEE",
      indefiniteDuration: true,
      waiverDurationMonths: null,
      reviewedByName: "Reviewer Name",
    });
  });

  it.each([
    ["Billing Exception", "BILLING_EXCEPTION"],
    ["Service Guarantee", "SERVICE_GUARANTEE"],
  ])("preserves Pending Approval %s requests without inventing review evidence", (kind, expectedKind) => {
    const parsed = parseLegacyBillingExceptionsCsv(billingCsv({ kind }));
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      status: "PENDING",
      kind: expectedKind,
      submittedAt: "2026-01-02T00:00:00.000Z",
      reviewedByName: null,
      reviewedAt: null,
      creditedAt: null,
      completedAt: null,
      apexRequestId: null,
      feeAmount: null,
      waiverStart: "2026-01-01",
      waiverDurationMonths: 6,
      reason: "Documented reason",
      relevantTicketRefs: ["https://example.invalid/ticket"],
      sourceAccountNumbers: ["ABC1234"],
    });
  });

  it.each(["", "Pending", "Awaiting Approval", "pending approval", "toString"])(
    "does not default an unsupported historical status %j to pending",
    (status) => {
      const parsed = parseLegacyBillingExceptionsCsv(billingCsv({ status }));
      expect(parsed.rows).toEqual([]);
      expect(parsed.issues).toContainEqual({
        source: LEGACY_BILLING_SOURCE,
        legacyId: "10",
        field: "approval_status",
        code: "unsupported_status",
      });
    },
  );

  it.each([
    { reviewedBy: "Reviewer Name", reviewedAt: "2026-01-03" },
    { reviewedBy: "Reviewer Name", reviewedAt: "" },
    { reviewedBy: "", reviewedAt: "2026-01-03" },
    { reviewedBy: "", reviewedAt: "not-a-date" },
  ])("blocks pending requests with contradictory review evidence: %j", (review) => {
    const parsed = parseLegacyBillingExceptionsCsv(billingCsv(review));
    expect(parsed.rows).toEqual([]);
    expect(parsed.issues).toContainEqual({
      source: LEGACY_BILLING_SOURCE,
      legacyId: "10",
      field: "review",
      code: "pending_has_review_metadata",
    });
  });

  it("keeps pending requests subject to the same canonical client and account checks", () => {
    const draft = parseLegacyBillingExceptionsCsv(billingCsv()).rows[0]!;
    expect(draft).toBeDefined();
    const clients: LegacyDirectoryClient[] = [{
      sfId: "003288867315530AAA",
      canonicalSfId: "003383995462795AAA",
      householdSfId: "001288867315530AAA",
      canonicalHouseholdSfId: "001288867315530AAA",
      name: "Sample Client",
      cedarRidgeUserId: null,
    }];
    const accounts: LegacyDirectoryAccount[] = [{
      id: "opaque-account-id",
      clientSfId: clients[0]!.sfId,
      apexAccountNumber: "ABC1234",
    }];
    expect(resolveLegacyRequest(draft, { clients, accounts }).resolved).toMatchObject({
      status: "PENDING",
      clientSfId: "003383995462795AAA",
      accountIds: ["opaque-account-id"],
      reviewedByName: null,
      reviewedAt: null,
    });
    expect(resolveLegacyRequest(draft, { clients, accounts: [] }).issue?.code).toBe("no_proven_match");
  });

  it("preserves same-trade-date reconciliation reruns and keeps notes at run level", () => {
    const csv = [
      "id,trade_date,run_time,total_apex,total_meridian,perfect_matches,breaks,unmatched_apex,unmatched_meridian,match_rate,Notes",
      "10,2026-07-01,7/2/2026 6:30:00 AM,71,68,68,0,3,0,95.7746,First run note",
      "11,2026-07-01,7/2/2026 7:45:00 AM,72,68,68,1,4,0,94.4444,Second run note",
    ].join("\n");
    const parsed = parseLegacyTradeReconciliationCsv(csv);
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows.map((row) => row.tradeDate)).toEqual(["2026-07-01", "2026-07-01"]);
    expect(parsed.rows[0]).toMatchObject({
      runDate: "2026-07-02",
      completedAt: "2026-07-02T10:30:00.000Z",
      runNote: "First run note",
      unmatchedApex: 3,
    });
  });

  it("encodes owner-confirmed zero-trade legacy runs 23 and 24 without missing-value blockers", () => {
    const csv = [
      "id,trade_date,run_time,total_apex,total_meridian,perfect_matches,breaks,unmatched_apex,unmatched_meridian,match_rate,Notes",
      "23,2025-12-04,12/5/2025 8:45:00 AM,0,0,0,,,,,",
      "24,2025-12-05,12/8/2025 9:00:00 AM,0,0,0,,,,,",
    ].join("\n");
    const parsed = parseLegacyTradeReconciliationCsv(csv);
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows.map((row) => ({
      legacyId: row.legacyId,
      runDate: row.runDate,
      breaks: row.exceptionCount,
      unmatchedApex: row.unmatchedApex,
      unmatchedMeridian: row.unmatchedMeridian,
      storedRate: row.rawMatchRate,
      sourceRate: row.legacyMatchRate,
    }))).toEqual([
      { legacyId: "23", runDate: "2025-12-05", breaks: 0, unmatchedApex: 0, unmatchedMeridian: 0, storedRate: "0.0000", sourceRate: "0" },
      { legacyId: "24", runDate: "2025-12-08", breaks: 0, unmatchedApex: 0, unmatchedMeridian: 0, storedRate: "0.0000", sourceRate: "0" },
    ]);
  });

  it("does not infer blank detail fields as zero for any other zero-total run", () => {
    const csv = [
      "id,trade_date,run_time,total_apex,total_meridian,perfect_matches,breaks,unmatched_apex,unmatched_meridian,match_rate,Notes",
      "25,2025-12-08,12/9/2025 9:00:00 AM,0,0,0,,,,,",
    ].join("\n");
    const parsed = parseLegacyTradeReconciliationCsv(csv);
    expect(parsed.rows).toEqual([]);
    expect(parsed.issues.map((value) => `${value.field}:${value.code}`)).toEqual([
      "breaks:invalid_count",
      "unmatched_apex:invalid_count",
      "unmatched_meridian:invalid_count",
      "match_rate:invalid_rate",
    ]);
  });

  it("requires one exact name + bridge + account-proven canonical client", () => {
    const draft = parseLegacyFeeCreditsCsv([
      feeHeader,
      "7,2026-01-02,Operations Associate,user-00000000-0000-0000-0000-000000000001,Wire,20.00,ABC1234,,2026-01-02,Rejected,,Sample Client,,",
    ].join("\n")).rows[0]!;
    const clients: LegacyDirectoryClient[] = [{
      sfId: "003288867315530AAA",
      canonicalSfId: "003383995462795AAA",
      householdSfId: "001288867315530AAA",
      canonicalHouseholdSfId: "001288867315530AAA",
      name: "Sample   Client",
      cedarRidgeUserId: "user-00000000-0000-0000-0000-000000000001",
    }];
    const accounts: LegacyDirectoryAccount[] = [{
      id: "opaque-account-id",
      clientSfId: "003288867315530AAA",
      apexAccountNumber: "ABC1234",
    }];
    expect(resolveLegacyRequest(draft, { clients, accounts })).toEqual({
      resolved: expect.objectContaining({
        clientSfId: "003383995462795AAA",
        accountIds: ["opaque-account-id"],
      }),
      issue: null,
    });
    expect(resolveLegacyRequest(draft, { clients, accounts: [] }).issue?.code).toBe("no_proven_match");
  });

  it("accepts a reviewed canonical mapping but still verifies account ownership", () => {
    const draft = parseLegacyFeeCreditsCsv([
      feeHeader,
      "24,2026-01-02,Operations Associate,user-00000000-0000-0000-0000-000000000001,Wire,20.00,ABC1234,,2026-01-02,Rejected,,Ambiguous Client,,",
    ].join("\n")).rows[0]!;
    const clients: LegacyDirectoryClient[] = [{
      sfId: "003288867315530AAA",
      canonicalSfId: "003288867315530AAA",
      householdSfId: "001288867315530AAA",
      canonicalHouseholdSfId: "001288867315530AAA",
      name: "Different Legal Name",
      cedarRidgeUserId: null,
    }];
    const accounts: LegacyDirectoryAccount[] = [{ id: "opaque", clientSfId: clients[0]!.sfId, apexAccountNumber: "ABC1234" }];
    const reviewed: LegacyReviewedMapping = {
      source: LEGACY_FEE_SOURCE,
      legacyId: "24",
      scope: "CLIENT",
      clientSfId: clients[0]!.sfId,
      householdSfId: null,
      accountIds: ["opaque"],
    };
    expect(resolveLegacyRequest(draft, { clients, accounts }, reviewed).resolved?.clientSfId).toBe(clients[0]!.sfId);
    expect(resolveLegacyRequest(draft, { clients, accounts: [] }, reviewed).issue?.code).toBe("reviewed_account_not_owned");
  });

  it("allows an explicitly reviewed request to span account owners in one canonical household", () => {
    const draft = parseLegacyBillingExceptionsCsv([
      billingHeader,
      "8,Household Source Label,January,2026,6,Documented reason,,ABC1234,MTJ7126,,,,,2026-01-01,Rejected,,,Billing Exception,f",
    ].join("\n")).rows[0]!;
    const clients: LegacyDirectoryClient[] = [
      {
        sfId: "003288867315530AAA",
        canonicalSfId: "003288867315530AAA",
        householdSfId: "001092155893454AAA",
        canonicalHouseholdSfId: "001383995462795AAA",
        name: "Synthetic One",
        cedarRidgeUserId: null,
      },
      {
        sfId: "003092155893454AAA",
        canonicalSfId: "003092155893454AAA",
        householdSfId: "001383995462795AAA",
        canonicalHouseholdSfId: "001383995462795AAA",
        name: "Synthetic Two",
        cedarRidgeUserId: null,
      },
    ];
    const accounts: LegacyDirectoryAccount[] = [
      { id: "opaque-one", clientSfId: clients[0]!.sfId, apexAccountNumber: "ABC1234" },
      { id: "opaque-two", clientSfId: clients[1]!.sfId, apexAccountNumber: "MTJ7126" },
    ];
    const reviewed: LegacyReviewedMapping = {
      source: LEGACY_BILLING_SOURCE,
      legacyId: "8",
      scope: "HOUSEHOLD",
      clientSfId: clients[0]!.sfId,
      householdSfId: "001383995462795AAA",
      accountIds: ["opaque-one", "opaque-two"],
    };
    expect(resolveLegacyRequest(draft, { clients, accounts }, reviewed)).toEqual({
      resolved: expect.objectContaining({
        scope: "HOUSEHOLD",
        clientSfId: clients[0]!.sfId,
        householdSfId: "001383995462795AAA",
        accountIds: ["opaque-one", "opaque-two"],
        clientName: "Household Source Label",
      }),
      issue: null,
    });
  });

  it("rejects cross-household accounts and any unapproved household-scoped source row", () => {
    const draft = parseLegacyBillingExceptionsCsv([
      billingHeader,
      "8,Household Source Label,January,2026,6,Documented reason,,ABC1234,MTJ7126,,,,,2026-01-01,Rejected,,,Billing Exception,f",
    ].join("\n")).rows[0]!;
    const clients: LegacyDirectoryClient[] = [
      {
        sfId: "003288867315530AAA",
        canonicalSfId: "003288867315530AAA",
        householdSfId: "001383995462795AAA",
        canonicalHouseholdSfId: "001383995462795AAA",
        name: "Synthetic One",
        cedarRidgeUserId: null,
      },
      {
        sfId: "003092155893454AAA",
        canonicalSfId: "003092155893454AAA",
        householdSfId: "001757316753719AAA",
        canonicalHouseholdSfId: "001757316753719AAA",
        name: "Synthetic Two",
        cedarRidgeUserId: null,
      },
    ];
    const accounts: LegacyDirectoryAccount[] = [
      { id: "opaque-one", clientSfId: clients[0]!.sfId, apexAccountNumber: "ABC1234" },
      { id: "opaque-two", clientSfId: clients[1]!.sfId, apexAccountNumber: "MTJ7126" },
    ];
    const mapping: LegacyReviewedMapping = {
      source: LEGACY_BILLING_SOURCE,
      legacyId: "8",
      scope: "HOUSEHOLD",
      clientSfId: clients[0]!.sfId,
      householdSfId: "001383995462795AAA",
      accountIds: ["opaque-one", "opaque-two"],
    };
    expect(resolveLegacyRequest(draft, { clients, accounts }, mapping).issue?.code).toBe("reviewed_account_not_owned");

    expect(resolveLegacyRequest({ ...draft, legacyId: "10" }, { clients, accounts }, { ...mapping, legacyId: "10" }).issue?.code)
      .toBe("household_scope_not_approved");
  });

  it("requires reviewed account IDs to exactly match the source accounts", () => {
    const draft = parseLegacyBillingExceptionsCsv([
      billingHeader,
      "8,Household Source Label,January,2026,6,Documented reason,,ABC1234,MTJ7126,,,,,2026-01-01,Rejected,,,Billing Exception,f",
    ].join("\n")).rows[0]!;
    const clients: LegacyDirectoryClient[] = [{
      sfId: "003288867315530AAA",
      canonicalSfId: "003288867315530AAA",
      householdSfId: "001383995462795AAA",
      canonicalHouseholdSfId: "001383995462795AAA",
      name: "Synthetic One",
      cedarRidgeUserId: null,
    }];
    const accounts: LegacyDirectoryAccount[] = [
      { id: "opaque-one", clientSfId: clients[0]!.sfId, apexAccountNumber: "ABC1234" },
      { id: "opaque-two", clientSfId: clients[0]!.sfId, apexAccountNumber: "MTJ7126" },
      { id: "opaque-three", clientSfId: clients[0]!.sfId, apexAccountNumber: "NPWSA712" },
    ];
    const mapping: LegacyReviewedMapping = {
      source: LEGACY_BILLING_SOURCE,
      legacyId: "8",
      scope: "HOUSEHOLD",
      clientSfId: clients[0]!.sfId,
      householdSfId: "001383995462795AAA",
      accountIds: ["opaque-one"],
    };
    expect(resolveLegacyRequest(draft, { clients, accounts }, mapping).issue?.code).toBe("reviewed_accounts_source_mismatch");
    expect(resolveLegacyRequest(draft, { clients, accounts }, {
      ...mapping,
      accountIds: ["opaque-one", "opaque-two", "opaque-three"],
    }).issue?.code).toBe("reviewed_accounts_source_mismatch");
  });

  it("detects mapping drift independently of an unchanged source digest", () => {
    const draft = parseLegacyFeeCreditsCsv([
      feeHeader,
      "24,2026-01-02,Operations Associate,user-00000000-0000-0000-0000-000000000001,Wire,20.00,ABC1234,,2026-01-02,Rejected,,Original Source Label,,",
    ].join("\n")).rows[0]!;
    const resolved = {
      ...draft,
      scope: "CLIENT" as const,
      clientSfId: "003288867315530AAA",
      householdSfId: null,
      accountIds: ["opaque-one", "opaque-two"],
    };
    expect(legacyResolutionMatchesStored(resolved, {
      scope: "CLIENT",
      clientSfId: "003288867315530",
      householdSfId: null,
      legacyClientName: "Original Source Label",
      accountIds: ["opaque-two", "opaque-one"],
    })).toBe(true);
    expect(legacyResolutionMatchesStored(resolved, {
      scope: "HOUSEHOLD",
      clientSfId: "003288867315530AAA",
      householdSfId: "001383995462795AAA",
      legacyClientName: "Original Source Label",
      accountIds: ["opaque-one", "opaque-two"],
    })).toBe(false);
    expect(legacyResolutionMatchesStored(resolved, {
      scope: "CLIENT",
      clientSfId: "003288867315530AAA",
      householdSfId: null,
      legacyClientName: "Original Source Label",
      accountIds: ["opaque-one"],
    })).toBe(false);
  });

  it("parses only approved household review mappings and keeps contact review mappings separate", () => {
    const header = "source,legacy_id,scope,client_sf_id,household_sf_id,account_ids";
    const parsed = parseReviewedMappingsCsv([
      header,
      `${LEGACY_BILLING_SOURCE},8,HOUSEHOLD,003288867315530AAA,001383995462795AAA,opaque-one|opaque-two`,
      `${LEGACY_FEE_SOURCE},24,CLIENT,003092155893454AAA,,opaque-three`,
    ].join("\n"));
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows).toEqual([
      expect.objectContaining({ source: LEGACY_BILLING_SOURCE, legacyId: "8", scope: "HOUSEHOLD" }),
      expect.objectContaining({ source: LEGACY_FEE_SOURCE, legacyId: "24", scope: "CLIENT", householdSfId: null }),
    ]);

    const rejected = parseReviewedMappingsCsv([
      header,
      `${LEGACY_FEE_SOURCE},24,HOUSEHOLD,003092155893454AAA,001383995462795AAA,opaque-three`,
    ].join("\n"));
    expect(rejected.rows).toEqual([]);
    expect(rejected.issues.map((value) => value.code)).toContain("household_scope_not_approved");
  });

  it("preserves identical source content under distinct legacy IDs", () => {
    const shared = ",2026-01-02,Operations Associate,user-00000000-0000-0000-0000-000000000001,Wire,20.00,ABC1234,,2026-01-02,Rejected,,Sample Client,,";
    const parsed = parseLegacyFeeCreditsCsv([feeHeader, `8${shared}`, `9${shared}`].join("\n"));
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows.map((row) => row.legacyId)).toEqual(["8", "9"]);
    expect(deterministicLegacyId(LEGACY_FEE_SOURCE, "8")).not.toBe(deterministicLegacyId(LEGACY_FEE_SOURCE, "9"));
  });

  it("uses a PII-free mapping template and report", () => {
    const row = parseLegacyFeeCreditsCsv([
      feeHeader,
      "7,2026-01-02,Operations Associate,user-00000000-0000-0000-0000-000000000001,Wire,20.00,ABC1234,,2026-01-02,Rejected,,Sensitive Name,,",
    ].join("\n")).rows[0]!;
    const csv = mappingReviewCsv([row]);
    expect(csv).toContain(`${LEGACY_FEE_SOURCE},7,,`);
    expect(csv).not.toContain("Sensitive Name");
    expect(csv).not.toContain("ABC1234");
    expect(parseReviewedMappingsCsv(csv).issues.map((value) => value.code)).toEqual([
      "invalid_mapping_scope",
      "invalid_client_sf_id",
    ]);

    const report = formatLegacyImportReport({
      parsed: { [LEGACY_FEE_SOURCE]: 1, [LEGACY_BILLING_SOURCE]: 0, [LEGACY_RECON_SOURCE]: 0 },
      ready: { [LEGACY_FEE_SOURCE]: 0, [LEGACY_BILLING_SOURCE]: 0, [LEGACY_RECON_SOURCE]: 0 },
      existing: { [LEGACY_FEE_SOURCE]: 0, [LEGACY_BILLING_SOURCE]: 0, [LEGACY_RECON_SOURCE]: 0 },
      issues: [{ source: LEGACY_FEE_SOURCE, legacyId: "7", field: "client_sf_id", code: "no_proven_match" }],
    });
    expect(report).toContain("fee_store_fee_credits:7:client_sf_id:no_proven_match");
    expect(report).not.toContain("Sensitive Name");
    expect(report).not.toContain("ABC1234");
  });

  it("creates stable non-PII database IDs", () => {
    expect(deterministicLegacyId(LEGACY_FEE_SOURCE, "43")).toBe(deterministicLegacyId(LEGACY_FEE_SOURCE, "43"));
    expect(deterministicLegacyId(LEGACY_FEE_SOURCE, "43")).not.toContain("43");
    expect(deterministicLegacyId(LEGACY_RECON_SOURCE, "43")).toMatch(/^[a-z0-9]{10,40}$/i);
  });

  it("keeps rejected free-text Apex context out of the 80-character request ID", () => {
    const context = "Rejected because the request needed additional custodian documentation before it could be processed.";
    const parsed = parseLegacyFeeCreditsCsv([
      feeHeader,
      `4,2026-01-02,Operations Associate,user-00000000-0000-0000-0000-000000000001,Wire,0.00,ABC1234,,2026-01-02,Rejected,,Sample Client,"${context}",`,
    ].join("\n"));
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({
      apexRequestId: null,
      legacyApexRequestText: context,
    });
  });
});
