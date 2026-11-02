import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), read: vi.fn(), post: vi.fn(), stale: vi.fn(), revalidate: vi.fn(), library: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/data/acat-fee", () => ({ readTransferFee: mocks.read, postTransferFee: mocks.post }));
vi.mock("@/lib/data/acat-workspace", () => ({ markAcatBookStale: mocks.stale }));
vi.mock("@/lib/data/custodian-library", () => ({ getCustodianLibrary: mocks.library }));

import * as feeActions from "@/app/(authenticated)/acat-tracking/fee-actions";
import {
  applyTransferFeeRules,
  loadFeeRules,
  loadTransferFee,
  saveTransferFeeField,
} from "@/app/(authenticated)/acat-tracking/fee-actions";

const SUITE = "acat-fee-actions";
const BOOK_EPIC = "EPIC_ACAT_OPS_WORKSPACE_TKT290";
const BOOK_SHOW = "SHOW_ACAT_OPS_BOOK_TKT293";
const EDITS = "ALLOW_ACAT_OPS_EDITS_TKT294";
const EPIC = "EPIC_ACAT_FEE_REIMBURSEMENT_TKT318";
const SHOW = "SHOW_ACAT_FEE_REIMBURSEMENT_TKT333";

const FEE = {
  feeCharged: "Yes", feeAmount: "$50.00", feeMemo: "ACAT Transfer Fee: $50.00", feeRequestSubmitted: null,
  feeRequestCompleted: null, feeApexTicket: null, feeCreditRequestId: null,
};
const PENDING = { id: "77", status: "Pending", feeAmount: 50, feeType: "ACAT Transfer Fee", submissionDate: "2026-10-12" };

function feeOn() {
  vi.stubEnv(BOOK_EPIC, "1");
  vi.stubEnv(BOOK_SHOW, "1");
  vi.stubEnv(EDITS, "1");
  vi.stubEnv(EPIC, "1");
  vi.stubEnv(SHOW, "1");
}

function session(role: string | null) {
  mocks.auth.mockResolvedValue(role === null ? null : { user: { role, email: "synthetic@example.test" } });
}

const ALL: Record<string, () => Promise<unknown>> = {
  load: () => loadTransferFee("rec-1"),
  save: () => saveTransferFeeField("rec-1", "feeAmount", "$10.00"),
  apply: () => applyTransferFeeRules("rec-1", ["fee-1"]),
  rules: () => loadFeeRules("cust-1"),
};

function library(fees: Record<string, unknown>[] = []) {
  return {
    schemaVersion: 1,
    custodians: [
      { id: "cust-1", name: "Fidelity", fees },
      { id: "cust-2", name: "Schwab", fees: [{ id: "other", feeType: "Other", accountType: "ANY", transferType: "ANY", direction: "ANY", amount: 1, amountText: null, notes: null }] },
    ],
  };
}
const RULE = {
  id: "fee-1", feeType: "ACAT Transfer Fee", accountType: "ANY", transferType: "ANY", direction: "OUT", amount: 75, amountText: null,
  notes: "Per schedule", documentation: "secret doc", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  feeOn();
  session("OPERATIONS");
  mocks.read.mockResolvedValue({ ok: true, fee: FEE, log: [] });
  mocks.post.mockResolvedValue({ ok: true, fee: FEE, log: [] });
  mocks.library.mockResolvedValue(library([RULE]));
});
afterEach(() => { vi.unstubAllEnvs(); });

function noCalls() {
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
  expect(mocks.library).not.toHaveBeenCalled();
  expect(mocks.stale).not.toHaveBeenCalled();
  expect(mocks.revalidate).not.toHaveBeenCalled();
}

