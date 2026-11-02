import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { listTransfers, transferOpsStats } from "@/lib/data/transfers";
import type { Identity } from "@/lib/data/types";

// DB-gated seam test for the FUNDED board fall-off rule (TKT board-behavior).
//
// The transfers seam (`listTransfers`) filters in SQL against a live RLS-scoped
// Postgres, so — like the ingest integration cases (test/ingest/db-fixture.ts)
// — the ONLY faithful test drives the real query. Gate on INGEST_DATABASE_URL,
// the SAME switch the ingest integration suites use (test/ingest/db-fixture.ts:
// `dbGated`). The DB-backed CI job sets both URLs and executes this suite. A
// developer's plain `npm run test` leaves INGEST_DATABASE_URL unset, so it
// never seeds/tears-down a local `aoa` DB unasked. To RUN it locally, set
// INGEST_DATABASE_URL (the gate) AND DATABASE_URL (the app `prisma` singleton
// that withUserScope reads through) to the target DB.
//
// Fixtures are seeded + torn down through a SEPARATE superuser/BYPASSRLS
// connection because app roles (app_rw) have NO DELETE grant (ADR-7) and the
// insert must bypass FORCE RLS. All ids are namespaced (TEST-FALLOFF-*) so
// teardown is exact and a partial run leaves nothing stray. The app-role
// `prisma` singleton (DATABASE_URL) does the reads, exactly as the app does.

const RUN = process.env.INGEST_DATABASE_URL ? describe : describe.skip;

// Superuser/BYPASSRLS client for seed + teardown (app_rw cannot DELETE). Prefer
// an explicit cleanup URL; else a peer-auth connection as the local OS user
// (SUPERUSER + BYPASSRLS in the local aoa stack — libpq peer auth, no password).
function makeSudoClient(): PrismaClient {
  const url =
    process.env.INGEST_TEST_CLEANUP_URL ??
    `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/aoa?schema=app`;
  return new PrismaClient({ datasources: { db: { url } } });
}

// OPERATIONS identity — the transfer read policies are all-roles-read (no book
// scoping), so any valid role sees every seeded row.
const OPS: Identity = { role: "OPERATIONS", email: "ops@example.com" };

const IDS = {
  fundedDone: "TEST-FALLOFF-F-DONE",
  fundedIncomplete: "TEST-FALLOFF-F-INCOMPLETE",
  fundedAccumulated: "TEST-FALLOFF-F-ACCUMULATED",
  fundedZero: "TEST-FALLOFF-F-ZERO",
  decisionIncomplete: "TEST-FALLOFF-D-INCOMPLETE",
  inTransferDone: "TEST-FALLOFF-I-DONE",
  // Count-parity fixtures: DECISION transfers seeded with the FULL pre-trim
  // 11-title checklist (as existing rows have). The board card's tasksTotal/
  // tasksDone must count only the VISIBLE tasks (visibleTasks), so the card
  // matches the trimmed detail checklist.
  decisionFull: "TEST-FALLOFF-D-FULL", // funding_type ACAT_FULL → worksheet hidden
  decisionPartial: "TEST-FALLOFF-D-PARTIAL", // ACAT_PARTIAL → worksheet shown
  // deal-card mirror S2: a linked deal supplies the mirrored flags. The board
  // count must RESOLVE the synced tasks (override_done ?? deal flag ?? done).
  // Two deals (transfer.deal_id is UNIQUE — one transfer per deal), both
  // statements=true / asset_mapped=false.
  deal: "TEST-FALLOFF-DEAL",
  dealOverride: "TEST-FALLOFF-DEAL-OVR",
  decisionMirror: "TEST-FALLOFF-D-MIRROR", // synced tasks follow the deal
  decisionMirrorOverride: "TEST-FALLOFF-D-MIRROR-OVR", // ops override wins
  // Fall-off + mirror: a FUNDED transfer whose synced tasks are DEAL-complete
  // (raw done=false) must still fall off under hideCompletedFunded (M1).
  dealFundedComplete: "TEST-FALLOFF-DEAL-FC", // statements=true AND asset_mapped=true
  fundedMirrorComplete: "TEST-FALLOFF-F-MIRROR",
  // value-follows-deal: a deal whose amount ($7,500) DIFFERS from the linked
  // transfer's stored value ($1,000). The board + stats must show/sum the deal
  // amount (deal owns the amount — resolveTransferValue / COALESCE(d.amount,…)).
  dealAmt: "TEST-FALLOFF-DEAL-AMT",
  decisionAmt: "TEST-FALLOFF-D-AMT",
  // Archived fall-off (feat/transfer-archive-falloff): a soft-archived,
  // NON-FUNDED, ADVISOR-owned transfer with an incomplete task. Non-FUNDED +
  // incomplete makes it the sharpest fixture: the completed-FUNDED fall-off's
  // OR would KEEP it, so its absence under BOTH option combinations proves the
  // archived predicate is ANDed (parenthesized) correctly, not OR-merged.
  // ADVISOR-owned so the opsbar `bouncing` count is exercised too.
  archivedDecision: "TEST-FALLOFF-ARCH-D",
  // Canonical-dev parity: stable demo IDs are retained but can be hidden from
  // the shared board and KPI reads with a dev-only runtime flag.
  demoDecision: "DEMO-T-TEST-FALLOFF",
  // The sync creates a normal transfer id for an eligible synthetic DEMO-* deal.
  // This is the production-shaped leak that canonical dev must also hide.
  demoDeal: "TEST-FALLOFF-DEMO-DEAL",
  demoDealDerived: "TEST-FALLOFF-DEMO-DERIVED",
} as const;

