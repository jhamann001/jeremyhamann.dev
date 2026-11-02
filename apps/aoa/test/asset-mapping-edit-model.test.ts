import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetMapAccountView, AssetMapHouseholdView, AssetMapPositionView } from "@/lib/data/asset-map";
import {
  EDIT_COPY,
  accountTypeConfirmTitle,
  applyEdits,
  editReducer,
  initialEditState,
  isAccountTypeChange,
  type EditAction,
  type EditState,
} from "@/components/asset-mapping/workspace/edits/edit-model";
import { performConfirm, performEdit, performUndo, type EditActions, type EditDeps } from "@/components/asset-mapping/workspace/edits/run-edit";
import { positionStatus, statusCounts } from "@/components/asset-mapping/workspace/workspace-model";

const POS = "77777777-7777-4777-8777-777777777777";
const POS2 = "77777777-7777-4777-8777-777777777778";
const ACC = "88888888-8888-4888-8888-888888888888";

function position(id: string, extra: Partial<AssetMapPositionView> = {}): AssetMapPositionView {
  return {
    id, symbol: "SYNX", description: "Synthetic Fund", assetType: "ETF", quantity: 10, marketValue: 100,
    transferEligible: "ACAT", effectiveStatus: null, transferNotes: null, effectiveNotes: null,
    costBasis: 50, costBasisGranularity: "position", transferring: null, lots: [], ...extra,
  };
}

function account(id: string, extra: Partial<AssetMapAccountView> = {}): AssetMapAccountView {
  return {
    id, custodian: "Synthetic Custodian", accountType: "Individual", accountTypeOther: null,
    accountNumberMasked: "••••1234", accountHolder: "Synthetic Client A", statementDate: "2026-09-01",
    statementAgeDays: 5, isStale: false, totalValue: 100, isRollover: false, isInherited: false,
    inheritedNotes: null, apexRestriction: null, costBasisStatus: null, validationStatus: null,
    validationIssues: [], custodianIntel: null, positions: [position(POS), position(POS2)], ...extra,
  };
}

function household(accounts: AssetMapAccountView[] = [account(ACC)]): AssetMapHouseholdView {
  return { id: "hh-1", clientName: "Synthetic Client A", processedAt: null, docsTotal: null, docsExtracted: null, accounts };
}

function defaultActions(): EditActions {
  return {
    saveStatus: vi.fn(async (_id: string, status: string) => ({ ok: true as const, data: { status: status as "ACAT" } })),
    saveTransferring: vi.fn(async (_id, value) => ({ ok: true as const, data: { value } })),
    saveAccountType: vi.fn(async (_id, accountType, accountTypeOther) => ({ ok: true as const, data: { accountType, accountTypeOther } })),
    removePosition: vi.fn(async (id) => ({ ok: true as const, data: { id } })),
    restorePosition: vi.fn(async (id) => ({ ok: true as const, data: { id } })),
    removeAccount: vi.fn(async (id) => ({ ok: true as const, data: { id } })),
    restoreAccount: vi.fn(async (id) => ({ ok: true as const, data: { id } })),
  };
}

function harness(overrides: Partial<EditActions> = {}) {
  const h = { state: initialEditState(), actions: { ...defaultActions(), ...overrides } as EditActions, deps: null as unknown as EditDeps };
  let seq = 0;
  h.deps = {
    actions: h.actions,
    dispatch: (a: EditAction) => { h.state = editReducer(h.state, a); },
    nextSeq: () => ++seq,
    schedule: (fn, ms) => { setTimeout(fn, ms); },
  };
  return h;
}

