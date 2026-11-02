import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";
import { transferFormFixture, confirmTitleFixture, generateTransferFixture } from "./fixtures/transfer-form";

const mocks = vi.hoisted(() => {
  class TransferFormBridgeError extends Error {
    constructor(readonly reason: string) { super("Transfer form operation unavailable"); }
  }
  return {
    auth: vi.fn(), load: vi.fn(), confirm: vi.fn(), generate: vi.fn(), record: vi.fn(), library: vi.fn(),
    TransferFormBridgeError,
  };
});
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/data/transfer-form-bridge", () => ({
  loadTrackerTransferForm: mocks.load,
  confirmTrackerReceivingTitle: mocks.confirm,
  generateTrackerTransferForm: mocks.generate,
  TransferFormBridgeError: mocks.TransferFormBridgeError,
}));
vi.mock("@/lib/data/acat-status", () => ({ getAcatStatusByRecordId: mocks.record }));
vi.mock("@/lib/data/custodian-library", () => ({ getCustodianLibrary: mocks.library }));

import {
  confirmPaperworkTitle,
  generatePaperwork,
  loadPaperwork,
  loadPaperworkWatchouts,
} from "@/app/(authenticated)/acat-tracking/paperwork-actions";

const SUITE = "acat-paperwork-actions";
const FLAGS = {
  BOOK_EPIC: "EPIC_ACAT_OPS_WORKSPACE_TKT290", BOOK_SHOW: "SHOW_ACAT_OPS_BOOK_TKT293", EDITS: "ALLOW_ACAT_OPS_EDITS_TKT294",
  DRAWER_EPIC: "EPIC_ACAT_TRANSFER_DRAWER_TKT319", DRAWER_SHOW: "SHOW_ACAT_TRANSFER_DRAWER_TKT332",
  EPIC: "EPIC_ACAT_PAPERWORK_TKT321", SHOW: "SHOW_ACAT_PAPERWORK_TKT335",
};

function paperworkOn() {
  for (const name of Object.values(FLAGS)) vi.stubEnv(name, "1");
}
function session(role: string | null, email = "Synthetic@Example.test") {
  mocks.auth.mockResolvedValue(role === null ? null : { user: { role, email } });
}

function profile(over: Record<string, unknown> = {}) {
  return {
    id: "cust-1", name: "Schwab", reviewStatus: "VERIFIED", acatFeeAmount: null, transferType: "ACAT_API", documentationStatus: null,
    dtcNumber: "0164", receivingAccountNumber: "HOUSE-1", signature: "Wet signature", letterOfAcceptance: "Required",
    medallionRequired: "No", liquidationMethod: "Market", returnMethod: "Mail", watchouts: "Original watchout",
    paperworkOnFile: true, transfersToDate: 3, contactEmail: null, configuredExpectedProcessingDays: null,
    observedAvgProcessingBusinessDays: null, observedCompletedTransfers: 0, fees: [], ...over,
  };
}
function library(custodians = [profile()]) {
  return { schemaVersion: 1, retrievedAt: "2026-10-13T15:00:00.000Z", custodians };
}
const record = { direction: "In", type: "Full", accountType: "Brokerage", transferringContra: "Schwab" };