// The pre-trim DECISION checklist (what existing transfers seeded). 4 always
// visible, 5 hidden, 2 partial-ACAT-only.
const ALL_DECISION_TITLES = [
  "Collect statements", // visible
  "Run asset mapper", // visible
  "Resolve review items", // hidden
  "Advisor meeting scheduled", // hidden
  "Advisor meeting held", // hidden
  "Asset decisions made", // hidden
  "Send decision worksheet", // partial-only
  "Asset decisions finalized", // partial-only
  "Open receiving accounts", // visible
  "Confirm account numbers", // visible
  "Submit ACAT to Apex", // hidden
] as const;

// Mark one VISIBLE title and one HIDDEN title done — proves tasksDone counts
// only visible-done (the hidden done row must not inflate the numerator).
const DONE_TITLES = new Set(["Collect statements", "Advisor meeting held"]);

async function seed(sudo: PrismaClient) {
  await teardown(sudo); // idempotent: clear any residue from a prior partial run

  const base = {
    source: "APP" as const,
    client_first_name: "Falloff",
    value: "1000.00",
    owner_kind: "OPERATIONS" as const,
  };

  // FUNDED + all tasks done → EXCLUDED.
  await sudo.transfer.create({
    data: {
      ...base,
      id: IDS.fundedDone,
      client_last_name: "FundedDone",
      stage: "FUNDED",
      tasks: {
        create: [
          { title: "t1", sort_order: 0, done: true },
          { title: "t2", sort_order: 1, done: true },
        ],
      },
    },
  });

  // Current-stage parity: retained IN_TRANSFER history is 3/4 complete, while
  // the FUNDED checklist is 1/4 complete. The board's stage-scoped mode must
  // report the same 1/4 the detail page renders, never the accumulated 4/8.
  await sudo.transfer.create({
    data: {
      ...base,
      id: IDS.fundedAccumulated,
      client_last_name: "FundedAccumulated",
      stage: "FUNDED",
      tasks: {
        create: [
          { title: "ACAT submitted to Apex", sort_order: 0, done: true },
          { title: "Transfer accepted by contra", sort_order: 1, done: true },
          { title: "Positions settling", sort_order: 2, done: true },
          { title: "Cost basis received", sort_order: 3, done: false },
          { title: "All positions received", sort_order: 4, done: true },
          { title: "Cost basis verified", sort_order: 5, done: false },
          { title: "Transition template applied", sort_order: 6, done: false },
          { title: "Fee reimbursement filed", sort_order: 7, done: false },
        ],
      },
    },
  });

  // FUNDED + one incomplete task → INCLUDED (still in the Funded lane).
  await sudo.transfer.create({
    data: {
      ...base,
      id: IDS.fundedIncomplete,
      client_last_name: "FundedIncomplete",
      stage: "FUNDED",
      tasks: {
        create: [
          { title: "t1", sort_order: 0, done: true },
          { title: "t2", sort_order: 1, done: false },
        ],
      },
    },
  });

  // FUNDED + zero tasks → EXCLUDED (vacuously "no incomplete task"; documents the
  // edge — a sync-created FUNDED transfer with an empty checklist falls off).
  await sudo.transfer.create({
    data: {
      ...base,
      id: IDS.fundedZero,
      client_last_name: "FundedZero",
      stage: "FUNDED",
    },
  });

  // DECISION + incomplete tasks → INCLUDED (non-FUNDED is never hidden).
  await sudo.transfer.create({
    data: {
      ...base,
      id: IDS.decisionIncomplete,
      client_last_name: "DecisionIncomplete",
      stage: "DECISION",
      tasks: {
        create: [
          { title: "t1", sort_order: 0, done: false },
          { title: "t2", sort_order: 1, done: false },
        ],
      },
    },
  });

  // IN_TRANSFER + ALL tasks done → INCLUDED (the "all done" rule applies ONLY to
  // FUNDED; a completed non-FUNDED transfer still shows).
  await sudo.transfer.create({
    data: {
      ...base,
      id: IDS.inTransferDone,
      client_last_name: "InTransferDone",
      stage: "IN_TRANSFER",
      tasks: {
        create: [
          { title: "t1", sort_order: 0, done: true },
          { title: "t2", sort_order: 1, done: true },
        ],
      },
    },
  });

  // Count-parity: DECISION with the full 11-title template. funding_type
  // ACAT_FULL → the 2 worksheet titles are hidden, the 5 removed titles hidden
  // → only 4 visible. One visible + one hidden title are done.
  const fullTemplate = ALL_DECISION_TITLES.map((title, i) => ({
    title,
    sort_order: i,
    done: DONE_TITLES.has(title),
  }));
  await sudo.transfer.create({
    data: {
      ...base,
      id: IDS.decisionFull,
      client_last_name: "DecisionFull",
      stage: "DECISION",
      funding_type: "ACAT_FULL",
      tasks: { create: fullTemplate },
    },
  });

  // Same full template but ACAT_PARTIAL → the 2 worksheet titles are now
  // visible → 6 visible.
  await sudo.transfer.create({
    data: {
      ...base,
      id: IDS.decisionPartial,
      client_last_name: "DecisionPartial",
      stage: "DECISION",
      funding_type: "ACAT_PARTIAL",
      tasks: { create: fullTemplate },
    },
  });

  // deal-card mirror S2: real linked deals. Transfer.deal_id is a bare SCALAR
  // (no Prisma relation) AND UNIQUE (one transfer per deal), so seed one deal
  // PER transfer. Both statements=true, asset_mapped=false.
  const dealData = (id: string, asset_mapped = false) => ({
    id,
    source: "APP" as const,
    name: "Falloff Deal",
    client_first_name: "Falloff",
    client_last_name: "Deal",
    amount: "1000.00",
    stage: "COMMITTED" as const,
    created_date: new Date("2026-07-01"),
    statements: true,
    asset_mapped,
  });
  await sudo.deal.create({ data: dealData(IDS.deal) });
  await sudo.deal.create({ data: dealData(IDS.dealOverride) });
  await sudo.deal.create({
    data: { ...dealData(IDS.demoDeal), sf_deal_id: "DEMO-TEST-FALLOFF" },
  });
  // FUNDED-fall-off deal: BOTH flags true → both synced tasks resolve DONE.
  await sudo.deal.create({ data: dealData(IDS.dealFundedComplete, true) });

  // FUNDED transfer whose two synced tasks are raw done=false but the deal
  // completes them (statements=true, asset_mapped=true) → resolved DONE → under
  // hideCompletedFunded it must FALL OFF (M1: the fall-off resolves too).
  await sudo.transfer.create({
    data: {
      ...base,
      id: IDS.fundedMirrorComplete,
      client_last_name: "FundedMirrorComplete",
      stage: "FUNDED",
      deal_id: IDS.dealFundedComplete,
      tasks: {
        create: [
          { title: "Collect statements", sort_order: 0, done: false },
          { title: "Run asset mapper", sort_order: 1, done: false },
        ],
      },
    },
  });

  // Two synced tasks, both done=false. "Collect statements" follows deal
  // (statements=true → resolves DONE); "Run asset mapper" follows deal
  // (asset_mapped=false → resolves NOT done). override_done omitted = NULL.
  await sudo.transfer.create({
    data: {
      ...base,
      id: IDS.decisionMirror,
      client_last_name: "DecisionMirror",
      stage: "DECISION",
      funding_type: "ACAT_FULL",
      deal_id: IDS.deal,
      tasks: {
        create: [
          { title: "Collect statements", sort_order: 0, done: false },
          { title: "Run asset mapper", sort_order: 1, done: false },
        ],
      },
    },
  });

  // Same deal (statements=true) but ops OVERRODE "Collect statements" to false
  // → override wins → resolves NOT done (deal ignored).
  await sudo.transfer.create({
    data: {
      ...base,
      id: IDS.decisionMirrorOverride,
      client_last_name: "DecisionMirrorOverride",
      stage: "DECISION",
      funding_type: "ACAT_FULL",
      deal_id: IDS.dealOverride,
      tasks: {
        create: [
          { title: "Collect statements", sort_order: 0, done: false, override_done: false },
          { title: "Run asset mapper", sort_order: 1, done: false },
        ],
      },
    },
  });

  // Archived (soft-deleted) DECISION transfer — the reconciler's deal_lost
  // stamp shape (archived_by null; the manual action would stamp an email).
  await sudo.transfer.create({
    data: {
      ...base,
      id: IDS.archivedDecision,
      client_last_name: "ArchivedDecision",
      stage: "DECISION",
      owner_kind: "ADVISOR",
      archived_at: new Date("2026-07-01T00:00:00Z"),
      archived_reason: "deal_lost",
      tasks: {
        create: [{ title: "t1", sort_order: 0, done: false }],
      },
    },
  });

  // value-follows-deal: deal amount $7,500 vs the transfer's stored value $1,000.
  await sudo.deal.create({
    data: { ...dealData(IDS.dealAmt), amount: "7500.00" },
  });
  await sudo.transfer.create({
    data: {
      ...base, // base.value = "1000.00"
      id: IDS.decisionAmt,
      client_last_name: "DecisionAmt",
      stage: "DECISION",
      funding_type: "ACAT_FULL",
      deal_id: IDS.dealAmt,
      tasks: { create: [{ title: "t1", sort_order: 0, done: false }] },
    },
  });

  await sudo.transfer.create({
    data: {
      ...base,
      id: IDS.demoDecision,
      client_last_name: "DemoDecision",
      stage: "DECISION",
      owner_kind: "ADVISOR",
      tasks: { create: [{ title: "t1", sort_order: 0, done: false }] },
    },
  });

  await sudo.transfer.create({
    data: {
      ...base,
      id: IDS.demoDealDerived,
      client_last_name: "DemoDealDerived",
      stage: "DECISION",
      owner_kind: "ADVISOR",
      deal_id: IDS.demoDeal,
      deal_sf_id: "DEMO-TEST-FALLOFF",
      tasks: { create: [{ title: "t1", sort_order: 0, done: false }] },
    },
  });
}

