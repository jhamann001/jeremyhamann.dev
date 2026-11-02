import { describe, expect, it } from "vitest";
import { markCase } from "./acat-book-flywheel";
import { transferFormFixture } from "./fixtures/transfer-form";
import {
  PAPERWORK_FAILURE_COPY,
  buildPaperworkRequest,
  handlingSummary,
  paperworkReadiness,
  partialCounts,
  type PaperworkDraft,
} from "@/lib/transfers/paperwork-section";
import { transferFormPreparationSchema, type TransferFormPreparation } from "@/lib/transfers/transfer-form-contract";

const SUITE = "acat-paperwork-contract";
const OPERATION = "c4b6a222-628d-4e71-951b-79c06ff00e02";
const CONFIRMATION = {
  id: "conf-1", title: "Sample Test", registration: "Individual", confirmedBy: "operator@example.test",
  confirmedAt: "2026-09-25T14:00:00.000Z", valid: true, source: "AOA" as const,
};

function prep(over: Partial<TransferFormPreparation> = {}): TransferFormPreparation {
  return { ...structuredClone(transferFormFixture), confirmation: { ...CONFIRMATION }, ...over };
}
function draft(over: Partial<PaperworkDraft> = {}): PaperworkDraft {
  return {
    workflowId: "default-brokerage", instruction: "IN_KIND", positionInstructions: {}, deliveringTitle: "Sample Test",
    houseAccount: "", houseVerified: false, letterRequired: false, reviewed: true, ...over,
  };
}
const holding = (id: string, include: boolean | null) => ({ id, symbol: id.toUpperCase(), description: `Holding ${id}`, quantity: 5, include });
const partial = (positions: TransferFormPreparation["positions"]) => prep({ scope: "PARTIAL", positions });

