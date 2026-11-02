import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DealRow, DealStage } from "@/lib/data/deal-types";
import {
  DEAL_OWNED_FIELDS,
  DEAL_STAGE_TO_TRANSFER_STAGE,
  buildSyncTransferInput,
  dealOwnedChanges,
  isPristine,
  orphanAction,
  reconcileAction,
  stageRank,
  type ExistingTransfer,
} from "@/lib/data/transfer-sync";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A full DealRow with sane defaults (COMMITTED, non-archived); override per case.
function makeDeal(over: Partial<DealRow> = {}): DealRow {
  return {
    id: "deal-1",
    source: "IMPORT",
    sf_deal_id: "SF-DEAL-1",
    name: "Willie Q Client — Roth rollover",
    client_first_name: "Willie",
    client_last_name: "Client",
    household_name: "Client Household",
    household_sf_id: "001HOUSEHOLD00000",
    client_sf_id: "003USNEOKL09083000",
    amount: 250000,
    stage: "COMMITTED",
    stage_raw: null,
    created_date: new Date("2026-06-01"),
    close_date: null,
    last_activity_date: null,
    owner_name: "Advisor A",
    owner_sf_user_id: null,
    secondary_owner: null,
    person_aum: null,
    potential_aum: null,
    cedar_ridge_user_id: null,
    cedar_ridge_user_id_masked: false,
    statements: false,
    asset_mapped: false,
    plaid_linked: false,
    account_last4: null,
    account_type: "Roth IRA",
    transferring_firm: "Fidelity",
    employer: null,
    rolling_into: null,
    lost_from: null,
    archived_reason: null,
    stage_history: [],
    created_by: null,
    updated_by: null,
    created_at: new Date("2026-06-01"),
    updated_at: new Date("2026-06-01"),
    archived_at: null,
    archived_by: null,
    ...over,
  };
}

