import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/flags", () => ({ checklistStageGateEnabled: () => true, transferDealSourcedRedesignEnabled: () => false }));

// Real PostgreSQL/RLS acceptance, constrained to an explicitly supplied local
// synthetic database. No policy changes and no remote or production fixtures.
const RUN = process.env.AUDIT_TEST_CLEANUP_URL ? describe : describe.skip;
const PREFIX = "ticket-SUMMARY-";
const IDS = ["roth", "traditional", "missing-deal"].map((suffix) => `${PREFIX}${suffix}`);
const DEALS = [`${PREFIX}deal-roth`, `${PREFIX}deal-traditional`];
const TASKS = IDS.map((id) => `${id}-task`);
const CASES = ["open", "snoozed", "resolved", "nonblocking"].map((suffix) => `${PREFIX}case-${suffix}`);
const OPS = { role: "OPERATIONS", email: "ticket-summary-synthetic@example.test" };

RUN("grouped transfer task summaries with PostgreSQL/RLS", () => {
  let owner: PrismaClient | undefined;
  let appPrisma: typeof import("@/lib/db").prisma | undefined;
  let listDecisionTasks: typeof import("@/lib/data/decision-cases").listDecisionTasks;

  async function cleanup() {
    if (!owner) return;
    await owner.decisionTask.deleteMany({ where: { id: { in: TASKS } } });
    await owner.decisionCase.deleteMany({ where: { id: { in: CASES } } });
    await owner.transferTask.deleteMany({ where: { id: `${PREFIX}checklist` } });
    await owner.transfer.deleteMany({ where: { id: { in: IDS } } });
    await owner.deal.deleteMany({ where: { id: { in: DEALS } } });
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE row_pk LIKE ${`${PREFIX}%`}`;
  }

  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL;
    const ownerUrl = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!appUrl || !ownerUrl) throw new Error("Explicit local synthetic database URLs required");
    const app = new URL(appUrl);
    const cleanupDb = new URL(ownerUrl);
    for (const url of [app, cleanupDb]) {
      if (!["postgres:", "postgresql:"].includes(url.protocol)
        || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        || !(url.pathname.endsWith("_synthetic") || (process.env.CI === "true" && url.pathname === "/aoa"))
        || url.host !== app.host || url.pathname !== app.pathname
        || [...url.searchParams.keys()].some((key) => !["schema", "connection_limit", "pool_timeout"].includes(key))
        || url.hash || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE) {
        throw new Error("Grouped Tasks acceptance requires one loopback synthetic database");
      }
    }
    if (app.username !== "app_rw") throw new Error("RLS reads must use app_rw");
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    ({ prisma: appPrisma } = await import("@/lib/db"));
    ({ listDecisionTasks } = await import("@/lib/data/decision-cases"));
    await cleanup();
    for (const [index, id] of DEALS.entries()) {
      await owner.deal.create({ data: {
        id, source: "APP", name: `Synthetic ${index ? "Traditional" : "Roth"} deal`,
        client_first_name: "Synthetic", client_last_name: "Grouped", household_sf_id: `${PREFIX}household`,
        amount: 100, stage: "COMMITTED", created_date: new Date("2026-09-28"),
        statements: true, asset_mapped: true, account_type: "ACAT-Full",
      } });
    }
    for (const [index, id] of IDS.entries()) {
      await owner.transfer.create({ data: {
        id, source: "APP", client_first_name: "Synthetic", client_last_name: "Grouped",
        client_sf_id: `${PREFIX}client`, household_sf_id: `${PREFIX}household`, household_name: "Synthetic Grouped Household",
        value: 100, stage: "DECISION", owner_kind: "OPERATIONS", funding_type: "ACAT_PARTIAL",
        funding_plan_complete: true, funding_plan_version: 1, asset_map_account_type: index ? "Traditional IRA" : "Roth IRA",
        asset_map_account_number: index ? "900088882222" : "900099991111", asset_map_custodian: "Synthetic Custodian",
        deal_id: DEALS[index] ?? `${PREFIX}absent-deal`,
      } });
      await owner.decisionTask.create({ data: {
        id: TASKS[index], transfer_id: id, task_key: "track-partial-acat", title: "Synthetic track partial ACAT",
        source_key: `asset-transfer:${id}:standard-partial-acat:track-partial-acat`, owner_team: "OPERATIONS", sort_order: 30 - index,
      } });
    }
    await owner.transferTask.create({ data: { id: `${PREFIX}checklist`, transfer_id: IDS[0],
      title: "Collect statements", done: false, sort_order: 10 } });
    for (const [index, id] of CASES.entries()) {
      await owner.decisionCase.create({ data: {
        id, source: "MANUAL", source_key: id, transfer_id: IDS[0], question: `Synthetic blocker ${index}`,
        owner_team: "OPERATIONS", status: index === 1 ? "SNOOZED" : index === 2 ? "RESOLVED" : "OPEN",
        blocks_transfer: index !== 3,
        ...(index === 2 ? { version: 1, resolution_code: "RESOLVED", resolution_summary: "Synthetic resolution",
          resolved_by: OPS.email, resolved_at: new Date() } : {}),
      } });
    }
  });

  afterAll(async () => {
    try { await cleanup(); } finally { await owner?.$disconnect(); await appPrisma?.$disconnect(); }
  });

  it("uses app_rw without bypass and leaves out-of-scope raw reads empty", async () => {
    const [role] = await appPrisma!.$queryRaw<Array<{ username: string; superuser: boolean; bypassrls: boolean }>>`
      SELECT current_user AS username, rolsuper AS superuser, rolbypassrls AS bypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(role).toEqual({ username: "app_rw", superuser: false, bypassrls: false });
    expect(await appPrisma!.decisionTask.findMany({ where: { id: { in: TASKS } } })).toEqual([]);
    expect(await appPrisma!.deal.findMany({ where: { id: { in: DEALS } } })).toEqual([]);
  });

  it("reads exact deals, registrations, blocker state and task order without changing stored tasks", async () => {
    const before = await owner!.decisionTask.findMany({ where: { id: { in: TASKS } }, orderBy: { id: "asc" } });
    const rows = (await listDecisionTasks(OPS)).filter((row) => TASKS.includes(row.id));
    expect(rows).toHaveLength(3);
    const roth = rows.find((row) => row.transferId === IDS[0])!;
    const traditional = rows.find((row) => row.transferId === IDS[1])!;
    const missing = rows.find((row) => row.transferId === IDS[2])!;
    expect(roth.transferSummary).toMatchObject({ id: IDS[0], accountType: "Roth IRA", deliveringAccountLast4: "1111",
      deal: { id: DEALS[0], name: "Synthetic Roth deal" }, requirements: [],
      blockers: [{ id: CASES[0], question: "Synthetic blocker 0" }, { id: CASES[1], question: "Synthetic blocker 1" }] });
    expect(traditional.transferSummary).toMatchObject({ id: IDS[1], accountType: "Traditional IRA", deal: { id: DEALS[1] } });
    expect(roth.transferSummary!.clientKey).toBe(traditional.transferSummary!.clientKey);
    expect(missing.transferSummary?.deal).toBeNull();
    expect(roth.sortOrder).toBe(30);
    expect(traditional.sortOrder).toBe(29);
    expect(JSON.stringify(rows)).not.toContain("900099991111");
    expect(await owner!.decisionTask.findMany({ where: { id: { in: TASKS } }, orderBy: { id: "asc" } })).toEqual(before);
  });

  it("resolves links for VIEWER under the same policies as transfer/deal detail pages", async () => {
    const rows = (await listDecisionTasks({ ...OPS, role: "VIEWER" })).filter((row) => TASKS.includes(row.id));
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.transferId === IDS[0])?.transferSummary?.deal?.id).toBe(DEALS[0]);
    expect(rows.find((row) => row.transferId === IDS[2])?.transferSummary?.deal).toBeNull();
    // Current app policies permit these roles the same rows. Missing/hidden
    // link fallbacks are additionally exercised with scoped mocks in the unit test.
  });
});