describe("paperwork contract", () => {
  it("tkt335 contract: the parser keeps the template when the tracker sends it", () => {
    const parsed = transferFormPreparationSchema.parse({
      ...transferFormFixture,
      workflows: [{ ...transferFormFixture.workflows[0], template: "APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST" }],
    });
    expect(parsed.workflows[0].template).toBe("APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST");
    markCase(SUITE, "tkt335 contract: the parser keeps the template when the tracker sends it");
  });

  it("tkt335 contract: the parser accepts a response without a template and adds no key", () => {
    const parsed = transferFormPreparationSchema.parse(structuredClone(transferFormFixture));
    expect(Object.keys(parsed.workflows[0])).toEqual(["id", "name", "automated", "requiresReceivingAccountNumber", "handling", "note"]);
    expect(parsed).toEqual(transferFormFixture);
    markCase(SUITE, "tkt335 contract: the parser accepts a response without a template and adds no key");
  });

  it("tkt335 contract: an unknown template value is refused", () => {
    const parsed = transferFormPreparationSchema.safeParse({
      ...transferFormFixture,
      workflows: [{ ...transferFormFixture.workflows[0], template: "SOMETHING_ELSE" }],
    });
    expect(parsed.success).toBe(false);
    markCase(SUITE, "tkt335 contract: an unknown template value is refused");
  });

  it("tkt335 contract: handling text for liquidate only, in kind only, and client-directed", () => {
    expect(handlingSummary({ handling: { mode: "FIXED", options: ["LIQUIDATE"] } })).toBe("Asset handling: Liquidate only");
    expect(handlingSummary({ handling: { mode: "FIXED", options: ["IN_KIND"] } })).toBe("Asset handling: In kind only");
    expect(handlingSummary({ handling: { mode: "CLIENT_DIRECTED", options: ["IN_KIND", "LIQUIDATE"] } }))
      .toBe("Asset handling: Client-directed — in kind or liquidate");
    markCase(SUITE, "tkt335 contract: handling text for liquidate only, in kind only, and client-directed");
  });

  it("tkt335 contract: partial counts split included, excluded, and undecided", () => {
    const data = partial([holding("a", true), holding("b", true), holding("c", false), holding("d", null)]);
    expect(partialCounts(data)).toEqual({ required: true, total: 4, included: 2, excluded: 1, undecided: 1 });
    markCase(SUITE, "tkt335 contract: partial counts split included, excluded, and undecided");
  });

  it("tkt335 contract: a full transfer reports no required partial selection", () => {
    expect(partialCounts(prep()).required).toBe(false);
    expect(partialCounts(prep({ scope: "UNKNOWN" })).required).toBe(false);
    markCase(SUITE, "tkt335 contract: a full transfer reports no required partial selection");
  });

  it("tkt335 contract: readiness names the first missing step in order", () => {
    const reason = (data: TransferFormPreparation, d: PaperworkDraft = draft()) => paperworkReadiness(data, d).reason;
    expect(reason(prep({ blockers: [{ code: "receiving_confirmation", message: "x" }, { code: "other", message: "Resolve the other blocker." }] }))).toBe("Resolve the other blocker.");
    expect(reason(prep({ confirmation: null, blockers: [{ code: "receiving_confirmation", message: "x" }] }))).toBe("Confirm and save the receiving account title first.");
    expect(reason(prep({ confirmation: { ...CONFIRMATION, valid: false } }))).toBe("Confirm and save the receiving account title first.");
    expect(reason(prep({ direction: "OUTGOING" }))).toBe("Automatic form preparation supports incoming transfers only.");
    expect(reason(prep({ scope: "UNKNOWN" }))).toBe("Confirm the transfer scope in Transfer Tracker, then refresh.");
    expect(reason(partial([holding("a", false)]))).toBe("Select at least one holding in Transfer Tracker, then refresh.");
    expect(reason(prep(), draft({ workflowId: "" }))).toBe("Choose a form workflow.");
    expect(reason(prep({ workflows: [{ ...transferFormFixture.workflows[0], automated: false }] }))).toBe("This form route needs manual preparation in Transfer Tracker.");
    expect(reason(prep(), draft({ instruction: "" }))).toBe("Choose how the assets should transfer.");
    expect(reason(prep({ workflows: [{ ...transferFormFixture.workflows[0], requiresReceivingAccountNumber: true }] }))).toBe("Verify the receiving / house account number with Apex MF Ops.");
    expect(reason(prep(), draft({ deliveringTitle: "  " }))).toBe("Enter the exact delivering account title.");
    expect(reason(prep(), draft({ reviewed: false }))).toBe("Check the final review confirmation to download the form.");
    expect(paperworkReadiness(prep(), draft())).toEqual({ ready: true, reason: "" });
    markCase(SUITE, "tkt335 contract: readiness names the first missing step in order");
  });

  it("tkt335 contract: undecided holdings make the download unavailable with the count in the reason", () => {
    const one = paperworkReadiness(partial([holding("a", true), holding("b", null)]), draft());
    expect(one).toEqual({ ready: false, reason: "Decide whether to include 1 undecided holding in Transfer Tracker, then refresh." });
    const two = paperworkReadiness(partial([holding("a", true), holding("b", null), holding("c", null)]), draft());
    expect(two).toEqual({ ready: false, reason: "Decide whether to include 2 undecided holdings in Transfer Tracker, then refresh." });
    expect(buildPaperworkRequest(partial([holding("a", true), holding("b", null)]), draft(), OPERATION)).toBeNull();
    markCase(SUITE, "tkt335 contract: undecided holdings make the download unavailable with the count in the reason");
  });

  it("tkt335 contract: a mixed packet needs both instructions on every included holding", () => {
    const data = partial([holding("a", true), holding("b", true), holding("c", false)]);
    const mixed = (positionInstructions: PaperworkDraft["positionInstructions"]) => paperworkReadiness(data, draft({ instruction: "MIXED", positionInstructions }));
    expect(mixed({ a: "IN_KIND" }).reason).toBe("Choose how the assets should transfer.");
    expect(mixed({ a: "IN_KIND", b: "IN_KIND" }).reason).toBe("Choose how the assets should transfer.");
    expect(mixed({ a: "IN_KIND", b: "LIQUIDATE" }).ready).toBe(true);
    // The excluded holding never needs an instruction; a single included holding cannot be mixed.
    expect(paperworkReadiness(partial([holding("a", true), holding("c", false)]), draft({ instruction: "MIXED", positionInstructions: { a: "IN_KIND" } })).ready).toBe(false);
    // A full transfer never offers a mix.
    expect(paperworkReadiness(prep(), draft({ instruction: "MIXED", positionInstructions: { "sample-holding": "IN_KIND" } })).ready).toBe(false);
    markCase(SUITE, "tkt335 contract: a mixed packet needs both instructions on every included holding");
  });

  it("tkt335 contract: differing inherited titles need the letter of authorization", () => {
    const inherited = prep({ inheritedTitleReview: true });
    expect(paperworkReadiness(inherited, draft({ deliveringTitle: "Other Name" })).reason)
      .toBe("Confirm the separate Letter of Authorization for the different account titles.");
    expect(paperworkReadiness(inherited, draft({ deliveringTitle: "Other Name", letterRequired: true })).ready).toBe(true);
    expect(paperworkReadiness(inherited, draft({ deliveringTitle: "  sample   TEST " })).ready).toBe(true);
    expect(paperworkReadiness(prep({ inheritedTitleReview: false }), draft({ deliveringTitle: "Other Name" })).ready).toBe(true);
    markCase(SUITE, "tkt335 contract: differing inherited titles need the letter of authorization");
  });

  it("tkt335 contract: the request carries the titles, the instruction, and the revision", () => {
    const request = buildPaperworkRequest(prep(), draft({ deliveringTitle: "  Delivering Title  " }), OPERATION);
    expect(request).toEqual({
      expectedRevision: "a".repeat(64), confirmationId: "conf-1", operationId: OPERATION, workflowId: "default-brokerage",
      assetInstruction: "IN_KIND", deliveringTitle: "Delivering Title", deliveringTitleConfirmed: true,
      accountsReviewed: true, instructionsReviewed: true, letterOfAuthorizationRequired: false,
    });
    const fixed = buildPaperworkRequest(
      prep({ workflows: [{ ...transferFormFixture.workflows[0], handling: { mode: "FIXED", options: ["LIQUIDATE"] } }] }),
      draft({ instruction: "" }), OPERATION);
    expect(fixed?.assetInstruction).toBe("LIQUIDATE");
    const house = buildPaperworkRequest(
      prep({ workflows: [{ ...transferFormFixture.workflows[0], requiresReceivingAccountNumber: true }] }),
      draft({ houseAccount: " 12345 ", houseVerified: true }), OPERATION);
    expect(house).toMatchObject({ receivingAccountNumber: "12345", receivingAccountNumberVerified: true });
    markCase(SUITE, "tkt335 contract: the request carries the titles, the instruction, and the revision");
  });

  it("tkt335 contract: the request carries per-holding instructions only for a mixed packet", () => {
    const data = partial([holding("a", true), holding("b", true), holding("c", false)]);
    const mixed = buildPaperworkRequest(data, draft({ instruction: "MIXED", positionInstructions: { a: "IN_KIND", b: "LIQUIDATE", c: "LIQUIDATE" } }), OPERATION);
    expect(mixed?.assetInstruction).toBe("MIXED");
    expect(mixed?.positionInstructions).toEqual([
      { positionId: "a", assetInstruction: "IN_KIND" }, { positionId: "b", assetInstruction: "LIQUIDATE" },
    ]);
    const single = buildPaperworkRequest(data, draft({ instruction: "LIQUIDATE" }), OPERATION);
    expect(single).not.toBeNull();
    expect(single).not.toHaveProperty("positionInstructions");
    markCase(SUITE, "tkt335 contract: the request carries per-holding instructions only for a mixed packet");
  });

  it("tkt335 contract: the request is null until the packet is ready", () => {
    expect(buildPaperworkRequest(prep(), draft({ reviewed: false }), OPERATION)).toBeNull();
    expect(buildPaperworkRequest(prep({ confirmation: null }), draft(), OPERATION)).toBeNull();
    expect(buildPaperworkRequest(prep(), draft({ workflowId: "missing" }), OPERATION)).toBeNull();
    expect(buildPaperworkRequest(prep(), draft(), "not-a-uuid")).toBeNull();
    markCase(SUITE, "tkt335 contract: the request is null until the packet is ready");
  });

  it("tkt335 contract: failure copy exists for every reason including off", () => {
    expect(Object.keys(PAPERWORK_FAILURE_COPY).sort()).toEqual(
      ["disabled", "forbidden", "invalid", "not_found", "off", "review_required", "stale", "unavailable"]);
    for (const copy of Object.values(PAPERWORK_FAILURE_COPY)) expect(copy.length).toBeGreaterThan(10);
    markCase(SUITE, "tkt335 contract: failure copy exists for every reason including off");
  });
});