async function teardown(sudo: PrismaClient) {
  await sudo.$executeRaw`DELETE FROM app.transfer_task WHERE transfer_id = ${IDS.demoDecision}`;
  await sudo.$executeRaw`DELETE FROM app.transfer WHERE id = ${IDS.demoDecision}`;
  await sudo.$executeRaw`DELETE FROM app.transfer_task WHERE transfer_id LIKE 'TEST-FALLOFF-%'`;
  await sudo.$executeRaw`DELETE FROM app.transfer WHERE id LIKE 'TEST-FALLOFF-%'`;
  // deal-card mirror S2: the linked deal fixture (transfer FK is a bare scalar,
  // so no cascade) — delete it after its transfers.
  await sudo.$executeRaw`DELETE FROM app.deal WHERE id LIKE 'TEST-FALLOFF-%'`;
  // The app.transfer AND app.deal INSERT/DELETE fire the row_change trigger
  // (audit.row_change, PR #113); remove BOTH tables' rows so the audit table is
  // left as it was found. Tolerate a DB that predates the audit migration.
  await sudo.$executeRaw`
    DO $$ BEGIN
      IF to_regclass('audit.row_change') IS NOT NULL THEN
        DELETE FROM audit.row_change
        WHERE table_name IN ('transfer', 'deal')
          AND (row_pk LIKE 'TEST-FALLOFF-%' OR row_pk = 'DEMO-T-TEST-FALLOFF');
      END IF;
    END $$`;
}

