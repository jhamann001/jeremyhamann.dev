import { afterEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";
import {
  ACAT_DRAWER_BLANK,
  ACAT_DRAWER_DATE,
  ACAT_DRAWER_MASKED,
  ACAT_DRAWER_REASON_SHORT,
  ACAT_WRITE_UNAVAILABLE,
  ACCOUNT_FIELDS,
  DATE_FIELDS,
  DRAWER_FIELD_KEYS,
  DRAWER_STATUS_OPTIONS,
  REJECTION_FIELD,
  TICKET_FIELDS,
  TRADE_REQUEST_FIELDS,
  TRANSFER_FIELDS,
  buildChangeRequest,
  buildCompleteRequest,
  buildDeleteRequest,
  buildRejectRequest,
  buildReplaceRequest,
  drawerFailureFrom,
  drawerStats,
  drawerStatusOptions,
  dtccSuggestionFrom,
  finalizeFeeLabel,
  finalizeReconLabel,
  formatDrawerDate,
  mapDrawerTransfer,
  neighbours,
  parseClientSearch,
  ticketFields,
  type DrawerTransfer,
} from "@/lib/data/acat-drawer-contract";
import {
  acatTransferDrawerEnabled,
  epicAcatTransferDrawerEnabled,
  showAcatTransferDrawerEnabled,
} from "@/lib/flags";

const SUITE = "acat-transfer-drawer-contract";
const BOOK_EPIC = "EPIC_ACAT_OPS_WORKSPACE_TKT290";
const BOOK_SHOW = "SHOW_ACAT_OPS_BOOK_TKT293";
const EPIC = "EPIC_ACAT_TRANSFER_DRAWER_TKT319";
const SHOW = "SHOW_ACAT_TRANSFER_DRAWER_TKT332";
const USER = "user-11111111-1111-1111-1111-111111111111";

afterEach(() => { vi.unstubAllEnvs(); });

function done(name: string) { markCase(SUITE, name); }

function raw(over: Record<string, unknown> = {}) {
  return {
    id: "rec-1",
    identityVersion: 4,
    clientName: "Pat Example",
    status: "Submitted",
    controlNumber: "CTRL-9",
    acatTransferId: "ACAT-1",
    direction: "In",
    type: "Full",
    accountType: "Traditional IRA",
    wealthAdvisor: "Rachel",
    notes: "Call back",
    transferWorkflow: "ACAT",
    dtccNumber: "0443",
    apexAccountId: "****1111",
    statementAccountNumber: "****2222",
    statementAmount: 123456,
    acatDate: "2026-10-01",
    assets: [{ mapStatus: "Mapped" }, { mapStatus: "Expected" }, { mapStatus: "Unmapped" }, { mapStatus: "Pending" }],
    ...over,
  };
}

function transfer(over: Record<string, unknown> = {}): DrawerTransfer {
  const mapped = mapDrawerTransfer(raw(over));
  if (!mapped) throw new Error("fixture must map");
  return mapped;
}

describe("transfer drawer contract", () => {
  it("tkt332 flags: drawer is off when every switch is unset", () => {
    expect(epicAcatTransferDrawerEnabled()).toBe(false);
    expect(showAcatTransferDrawerEnabled()).toBe(false);
    expect(acatTransferDrawerEnabled()).toBe(false);
    done("tkt332 flags: drawer is off when every switch is unset");
  });

  it("tkt332 flags: drawer is off unless the book, epic, and show switches are exactly 1", () => {
    const base = { [BOOK_EPIC]: "1", [BOOK_SHOW]: "1", [EPIC]: "1", [SHOW]: "1" };
    for (const key of Object.keys(base)) {
      for (const bad of ["", "0", "true", "yes", "2", " 1"]) {
        vi.unstubAllEnvs();
        for (const [k, v] of Object.entries(base)) vi.stubEnv(k, k === key ? bad : v);
        expect(acatTransferDrawerEnabled()).toBe(false);
      }
    }
    done("tkt332 flags: drawer is off unless the book, epic, and show switches are exactly 1");
  });

  it("tkt332 flags: drawer is on only when the book, epic, and show switches are all exactly 1", () => {
    vi.stubEnv(BOOK_EPIC, "1");
    vi.stubEnv(BOOK_SHOW, "1");
    vi.stubEnv(EPIC, "1");
    expect(acatTransferDrawerEnabled()).toBe(false);
    vi.stubEnv(SHOW, "1");
    expect(acatTransferDrawerEnabled()).toBe(true);
    done("tkt332 flags: drawer is on only when the book, epic, and show switches are all exactly 1");
  });

  it("tkt332 contract: status options are the 17 tracker picker statuses in tracker order with tracker labels", () => {
    expect(DRAWER_STATUS_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ["WaitingForApex", "Waiting for Apex"],
      ["PendingAccountOpening", "Pending Account Opening"],
      ["WaitingOnClient", "Waiting on Client"],
      ["WaitingForStatement", "Waiting for Statement"],
      ["AcatReceived", "ACAT Received"],
      ["ToCome", "To Come"],
      ["Submitted", "Submitted"],
      ["PendingReview", "Pending Review"],
      ["PendingContraResponse", "Pending Contra Response"],
      ["Accepted", "Accepted"],
      ["PendingSettlement", "Pending Settlement"],
      ["PendingBookkeeping", "Pending Bookkeeping"],
      ["Completed", "Completed"],
      ["Rejected", "Rejected"],
      ["Purged", "Purged"],
      ["Canceled", "Canceled"],
      ["Deferred", "Deferred"],
    ]);
    expect(drawerStatusOptions("Submitted")).toHaveLength(17);
    done("tkt332 contract: status options are the 17 tracker picker statuses in tracker order with tracker labels");
  });

  it("tkt332 contract: a legacy recon status is offered first with the legacy suffix", () => {
    expect(drawerStatusOptions("Matched")[0]).toEqual({ value: "Matched", label: "Recon: Matched (legacy)" });
    expect(drawerStatusOptions("Mismatch")[0].label).toBe("Recon: Mismatch (legacy)");
    expect(drawerStatusOptions("Pending")[0].label).toBe("Recon: Pending (legacy)");
    expect(drawerStatusOptions("Matched")).toHaveLength(18);
    expect(drawerStatusOptions(null)).toHaveLength(17);
    done("tkt332 contract: a legacy recon status is offered first with the legacy suffix");
  });

  it("tkt332 contract: detail groups keep the tracker field order, labels, and types", () => {
    const shape = (fields: readonly { key: string; label: string; type: string }[]) =>
      fields.map((f) => [f.key, f.label, f.type]);
    expect(shape(TRANSFER_FIELDS)).toEqual([
      ["controlNumber", "Control #", "text"],
      ["associatedControlNumber", "Associated Control #", "text"],
      ["acatTransferId", "ACAT Transfer ID", "text"],
      ["transferWorkflow", "Transfer Workflow", "select"],
      ["direction", "Direction", "select"],
      ["type", "Type", "select"],
      ["accountType", "Account Type", "select"],
      ["methodRequested", "Request Method", "multiselect"],
      ["wealthAdvisor", "Advisor", "select"],
      ["crwEe", "CRW EE?", "select"],
    ]);
    expect(shape(ACCOUNT_FIELDS)).toEqual([
      ["apexAccountId", "Apex Account #", "text"],
      ["statementAccountNumber", "Statement Account #", "text"],
      ["transferringContra", "Transferring Contra", "contra"],
      ["dtccNumber", "DTCC #", "text"],
      ["statementAmount", "Statement Amount", "text"],
    ]);
    expect(shape(DATE_FIELDS).map((f) => f[0])).toEqual([
      "originalClientRequestDate", "opsSubmissionDateToApex", "apexCompletionDate",
      "residualMonitoringRequired", "residualFollowUpDate",
    ]);
    expect(shape(TICKET_FIELDS).map((f) => f[1])).toEqual([
      "CRM Ticket", "CRM Deal ID", "Apex Ticket", "Additional Resources",
    ]);
    expect(shape(TRADE_REQUEST_FIELDS)).toEqual([
      ["tradeInstructions", "Trade Instructions", "textarea"],
      ["tradeRequestId", "Trade Request ID", "text"],
      ["tradeRequestUrl", "Trade Request Link", "text"],
    ]);
    expect(TRANSFER_FIELDS[3].options?.map((o) => o.label)).toEqual(["ACAT (API)", "Manual", "DRS", "Residual", "Unclassified"]);
    expect(TRANSFER_FIELDS[6].options).toHaveLength(9);
    expect(TRANSFER_FIELDS[7].options?.map((o) => o.value)).toEqual([
      "API", "Full Docusign", "Partial Docusign", "Non-ACAT Transfer (Manual)", "N/A",
    ]);
    expect(TRANSFER_FIELDS[8].options?.map((o) => o.value)).toEqual(["Rachel", "None"]);
    expect(DATE_FIELDS[3].options).toEqual([{ value: "true", label: "Yes" }, { value: "false", label: "No" }]);
    expect(ticketFields("Rejected").at(-1)).toBe(REJECTION_FIELD);
    expect(ticketFields("Submitted")).toBe(TICKET_FIELDS);
    done("tkt332 contract: detail groups keep the tracker field order, labels, and types");
  });

  it("tkt332 contract: every detail field except Control # and Trade Instructions is a tracker drawer field", () => {
    expect(DRAWER_FIELD_KEYS).toHaveLength(26);
    const all = [...TRANSFER_FIELDS, ...ACCOUNT_FIELDS, ...DATE_FIELDS, ...TICKET_FIELDS, REJECTION_FIELD, ...TRADE_REQUEST_FIELDS];
    const outside = all.filter((f) => !(DRAWER_FIELD_KEYS as readonly string[]).includes(f.key)).map((f) => f.key);
    expect(outside).toEqual(["controlNumber", "tradeInstructions"]);
    expect(all.filter((f) => f.route === "general").map((f) => f.key)).toEqual(["controlNumber", "tradeInstructions"]);
    expect(all).toHaveLength(28);
    done("tkt332 contract: every detail field except Control # and Trade Instructions is a tracker drawer field");
  });

  it("tkt332 contract: stats count Mapped and Expected as matched and Unmapped as issues", () => {
    const stats = drawerStats(transfer(), Date.parse("2026-10-01T12:00:00Z"));
    expect(stats.totalAssets).toBe(4);
    expect(stats.matched).toBe(2);
    expect(stats.issues).toBe(1);
    done("tkt332 contract: stats count Mapped and Expected as matched and Unmapped as issues");
  });

  it("tkt332 contract: days since initiation floors whole days from the ACAT date", () => {
    const t = transfer({ acatDate: "2026-10-01" });
    expect(drawerStats(t, Date.parse("2026-10-01T00:00:00Z") + 86400000 * 7 + 3600000).daysSince).toBe(7);
    expect(drawerStats(t, Date.parse("2026-10-01T00:00:00Z") + 86400000 * 8).daysSince).toBe(8);
    expect(drawerStats(transfer({ acatDate: null }), Date.now()).daysSince).toBeNull();
    done("tkt332 contract: days since initiation floors whole days from the ACAT date");
  });

  it("tkt332 contract: maps the tracker projection and keeps the unmasked DTCC and masked account numbers as received", () => {
    const t = transfer({ unexpectedKey: "ignored" });
    expect(t.id).toBe("rec-1");
    expect(t.identityVersion).toBe(4);
    expect(t.dtccNumber).toBe("0443");
    expect(t.apexAccountId).toBe("****1111");
    expect(t.statementAccountNumber).toBe("****2222");
    expect(t.statementAmount).toBe(123456);
    expect(t.assets).toHaveLength(4);
    expect("unexpectedKey" in t).toBe(false);
    expect(transfer({ identityVersion: 1.5 }).identityVersion).toBeNull();
    expect(transfer({ statementAmount: 12.5 }).statementAmount).toBeNull();
    expect(transfer({ residualMonitoringRequired: true }).residualMonitoringRequired).toBe(true);
    done("tkt332 contract: maps the tracker projection and keeps the unmasked DTCC and masked account numbers as received");
  });

  it("tkt332 contract: a payload without an id maps to nothing", () => {
    expect(mapDrawerTransfer(null)).toBeNull();
    expect(mapDrawerTransfer({})).toBeNull();
    expect(mapDrawerTransfer({ id: "  " })).toBeNull();
    expect(mapDrawerTransfer({ id: 7 })).toBeNull();
    done("tkt332 contract: a payload without an id maps to nothing");
  });

  it("tkt332 contract: neighbours follow the given order and stop at both ends", () => {
    const ids = ["a", "b", "c"];
    expect(neighbours(ids, "a")).toEqual({ index: 0, total: 3, previous: null, next: "b" });
    expect(neighbours(ids, "b")).toEqual({ index: 1, total: 3, previous: "a", next: "c" });
    expect(neighbours(ids, "c")).toEqual({ index: 2, total: 3, previous: "b", next: null });
    expect(neighbours(ids, "z")).toEqual({ index: -1, total: 3, previous: null, next: null });
    done("tkt332 contract: neighbours follow the given order and stop at both ends");
  });

  it("tkt332 contract: statement amount parses dollars to signed cents and refuses text", () => {
    const inbound = buildChangeRequest("statementAmount", "$1,234.50", { direction: "In" });
    expect(inbound).toEqual({ ok: true, body: { action: "change", field: "statementAmount", value: 123450 } });
    const outbound = buildChangeRequest("statementAmount", "1234.5", { direction: "Out" });
    expect(outbound).toEqual({ ok: true, body: { action: "change", field: "statementAmount", value: -123450 } });
    expect(buildChangeRequest("statementAmount", "about ten", { direction: "In" })).toEqual({
      ok: false, reason: "Invalid Statement Amount",
    });
    done("tkt332 contract: statement amount parses dollars to signed cents and refuses text");
  });

  it("tkt332 contract: refuses blank values, masked placeholders, and invalid dates before any call", () => {
    expect(buildChangeRequest("direction", "   ")).toEqual({ ok: false, reason: ACAT_DRAWER_BLANK });
    expect(buildChangeRequest("apexAccountId", "****1111")).toEqual({ ok: false, reason: ACAT_DRAWER_MASKED });
    expect(buildChangeRequest("statementAccountNumber", "•••• 2222")).toEqual({ ok: false, reason: ACAT_DRAWER_MASKED });
    expect(buildChangeRequest("dtccNumber", "*443")).toEqual({ ok: false, reason: ACAT_DRAWER_MASKED });
    expect(buildChangeRequest("apexCompletionDate", "10/12/2026")).toEqual({ ok: false, reason: ACAT_DRAWER_DATE });
    expect(buildChangeRequest("residualFollowUpDate", "2026-13")).toEqual({ ok: false, reason: ACAT_DRAWER_DATE });
    expect(buildChangeRequest("notes", "hello").ok).toBe(false);
    expect(buildChangeRequest("controlNumber", "CTRL-1").ok).toBe(false);
    expect(buildChangeRequest("dtccNumber", "0443").ok).toBe(true);
    done("tkt332 contract: refuses blank values, masked placeholders, and invalid dates before any call");
  });

  it("tkt332 contract: builds the exact tracker request body for each action", () => {
    expect(buildChangeRequest("apexAccountId", " 12345678 ", { identityVersion: 4 })).toEqual({
      ok: true, body: { action: "change", field: "apexAccountId", value: "12345678", expectedIdentityVersion: 4 },
    });
    expect(buildChangeRequest("acatTransferId", "ACAT-9", { identityVersion: 0 })).toEqual({
      ok: true, body: { action: "change", field: "acatTransferId", value: "ACAT-9", expectedIdentityVersion: 0 },
    });
    expect(buildChangeRequest("direction", "Out", { identityVersion: 4 })).toEqual({
      ok: true, body: { action: "change", field: "direction", value: "Out" },
    });
    expect(buildChangeRequest("residualMonitoringRequired", "true")).toEqual({
      ok: true, body: { action: "change", field: "residualMonitoringRequired", value: true },
    });
    expect(buildCompleteRequest({ apexCompletionDate: "2026-10-12", controlNumber: " CTRL-9 " })).toEqual({
      ok: true, body: { action: "complete", apexCompletionDate: "2026-10-12", controlNumber: "CTRL-9" },
    });
    expect(buildCompleteRequest({ apexCompletionDate: "2026-10-12", controlNumber: " " })).toEqual({
      ok: true, body: { action: "complete", apexCompletionDate: "2026-10-12", controlNumber: null },
    });
    expect(buildCompleteRequest({ apexCompletionDate: "", controlNumber: "x" }).ok).toBe(false);
    expect(buildRejectRequest("  Wrong custodian ")).toEqual({ ok: true, body: { action: "reject", reason: "Wrong custodian" } });
    expect(buildRejectRequest("   ")).toEqual({ ok: false, reason: "A rejection reason is required" });
    expect(buildDeleteRequest(" Wrong client ")).toEqual({ ok: true, body: { reason: "Wrong client" } });
    const relink = buildReplaceRequest({
      cedarRidgeUserIds: [USER], expectedIdentityVersion: 4, reason: " Name fixed ",
      apexAccountId: "", acknowledgeMappingInvalidation: false,
    });
    expect(relink).toEqual({
      ok: true,
      body: { action: "replaceClient", relink: { cedarRidgeUserIds: [USER], expectedIdentityVersion: 4, reason: "Name fixed", replaceDisplayName: true } },
    });
    const acknowledged = buildReplaceRequest({
      cedarRidgeUserIds: [USER], expectedIdentityVersion: 4, reason: "Name fixed",
      apexAccountId: "12345678", acknowledgeMappingInvalidation: true,
    });
    expect(acknowledged.ok && acknowledged.body.relink).toEqual({
      cedarRidgeUserIds: [USER], expectedIdentityVersion: 4, reason: "Name fixed", replaceDisplayName: true,
      apexAccountId: "12345678", acknowledgeMappingInvalidation: true,
    });
    expect(buildReplaceRequest({ cedarRidgeUserIds: [USER, USER], expectedIdentityVersion: 4, reason: "r", apexAccountId: "", acknowledgeMappingInvalidation: false }).ok).toBe(false);
    expect(buildReplaceRequest({ cedarRidgeUserIds: ["user-bad"], expectedIdentityVersion: 4, reason: "r", apexAccountId: "", acknowledgeMappingInvalidation: false }).ok).toBe(false);
    expect(buildReplaceRequest({ cedarRidgeUserIds: [USER], expectedIdentityVersion: null, reason: "r", apexAccountId: "", acknowledgeMappingInvalidation: false }).ok).toBe(false);
    expect(buildReplaceRequest({ cedarRidgeUserIds: [USER], expectedIdentityVersion: 4, reason: "r", apexAccountId: "****1", acknowledgeMappingInvalidation: false })).toEqual({ ok: false, reason: ACAT_DRAWER_MASKED });
    done("tkt332 contract: builds the exact tracker request body for each action");
  });

  it("tkt332 contract: tracker refusals become messages and no answer becomes a retryable failure", () => {
    const current = raw({ status: "Submitted" });
    expect(drawerFailureFrom(400, { error: "Reason is required", code: "BAD", transfer: current })).toMatchObject({
      ok: false, reason: "Reason is required", retryable: false, code: "BAD", current: { id: "rec-1" },
    });
    expect(drawerFailureFrom(409, { error: "Client details changed", code: "IDENTITY_CONFLICT" })).toMatchObject({
      reason: "Client details changed", retryable: false, code: "IDENTITY_CONFLICT",
    });
    expect(drawerFailureFrom(401, {})).toMatchObject({ reason: "AoA is not allowed to change transfers in the tracker.", retryable: false });
    expect(drawerFailureFrom(404, {}).reason).toBe("This transfer no longer exists in the tracker.");
    expect(drawerFailureFrom(429, {})).toMatchObject({ retryable: true });
    expect(drawerFailureFrom(500, { error: "internal_error" })).toMatchObject({ reason: ACAT_WRITE_UNAVAILABLE, retryable: true });
    expect(drawerFailureFrom(null, null)).toMatchObject({ reason: ACAT_WRITE_UNAVAILABLE, retryable: true });
    done("tkt332 contract: tracker refusals become messages and no answer becomes a retryable failure");
  });

  it("tkt332 contract: client search keeps only selectable clients", () => {
    const parsed = parseClientSearch({
      items: [
        { cedarRidgeUserId: USER, displayName: " Pat Example ", accountHints: [{ custodian: "Apex", maskedAccountNumber: "****1111", relationshipType: "Owner" }] },
        { cedarRidgeUserId: "not-a-user", displayName: "Nope" },
        { cedarRidgeUserId: USER.replace("1111", "2222"), displayName: "  " },
      ],
      hasMore: true,
      directory: { writeEligible: true, enabled: true, health: "FRESH", pendingAccountPolicy: "ACCOUNT_REQUIRED" },
    });
    expect(parsed.clients).toEqual([{
      cedarRidgeUserId: USER, displayName: "Pat Example",
      accountHints: [{ custodian: "Apex", maskedAccountNumber: "****1111", relationshipType: "Owner" }],
    }]);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.directory?.health).toBe("FRESH");
    expect(parseClientSearch({ items: "x", directory: { health: 1 } })).toEqual({ clients: [], hasMore: false, directory: null });
    done("tkt332 contract: client search keeps only selectable clients");
  });

  it("tkt332 contract: the DTCC suggestion offers a number only when suggested", () => {
    expect(dtccSuggestionFrom({ status: "suggested", dtccNumber: "0443" })).toEqual({ status: "suggested", dtccNumber: "0443" });
    expect(dtccSuggestionFrom({ status: "suggested", dtccNumber: " " })).toEqual({ status: "suggested", dtccNumber: null });
    expect(dtccSuggestionFrom({ status: "ambiguous", dtccNumber: "0443" })).toEqual({ status: "ambiguous", dtccNumber: null });
    expect(dtccSuggestionFrom({ status: "insufficient", dtccNumber: "0443" }).dtccNumber).toBeNull();
    expect(dtccSuggestionFrom({ status: "weird", dtccNumber: "0443" })).toEqual({ status: "none", dtccNumber: null });
    expect(dtccSuggestionFrom(null)).toEqual({ status: "none", dtccNumber: null });
    done("tkt332 contract: the DTCC suggestion offers a number only when suggested");
  });

  it("tkt332 contract: modal, field, and delete reasons follow the tracker minimums", () => {
    expect(buildDeleteRequest("ab")).toEqual({ ok: false, reason: ACAT_DRAWER_REASON_SHORT });
    expect(buildDeleteRequest("   a  ")).toEqual({ ok: false, reason: ACAT_DRAWER_REASON_SHORT });
    expect(buildDeleteRequest("abc").ok).toBe(true);
    expect(buildDeleteRequest("x".repeat(500)).ok).toBe(true);
    expect(buildDeleteRequest("x".repeat(501))).toEqual({ ok: false, reason: "Reason must be 500 characters or fewer" });
    const base = { cedarRidgeUserIds: [USER], expectedIdentityVersion: 4, apexAccountId: "", acknowledgeMappingInvalidation: false };
    expect(buildReplaceRequest({ ...base, reason: "x".repeat(2000) }).ok).toBe(true);
    expect(buildReplaceRequest({ ...base, reason: "x".repeat(2001) })).toEqual({ ok: false, reason: "Reason must be 2000 characters or fewer" });
    expect(buildReplaceRequest({ ...base, reason: "  " }).ok).toBe(false);
    expect(formatDrawerDate("2026-10-12")).toBe("10-12-2026");
    expect(formatDrawerDate("2026-10-12T04:00:00.000Z")).toBe("10-12-2026");
    expect(formatDrawerDate("n/a")).toBe("");
    done("tkt332 contract: modal, field, and delete reasons follow the tracker minimums");
  });

  it("tkt332 contract: the finalize summary maps recon and fee review to the tracker wording", () => {
    expect(finalizeReconLabel("Complete")).toBe("Complete");
    expect(finalizeReconLabel("Needs Review")).toBe("Needs review");
    expect(finalizeReconLabel("Pending")).toBe("Pending");
    expect(finalizeReconLabel(null)).toBe("Pending");
    expect(finalizeFeeLabel({ feeCharged: "Yes", feeAmount: "$50.00" })).toBe("$50.00");
    expect(finalizeFeeLabel({ feeCharged: "Yes", feeAmount: null })).toBe("Fee recorded");
    expect(finalizeFeeLabel({ feeCharged: "No", feeAmount: "$50.00" })).toBe("No fee");
    expect(finalizeFeeLabel({ feeCharged: null, feeAmount: null })).toBe("Not reviewed");
    done("tkt332 contract: the finalize summary maps recon and fee review to the tracker wording");
  });
});