describe("fee actions", () => {
  it("every fee action refuses while the release is off and makes no tracker call", async () => {
    const cases: Array<[string, string | undefined]> = [[EPIC, undefined], [SHOW, undefined], [EPIC, "true"], [SHOW, "0"], [BOOK_SHOW, "0"]];
    for (const [key, value] of cases) {
      vi.unstubAllEnvs();
      feeOn();
      if (value === undefined) vi.stubEnv(key, ""); else vi.stubEnv(key, value);
      for (const [name, call] of Object.entries(ALL)) {
        const result = await call() as { ok: boolean; code?: string; reason?: string };
        expect(result.ok, `${name} with ${key}=${value}`).toBe(false);
        expect(result.code ?? result.reason).toBe("off");
      }
      noCalls();
    }
    markCase(SUITE, "every fee action refuses while the release is off and makes no tracker call");
  });

  it("every fee action refuses while book edits are off", async () => {
    vi.stubEnv(EDITS, "0");
    for (const [name, call] of Object.entries(ALL)) {
      const result = await call() as { ok: boolean; code?: string; reason?: string };
      expect(result.ok, name).toBe(false);
      expect(result.code ?? result.reason).toBe("off");
    }
    noCalls();
    markCase(SUITE, "every fee action refuses while book edits are off");
  });

  it("every fee action refuses a viewer", async () => {
    for (const role of ["VIEWER", "ADVISOR", "CLIENT_SERVICE"]) {
      session(role);
      for (const [name, call] of Object.entries(ALL)) {
        const result = await call() as { ok: boolean; code?: string; reason?: string };
        expect(result.ok, `${name} as ${role}`).toBe(false);
        expect(result.code ?? result.reason).toBe("forbidden");
      }
    }
    session(null);
    expect((await loadTransferFee("rec-1")).ok).toBe(false);
    noCalls();
    markCase(SUITE, "every fee action refuses a viewer");
  });

  it("save posts one field and returns the stored fee", async () => {
    const stored = { ...FEE, feeAmount: "$10.00" };
    mocks.post.mockResolvedValue({ ok: true, fee: stored, log: [PENDING] });
    const result = await saveTransferFeeField("rec-1", "feeAmount", "$10.00");
    expect(mocks.post).toHaveBeenCalledWith("rec-1", { action: "save", fields: { feeAmount: "$10.00" } });
    expect(result).toEqual({ ok: true, fee: stored, log: [PENDING] });
    // An empty value is sent so a blanked field clears; an unknown key or a non-string never reaches the tracker.
    await saveTransferFeeField("rec-1", "feeMemo", "");
    expect(mocks.post).toHaveBeenLastCalledWith("rec-1", { action: "save", fields: { feeMemo: "" } });
    mocks.post.mockClear();
    expect(await saveTransferFeeField("rec-1", "clientName", "x")).toMatchObject({ ok: false, code: "invalid" });
    expect(await saveTransferFeeField("rec-1", "feeMemo", 5 as unknown as string)).toMatchObject({ ok: false, code: "invalid" });
    expect(await saveTransferFeeField("", "feeMemo", "x")).toMatchObject({ ok: false, code: "invalid" });
    expect(await saveTransferFeeField("x".repeat(200), "feeMemo", "x")).toMatchObject({ ok: false, code: "invalid" });
    expect(mocks.post).not.toHaveBeenCalled();
    markCase(SUITE, "save posts one field and returns the stored fee");
  });

  it("a refused save returns the unchanged fee", async () => {
    mocks.post.mockResolvedValue({ ok: false, code: "refused", fee: FEE, log: [PENDING] });
    const result = await saveTransferFeeField("rec-1", "feeAmount", "bad");
    expect(result).toEqual({ ok: false, code: "refused", fee: FEE, log: [PENDING] });
    expect(mocks.stale).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
    markCase(SUITE, "a refused save returns the unchanged fee");
  });

  it("apply posts the selected rule ids", async () => {
    await applyTransferFeeRules("rec-1", ["fee-1", "fee-2"]);
    expect(mocks.post).toHaveBeenCalledWith("rec-1", { action: "apply", feeRuleIds: ["fee-1", "fee-2"] });
    markCase(SUITE, "apply posts the selected rule ids");
  });

  it("apply refuses zero or too many rule ids before any call", async () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `fee-${i}`);
    const exactly = Array.from({ length: 50 }, (_, i) => `fee-${i}`);
    for (const ids of [[], tooMany, ["a", "a"], [""], ["x".repeat(65)], [5 as unknown as string]]) {
      expect(await applyTransferFeeRules("rec-1", ids)).toMatchObject({ ok: false, code: "invalid" });
    }
    expect(await applyTransferFeeRules("rec-1", "fee-1" as unknown as string[])).toMatchObject({ ok: false, code: "invalid" });
    expect(mocks.post).not.toHaveBeenCalled();
    await applyTransferFeeRules("rec-1", exactly);
    await applyTransferFeeRules("rec-1", ["x".repeat(64)]);
    expect(mocks.post).toHaveBeenCalledTimes(2);
    markCase(SUITE, "apply refuses zero or too many rule ids before any call");
  });

  it("apply fails when the library is unavailable and leaves the fee unchanged", async () => {
    mocks.library.mockRejectedValue(new Error("down"));
    expect(await loadFeeRules("cust-1")).toEqual({ ok: false, reason: "unavailable" });
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.stale).not.toHaveBeenCalled();
    // A matching custodian returns only the projected rule fields; no match and no id return no rules.
    mocks.library.mockResolvedValue(library([RULE]));
    const found = await loadFeeRules("cust-1");
    expect(found).toEqual({
      ok: true,
      rules: [{ id: "fee-1", feeType: "ACAT Transfer Fee", accountType: "ANY", transferType: "ANY", direction: "OUT", amount: 75, amountText: null, notes: "Per schedule" }],
    });
    expect(JSON.stringify(found)).not.toContain("secret doc");
    expect(mocks.library).toHaveBeenLastCalledWith("OPERATIONS");
    expect(await loadFeeRules("missing")).toEqual({ ok: true, rules: [] });
    expect(await loadFeeRules(null)).toEqual({ ok: true, rules: [] });
    markCase(SUITE, "apply fails when the library is unavailable and leaves the fee unchanged");
  });

  it("tkt349: exports no reimbursement-log action and never posts a log action", async () => {
    // Stage 1 moved reimbursements to Operations Tools; the drawer has no path to the tracker's log write.
    expect(Object.keys(feeActions).sort()).toEqual(["applyTransferFeeRules", "loadFeeRules", "loadTransferFee", "saveTransferFeeField"]);
    expect("logTransferReimbursement" in feeActions).toBe(false);
    for (const call of Object.values(ALL)) await call();
    await saveTransferFeeField("rec-1", "feeMemo", "x");
    await applyTransferFeeRules("rec-1", ["fee-1"]);
    const actions = mocks.post.mock.calls.map(([, body]) => (body as { action: string }).action);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions).not.toContain("log");
    markCase(SUITE, "tkt349: exports no reimbursement-log action and never posts a log action");
  });

  it("no action writes the playbook", async () => {
    for (const call of Object.values(ALL)) await call();
    const bodies = mocks.post.mock.calls.map(([, body]) => (body as { action: string }).action).sort();
    expect(bodies).toEqual(["apply", "save"]);
    // The only tracker writes go through the fee adapter, which targets the by-record fee route.
    expect(mocks.post.mock.calls.every(([id]) => id === "rec-1")).toBe(true);
    expect(mocks.library).toHaveBeenCalledTimes(1);
    markCase(SUITE, "no action writes the playbook");
  });

  it("a successful write marks the book stale and revalidates", async () => {
    await saveTransferFeeField("rec-1", "feeMemo", "x");
    await applyTransferFeeRules("rec-1", ["fee-1"]);
    expect(mocks.stale).toHaveBeenCalledTimes(2);
    expect(mocks.revalidate).toHaveBeenCalledTimes(2);
    expect(mocks.revalidate).toHaveBeenCalledWith("/acat-tracking");
    mocks.stale.mockClear();
    mocks.revalidate.mockClear();
    await loadTransferFee("rec-1");
    mocks.post.mockResolvedValue({ ok: false, code: "refused", fee: FEE, log: [] });
    await saveTransferFeeField("rec-1", "feeMemo", "x");
    expect(mocks.stale).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
    markCase(SUITE, "a successful write marks the book stale and revalidates");
  });
});