const REJECTED = { ok: false as const, reason: "rejected" as const };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("asset-mapping edit model", () => {
  it("applyEdits shows a saved status on the position and in the status counts", () => {
    const state: EditState = { ...initialEditState(), status: { [POS]: "LIQUIDATE" } };
    const view = applyEdits(household(), state);
    expect(positionStatus(view.accounts[0].positions[0])).toBe("LIQUIDATE");
    expect(statusCounts(view)).toMatchObject({ liquidate: 1, acat: 1, total: 2 });
  });

  it("applyEdits shows a saved transferring value as Yes, No, or cleared", () => {
    const h = household([account(ACC, { positions: [position(POS, { transferring: true }), position(POS2)] })]);
    const yes = applyEdits(h, { ...initialEditState(), transferring: { [POS2]: "YES" } });
    expect(yes.accounts[0].positions[1].transferring).toBe(true);
    const no = applyEdits(h, { ...initialEditState(), transferring: { [POS2]: "NO" } });
    expect(no.accounts[0].positions[1].transferring).toBe(false);
    const cleared = applyEdits(h, { ...initialEditState(), transferring: { [POS]: null } });
    expect(cleared.accounts[0].positions[0].transferring).toBeNull();
  });

  it("applyEdits shows a saved account type with its rollover, inherited, and Apex fields", () => {
    const view = applyEdits(household(), {
      ...initialEditState(),
      accountType: { [ACC]: { accountType: "Other", accountTypeOther: "Synthetic label", isRollover: true, isInherited: true, apexRestriction: "Synthetic restriction" } },
    });
    expect(view.accounts[0]).toMatchObject({
      accountType: "Other", accountTypeOther: "Synthetic label", isRollover: true, isInherited: true, apexRestriction: "Synthetic restriction",
    });
  });

  it("applyEdits shows the manual badge from a confirmed account-type save at once (ticket)", () => {
    const pipeline = { by: "pipeline.person@example.invalid", at: "2026-10-01T00:00:00.000Z" };
    const h = household([account(ACC, { accountTypeOverride: pipeline })]);
    const saved = applyEdits(h, {
      ...initialEditState(),
      accountType: { [ACC]: { accountType: "IRA", accountTypeOther: null, overriddenBy: "saver@example.invalid", overriddenAt: "2026-10-06T14:05:00.000Z" } },
    });
    expect(saved.accounts[0].accountTypeOverride).toEqual({ by: "saver@example.invalid", at: "2026-10-06T14:05:00.000Z" });
    const untimed = applyEdits(h, { ...initialEditState(), accountType: { [ACC]: { accountType: "IRA", accountTypeOther: null } } });
    expect(untimed.accounts[0].accountTypeOverride).toEqual(pipeline);
  });

  it("applyEdits hides a removed position and a removed account", () => {
    const withoutPosition = applyEdits(household(), { ...initialEditState(), removedPositions: [POS] });
    expect(withoutPosition.accounts[0].positions.map((p) => p.id)).toEqual([POS2]);
    const withoutAccount = applyEdits(household(), { ...initialEditState(), removedAccounts: [ACC] });
    expect(withoutAccount.accounts).toEqual([]);
  });

  it("applyEdits shows a restored position and a restored account again", async () => {
    const h = harness();
    await performEdit({ kind: "removePosition", positionId: POS, label: "SYNX" }, h.deps);
    await performUndo(h.state.undo!, h.deps);
    await performEdit({ kind: "removeAccount", accountId: ACC, label: "Synthetic Custodian Individual" }, h.deps);
    await performUndo(h.state.undo!, h.deps);
    const view = applyEdits(household(), h.state);
    expect(view.accounts).toHaveLength(1);
    expect(view.accounts[0].positions.map((p) => p.id)).toEqual([POS, POS2]);
  });

  it("a status save shows the saved value from the response and clears pending", async () => {
    const h = harness({ saveStatus: vi.fn(async () => ({ ok: true as const, data: { status: "REVIEW" as const } })) });
    const done = performEdit({ kind: "positionStatus", positionId: POS, status: "LIQUIDATE" }, h.deps);
    expect(h.state.pending).toEqual([`positionStatus:${POS}`]);
    await done;
    expect(h.state.status[POS]).toBe("REVIEW");
    expect(h.state.pending).toEqual([]);
  });

  it("a transferring save shows the saved value from the response", async () => {
    const h = harness({ saveTransferring: vi.fn(async () => ({ ok: true as const, data: { value: "NO" as const } })) });
    await performEdit({ kind: "positionTransferring", positionId: POS, value: "YES" }, h.deps);
    expect(h.state.transferring[POS]).toBe("NO");
  });

  it("a rejected save keeps the last saved value and keeps the failure text for 5 seconds", async () => {
    const saveStatus = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { status: "ACAT" } })
      .mockResolvedValueOnce(REJECTED);
    const h = harness({ saveStatus });
    await performEdit({ kind: "positionStatus", positionId: POS, status: "ACAT" }, h.deps);
    await performEdit({ kind: "positionStatus", positionId: POS, status: "LIQUIDATE" }, h.deps);
    expect(h.state.status[POS]).toBe("ACAT");
    expect(h.state.failure?.text).toBe("Failed to update status");
    vi.advanceTimersByTime(4999);
    expect(h.state.failure).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(h.state.failure).toBeNull();
  });

  it("a save with no response keeps the last saved value and shows the failure text", async () => {
    const h = harness({ saveTransferring: vi.fn(async () => { throw new Error("synthetic timeout"); }) });
    await performEdit({ kind: "positionTransferring", positionId: POS, value: "YES" }, h.deps);
    expect(POS in h.state.transferring).toBe(false);
    expect(h.state.failure?.text).toBe("Failed to update transferring");
    expect(h.state.pending).toEqual([]);
  });

  it("a forbidden save shows the visible rejection text", async () => {
    const h = harness({ saveStatus: vi.fn(async () => ({ ok: false as const, reason: "forbidden" as const })) });
    await performEdit({ kind: "positionStatus", positionId: POS, status: "ACAT" }, h.deps);
    expect(h.state.failure?.text).toBe("Operations role required");
  });

  it("a position removal runs with no confirmation and offers Undo for 8 seconds", async () => {
    const h = harness();
    await performEdit({ kind: "removePosition", positionId: POS, label: "SYNX" }, h.deps);
    expect(h.actions.removePosition).toHaveBeenCalledWith(POS);
    expect(h.state.confirm).toBeNull();
    expect(h.state.undo?.label).toBe("SYNX");
    vi.advanceTimersByTime(7999);
    expect(h.state.undo).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(h.state.undo).toBeNull();
  });

  it("Undo within 8 seconds calls the matching restore route and restores the position", async () => {
    const h = harness();
    await performEdit({ kind: "removePosition", positionId: POS, label: "SYNX" }, h.deps);
    vi.advanceTimersByTime(5000);
    await performUndo(h.state.undo!, h.deps);
    expect(h.actions.restorePosition).toHaveBeenCalledWith(POS);
    expect(h.state.removedPositions).not.toContain(POS);
    expect(h.state.undo).toBeNull();
  });

  it("Undo for an account calls restore account and restores the account", async () => {
    const h = harness();
    await performEdit({ kind: "removeAccount", accountId: ACC, label: "Synthetic Custodian Individual" }, h.deps);
    await performUndo(h.state.undo!, h.deps);
    expect(h.actions.restoreAccount).toHaveBeenCalledWith(ACC);
    expect(h.state.removedAccounts).not.toContain(ACC);
  });

  it("after 8 seconds Undo is gone and no restore is sent", async () => {
    const h = harness();
    await performEdit({ kind: "removePosition", positionId: POS, label: "SYNX" }, h.deps);
    vi.advanceTimersByTime(8000);
    expect(h.state.undo).toBeNull();
    expect(h.actions.restorePosition).not.toHaveBeenCalled();
    expect(h.state.removedPositions).toContain(POS);
  });

  it("an account removal asks for confirmation before any call, and Cancel sends nothing", () => {
    const h = harness();
    h.deps.dispatch({ type: "askRemoveAccount", accountId: ACC, label: "Synthetic Custodian Individual" });
    expect(h.state.confirm).toEqual({ kind: "removeAccount", accountId: ACC, label: "Synthetic Custodian Individual" });
    expect(h.actions.removeAccount).not.toHaveBeenCalled();
    h.deps.dispatch({ type: "cancelConfirm" });
    expect(h.state.confirm).toBeNull();
    expect(h.actions.removeAccount).not.toHaveBeenCalled();
  });

  it("confirming an account removal sends the removal and offers Undo", async () => {
    const h = harness();
    h.deps.dispatch({ type: "askRemoveAccount", accountId: ACC, label: "Synthetic Custodian Individual" });
    await performConfirm(h.state.confirm!, h.deps);
    expect(h.actions.removeAccount).toHaveBeenCalledWith(ACC);
    expect(h.state.confirm).toBeNull();
    expect(h.state.undo).toMatchObject({ kind: "account", id: ACC });
  });

  it("an account type change asks for confirmation that says positions are classified again and corrections are kept", async () => {
    expect(accountTypeConfirmTitle("Individual", "IRA", null)).toBe('Change account classification from "Individual" to "IRA"?');
    expect(EDIT_COPY.accountTypeConfirmBody).toBe(
      "This will re-run the rule engine for every position in this account. Manual position-level overrides will be preserved.",
    );
    const h = harness();
    h.deps.dispatch({ type: "askAccountType", accountId: ACC, from: "Individual", accountType: "IRA", accountTypeOther: null });
    expect(h.actions.saveAccountType).not.toHaveBeenCalled();
    await performConfirm(h.state.confirm!, h.deps);
    expect(h.actions.saveAccountType).toHaveBeenCalledWith(ACC, "IRA", null);
    expect(h.state.accountType[ACC]).toEqual({ accountType: "IRA", accountTypeOther: null });
  });

  it("choosing the current account type and label is not a change", () => {
    expect(isAccountTypeChange("Individual", null, "Individual", null)).toBe(false);
    expect(isAccountTypeChange("Other", "Synthetic label", "Other", "  Synthetic label ")).toBe(false);
    expect(isAccountTypeChange("Other", "Synthetic label", "Other", "Another label")).toBe(true);
    expect(isAccountTypeChange("Individual", null, "IRA", null)).toBe(true);
  });

  it("a rejected removal keeps the row on the household and shows the failure text", async () => {
    const h = harness({ removePosition: vi.fn(async () => REJECTED) });
    await performEdit({ kind: "removePosition", positionId: POS, label: "SYNX" }, h.deps);
    expect(h.state.removedPositions).toEqual([]);
    expect(h.state.undo).toBeNull();
    expect(h.state.failure?.text).toBe("Failed to delete position");
    expect(applyEdits(household(), h.state).accounts[0].positions.map((p) => p.id)).toContain(POS);
  });

  it("an older failure timer does not clear a newer failure", async () => {
    const h = harness({ saveStatus: vi.fn(async () => REJECTED), saveTransferring: vi.fn(async () => REJECTED) });
    await performEdit({ kind: "positionStatus", positionId: POS, status: "ACAT" }, h.deps);
    vi.advanceTimersByTime(3000);
    await performEdit({ kind: "positionTransferring", positionId: POS, value: "YES" }, h.deps);
    vi.advanceTimersByTime(2000);
    expect(h.state.failure?.text).toBe("Failed to update transferring");
    vi.advanceTimersByTime(3000);
    expect(h.state.failure).toBeNull();
  });

  it("reset clears saved values, removals, Undo, and failures when the household changes", async () => {
    const h = harness({ saveTransferring: vi.fn(async () => REJECTED) });
    await performEdit({ kind: "positionStatus", positionId: POS, status: "REVIEW" }, h.deps);
    await performEdit({ kind: "removePosition", positionId: POS2, label: "SYNX" }, h.deps);
    await performEdit({ kind: "positionTransferring", positionId: POS, value: "YES" }, h.deps);
    expect(h.state.failure).not.toBeNull();
    h.deps.dispatch({ type: "reset" });
    expect(h.state).toEqual(initialEditState());
  });
});
