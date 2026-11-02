import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DealRow } from "@/lib/data/deal-types";

// Pure (no-DB) cron transfer-sync route cases. The ingest scope, the deals read
// seam, the audit writer, and the feature flag are MOCKED so we exercise auth,
// method-gating, the flag-OFF dark path, and the dryRun-writes-only-the-audit-row
// contract without a database. Follows the account-aum-route.test.ts idiom.

const {
  scopeSpy,
  createSpy,
  updateSpy,
  findManySpy,
  findUniqueSpy,
  lockSpy,
  taskFindManySpy,
  taskCreateManySpy,
  writeAuditSpy,
  listDealsSpy,
  flagSpy,
  signalSpy,
} =
  vi.hoisted(() => {
    const createSpy = vi.fn(async () => ({ id: "new-transfer" }));
    const updateSpy = vi.fn(async () => ({ id: "upd-transfer" }));
    const findManySpy = vi.fn(async () => [] as unknown[]);
    const findUniqueSpy = vi.fn();
    const taskFindManySpy = vi.fn(async () => [] as unknown[]);
    const taskCreateManySpy = vi.fn(async () => ({ count: 0 }));
    const scopeSpy = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        transfer: { findMany: findManySpy, findUnique: findUniqueSpy, create: createSpy, update: updateSpy },
        transferTask: {
          findMany: taskFindManySpy,
          createMany: taskCreateManySpy,
        },
      }),
    );
    return {
      scopeSpy,
      createSpy,
      updateSpy,
      findManySpy,
      findUniqueSpy,
      lockSpy: vi.fn(async () => {}),
      taskFindManySpy,
      taskCreateManySpy,
      writeAuditSpy: vi.fn(async () => {}),
      listDealsSpy: vi.fn(async () => [] as DealRow[]),
      flagSpy: vi.fn(() => true),
      signalSpy: vi.fn(() => true),
    };
  });

vi.mock("@/lib/ingest/scope", () => ({ withIngestScope: scopeSpy }));
vi.mock("@/lib/data/deals", () => ({ listDeals: listDealsSpy }));
vi.mock("@/lib/data/transfer-plan-lock", () => ({ lockTransferPlan: lockSpy }));
vi.mock("@/lib/flags", () => ({ transferDealSourcedRedesignEnabled: flagSpy }));
vi.mock("@/lib/crm/post-commit-signal", () => ({
  scheduleCrmIdentityReconciliation: signalSpy,
}));
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, writeAudit: writeAuditSpy };
});

import * as route from "../../app/api/cron/transfer-sync/route";

const TOKEN = "test-transfer-sync-token";

function post(opts: { auth?: string; url?: string } = {}) {
  const headers = new Headers();
  const auth = "auth" in opts ? opts.auth : `Bearer ${TOKEN}`;
  if (auth !== undefined) headers.set("authorization", auth);
  return new Request(opts.url ?? "https://x/api/cron/transfer-sync", {
    method: "POST",
    headers,
  });
}