type Call = () => Promise<unknown>;
const ALL: Record<string, Call> = {
  load: () => loadPaperwork("rec-1"),
  confirm: () => confirmPaperworkTitle("rec-1", confirmTitleFixture),
  generate: () => generatePaperwork("rec-1", generateTransferFixture),
  watchouts: () => loadPaperworkWatchouts("rec-1"),
};
function noTrackerCall() {
  for (const fn of [mocks.load, mocks.confirm, mocks.generate, mocks.record, mocks.library]) expect(fn).not.toHaveBeenCalled();
}

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  session("OPERATIONS");
  paperworkOn();
  mocks.load.mockResolvedValue(structuredClone(transferFormFixture));
  mocks.confirm.mockResolvedValue(structuredClone(transferFormFixture));
  mocks.generate.mockResolvedValue({ documentId: "doc-1" });
  mocks.record.mockResolvedValue(record);
  mocks.library.mockResolvedValue(library());
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("paperwork actions", () => {
  it("tkt335 actions: every action is refused while paperwork is off and makes no tracker call", async () => {
    for (const off of [FLAGS.EPIC, FLAGS.SHOW, FLAGS.DRAWER_SHOW, FLAGS.BOOK_SHOW]) {
      vi.stubEnv(off, "0");
      for (const [name, call] of Object.entries(ALL)) {
        expect(await call(), `${name} with ${off} off`).toEqual({ ok: false, reason: "off" });
      }
      noTrackerCall();
      paperworkOn();
    }
    markCase(SUITE, "tkt335 actions: every action is refused while paperwork is off and makes no tracker call");
  });

  it("tkt335 actions: every action is refused for a signed-out user and for roles other than admin and operations", async () => {
    for (const role of [null, "CLIENT_SERVICE", "ADVISOR", "VIEWER", ""]) {
      session(role);
      for (const [name, call] of Object.entries(ALL)) {
        expect(await call(), `${name} for ${String(role)}`).toEqual({ ok: false, reason: "forbidden" });
      }
    }
    mocks.auth.mockResolvedValue({ user: { role: "ADMIN" } });
    expect(await loadPaperwork("rec-1")).toEqual({ ok: false, reason: "forbidden" });
    noTrackerCall();
    markCase(SUITE, "tkt335 actions: every action is refused for a signed-out user and for roles other than admin and operations");
  });

  it("tkt335 actions: the write actions are refused while edits are off and the reads still work", async () => {
    vi.stubEnv(FLAGS.EDITS, "0");
    expect(await confirmPaperworkTitle("rec-1", confirmTitleFixture)).toEqual({ ok: false, reason: "off" });
    expect(await generatePaperwork("rec-1", generateTransferFixture)).toEqual({ ok: false, reason: "off" });
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(await loadPaperwork("rec-1")).toMatchObject({ ok: true });
    expect(await loadPaperworkWatchouts("rec-1")).toMatchObject({ ok: true });
    markCase(SUITE, "tkt335 actions: the write actions are refused while edits are off and the reads still work");
  });

  it("tkt335 actions: load passes the actor and record id to the bridge and returns the preparation", async () => {
    const result = await loadPaperwork("rec-1");
    expect(result).toEqual({ ok: true, data: transferFormFixture });
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.load).toHaveBeenCalledWith({ email: "Synthetic@Example.test", role: "OPERATIONS" }, "rec-1");
    markCase(SUITE, "tkt335 actions: load passes the actor and record id to the bridge and returns the preparation");
  });

  it("tkt335 actions: a bridge refusal returns only its bounded reason", async () => {
    for (const reason of ["disabled", "forbidden", "invalid", "not_found", "stale", "unavailable", "review_required"]) {
      mocks.load.mockRejectedValueOnce(new mocks.TransferFormBridgeError(reason));
      expect(await loadPaperwork("rec-1"), reason).toEqual({ ok: false, reason });
    }
    mocks.load.mockRejectedValueOnce(new Error("Bearer secret-token https://tracker.internal/path"));
    expect(await loadPaperwork("rec-1")).toEqual({ ok: false, reason: "unavailable" });
    markCase(SUITE, "tkt335 actions: a bridge refusal returns only its bounded reason");
  });

  it("tkt335 actions: confirm title and generate pass the parsed input to the bridge", async () => {
    expect(await confirmPaperworkTitle("rec-1", confirmTitleFixture)).toEqual({ ok: true, data: transferFormFixture });
    expect(mocks.confirm).toHaveBeenCalledWith({ email: "Synthetic@Example.test", role: "OPERATIONS" }, "rec-1", confirmTitleFixture);
    expect(await generatePaperwork("rec-1", generateTransferFixture)).toEqual({ ok: true, data: { documentId: "doc-1" } });
    expect(mocks.generate).toHaveBeenCalledWith({ email: "Synthetic@Example.test", role: "OPERATIONS" }, "rec-1", generateTransferFixture);
    const bad = { ...generateTransferFixture, accountsReviewed: false } as unknown as typeof generateTransferFixture;
    expect(await generatePaperwork("rec-1", bad)).toEqual({ ok: false, reason: "invalid" });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    const badTitle = { ...confirmTitleFixture, confirmed: false } as unknown as typeof confirmTitleFixture;
    expect(await confirmPaperworkTitle("rec-1", badTitle)).toEqual({ ok: false, reason: "invalid" });
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    markCase(SUITE, "tkt335 actions: confirm title and generate pass the parsed input to the bridge");
  });

  it("tkt335 actions: watchouts read the live library and return the matched custodian's rules", async () => {
    const result = await loadPaperworkWatchouts("rec-1");
    expect(result).toMatchObject({
      ok: true, match: "MATCHED", candidates: [], retrievedAt: "2026-10-13T15:00:00.000Z",
      custodian: {
        id: "cust-1", name: "Schwab", watchouts: "Original watchout", letterOfAcceptance: "Required", receivingAccountNumber: "HOUSE-1",
        medallionRequired: "No", signature: "Wet signature", returnMethod: "Mail", liquidationMethod: "Market", reviewStatus: "VERIFIED",
      },
    });
    expect(mocks.library).toHaveBeenCalledWith("OPERATIONS");
    expect(mocks.record).toHaveBeenCalledWith("rec-1", expect.objectContaining({ signal: expect.anything() }));
    markCase(SUITE, "tkt335 actions: watchouts read the live library and return the matched custodian's rules");
  });

  it("tkt335 actions: watchouts return the current text on every call", async () => {
    const first = await loadPaperworkWatchouts("rec-1");
    mocks.library.mockResolvedValue(library([profile({ watchouts: "Changed after the transfer opened" })]));
    const second = await loadPaperworkWatchouts("rec-1");
    expect(first).toMatchObject({ custodian: { watchouts: "Original watchout" } });
    expect(second).toMatchObject({ custodian: { watchouts: "Changed after the transfer opened" } });
    expect(mocks.library).toHaveBeenCalledTimes(2);
    markCase(SUITE, "tkt335 actions: watchouts return the current text on every call");
  });

  it("tkt335 actions: watchouts with no matched custodian return a null custodian and the match status", async () => {
    mocks.record.mockResolvedValue({ ...record, transferringContra: "Unknown Firm" });
    expect(await loadPaperworkWatchouts("rec-1")).toMatchObject({ ok: true, custodian: null, match: "UNKNOWN", candidates: [] });
    mocks.record.mockResolvedValue(record);
    mocks.library.mockResolvedValue(library([profile(), profile({ id: "cust-2" })]));
    expect(await loadPaperworkWatchouts("rec-1")).toMatchObject({ ok: true, custodian: null, match: "AMBIGUOUS", candidates: ["Schwab", "Schwab"] });
    mocks.record.mockResolvedValue(null);
    expect(await loadPaperworkWatchouts("rec-1")).toEqual({ ok: false, reason: "not_found" });
    markCase(SUITE, "tkt335 actions: watchouts with no matched custodian return a null custodian and the match status");
  });

  it("tkt335 actions: a library failure returns unavailable with no error detail", async () => {
    mocks.library.mockRejectedValue(new Error("Bearer secret-token"));
    const result = await loadPaperworkWatchouts("rec-1");
    expect(result).toEqual({ ok: false, reason: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("secret");
    mocks.library.mockResolvedValue({ not: "a library" });
    expect(await loadPaperworkWatchouts("rec-1")).toEqual({ ok: false, reason: "unavailable" });
    markCase(SUITE, "tkt335 actions: a library failure returns unavailable with no error detail");
  });

  it("tkt335 actions: a record id that is not a stable id is refused before any call", async () => {
    for (const id of ["", "../other", "rec?x=1", "x".repeat(129), "a b"]) {
      expect(await loadPaperworkWatchouts(id), id).toEqual({ ok: false, reason: "invalid" });
    }
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.library).not.toHaveBeenCalled();
    mocks.load.mockRejectedValueOnce(new mocks.TransferFormBridgeError("invalid"));
    expect(await loadPaperwork("../other")).toEqual({ ok: false, reason: "invalid" });
    markCase(SUITE, "tkt335 actions: a record id that is not a stable id is refused before any call");
  });

  it("tkt335 actions: no action result contains a client account number, a client name, or a credential", async () => {
    mocks.record.mockResolvedValue({ ...record, clientName: "Pat Example", apexAccountId: "123456789", statementAccountNumber: "761704106" });
    const results = [await loadPaperwork("rec-1"), await loadPaperworkWatchouts("rec-1"), await generatePaperwork("rec-1", generateTransferFixture)];
    const text = JSON.stringify(results);
    for (const secret of ["Pat Example", "123456789", "761704106", "Bearer", "token"]) expect(text).not.toContain(secret);
    // The only account-like value besides the tracker's masked numbers is the custodian's house-account reference.
    expect(results[1]).toMatchObject({ custodian: { receivingAccountNumber: "HOUSE-1" } });
    markCase(SUITE, "tkt335 actions: no action result contains a client account number, a client name, or a credential");
  });

  it("tkt335 actions: failures log only the action name and a bounded reason", async () => {
    mocks.load.mockRejectedValueOnce(new mocks.TransferFormBridgeError("stale"));
    mocks.generate.mockRejectedValueOnce(new Error("Bearer secret-token rec-1 Pat Example"));
    mocks.library.mockRejectedValueOnce(new Error("secret"));
    await loadPaperwork("rec-1");
    await generatePaperwork("rec-1", generateTransferFixture);
    await loadPaperworkWatchouts("rec-1");
    expect(errors.mock.calls).toEqual([
      ["[acat-paperwork] load stale"],
      ["[acat-paperwork] generate unavailable"],
      ["[acat-paperwork] watchouts unavailable"],
    ]);
    errors.mockClear();
    vi.stubEnv(FLAGS.EPIC, "0");
    await loadPaperwork("rec-1");
    expect(errors).not.toHaveBeenCalled();
    markCase(SUITE, "tkt335 actions: failures log only the action name and a bounded reason");
  });
});
