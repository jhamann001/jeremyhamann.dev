import { describe, expect, it } from "vitest";
import {
  CONFIRM_DELETE_FEE, CONFIRM_MERGE_CUSTODIAN, CSV_HEADER, adminFailureMessage, applyMerge, applySaved,
  csvFilename, custodiansCsv, detailsPatch, feeAmountLabel, feePayload, nameFailure, playbookDraftFrom,
  playbookPatch, patchLibrarySnapshot, playbookSummary, BLANK_FEE,
} from "@/lib/data/custodian-admin-contract";
import type { CustodianProfile } from "@/lib/data/custodian-library-contract";
import { libraryFixture } from "./fixtures/custodian-library";
import { markCase } from "./acat-book-flywheel";

const base = libraryFixture.custodians[0];
const profile = (over: Partial<CustodianProfile> = {}): CustodianProfile => ({ ...base, ...over });

describe("custodian admin contract", () => {
  it("builds a playbook patch with only changed fields and blanks as null", () => {
    const draft = { ...playbookDraftFrom(base), dtcNumber: "  0443 ", signature: "   ", transferType: "", watchouts: "Confirm instructions\nUse current form" };
    expect(playbookPatch(base, draft)).toEqual({ dtcNumber: "0443", signature: null, transferType: null });
    expect(playbookPatch(base, playbookDraftFrom(base))).toEqual({});
    markCase("custodian-admin-contract", "builds a playbook patch with only changed fields and blanks as null");
  });

  it("sends paperworkOnFile and transfersToDate only when they change", () => {
    const same = playbookDraftFrom(base);
    expect(playbookPatch(base, { ...same, paperworkOnFile: true, transfersToDate: "12" }))
      .toEqual({ paperworkOnFile: true, transfersToDate: 12 });
    expect(playbookPatch(base, { ...same, transfersToDate: "" })).toEqual({ transfersToDate: null });
    expect(playbookPatch(base, { ...same, transfersToDate: "abc" })).toEqual({});
    expect(playbookPatch(profile({ paperworkOnFile: null }), { ...same, paperworkOnFile: false })).toEqual({});
    markCase("custodian-admin-contract", "sends paperworkOnFile and transfersToDate only when they change");
  });

  it("sends contact method and details together and clears both when Contact is unset", () => {
    const same = playbookDraftFrom(base);
    expect(playbookPatch(base, { ...same, contactMethod: "PHONE", contactDetails: "555-0100" }))
      .toEqual({ contactMethod: "PHONE", contactDetails: "555-0100" });
    expect(playbookPatch(base, { ...same, contactMethod: "", contactDetails: "" }))
      .toEqual({ contactMethod: null, contactDetails: null });
    expect(playbookPatch(base, { ...same, contactDetails: " ops@example.test " })).toEqual({});
    expect(playbookPatch(profile({ contactMethod: null, contactDetails: null, contactEmail: "legacy@example.test" }), playbookDraftFrom(profile({
      contactMethod: null, contactDetails: null, contactEmail: "legacy@example.test",
    })))).toEqual({});
    markCase("custodian-admin-contract", "sends contact method and details together and clears both when Contact is unset");
  });

  it("rejects a blank name on create with Name is required", () => {
    expect(nameFailure("")).toBe("Name is required");
    expect(nameFailure("   ")).toBe("Name is required");
    expect(nameFailure("x".repeat(121))).toBe("Name is too long");
    expect(nameFailure(" Betterment ")).toBeNull();
    markCase("custodian-admin-contract", "rejects a blank name on create with Name is required");
  });

  it("rejects a blank name on edit and leaves the name out of the patch", () => {
    expect(detailsPatch(base, { name: "  ", avgProcessingDays: "9" })).toEqual({ ok: false, reason: "Name is required" });
    expect(detailsPatch(base, { name: base.name, avgProcessingDays: "9" })).toEqual({ ok: true, patch: { avgProcessingDays: 9 } });
    expect(detailsPatch(base, { name: " Renamed ", avgProcessingDays: "7" })).toEqual({ ok: true, patch: { name: "Renamed" } });
    expect(detailsPatch(base, { name: base.name, avgProcessingDays: "x" })).toEqual({ ok: true, patch: {} });
    markCase("custodian-admin-contract", "rejects a blank name on edit and leaves the name out of the patch");
  });

  it("builds a fee payload with blank amount as null", () => {
    expect(feePayload({ ...BLANK_FEE, feeType: " Outgoing ACAT ", notes: " Call " })).toEqual({
      feeType: "Outgoing ACAT", accountType: "ANY", transferType: "ANY", direction: "ANY",
      amount: null, amountText: null, notes: "Call", documentation: null,
    });
    expect(feePayload({ ...BLANK_FEE, feeType: "x", amount: "75.5", direction: "IN" })).toMatchObject({ amount: 75.5, direction: "IN" });
    markCase("custodian-admin-contract", "builds a fee payload with blank amount as null");
  });

  it("builds the CSV with the tracker header and one row per fee", () => {
    const lines = custodiansCsv([base]).split("\n");
    expect(lines[0]).toBe("Custodian,Observed Avg Processing Business Days,Completed Timing Sample,Contact Email,Fee Type,Account Type,Transfer Type,Amount,Amount Text");
    expect(CSV_HEADER).toHaveLength(9);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("Example Custodian,3,8,ops@example.test,Transfer fee,IRA,FULL,0.00,Waived with qualification");
    expect(lines[2]).toBe("Example Custodian,3,8,ops@example.test,Delivery fee,ANY,ANY,,Varies");
    markCase("custodian-admin-contract", "builds the CSV with the tracker header and one row per fee");
  });

  it("writes one blank-fee row for a custodian with no fees and escapes quotes", () => {
    const lines = custodiansCsv([profile({ name: 'A "Quoted", Inc', fees: [], contactEmail: null, observedAvgProcessingBusinessDays: null })]).split("\n");
    expect(lines[1]).toBe('"A ""Quoted"", Inc",,8,,,,,,');
    expect(custodiansCsv([])).toBe(CSV_HEADER.join(","));
    markCase("custodian-admin-contract", "writes one blank-fee row for a custodian with no fees and escapes quotes");
  });

  it("names the CSV file with the UTC date", () => {
    expect(csvFilename(new Date("2026-10-13T23:30:00-04:00"))).toBe("custodians-fees-2026-10-14.csv");
    expect(csvFilename(new Date("2026-01-02T00:00:00Z"))).toBe("custodians-fees-2026-01-02.csv");
    markCase("custodian-admin-contract", "names the CSV file with the UTC date");
  });

  it("replaces a saved custodian in the shown list", () => {
    const other = profile({ id: "other", name: "Aardvark" });
    const edited = profile({ watchouts: "New" });
    expect(applySaved([base, other], edited)).toEqual([edited, other]);
    const created = profile({ id: "new", name: "Betterment" });
    expect(applySaved([other, base], created).map((c) => c.name)).toEqual(["Aardvark", "Betterment", "Example Custodian"]);
    markCase("custodian-admin-contract", "replaces a saved custodian in the shown list");
  });

  it("removes the merged duplicate and replaces the kept custodian", () => {
    const dupe = profile({ id: "dupe", name: "ETrade" });
    const kept = profile({ id: "kept", name: "E*Trade" });
    const keptAfter = profile({ id: "kept", name: "E*Trade", transfersToDate: 5 });
    expect(applyMerge([dupe, kept, base], "dupe", keptAfter).map((c) => c.id).sort()).toEqual(["kept", "synthetic-one"]);
    expect(applyMerge([dupe, kept], "dupe", keptAfter)).toEqual([keptAfter]);
    markCase("custodian-admin-contract", "removes the merged duplicate and replaces the kept custodian");
  });

  it("maps each tracker refusal to its message", () => {
    expect(adminFailureMessage(400, { error: "Fee type is required" })).toBe("Fee type is required");
    expect(adminFailureMessage(409, { error: "x".repeat(400) })).toHaveLength(300);
    expect(adminFailureMessage(401, { error: "unauthorized" })).toBe("Always On Advice could not authenticate to the tracker. Try again, or contact an administrator.");
    expect(adminFailureMessage(403, { error: "forbidden" })).toBe("You are not allowed to change custodians in the tracker.");
    expect(adminFailureMessage(404, { error: "not_found" })).toBe("Custodian editing is not available in the tracker right now.");
    expect(adminFailureMessage(404, "<html>Not found</html>")).toBe("Custodian editing is not available in the tracker right now.");
    expect(adminFailureMessage(404, { error: "Fee not found" })).toBe("This fee rule no longer exists in the tracker.");
    expect(adminFailureMessage(404, { error: "Custodian not found" })).toBe("This custodian no longer exists in the tracker.");
    expect(adminFailureMessage(404, { error: "Target custodian not found" })).toBe("This custodian no longer exists in the tracker.");
    expect(adminFailureMessage(429, null)).toBe("Too many changes — wait and try again.");
    for (const status of [500, 503, null]) expect(adminFailureMessage(status, null)).toBe("The tracker did not save this change. Try again.");
    markCase("custodian-admin-contract", "maps each tracker refusal to its message");
  });

  it("keeps the confirmation strings equal to the tracker's", () => {
    // Copied from transfer-tracker src/app/admin/custodians/[id]/page.tsx at a05de7c.
    expect(playbookSummary(profile({ transferType: null, documentationStatus: null, signature: null, letterOfAcceptance: null, medallionRequired: null }))).toBe("Custodian record + fee schedule");
    expect(CONFIRM_DELETE_FEE).toBe("Delete this fee row? This cannot be undone.");
    expect(CONFIRM_MERGE_CUSTODIAN).toBe("Merge this custodian into the selected one? Its ACAT records and attached fee schedules will be moved, and this card deleted.");
    markCase("custodian-admin-contract", "keeps the confirmation strings equal to the tracker's");
  });

  it("formats a fee amount like the tracker", () => {
    expect(feeAmountLabel({ amount: 1000, amountText: "x" })).toBe("$1000.00");
    expect(feeAmountLabel({ amount: 0, amountText: null })).toBe("$0.00");
    expect(feeAmountLabel({ amount: null, amountText: "Call contra" })).toBe("Call contra");
    expect(feeAmountLabel({ amount: null, amountText: null })).toBe("—");
    markCase("custodian-admin-contract", "formats a fee amount like the tracker");
  });

  it("patches only the library snapshot, keeps its lease and ignores a missing entry", () => {
    const entry = { until: 42, response: { scope: "s", snapshot: { view: "library", data: { custodians: [base] } } } };
    const tracking = { until: 7, response: { scope: "s", snapshot: { view: "tracking", data: {} } } };
    const patched = patchLibrarySnapshot({ library: entry, tracking } as never, (library) => ({ ...library, custodians: [] })) as never as { library: typeof entry; tracking: typeof tracking };
    expect(patched.library.until).toBe(42);
    expect(patched.library.response.snapshot.data).toEqual({ custodians: [] });
    expect(patched.tracking).toBe(tracking);
    expect(entry.response.snapshot.data).toEqual({ custodians: [base] });
    const onlyTracking = { tracking } as never;
    expect(patchLibrarySnapshot(onlyTracking, (library) => library)).toBe(onlyTracking);
    markCase("custodian-admin-contract", "patches only the library snapshot, keeps its lease and ignores a missing entry");
  });
});