RUN("listTransfers — FUNDED board fall-off", () => {
  let sudo: PrismaClient;

  beforeAll(async () => {
    sudo = makeSudoClient();
    await seed(sudo);
  });

  afterAll(async () => {
    await teardown(sudo);
    await sudo.$disconnect();
    await prisma.$disconnect();
  });

  // The board opts in; the Transfer-Tracker consumers do not.
  const BOARD = { hideCompletedFunded: true } as const;

  it("WITHOUT the flag, still returns a completed-FUNDED transfer (default is unfiltered — guards the AcatTrackingData linkage-map regression)", async () => {
    // listTransfers is a SHARED seam: its two Transfer-Tracker callers pass NO flag
    // and MUST keep seeing completed-FUNDED transfers, or a linked ACAT would
    // wrongly flip linked→unlinked. Default call = every transfer.
    const ids = (await listTransfers(OPS)).map((r) => r.id);
    expect(ids).toContain(IDS.fundedDone);
    expect(ids).toContain(IDS.fundedZero);
    // Sanity: the unfiltered call also carries the non-FUNDED + FUNDED-incomplete.
    expect(ids).toContain(IDS.fundedIncomplete);
    expect(ids).toContain(IDS.decisionIncomplete);
    expect(ids).toContain(IDS.inTransferDone);
  });

  it("WITH the flag, excludes a FUNDED transfer whose every to-do task is done", async () => {
    const ids = (await listTransfers(OPS, BOARD)).map((r) => r.id);
    expect(ids).not.toContain(IDS.fundedDone);
  });

  it("WITH the flag, includes a FUNDED transfer that still has an incomplete task", async () => {
    const rows = await listTransfers(OPS, BOARD);
    const row = rows.find((r) => r.id === IDS.fundedIncomplete);
    expect(row).toBeDefined();
    expect(row?.stage).toBe("FUNDED");
    // The row still carries its task counts — hiding is all-or-nothing, the
    // aggregates on surviving rows are untouched by the fall-off WHERE.
    expect(row?.tasksTotal).toBe(2);
    expect(row?.tasksDone).toBe(1);
  });

  it("WITH the flag, excludes a FUNDED transfer with zero tasks (vacuous — documents the edge)", async () => {
    const ids = (await listTransfers(OPS, BOARD)).map((r) => r.id);
    expect(ids).not.toContain(IDS.fundedZero);
  });

  it("WITH the flag, always includes non-FUNDED transfers, regardless of task state", async () => {
    const ids = (await listTransfers(OPS, BOARD)).map((r) => r.id);
    // DECISION with incomplete tasks AND IN_TRANSFER with all-done tasks both
    // show — the rule is FUNDED-only.
    expect(ids).toContain(IDS.decisionIncomplete);
    expect(ids).toContain(IDS.inTransferDone);
  });

  it("card counts only VISIBLE DECISION tasks — a full 11-title template shows 4/6, not 11 (matches the trimmed checklist)", async () => {
    const rows = await listTransfers(OPS);
    const full = rows.find((r) => r.id === IDS.decisionFull);
    const partial = rows.find((r) => r.id === IDS.decisionPartial);
    expect(full).toBeDefined();
    expect(partial).toBeDefined();

    // ACAT_FULL: the 5 removed + the 2 worksheet titles are hidden → 4 visible
    // ("Collect statements", "Run asset mapper", "Open receiving accounts",
    // "Confirm account numbers"). NOT 11.
    expect(full?.tasksTotal).toBe(4);
    // Only "Collect statements" (visible) is done; "Advisor meeting held" is
    // hidden-and-done and must NOT be counted → tasksDone = 1.
    expect(full?.tasksDone).toBe(1);

    // ACAT_PARTIAL: the 2 worksheet titles become visible → 6 visible.
    expect(partial?.tasksTotal).toBe(6);
    expect(partial?.tasksDone).toBe(1);
  });

  it("stage-scoped board counts match the FUNDED detail checklist and ignore retained prior-stage tasks", async () => {
    const legacy = (await listTransfers(OPS)).find(
      (row) => row.id === IDS.fundedAccumulated,
    );
    const stageScoped = (
      await listTransfers(OPS, { currentStageChecklistOnly: true })
    ).find((row) => row.id === IDS.fundedAccumulated);

    expect(legacy).toMatchObject({
      tasksDone: 4,
      tasksTotal: 8,
      nextIncompleteTask: "Cost basis received",
    });
    expect(stageScoped).toMatchObject({
      tasksDone: 1,
      tasksTotal: 4,
      nextIncompleteTask: "Cost basis verified",
    });
  });

  it("stage-scoped FUNDED fall-off ignores incomplete historical tasks", async () => {
    // Complete the four FUNDED rows while leaving the historical IN_TRANSFER
    // row open. Stage-scoped fall-off must hide the transfer because its
    // CURRENT checklist is complete; history cannot keep a completed card live.
    await sudo.$executeRaw`
      UPDATE app.transfer_task
      SET done = true
      WHERE transfer_id = ${IDS.fundedAccumulated}
        AND title IN (
          'All positions received',
          'Cost basis verified',
          'Transition template applied',
          'Fee reimbursement filed'
        )`;
    try {
      const ids = (
        await listTransfers(OPS, {
          currentStageChecklistOnly: true,
          hideCompletedFunded: true,
        })
      ).map((row) => row.id);
      expect(ids).not.toContain(IDS.fundedAccumulated);
    } finally {
      await sudo.$executeRaw`
        UPDATE app.transfer_task
        SET done = false
        WHERE transfer_id = ${IDS.fundedAccumulated}
          AND title IN (
            'Cost basis verified',
            'Transition template applied',
            'Fee reimbursement filed'
          )`;
    }
  });

  it("board count RESOLVES synced tasks against the linked deal (deal-card mirror S2)", async () => {
    const rows = await listTransfers(OPS);
    const mirror = rows.find((r) => r.id === IDS.decisionMirror);
    const override = rows.find((r) => r.id === IDS.decisionMirrorOverride);
    expect(mirror).toBeDefined();
    expect(override).toBeDefined();

    // deal.statements=true, asset_mapped=false; both tasks done=false, override
    // NULL. "Collect statements" FOLLOWS the deal → DONE; "Run asset mapper"
    // follows the deal → NOT done. So 1 of 2 counts done — even though BOTH
    // rows' raw `done` is false (proves the count resolves the deal, not raw done).
    expect(mirror?.tasksTotal).toBe(2);
    expect(mirror?.tasksDone).toBe(1);

    // Same deal (statements=true) but ops overrode "Collect statements"=false →
    // override WINS → 0 of 2 done (the deal's true is ignored).
    expect(override?.tasksTotal).toBe(2);
    expect(override?.tasksDone).toBe(0);
  });

  it("board VALUE follows the linked deal's amount (deal owns the amount); an unlinked transfer keeps its own value", async () => {
    const rows = await listTransfers(OPS);
    const linked = rows.find((r) => r.id === IDS.decisionAmt);
    const unlinked = rows.find((r) => r.id === IDS.decisionIncomplete);
    expect(linked).toBeDefined();
    // Stored transfer.value is 1000, deal.amount is 7500 → the deal wins live.
    expect(linked?.value).toBe(7500);
    // No linked deal → COALESCE falls back to the transfer's own stored value.
    expect(unlinked?.value).toBe(1000);
  });

  it("ARCHIVED transfers are excluded by DEFAULT (the seam-level fix: reconciler-stamped rows are zombie cards no more)", async () => {
    const ids = (await listTransfers(OPS)).map((r) => r.id);
    expect(ids).not.toContain(IDS.archivedDecision);
  });

  it("keeps demo transfers by default but hides direct and demo-deal-derived cards in canonical dev", async () => {
    const saved = process.env.HIDE_DEMO_TRANSFER_CARDS;
    try {
      delete process.env.HIDE_DEMO_TRANSFER_CARDS;
      const unfiltered = (await listTransfers(OPS)).map((r) => r.id);
      expect(unfiltered).toContain(IDS.demoDecision);
      expect(unfiltered).toContain(IDS.demoDealDerived);

      process.env.HIDE_DEMO_TRANSFER_CARDS = "1";
      const filtered = (await listTransfers(OPS)).map((r) => r.id);
      expect(filtered).not.toContain(IDS.demoDecision);
      expect(filtered).not.toContain(IDS.demoDealDerived);
    } finally {
      if (saved === undefined) delete process.env.HIDE_DEMO_TRANSFER_CARDS;
      else process.env.HIDE_DEMO_TRANSFER_CARDS = saved;
    }
  });

  it("includeArchived: true returns archived rows (the AcatTrackingData linkage-map opt-in)", async () => {
    const rows = await listTransfers(OPS, { includeArchived: true });
    const row = rows.find((r) => r.id === IDS.archivedDecision);
    expect(row).toBeDefined();
    expect(row?.archived_at).not.toBeNull();
    expect(row?.archived_reason).toBe("deal_lost");
  });

  it("archived exclusion composes with hideCompletedFunded — ANDed, never OR-merged (parenthesization guard)", async () => {
    // The fixture is NON-FUNDED with an incomplete task, so the fall-off's
    // `stage <> 'FUNDED' OR EXISTS(…)` predicate is TRUE for it. If the WHERE
    // were mis-composed as `archived AND not-funded OR EXISTS(…)`, the row
    // would leak back in — so its absence here pins the parentheses.
    const ids = (
      await listTransfers(OPS, { hideCompletedFunded: true })
    ).map((r) => r.id);
    expect(ids).not.toContain(IDS.archivedDecision);
    // Both opts together: archived shows again, completed-FUNDED still hidden.
    const both = (
      await listTransfers(OPS, {
        hideCompletedFunded: true,
        includeArchived: true,
      })
    ).map((r) => r.id);
    expect(both).toContain(IDS.archivedDecision);
    expect(both).not.toContain(IDS.fundedDone);
  });

  it("fall-off RESOLVES synced tasks too: a FUNDED transfer whose synced tasks are deal-complete (raw done=false) still falls off (M1)", async () => {
    // deal.statements=true AND asset_mapped=true → both synced tasks resolve
    // DONE via the mirror, though their raw `done` is false. Under the board
    // flag the fall-off EXISTS must apply the SAME resolution as the card count,
    // so this row has no remaining work and drops off. A raw-done fall-off would
    // wrongly keep it (regression guard for the M1 finding).
    const withFlag = (await listTransfers(OPS, BOARD)).map((r) => r.id);
    expect(withFlag).not.toContain(IDS.fundedMirrorComplete);
    // Sanity: without the flag it is still returned (default is unfiltered).
    const noFlag = (await listTransfers(OPS)).map((r) => r.id);
    expect(noFlag).toContain(IDS.fundedMirrorComplete);
  });
});

