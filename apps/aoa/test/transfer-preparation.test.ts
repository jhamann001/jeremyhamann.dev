import { describe, expect, it } from "vitest";
import type { CustodianProfile } from "@/lib/data/custodian-library-contract";
import {
  resolveTransferPreparation,
  type PreparationContext,
} from "@/lib/transfers/transfer-preparation";
import { libraryFixture } from "./fixtures/custodian-library";

function profile(overrides: Partial<CustodianProfile> = {}): CustodianProfile {
  return { ...structuredClone(libraryFixture.custodians[0]), id: "synthetic-victory", name: "Victory Funds", transferType: "MANUAL", ...overrides };
}

function context(
  record: Partial<PreparationContext["record"]> = {},
  custodians: CustodianProfile[] = [profile()],
): PreparationContext {
  return {
    recordId: "synthetic-record-without-acat-id",
    record: { direction: "Incoming", type: "Full account transfer", accountType: "IRA", transferringContra: "Victory Funds", ...record },
    library: { schemaVersion: 1, retrievedAt: "2026-09-22T16:00:00.000Z", custodians },
  };
}

const reviewCodes = (result: ReturnType<typeof resolveTransferPreparation>) => result.reviewItems.map((item) => item.code);

describe("transfer preparation from an existing Tracker record", () => {
  it("provides a review plan with source provenance and no generation readiness", () => {
    const result = resolveTransferPreparation(context());
    expect(result.recordId).toBe("synthetic-record-without-acat-id");
    expect(result.status).toBe("REVIEW_REQUIRED");
    expect(result.custodianMatch.status).toBe("MATCHED");
    expect(result.selectedForm).toMatchObject({ template: "APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST", support: "TRACKER_AUTOMATED" });
    expect(reviewCodes(result)).toEqual(expect.arrayContaining([
      "VERIFY_SOURCE_ACCOUNT_DETAILS", "VERIFY_RECORDED_WORKFLOW", "VERIFY_CURRENT_DOCUMENTATION",
      "CONFIRM_FIXED_ASSET_INSTRUCTION", "VERIFY_RECEIVING_HOUSE_ACCOUNT",
    ]));
    expect(result.libraryRetrievedAt).toBe("2026-09-22T16:00:00.000Z");
    expect(result.ruleVersion).toContain("30f0a9efe540a69189bbae016e35119aee0a2d9f");
    expect(result.proposedTasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ owner: "CS", id: "confirm-client-instructions" }),
      expect.objectContaining({ owner: "CS", id: "prepare-paperwork" }),
      expect.objectContaining({ owner: "Operations", id: "verify-transfer-details" }),
    ]));
  });

  it("matches exact normalized names but does not infer aliases or substrings", () => {
    const normalized = resolveTransferPreparation(context({ transferringContra: "  VICTORY   funds  " }));
    expect(normalized.custodianMatch.status).toBe("MATCHED");
    const unknown = resolveTransferPreparation(context({ transferringContra: "Victory" }));
    expect(unknown.custodianMatch.status).toBe("UNKNOWN");
    expect(unknown.candidateWorkflows).toEqual([]);
    expect(unknown.selectedForm).toBeNull();
    expect(reviewCodes(unknown)).toContain("UNKNOWN_CUSTODIAN");
  });

  it("requires identity review for duplicate names and any explicit override", () => {
    const data = context({}, [profile(), profile({ id: "synthetic-second", name: " victory funds " })]);
    const ambiguous = resolveTransferPreparation(data);
    expect(ambiguous.custodianMatch.status).toBe("AMBIGUOUS");
    expect(ambiguous.custodianMatch.candidates).toHaveLength(2);
    expect(ambiguous.candidateWorkflows).toHaveLength(0);
    const chosen = resolveTransferPreparation(data, { custodianId: "synthetic-second" });
    expect(chosen.custodianMatch.status).toBe("CONFIRMATION_REQUIRED");
    expect(chosen.custodianMatch.selected?.id).toBe("synthetic-second");
    expect(reviewCodes(chosen)).toContain("CONFIRM_CUSTODIAN_SELECTION");
  });

  it("does not reuse the name match when a chosen custodian no longer exists", () => {
    const result = resolveTransferPreparation(context(), { custodianId: "removed" });
    expect(result.custodianMatch.selected).toBeNull();
    expect(result.selectedForm).toBeNull();
    expect(result.sourceRequirements).toEqual([]);
    expect(reviewCodes(result)).toContain("INVALID_CUSTODIAN_SELECTION");
  });

  it("offers both Empower routes and preserves manual preparation as a real choice", () => {
    const data = context({ transferringContra: "Empower / Pershing" }, [profile({ name: "Empower / Pershing" })]);
    const undecided = resolveTransferPreparation(data);
    expect(undecided.candidateWorkflows.map((rule) => rule.id)).toEqual(["empower-pershing", "empower-direct-rollover"]);
    expect(undecided.selectedForm).toBeNull();
    expect(reviewCodes(undecided)).toContain("SELECT_FORM_WORKFLOW");
    const manual = resolveTransferPreparation(data, { workflowId: "empower-direct-rollover" });
    expect(manual.selectedForm).toMatchObject({ support: "MANUAL_ONLY", template: "EMPOWER_WITHDRAWAL_DIRECT_ROLLOVER_TRANSFER_REQUEST" });
    expect(reviewCodes(manual)).toContain("MANUAL_FORM_WORKFLOW");
    expect(reviewCodes(manual)).not.toContain("CONFIRM_ASSET_INSTRUCTIONS");
    expect(manual.proposedTasks.find((task) => task.id === "prepare-paperwork")?.title).toContain("manual form");
  });

  it("rejects a stale or cross-custodian workflow rather than silently switching forms", () => {
    const result = resolveTransferPreparation(context(), { workflowId: "empower-pershing" });
    expect(result.candidateWorkflows).toHaveLength(1);
    expect(result.selectedWorkflow).toBeNull();
    expect(result.selectedForm).toBeNull();
    expect(reviewCodes(result)).toContain("INVALID_WORKFLOW_SELECTION");
  });

  it("keeps conditional source requirements intact and separates Acceptance from Authorization", () => {
    const custodian = profile({
      letterOfAcceptance: "Required for inherited IRA only; verify exact titles",
      medallionRequired: "Call if account title differs",
      signature: "Wet signature if manual; otherwise confirm",
      watchouts: "Confirm directly\nDo not assume eligibility",
    });
    const result = resolveTransferPreparation(context({ accountType: "Inherited IRA" }, [custodian]));
    expect(result.sourceRequirements).toEqual(expect.arrayContaining([
      { field: "letterOfAcceptance", label: "Letter of Acceptance", value: custodian.letterOfAcceptance },
      { field: "medallionRequired", label: "Medallion requirements", value: custodian.medallionRequired },
      { field: "signature", label: "Signature requirements", value: custodian.signature },
      { field: "watchouts", label: "Custodian watchouts", value: custodian.watchouts },
    ]));
    expect(result.reviewItems.find((item) => item.code === "VERIFY_INHERITED_TITLES")?.message).toContain("Letter of Acceptance is a separate requirement");
    expect(result.sourceRequirements.some((item) => item.label === "Letter of Authorization")).toBe(false);
  });

  it.each(["Partial transfer", "Partial account transfer", "PARTIAL"])("requires explicit positions and cash for %s", (type) => {
    const result = resolveTransferPreparation(context({ type, accountType: "Joint tenants in common" }));
    expect(result.scope).toBe("PARTIAL");
    expect(reviewCodes(result)).toEqual(expect.arrayContaining(["CONFIRM_PARTIAL_POSITIONS", "VERIFY_JOINT_SIGNERS"]));
    expect(result.reviewItems.find((item) => item.code === "CONFIRM_PARTIAL_POSITIONS")?.message).toContain("which will remain");
    expect(result.cautions.some((caution) => caution.includes("does not authorize moving all assets"))).toBe(true);
  });

  it.each([
    { direction: "Outgoing", expected: "OUTGOING_NOT_SUPPORTED" },
    { direction: "OUT", expected: "OUTGOING_NOT_SUPPORTED" },
    { direction: null, expected: "VERIFY_DIRECTION" },
    { direction: "Internal", expected: "VERIFY_DIRECTION" },
  ])("does not apply incoming forms when direction is $direction", ({ direction, expected }) => {
    const result = resolveTransferPreparation(context({ direction }));
    expect(result.candidateWorkflows).toEqual([]);
    expect(result.selectedForm).toBeNull();
    expect(result.proposedTasks.some((task) => task.id === "prepare-paperwork")).toBe(false);
    expect(reviewCodes(result)).toContain(expected);
  });

  it.each([null, "Unknown", "Full liquidation"])("keeps unrecognized scope %s unresolved", (type) => {
    const result = resolveTransferPreparation(context({ type }));
    expect(result.scope).toBe("UNKNOWN");
    expect(result.selectedForm).toBeNull();
    expect(reviewCodes(result)).toContain("VERIFY_TRANSFER_SCOPE");
  });

  it("accepts the Tracker machine API's IN and FULL values without broad inference", () => {
    const result = resolveTransferPreparation(context({ direction: "IN", type: "FULL" }));
    expect(result.direction).toBe("INCOMING");
    expect(result.scope).toBe("FULL");
    expect(result.selectedWorkflow?.id).toBe("victory-funds");
  });

  it.each(["MANUAL", "MIXED", "INTERNAL", "UNCONFIRMED", null])("does not invent generic paperwork for an uncataloged %s custodian", (transferType) => {
    const result = resolveTransferPreparation(context({ transferringContra: "Example Custodian" }, [profile({ name: "Example Custodian", transferType })]));
    expect(result.custodianMatch.status).toBe("MATCHED");
    expect(result.candidateWorkflows).toEqual([]);
    expect(reviewCodes(result)).toContain("NO_SUPPORTED_WORKFLOW");
  });

  it("offers standard brokerage for a verified ACAT_API profile only as a review candidate", () => {
    const data = context({ transferringContra: "Example Custodian" }, [profile({ name: "Example Custodian", transferType: "ACAT_API" })]);
    const result = resolveTransferPreparation(data);
    expect(result.candidateWorkflows).toHaveLength(1);
    expect(result.selectedWorkflow?.displayName).toContain("confirm route");
    expect(result.status).toBe("REVIEW_REQUIRED");
    expect(reviewCodes(result)).toContain("VERIFY_RECORDED_WORKFLOW");
    data.library.custodians[0].reviewStatus = "NEEDS_SETUP";
    const unverified = resolveTransferPreparation(data);
    expect(unverified.selectedForm).toBeNull();
    expect(reviewCodes(unverified)).toContain("VERIFY_CUSTODIAN_PLAYBOOK");
  });

  it("preserves the historical Acorns route caveat and does not auto-select among variants", () => {
    const data = context({ transferringContra: "Acorns" }, [profile({ name: "Acorns" })]);
    expect(resolveTransferPreparation(data).selectedForm).toBeNull();
    const result = resolveTransferPreparation(data, { workflowId: "acorns-securities-historical" });
    expect(result.cautions.some((caution) => caution.includes("Historical 2026 packets"))).toBe(true);
  });

  it("requires client instructions despite T. Rowe's historical liquidation preference", () => {
    const data = context({ transferringContra: "T. Rowe Price / Pershing" }, [profile({ name: "T. Rowe Price / Pershing" })]);
    const result = resolveTransferPreparation(data);
    expect(reviewCodes(result)).toContain("CONFIRM_ASSET_INSTRUCTIONS");
    expect(reviewCodes(result)).toContain("CONFIRM_WET_SIGNATURE");
    expect(result.cautions.some((caution) => caution.includes("despite in-kind instructions"))).toBe(true);
  });

  it("is deterministic, leaves source data unchanged and never carries an earlier match into a new record", () => {
    const data = context();
    const original = structuredClone(data);
    expect(resolveTransferPreparation(data)).toEqual(resolveTransferPreparation(data));
    expect(data).toEqual(original);
    const unrelated = context({ transferringContra: "Unknown Example Custodian" });
    unrelated.recordId = "another-synthetic-record";
    const next = resolveTransferPreparation(unrelated);
    expect(next.recordId).toBe("another-synthetic-record");
    expect(next.selectedForm).toBeNull();
    expect(next.sourceRequirements).toEqual([]);
  });
});