// A COMMITTED deal with no existing transfer → reconciles to `create`.
function committedDeal(over: Partial<DealRow> = {}): DealRow {
  return {
    id: "deal-1",
    source: "IMPORT",
    sf_deal_id: "SF-DEAL-1",
    name: "New client rollover",
    client_first_name: "Willie",
    client_last_name: "Client",
    household_name: "Client HH",
    household_sf_id: "001HH",
    client_sf_id: "003C",
    amount: 100000,
    stage: "COMMITTED",
    stage_raw: null,
    created_date: new Date("2026-06-01"),
    close_date: null,
    last_activity_date: null,
    owner_name: null,
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
    account_type: null,
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

// The minimal Prisma-Transfer-shaped row `toExisting` reads for the §4.1 orphan
// sweep. Pristine + active-linked by default; override deal_id / workflow fields
// per case. Returned by findManySpy for the orphan (deal_id:{not:null}) query.
function transferRow(over: Record<string, unknown> = {}) {
  return {
    id: "transfer-orphan",
    deal_id: "deal-gone",
    stage: "DECISION",
    funding_type: null,
    client_first_name: "Willie",
    client_last_name: "Client",
    client_sf_id: "003C",
    household_name: "Client HH",
    household_sf_id: "001HH",
    value: 100000,
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

// Route findMany with two calls per run: pass 1 (existing-by-deal_id, where
// deal_id:{in:[...]}) and pass 2 (orphan sweep, where deal_id:{not:null}). Wire
// findManySpy to return `orphans` only for the orphan-sweep query, [] otherwise.
function wireFindMany(orphans: unknown[]) {
  findManySpy.mockImplementation(async (args?: { where?: { deal_id?: Record<string, unknown> } }) => {
    const dealIdFilter = args?.where?.deal_id ?? {};
    return "not" in dealIdFilter ? orphans : [];
  });
}

describe("POST /api/cron/transfer-sync — pure (mocked scope/seam/flag)", () => {
  const originalToken = process.env.INGEST_TOKEN;

  beforeEach(() => {
    process.env.INGEST_TOKEN = TOKEN;
    scopeSpy.mockClear();
    createSpy.mockClear();
    updateSpy.mockClear();
    findManySpy.mockClear();
    findManySpy.mockResolvedValue([]);
    findUniqueSpy.mockReset();
    findUniqueSpy.mockImplementation(async ({ where }: { where: { id: string } }) => {
      for (const result of findManySpy.mock.results) {
        if (result.type !== "return") continue;
        const rows = await result.value as { id: string }[];
        const row = rows.find((candidate) => candidate.id === where.id);
        if (row) return row;
      }
      return null;
    });
    lockSpy.mockClear();
    taskFindManySpy.mockClear();
    taskFindManySpy.mockResolvedValue([]);
    taskCreateManySpy.mockClear();
    taskCreateManySpy.mockResolvedValue({ count: 0 });
    writeAuditSpy.mockClear();
    listDealsSpy.mockClear();
    listDealsSpy.mockResolvedValue([]);
    flagSpy.mockReturnValue(true);
    signalSpy.mockClear();
  });
  afterEach(() => {
    if (originalToken === undefined) delete process.env.INGEST_TOKEN;
    else process.env.INGEST_TOKEN = originalToken;
    vi.restoreAllMocks();
  });

  it("auth: wrong bearer → 401, never reads deals or writes", async () => {
    const res = await route.POST(post({ auth: "Bearer wrong" }));
    expect(res.status).toBe(401);
    expect(listDealsSpy).not.toHaveBeenCalled();
    expect(scopeSpy).not.toHaveBeenCalled();
  });

  it("auth: missing bearer → 401", async () => {
    const res = await route.POST(post({ auth: undefined }));
    expect(res.status).toBe(401);
  });

  it("non-POST verbs → 405 on every verb", async () => {
    for (const verb of [route.GET, route.PUT, route.PATCH, route.DELETE]) {
      const res = verb();
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ error: "method_not_allowed" });
    }
  });

  it("flag OFF → { synced: 0, skipped: 'flag_off' }, NO writes at all (not even audit), no deals read", async () => {
    flagSpy.mockReturnValue(false);
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ synced: 0, skipped: "flag_off" });
    expect(listDealsSpy).not.toHaveBeenCalled();
    expect(scopeSpy).not.toHaveBeenCalled();
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });

  it("flag ON, dryRun=1 → computes counts, writes ONLY the audit row (no create/update)", async () => {
    listDealsSpy.mockResolvedValue([committedDeal()]);
    const res = await route.POST(post({ url: "https://x/api/cron/transfer-sync?dryRun=1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.received).toBe(1);
    expect(body.created).toBe(1); // the action was COMPUTED
    expect(body.dry_run).toBe(true);
    // No reconcile write executed; only the audit row.
    expect(createSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(scopeSpy).toHaveBeenCalledTimes(1);
    expect(writeAuditSpy).toHaveBeenCalledTimes(1);
    expect(signalSpy).not.toHaveBeenCalled();
    const [, identity, entry] = writeAuditSpy.mock.calls[0] as unknown[] as [
      unknown,
      { role: string; email: null },
      { action: string; detail: Record<string, unknown> },
    ];
    expect(identity).toEqual({ role: "INGEST", email: null });
    expect(entry.action).toBe("ingest.transfer_sync");
    expect(entry.detail).toMatchObject({ received: 1, created: 1, dry_run: true });
  });

  it("flag ON, live → executes the create + writes the audit row (dry_run false)", async () => {
    listDealsSpy.mockResolvedValue([committedDeal()]);
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.received).toBe(1);
    expect(body.created).toBe(1);
    expect(body.dry_run).toBe(false);
    expect(body.source).toBe("app.deal");
    expect(createSpy).toHaveBeenCalledTimes(1);
    // The seeded create carries the sync's fixed shape + DECISION tasks.
    const data = ((createSpy.mock.calls[0] as unknown[])[0] as {
      data: Record<string, unknown>;
    }).data;
    expect(data.source).toBe("IMPORT");
    expect(data.stage).toBe("DECISION");
    expect(data.owner_kind).toBe("CLIENT_SERVICE");
    expect(data.deal_id).toBe("deal-1");
    expect(data.value).toBe(100000);
    expect(writeAuditSpy).toHaveBeenCalledTimes(1);
    const entry = (writeAuditSpy.mock.calls[0] as unknown[])[2] as {
      detail: Record<string, unknown>;
    };
    expect(entry.detail).toMatchObject({ created: 1, dry_run: false });
    expect(signalSpy).toHaveBeenCalledTimes(1);
    expect(signalSpy).toHaveBeenCalledWith("transfer_sync");
  });

  it("flag ON, live → an ADVANCING deal (FUNDING over a DECISION transfer) writes the forward-only stage", async () => {
    // ticket sync-stage-mapping: the deal drives the transfer stage. A FUNDING
    // deal whose existing transfer is still at DECISION advances → IN_TRANSFER.
    // All deal-owned fields already match (committedDeal ⇄ transferRow defaults),
    // so the ONLY write is the stage advance.
    listDealsSpy.mockResolvedValue([committedDeal({ id: "deal-1", stage: "FUNDING" })]);
    findManySpy.mockImplementation(
      async (args?: { where?: { deal_id?: Record<string, unknown> } }) => {
        const dealIdFilter = args?.where?.deal_id ?? {};
        // pass 1 (existing-by-deal_id, `in`) returns the DECISION transfer;
        // pass 2 (orphan sweep, `not`) sees no orphans (its deal is active).
        return "in" in dealIdFilter
          ? [transferRow({ id: "t-1", deal_id: "deal-1", stage: "DECISION" })]
          : [];
      },
    );
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(1);
    expect(body.stage_advanced).toBe(1);
    expect(createSpy).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const data = ((updateSpy.mock.calls[0] as unknown[])[0] as {
      data: Record<string, unknown>;
    }).data;
    expect(data.stage).toBe("IN_TRANSFER");
    expect(taskFindManySpy).toHaveBeenCalledWith({
      where: { transfer_id: "t-1" },
      select: { title: true, sort_order: true },
    });
    expect(taskCreateManySpy).toHaveBeenCalledTimes(1);
    const seeded = (taskCreateManySpy.mock.calls[0] as unknown[])[0] as {
      data: { transfer_id: string; title: string; sort_order: number }[];
    };
    expect(seeded.data.map((task) => task.title)).toEqual([
      "ACAT submitted to Apex",
      "Transfer accepted by contra",
      "Positions settling",
      "Cost basis received",
    ]);
    expect(seeded.data.every((task) => task.transfer_id === "t-1")).toBe(true);
    expect(signalSpy).not.toHaveBeenCalled();
    const entry = (writeAuditSpy.mock.calls[0] as unknown[])[2] as {
      detail: Record<string, unknown>;
    };
    expect(entry.detail).toMatchObject({ updated: 1, stage_advanced: 1 });
  });

  it("flag ON, live → a re-committed deal AUTO-HEALS its transfer's stale sync_flag (update writes sync_flag: null)", async () => {
    // transfer-syncflag-surface: the reconciler flagged this transfer while its
    // deal sat in POTENTIAL; the deal is back at COMMITTED with no drift, so the
    // ONLY write is the flag clear — riding the normal update path (applyAction
    // spreads changes verbatim, updated_by stays null for the ingest actor).
    listDealsSpy.mockResolvedValue([committedDeal({ id: "deal-1", stage: "COMMITTED" })]);
    findManySpy.mockImplementation(
      async (args?: { where?: { deal_id?: Record<string, unknown> } }) => {
        const dealIdFilter = args?.where?.deal_id ?? {};
        return "in" in dealIdFilter
          ? [
              transferRow({
                id: "t-1",
                deal_id: "deal-1",
                stage: "DECISION",
                sync_flag: "uncommitted_review",
              }),
            ]
          : [];
      },
    );
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(1);
    expect(body.stage_advanced).toBe(0); // COMMITTED ↔ DECISION: no advance
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const call = (updateSpy.mock.calls[0] as unknown[])[0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ id: "t-1" });
    expect(call.data.sync_flag).toBeNull();
    expect(call.data.updated_by).toBeNull();
    expect(call.data.stage).toBeUndefined();
    expect(call.data.archived_at).toBeUndefined();
    expect(taskFindManySpy).not.toHaveBeenCalled();
    expect(taskCreateManySpy).not.toHaveBeenCalled();
  });

  it("only reconcilable stages are read forward; deals read failure → 500", async () => {
    listDealsSpy.mockRejectedValue(new Error("db down"));
    const res = await route.POST(post());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
    expect(scopeSpy).not.toHaveBeenCalled();
    expect(signalSpy).not.toHaveBeenCalled();
  });

  it("refreshes DRS deal fields without advancing its stage or seeding ACAT tasks", async () => {
    listDealsSpy.mockResolvedValue([committedDeal({ stage: "WON", amount: 123 })]);
    findManySpy.mockResolvedValue([transferRow({ deal_id: "deal-1", funding_type: "DRS" })]);
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ updated: 1, stage_advanced: 0 });
    expect(updateSpy).toHaveBeenCalledExactlyOnceWith({
      where: { id: "transfer-orphan" }, data: { value: 123, updated_by: null },
    });
    expect(taskCreateManySpy).not.toHaveBeenCalled();
  });

  it("rechecks a concurrent DRS approval under the row lock before an automated advance", async () => {
    const original = transferRow({ deal_id: "deal-1", funding_plan_complete: true, funding_plan_version: 1 });
    listDealsSpy.mockResolvedValue([committedDeal({ stage: "WON" })]);
    findManySpy.mockResolvedValue([original]);
    findUniqueSpy.mockResolvedValue({ ...original, funding_type: "DRS", funding_plan_complete: true });
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ noop: 1, stage_advanced: 0 });
    expect(lockSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(taskCreateManySpy).not.toHaveBeenCalled();
  });

  it("rechecks a concurrent DRS approval before an orphan archive and flags review instead", async () => {
    const original = transferRow();
    wireFindMany([original]);
    findUniqueSpy.mockResolvedValue({ ...original, funding_type: "DRS", funding_plan_complete: true });
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ orphan_archived: 0, orphan_flagged: 1 });
    expect(lockSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledExactlyOnceWith({
      where: { id: "transfer-orphan" }, data: { sync_flag: "orphan_review", updated_by: null },
    });
  });

  it.each([
    { funding_plan_complete: false, funding_plan_version: 0 },
    { funding_plan_complete: true, funding_plan_version: 0 },
    { funding_plan_complete: false, funding_plan_version: 2 },
  ])("holds existing In transfer completion without current approval: %j", async (approval) => {
    listDealsSpy.mockResolvedValue([committedDeal({ stage: "WON" })]);
    findManySpy.mockResolvedValue([transferRow({ deal_id: "deal-1", stage: "IN_TRANSFER", ...approval })]);
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ noop: 1, updated: 0, created: 0, stage_advanced: 0 });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(taskFindManySpy).not.toHaveBeenCalled();
    expect(taskCreateManySpy).not.toHaveBeenCalled();
    expect(writeAuditSpy).toHaveBeenCalledTimes(1); // normal run summary, no completion event
    expect((writeAuditSpy.mock.calls[0] as unknown[])[2]).toMatchObject({
      detail: expect.objectContaining({ stage_advanced: 0 }),
    });
  });

  it("refreshes source metadata while holding an unapproved existing In transfer stage", async () => {
    listDealsSpy.mockResolvedValue([committedDeal({ stage: "WON", amount: 777 })]);
    findManySpy.mockResolvedValue([transferRow({ deal_id: "deal-1", stage: "IN_TRANSFER" })]);
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ updated: 1, stage_advanced: 0 });
    expect(updateSpy).toHaveBeenCalledExactlyOnceWith({
      where: { id: "transfer-orphan" }, data: { value: 777, updated_by: null },
    });
    expect(taskCreateManySpy).not.toHaveBeenCalled();
  });

  it("advances an explicitly approved existing record after the locked reread, with a guarded write", async () => {
    listDealsSpy.mockResolvedValue([committedDeal({ stage: "WON" })]);
    findManySpy.mockResolvedValue([transferRow({ deal_id: "deal-1", stage: "IN_TRANSFER",
      funding_plan_complete: true, funding_plan_version: 2 })]);
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ updated: 1, stage_advanced: 1 });
    expect(lockSpy).toHaveBeenCalledTimes(1);
    expect(findUniqueSpy).toHaveBeenCalledWith({ where: { id: "transfer-orphan" } });
    expect(updateSpy).toHaveBeenCalledExactlyOnceWith({
      where: { id: "transfer-orphan", stage: "IN_TRANSFER", archived_at: null,
        funding_plan_complete: true, funding_plan_version: 2, funding_route_change_pending: false },
      data: { stage: "FUNDED", updated_by: null },
    });
    expect(taskCreateManySpy).toHaveBeenCalledTimes(1);
  });

  it("holds completion when a funding route changes after the batch read", async () => {
    const original = transferRow({ deal_id: "deal-1", stage: "IN_TRANSFER",
      funding_plan_complete: true, funding_plan_version: 2 });
    listDealsSpy.mockResolvedValue([committedDeal({ stage: "WON" })]);
    findManySpy.mockResolvedValue([original]);
    findUniqueSpy.mockResolvedValue({ ...original, funding_route_change_pending: true });
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ noop: 1, stage_advanced: 0 });
    expect(lockSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(taskCreateManySpy).not.toHaveBeenCalled();
  });

  it.each([false, true])("rechecks invalidation after the batch read and preserves metadata refresh=%s", async (metadataDrift) => {
    const original = transferRow({ deal_id: "deal-1", stage: "IN_TRANSFER",
      funding_plan_complete: true, funding_plan_version: 2 });
    listDealsSpy.mockResolvedValue([committedDeal({ stage: "WON", ...(metadataDrift ? { amount: 777 } : {}) })]);
    findManySpy.mockResolvedValue([original]);
    findUniqueSpy.mockResolvedValue({ ...original, funding_plan_complete: false, funding_plan_version: 3 });
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stage_advanced: 0, updated: metadataDrift ? 1 : 0 });
    expect(lockSpy).toHaveBeenCalledTimes(1);
    if (metadataDrift) expect(updateSpy).toHaveBeenCalledExactlyOnceWith({
      where: { id: "transfer-orphan" }, data: { value: 777, updated_by: null },
    });
    else expect(updateSpy).not.toHaveBeenCalled();
    expect(taskFindManySpy).not.toHaveBeenCalled();
    expect(taskCreateManySpy).not.toHaveBeenCalled();
  });

  it("does not seed destination tasks or report success when the completion write loses its predicate", async () => {
    listDealsSpy.mockResolvedValue([committedDeal({ stage: "WON" })]);
    findManySpy.mockResolvedValue([transferRow({ deal_id: "deal-1", stage: "IN_TRANSFER",
      funding_plan_complete: true, funding_plan_version: 2 })]);
    updateSpy.mockRejectedValueOnce(new Error("conditional write no longer matches"));
    const res = await route.POST(post());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
    expect(taskCreateManySpy).not.toHaveBeenCalled();
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });

  it("preserves initial source materialization of an already-Won deal at Funded", async () => {
    listDealsSpy.mockResolvedValue([committedDeal({ stage: "WON" })]);
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: 1, updated: 0, stage_advanced: 0 });
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect((createSpy.mock.calls[0] as unknown[])[0]).toMatchObject({ data: {
      source: "IMPORT", stage: "FUNDED", deal_id: "deal-1",
    } });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("does not signal when the ingest transaction fails", async () => {
    listDealsSpy.mockResolvedValue([committedDeal()]);
    scopeSpy.mockRejectedValueOnce(new Error("transaction failed"));

    const res = await route.POST(post());

    expect(res.status).toBe(500);
    expect(signalSpy).not.toHaveBeenCalled();
  });

  // §4.1 ORPHAN SWEEP -------------------------------------------------------

  it("orphan sweep: active transfer whose deal is gone + pristine → archived(deal_gone)", async () => {
    listDealsSpy.mockResolvedValue([]); // no active deals → activeDealIds empty
    wireFindMany([transferRow({ deal_id: "deal-gone" })]);
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orphan_archived).toBe(1);
    expect(body.orphan_flagged).toBe(0);
    expect(createSpy).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const data = ((updateSpy.mock.calls[0] as unknown[])[0] as {
      data: Record<string, unknown>;
    }).data;
    expect(data.archived_reason).toBe("deal_gone");
    expect(data.archived_at).toBeInstanceOf(Date);
    const entry = (writeAuditSpy.mock.calls[0] as unknown[])[2] as {
      detail: Record<string, unknown>;
    };
    expect(entry.detail).toMatchObject({ orphan_archived: 1, orphan_flagged: 0 });
  });

  it("orphan sweep: deal gone + PROGRESSED transfer → flagged(orphan_review), never archived", async () => {
    listDealsSpy.mockResolvedValue([]);
    wireFindMany([transferRow({ deal_id: "deal-gone", funding_initiated: true })]);
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orphan_flagged).toBe(1);
    expect(body.orphan_archived).toBe(0);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const data = ((updateSpy.mock.calls[0] as unknown[])[0] as {
      data: Record<string, unknown>;
    }).data;
    expect(data.sync_flag).toBe("orphan_review");
    expect(data.archived_at).toBeUndefined(); // NOT a teardown
  });

  it("orphan sweep: a transfer whose deal IS active is untouched", async () => {
    // Deal still active (present in listDeals) → in activeDealIds → orphan noop.
    // The deal is WON and its transfer is ALREADY at FUNDED, so the active pass
    // is a noop too (deal-driven stage already satisfied, no drift) — pass 1
    // returns the existing row so WON does not create/advance it.
    listDealsSpy.mockResolvedValue([committedDeal({ id: "deal-active", stage: "WON" })]);
    findManySpy.mockImplementation(
      async (args?: { where?: { deal_id?: Record<string, unknown> } }) => {
        const dealIdFilter = args?.where?.deal_id ?? {};
        const row = transferRow({ deal_id: "deal-active", stage: "FUNDED" });
        // both passes see the (active, deal-linked, FUNDED) transfer.
        return "in" in dealIdFilter ? [row] : [row];
      },
    );
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orphan_archived).toBe(0);
    expect(body.orphan_flagged).toBe(0);
    expect(createSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("orphan sweep: flag OFF → zero reads/writes (no deals read, no scope, no findMany)", async () => {
    flagSpy.mockReturnValue(false);
    wireFindMany([transferRow({ deal_id: "deal-gone" })]);
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ synced: 0, skipped: "flag_off" });
    expect(listDealsSpy).not.toHaveBeenCalled();
    expect(scopeSpy).not.toHaveBeenCalled();
    expect(findManySpy).not.toHaveBeenCalled();
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });

  it("orphan sweep: dryRun computes orphan counts but writes ONLY the audit row", async () => {
    listDealsSpy.mockResolvedValue([]);
    wireFindMany([transferRow({ deal_id: "deal-gone" })]);
    const res = await route.POST(post({ url: "https://x/api/cron/transfer-sync?dryRun=1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orphan_archived).toBe(1);
    expect(body.dry_run).toBe(true);
    expect(createSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled(); // no transfer write in a dry run
    expect(writeAuditSpy).toHaveBeenCalledTimes(1);
    const entry = (writeAuditSpy.mock.calls[0] as unknown[])[2] as {
      detail: Record<string, unknown>;
    };
    expect(entry.detail).toMatchObject({ orphan_archived: 1, dry_run: true });
  });
});