RUN("transferOpsStats — opsbar consistency with the fall-off", () => {
  let sudo: PrismaClient;

  beforeAll(async () => {
    sudo = makeSudoClient();
    await seed(sudo);
  });

  afterAll(async () => {
    await teardown(sudo);
    await sudo.$disconnect();
    await prisma.$disconnect();
  });

  it("counts only non-FUNDED transfers, so hiding completed-FUNDED rows never shifts the opsbar", async () => {
    // The three opsbar aggregates all filter stage <> 'FUNDED'. Hidden rows are
    // a strict subset of FUNDED, so the opsbar is unaffected by the fall-off:
    // outstanding == the sum of the VISIBLE non-FUNDED cards, by construction.
    const before = await transferOpsStats(OPS);
    const visibleNonFunded = (
      await listTransfers(OPS, { hideCompletedFunded: true })
    ).filter((r) => r.stage !== "FUNDED");
    const sumVisible = visibleNonFunded.reduce((a, r) => a + r.value, 0);
    // active == the count of visible non-FUNDED cards; outstanding == their sum.
    // The seeded ARCHIVED ADVISOR-owned DECISION row is excluded from BOTH
    // sides of these equalities — this consistency check would fail if the
    // stats query still counted archived rows the list now hides.
    expect(before.active).toBe(visibleNonFunded.length);
    expect(before.outstanding).toBeCloseTo(sumVisible, 2);
    // Our two FUNDED fixtures (done + zero-task, both hidden) contribute nothing.
    expect(visibleNonFunded.some((r) => r.id === IDS.decisionIncomplete)).toBe(
      true,
    );
    expect(visibleNonFunded.some((r) => r.id === IDS.inTransferDone)).toBe(true);
  });

  it("excludes ARCHIVED rows from every aggregate — bouncing does not count the archived ADVISOR-owned transfer", async () => {
    const stats = await transferOpsStats(OPS);
    // bouncing == ADVISOR-owned non-FUNDED among the VISIBLE (non-archived)
    // rows. The archived fixture is ADVISOR + DECISION, so a stats query that
    // ignored archived_at would read one higher than the visible count.
    const visibleBouncing = (
      await listTransfers(OPS)
    ).filter((r) => r.owner_kind === "ADVISOR" && r.stage !== "FUNDED").length;
    expect(stats.bouncing).toBe(visibleBouncing);
    // And the archived row's $1,000 is absent from outstanding (equality with
    // the visible sum is asserted above; this pins the archived leg directly).
    const withArchived = (
      await listTransfers(OPS, { includeArchived: true })
    ).filter((r) => r.stage !== "FUNDED");
    const visibleSum = withArchived
      .filter((r) => r.archived_at == null)
      .reduce((a, r) => a + r.value, 0);
    const archivedSum = withArchived.reduce((a, r) => a + r.value, 0);
    expect(archivedSum).toBeGreaterThan(visibleSum); // fixture really adds value
    expect(stats.outstanding).toBeCloseTo(visibleSum, 2);
  });

  it("keeps opsbar aggregates aligned when canonical dev hides demo rows", async () => {
    const saved = process.env.HIDE_DEMO_TRANSFER_CARDS;
    try {
      process.env.HIDE_DEMO_TRANSFER_CARDS = "1";
      const stats = await transferOpsStats(OPS);
      const visible = (await listTransfers(OPS)).filter(
        (row) => row.stage !== "FUNDED",
      );
      expect(visible.map((row) => row.id)).not.toContain(IDS.demoDecision);
      expect(visible.map((row) => row.id)).not.toContain(IDS.demoDealDerived);
      expect(stats.active).toBe(visible.length);
      expect(stats.outstanding).toBeCloseTo(
        visible.reduce((sum, row) => sum + row.value, 0),
        2,
      );
      expect(stats.bouncing).toBe(
        visible.filter((row) => row.owner_kind === "ADVISOR").length,
      );
    } finally {
      if (saved === undefined) delete process.env.HIDE_DEMO_TRANSFER_CARDS;
      else process.env.HIDE_DEMO_TRANSFER_CARDS = saved;
    }
  });
});