// A transfer that is IN SYNC with makeDeal()'s deal-owned projection (so a
// COMMITTED re-sync is a noop unless a case perturbs a field). Pristine by
// default (DECISION, all booleans false, no ACAT, not archived).
function makeExisting(over: Partial<ExistingTransfer> = {}): ExistingTransfer {
  return {
    id: "transfer-1",
    deal_id: "deal-1",
    stage: "DECISION",
    funding_type: null,
    client_first_name: "Willie",
    client_last_name: "Client",
    client_sf_id: "003USNEOKL09083000",
    household_name: "Client Household",
    household_sf_id: "001HOUSEHOLD00000",
    value: 250000,
    transferring_firm: "Fidelity",
    deal_sf_id: "SF-DEAL-1",
    accounts_opened_at_apex: false,
    funding_plan_complete: false,
    funding_plan_version: 0,
    funding_initiated: false,
    cash_in_flight: false,
    acat_transfer_id: null,
    acat_record_id: null,
    archived_at: null,
    sync_flag: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// buildSyncTransferInput — the create projection + the value ⟵ amount rename
// ---------------------------------------------------------------------------

describe("buildSyncTransferInput", () => {
  it("sets source IMPORT, stage DECISION, owner CLIENT_SERVICE", () => {
    const input = buildSyncTransferInput(makeDeal());
    expect(input.source).toBe("IMPORT");
    expect(input.stage).toBe("DECISION");
    expect(input.owner_kind).toBe("CLIENT_SERVICE");
  });

  it("renames transfer.value ⟵ deal.amount (the only rename)", () => {
    const input = buildSyncTransferInput(makeDeal({ amount: 314159 }));
    expect(input.value).toBe(314159);
  });

  it("sets deal_id ⟵ deal.id (the create-only sync key)", () => {
    const input = buildSyncTransferInput(makeDeal({ id: "deal-XYZ" }));
    expect(input.deal_id).toBe("deal-XYZ");
  });

  it("maps deal_sf_id ⟵ deal.sf_deal_id and the client/household/firm columns", () => {
    const input = buildSyncTransferInput(
      makeDeal({
        sf_deal_id: "SF-99",
        client_first_name: "Sam",
        client_last_name: "Saver",
        client_sf_id: "003SAM",
        household_name: "Saver HH",
        household_sf_id: "001SAV",
        transferring_firm: "Schwab",
      }),
    );
    expect(input.deal_sf_id).toBe("SF-99");
    expect(input.client_first_name).toBe("Sam");
    expect(input.client_last_name).toBe("Saver");
    expect(input.client_sf_id).toBe("003SAM");
    expect(input.household_name).toBe("Saver HH");
    expect(input.household_sf_id).toBe("001SAV");
    expect(input.transferring_firm).toBe("Schwab");
  });

  it("deal_id is NOT one of the DEAL_OWNED_FIELDS (create-only, never re-written)", () => {
    expect(DEAL_OWNED_FIELDS).not.toContain("deal_id");
    expect(DEAL_OWNED_FIELDS).toContain("value");
  });
});

// ---------------------------------------------------------------------------
// isPristine — the §1.5b predicate (every workflow field flips it)
// ---------------------------------------------------------------------------

describe("isPristine", () => {
  it("true for a clean DECISION transfer (no workflow state)", () => {
    expect(isPristine(makeExisting())).toBe(true);
  });

  it("false when any checklist boolean / cash / ACAT / stage / archive is set", () => {
    expect(isPristine(makeExisting({ stage: "IN_TRANSFER" }))).toBe(false);
    expect(isPristine(makeExisting({ accounts_opened_at_apex: true }))).toBe(false);
    expect(isPristine(makeExisting({ funding_plan_complete: true }))).toBe(false);
    expect(isPristine(makeExisting({ funding_initiated: true }))).toBe(false);
    expect(isPristine(makeExisting({ cash_in_flight: true }))).toBe(false);
    expect(isPristine(makeExisting({ acat_transfer_id: "acat-uuid" }))).toBe(false);
    // #151 robust linkage key: a set acat_record_id (even with acat_transfer_id
    // null) is live Transfer linkage → NOT pristine → orphan sweep flags, not archives.
    expect(isPristine(makeExisting({ acat_record_id: "rec-uuid" }))).toBe(false);
    expect(isPristine(makeExisting({ archived_at: new Date() }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dealOwnedChanges — only differing deal-owned fields; workflow state excluded
// ---------------------------------------------------------------------------

describe("dealOwnedChanges", () => {
  it("empty when the transfer already matches the deal projection", () => {
    expect(dealOwnedChanges(makeDeal(), makeExisting())).toEqual({});
  });

  it("captures the value rename drift (amount changed)", () => {
    const changes = dealOwnedChanges(makeDeal({ amount: 999 }), makeExisting());
    expect(changes).toEqual({ value: 999 });
  });

  it("captures multiple deal-owned field diffs", () => {
    const changes = dealOwnedChanges(
      makeDeal({ transferring_firm: "Vanguard", client_last_name: "Renamed" }),
      makeExisting(),
    );
    expect(changes).toEqual({
      transferring_firm: "Vanguard",
      client_last_name: "Renamed",
    });
  });
});

// ---------------------------------------------------------------------------
// reconcileAction — every rule + idempotency
// ---------------------------------------------------------------------------

describe("reconcileAction", () => {
  it("COMMITTED + no transfer → create (with the built input)", () => {
    const action = reconcileAction(makeDeal({ stage: "COMMITTED" }), null);
    expect(action.kind).toBe("create");
    if (action.kind === "create") {
      expect(action.input.deal_id).toBe("deal-1");
      expect(action.input.value).toBe(250000);
      expect(action.input.source).toBe("IMPORT");
    }
  });

  it("COMMITTED + transfer with drift → update (deal-owned fields only)", () => {
    const action = reconcileAction(
      makeDeal({ stage: "COMMITTED", amount: 500000 }),
      makeExisting({ value: 250000 }),
    );
    expect(action).toEqual({ kind: "update", changes: { value: 500000 } });
  });

  it("COMMITTED + unchanged transfer → noop (IDEMPOTENT re-sync, no clobber)", () => {
    const action = reconcileAction(makeDeal({ stage: "COMMITTED" }), makeExisting());
    expect(action).toEqual({ kind: "noop" });
  });

  it("COMMITTED update never touches workflow state (progressed transfer, no drift → noop)", () => {
    // A transfer deep in workflow (checklist done, ACAT linked) whose deal-owned
    // fields still match the deal yields noop — the sync leaves ops' state alone.
    const action = reconcileAction(
      makeDeal({ stage: "COMMITTED" }),
      makeExisting({
        stage: "IN_TRANSFER",
        accounts_opened_at_apex: true,
        funding_plan_complete: true,
        funding_initiated: true,
        acat_transfer_id: "acat-uuid",
      }),
    );
    expect(action).toEqual({ kind: "noop" });
  });

  it("COMMITTED + archived transfer → noop (never resurrect)", () => {
    const action = reconcileAction(
      makeDeal({ stage: "COMMITTED", amount: 1 }),
      makeExisting({ archived_at: new Date() }),
    );
    expect(action).toEqual({ kind: "noop" });
  });

  it("WON + no transfer → create at FUNDED (deal drives the created stage)", () => {
    const action = reconcileAction(makeDeal({ stage: "WON" }), null);
    expect(action.kind).toBe("create");
    if (action.kind === "create") expect(action.input.stage).toBe("FUNDED");
  });

  it("WON + approved transfer at DECISION → update advances stage to FUNDED", () => {
    const action = reconcileAction(makeDeal({ stage: "WON" }), makeExisting({ funding_plan_complete: true, funding_plan_version: 1 }));
    expect(action).toEqual({ kind: "update", changes: { stage: "FUNDED" } });
  });

  it("LOST + active transfer → archive(deal_lost)", () => {
    const action = reconcileAction(makeDeal({ stage: "LOST" }), makeExisting());
    expect(action).toEqual({ kind: "archive", reason: "deal_lost" });
  });

  it("LOST + already-archived transfer → noop", () => {
    const action = reconcileAction(
      makeDeal({ stage: "LOST" }),
      makeExisting({ archived_at: new Date() }),
    );
    expect(action).toEqual({ kind: "noop" });
  });

  it("LOST + no transfer → noop", () => {
    expect(reconcileAction(makeDeal({ stage: "LOST" }), null)).toEqual({
      kind: "noop",
    });
  });

  it("deal archived (archived_at set, stage COMMITTED) → treated like LOST → archive(deal_lost)", () => {
    const action = reconcileAction(
      makeDeal({ stage: "COMMITTED", archived_at: new Date() }),
      makeExisting(),
    );
    expect(action).toEqual({ kind: "archive", reason: "deal_lost" });
  });

  it("POTENTIAL + pristine transfer → archive(uncommitted)", () => {
    const action = reconcileAction(makeDeal({ stage: "POTENTIAL" }), makeExisting());
    expect(action).toEqual({ kind: "archive", reason: "uncommitted" });
  });

  it("FIXED BUG: FUNDING + PRISTINE transfer → advance to IN_TRANSFER, NEVER archive(uncommitted)", () => {
    // Was the live bug: FUNDING shared the POTENTIAL uncommitted branch, so a
    // freshly-synced (pristine) transfer for a Committed→In-Process deal was
    // mis-archived. FUNDING is now a first-class advance stage.
    const action = reconcileAction(makeDeal({ stage: "FUNDING" }), makeExisting());
    expect(action).toEqual({ kind: "update", changes: { stage: "IN_TRANSFER" } });
  });

  it("POTENTIAL + PROGRESSED transfer → flag(uncommitted_review), never archive", () => {
    const action = reconcileAction(
      makeDeal({ stage: "POTENTIAL" }),
      makeExisting({ funding_initiated: true }),
    );
    expect(action).toEqual({ kind: "flag", sync_flag: "uncommitted_review" });
  });

  it("FUNDING + transfer at DECISION (ACAT linked) → advance to IN_TRANSFER (FUNDING no longer runs the uncommitted guard)", () => {
    const action = reconcileAction(
      makeDeal({ stage: "FUNDING" }),
      makeExisting({ acat_transfer_id: "acat-uuid" }),
    );
    expect(action).toEqual({ kind: "update", changes: { stage: "IN_TRANSFER" } });
  });

  it("POTENTIAL + no transfer → noop (uncommitted-guard needs an existing transfer)", () => {
    expect(reconcileAction(makeDeal({ stage: "POTENTIAL" }), null)).toEqual({
      kind: "noop",
    });
  });

  it("FUNDING + no transfer → create at IN_TRANSFER", () => {
    const action = reconcileAction(makeDeal({ stage: "FUNDING" }), null);
    expect(action.kind).toBe("create");
    if (action.kind === "create") {
      expect(action.input.stage).toBe("IN_TRANSFER");
      expect(action.input.deal_id).toBe("deal-1");
    }
  });

  it("uncommitted + already-archived transfer → noop", () => {
    const action = reconcileAction(
      makeDeal({ stage: "POTENTIAL" }),
      makeExisting({ archived_at: new Date() }),
    );
    expect(action).toEqual({ kind: "noop" });
  });

  it("covers every live deal stage without throwing", () => {
    const stages: DealStage[] = ["POTENTIAL", "COMMITTED", "FUNDING", "WON", "LOST"];
    for (const stage of stages) {
      expect(() => reconcileAction(makeDeal({ stage }), makeExisting())).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Deal-driven transfer stage (ticket sync-stage-mapping): create at the
// mapped stage, forward-only advance on update, never regress.
// ---------------------------------------------------------------------------

describe("deal-driven stage mapping (forward-only)", () => {
  it.each(["FUNDING", "WON"] as const)("preserves the current stage while a changed funding route needs review for a %s deal", (stage) => {
    const transfer = makeExisting({
      stage: "DECISION", funding_type: "ACAT_FULL", funding_plan_complete: true,
      funding_plan_version: 2, funding_route_change_pending: true,
    });
    expect(reconcileAction(makeDeal({ stage }), transfer)).toEqual({ kind: "noop" });
    expect(reconcileAction(makeDeal({ stage, amount: 777 }), transfer))
      .toEqual({ kind: "update", changes: { value: 777 } });
    expect(reconcileAction(makeDeal({ stage }), { ...transfer, funding_route_change_pending: false }))
      .toEqual({ kind: "update", changes: { stage: stage === "WON" ? "FUNDED" : "IN_TRANSFER" } });
  });

  it.each(["DECISION", "IN_TRANSFER"] as const)("requires explicit approval before an existing %s record becomes Funded", (stage) => {
    for (const approval of [
      { funding_plan_complete: false, funding_plan_version: 0 },
      { funding_plan_complete: true, funding_plan_version: 0 },
      { funding_plan_complete: false, funding_plan_version: 2 },
      { funding_plan_complete: true, funding_plan_version: -1 },
      { funding_plan_complete: true, funding_plan_version: 1.5 },
    ]) {
      expect(reconcileAction(makeDeal({ stage: "WON" }), makeExisting({ stage, ...approval })))
        .toEqual({ kind: "noop" });
      expect(reconcileAction(makeDeal({ stage: "WON", amount: 777 }), makeExisting({ stage, ...approval })))
        .toEqual({ kind: "update", changes: { value: 777 } });
    }
    expect(reconcileAction(makeDeal({ stage: "WON" }), makeExisting({
      stage, funding_plan_complete: true, funding_plan_version: 2,
    }))).toEqual({ kind: "update", changes: { stage: "FUNDED" } });
  });

  it.each(["FUNDING", "WON"] as const)("leaves DRS stage under Operations control for a %s deal", (stage) => {
    expect(reconcileAction(makeDeal({ stage }), makeExisting({ funding_type: "DRS" })))
      .toEqual({ kind: "noop" });
    expect(reconcileAction(makeDeal({ stage, amount: 777 }), makeExisting({ funding_type: "DRS" })))
      .toEqual({ kind: "update", changes: { value: 777 } });
  });

  it("flags DRS for review when its source deal is lost, uncommitted or gone", () => {
    const drs = makeExisting({ funding_type: "DRS" });
    expect(isPristine(drs)).toBe(false);
    expect(reconcileAction(makeDeal({ stage: "LOST" }), drs))
      .toEqual({ kind: "flag", sync_flag: "orphan_review" });
    expect(reconcileAction(makeDeal({ archived_at: new Date() }), drs))
      .toEqual({ kind: "flag", sync_flag: "orphan_review" });
    expect(reconcileAction(makeDeal({ stage: "POTENTIAL" }), drs))
      .toEqual({ kind: "flag", sync_flag: "uncommitted_review" });
    expect(orphanAction(drs, new Set())).toEqual({ kind: "flag", sync_flag: "orphan_review" });
    expect(reconcileAction(makeDeal({ stage: "LOST" }), { ...drs, archived_at: new Date() }))
      .toEqual({ kind: "noop" });
  });

  it("DEAL_STAGE_TO_TRANSFER_STAGE maps the three create/advance deal stages", () => {
    expect(DEAL_STAGE_TO_TRANSFER_STAGE).toEqual({
      COMMITTED: "DECISION",
      FUNDING: "IN_TRANSFER",
      WON: "FUNDED",
    });
  });

  it("stageRank orders DECISION < IN_TRANSFER < FUNDED", () => {
    expect(stageRank("DECISION")).toBeLessThan(stageRank("IN_TRANSFER"));
    expect(stageRank("IN_TRANSFER")).toBeLessThan(stageRank("FUNDED"));
  });

  it("buildSyncTransferInput: FUNDING deal → create input at IN_TRANSFER", () => {
    expect(buildSyncTransferInput(makeDeal({ stage: "FUNDING" })).stage).toBe(
      "IN_TRANSFER",
    );
  });

  it("buildSyncTransferInput: WON deal → create input at FUNDED", () => {
    expect(buildSyncTransferInput(makeDeal({ stage: "WON" })).stage).toBe("FUNDED");
  });

  it("COMMITTED transfer (DECISION) + deal now FUNDING → update advances stage to IN_TRANSFER", () => {
    const action = reconcileAction(
      makeDeal({ stage: "FUNDING" }),
      makeExisting({ stage: "DECISION" }),
    );
    expect(action).toEqual({ kind: "update", changes: { stage: "IN_TRANSFER" } });
  });

  it("advance + deal-owned drift → update carries BOTH the field diff and the stage", () => {
    const action = reconcileAction(
      makeDeal({ stage: "WON", amount: 777 }),
      makeExisting({ stage: "DECISION", value: 250000, funding_plan_complete: true, funding_plan_version: 1 }),
    );
    expect(action).toEqual({
      kind: "update",
      changes: { value: 777, stage: "FUNDED" },
    });
  });

  it("deal WON + transfer already FUNDED → noop (no re-advance, idempotent)", () => {
    expect(
      reconcileAction(makeDeal({ stage: "WON" }), makeExisting({ stage: "FUNDED" })),
    ).toEqual({ kind: "noop" });
  });

  it("transfer at FUNDED + deal regressed to COMMITTED → NO regression, noop when no drift", () => {
    const action = reconcileAction(
      makeDeal({ stage: "COMMITTED" }),
      makeExisting({ stage: "FUNDED" }),
    );
    expect(action).toEqual({ kind: "noop" });
  });

  it("transfer at FUNDED + deal regressed to COMMITTED WITH drift → deal-owned fields update, stage stays FUNDED", () => {
    const action = reconcileAction(
      makeDeal({ stage: "COMMITTED", amount: 42 }),
      makeExisting({ stage: "FUNDED", value: 250000 }),
    );
    expect(action).toEqual({ kind: "update", changes: { value: 42 } });
  });

  it("idempotent: FUNDING re-run over an already-advanced (IN_TRANSFER) transfer → noop", () => {
    const advanced = makeExisting({ stage: "IN_TRANSFER" });
    expect(reconcileAction(makeDeal({ stage: "FUNDING" }), advanced)).toEqual({
      kind: "noop",
    });
  });
});

// ---------------------------------------------------------------------------
// sync_flag AUTO-HEAL (transfer-syncflag-surface): a flagged transfer whose
// deal is BACK in a driving stage clears its stale review marker on update.
// ---------------------------------------------------------------------------

describe("reconcileAction — sync_flag auto-heal", () => {
  it("COMMITTED + flagged transfer, no other drift → update clears sync_flag ONLY", () => {
    const action = reconcileAction(
      makeDeal({ stage: "COMMITTED" }),
      makeExisting({ stage: "DECISION", sync_flag: "uncommitted_review" }),
    );
    expect(action).toEqual({ kind: "update", changes: { sync_flag: null } });
  });

  it("FUNDING + flagged transfer → update carries the stage advance AND the flag clear", () => {
    const action = reconcileAction(
      makeDeal({ stage: "FUNDING" }),
      makeExisting({ stage: "DECISION", sync_flag: "uncommitted_review" }),
    );
    expect(action).toEqual({
      kind: "update",
      changes: { stage: "IN_TRANSFER", sync_flag: null },
    });
  });

  it("WON + orphan_review-flagged transfer with drift → fields + stage + flag clear together", () => {
    const action = reconcileAction(
      makeDeal({ stage: "WON", amount: 777 }),
      makeExisting({
        stage: "IN_TRANSFER",
        value: 250000,
        sync_flag: "orphan_review",
        funding_plan_complete: true,
        funding_plan_version: 1,
      }),
    );
    expect(action).toEqual({
      kind: "update",
      changes: { value: 777, stage: "FUNDED", sync_flag: null },
    });
  });

  it("unflagged transfer stays flag-free: no drift → noop (no gratuitous update)", () => {
    expect(
      reconcileAction(makeDeal({ stage: "COMMITTED" }), makeExisting()),
    ).toEqual({ kind: "noop" });
  });

  it("POTENTIAL + progressed + already-flagged transfer → re-flag (the guard is untouched)", () => {
    const action = reconcileAction(
      makeDeal({ stage: "POTENTIAL" }),
      makeExisting({ cash_in_flight: true, sync_flag: "uncommitted_review" }),
    );
    expect(action).toEqual({ kind: "flag", sync_flag: "uncommitted_review" });
  });

  it("COMMITTED + archived + flagged transfer → noop (never resurrect, even to heal a flag)", () => {
    expect(
      reconcileAction(
        makeDeal({ stage: "COMMITTED" }),
        makeExisting({ archived_at: new Date(), sync_flag: "orphan_review" }),
      ),
    ).toEqual({ kind: "noop" });
  });
});

// ---------------------------------------------------------------------------
// orphanAction — §4.1 orphan sweep (deal directly archived/deleted, so the
// per-deal reconcile pass never sees it). Progressed-guarded, idempotent.
// ---------------------------------------------------------------------------

describe("orphanAction", () => {
  // The active-deal id set the route builds from the FULL listDeals result.
  const active = new Set<string>(["deal-1", "deal-2"]);

  it("deal-gone + pristine → archive(deal_gone)", () => {
    const action = orphanAction(
      makeExisting({ deal_id: "deal-GONE" }),
      active,
    );
    expect(action).toEqual({ kind: "archive", reason: "deal_gone" });
  });

  it("deal-gone + progressed (funding in flight) → flag(orphan_review), never archive", () => {
    const action = orphanAction(
      makeExisting({ deal_id: "deal-GONE", funding_initiated: true }),
      active,
    );
    expect(action).toEqual({ kind: "flag", sync_flag: "orphan_review" });
  });

  it("deal-gone + progressed (ACAT linked) → flag(orphan_review)", () => {
    const action = orphanAction(
      makeExisting({ deal_id: "deal-GONE", acat_transfer_id: "acat-uuid" }),
      active,
    );
    expect(action).toEqual({ kind: "flag", sync_flag: "orphan_review" });
  });

  it("deal-gone + ACAT linked via acat_record_id only → flag, NOT archive (#151)", () => {
    const action = orphanAction(
      makeExisting({ deal_id: "deal-GONE", acat_record_id: "rec-uuid" }),
      active,
    );
    expect(action).toEqual({ kind: "flag", sync_flag: "orphan_review" });
  });

  it("deal_id present in the active set → noop (NOT orphaned, even if pristine)", () => {
    expect(orphanAction(makeExisting({ deal_id: "deal-1" }), active)).toEqual({
      kind: "noop",
    });
  });

  it("deal_id null → noop (an unlinked/manual transfer is never swept)", () => {
    expect(orphanAction(makeExisting({ deal_id: null }), active)).toEqual({
      kind: "noop",
    });
  });

  it("idempotent: re-run over the same (still-active) set yields the same actions, no new state", () => {
    // A transfer whose deal is still active stays a noop across runs; a truly
    // orphaned+pristine one resolves to the SAME archive action every call (the
    // route excludes archived_at:null rows on the next run, so it is applied once).
    const stillActive = makeExisting({ deal_id: "deal-2" });
    expect(orphanAction(stillActive, active)).toEqual({ kind: "noop" });
    expect(orphanAction(stillActive, active)).toEqual({ kind: "noop" });

    const orphaned = makeExisting({ deal_id: "deal-GONE" });
    const first = orphanAction(orphaned, active);
    const second = orphanAction(orphaned, active);
    expect(first).toEqual({ kind: "archive", reason: "deal_gone" });
    expect(second).toEqual(first);
  });
});
