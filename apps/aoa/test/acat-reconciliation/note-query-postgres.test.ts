import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Private proposal: native SQL/RLS proof using only the existing isolated synthetic database.
const mock = vi.hoisted(() => ({ scope: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { role: "OPERATIONS", email: "note-reader@example.invalid" } }) }));
vi.mock("@/lib/flags", () => ({ acatAutoLinkReviewEnabled: () => true }));
vi.mock("@/lib/rls", () => ({ withUserScope: mock.scope }));
vi.mock("@/lib/data/acat-match-source", () => ({ transferLinkageConfiguration: () => { throw new Error("no_source_needed"); } }));
vi.mock("@/lib/data/acat-reconciliation/verification", () => ({ verifyReconciliationRun: async () => null }));
vi.mock("@/app/(authenticated)/acat-link-review/actions", () => ({ prepareAcatReview: vi.fn(), prepareAcatPair: vi.fn(), prepareHistoricalAcatPair: vi.fn(), reviewAcatDecision: vi.fn(), applyReviewedAcatDecision: vi.fn(), undoReviewedAcatDecision: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); }, redirect: () => { throw new Error("REDIRECT"); } }));
import Page from "@/app/(authenticated)/acat-link-review/page";

const RUN = process.env.ACAT_RECONCILIATION_TEST_DATABASE_URL ? describe : describe.skip;
const PREFIX = "zztest-note-visibility-";
const key = (s: string) => PREFIX + s;
const OPS = { role: "OPERATIONS", email: "note-reader@example.invalid" };
type Note = { transfer_id: string; run_id: string; run_created_at: Date; review_reason: string; reviewed_at: Date | null; reviewed_by: string | null };

function localUrl(raw: string | undefined, role: string): string {
  if (!raw) throw new Error("explicit_synthetic_database_required");
  const u = new URL(raw);
  if (!["postgresql:", "postgres:"].includes(u.protocol) || u.hostname !== "127.0.0.1" || u.port !== "15542"
    || u.pathname !== "/aoa_acat_reconciliation_synthetic" || u.username !== role || u.password || u.hash
    || [...u.searchParams.keys()].some((x) => !["schema", "connection_limit", "pool_timeout"].includes(x))
    || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE || ["dev", "development", "prod", "production"].includes(process.env.APP_ENV?.toLowerCase() ?? "")) throw new Error("wrong_synthetic_database");
  return u.href;
}

RUN("actual page note SQL on isolated PostgreSQL with forced RLS", () => {
  let owner: PrismaClient;
  let app: typeof import("@/lib/db").prisma;
  let scope: typeof import("@/lib/rls").withUserScope;
  let seeded = false;
  const runIds: string[] = [];
  const run = (name: string, date: string) => {
    const id = key(name); runIds.push(id);
    return { id, mode: "PREPARE", contract_version: 1, rule_version: "synthetic-note-query", installation_id: "synthetic",
      source_scope: "FULL", source_boundary: {}, source_digest: "a".repeat(64), source_count: 0, source_complete: true,
      target_boundary: new Date(date), target_digest: "b".repeat(64), target_count: 0, manifest_digest: "c".repeat(64),
      idempotency_key: id, created_role: "OPERATIONS", created_at: new Date(date), summary: {} };
  };
  const note = (id: string, r: string, t: string | null, reason: string | null, reviewed: string | null) => ({
    id: key(id), run_id: key(r), decision_key: key(id), record_id: "synthetic-record", transfer_id: t ? key(t) : null,
    reason: "manual_hold", action: "exclude", rule_version: "synthetic-note-query", evidence_digest: "a".repeat(64),
    source_candidate_set_digest: "b".repeat(64), payload: {}, review_reason: reason,
    reviewed_at: reviewed ? new Date(reviewed) : null, reviewed_by: reason ? "earlier@example.invalid" : null,
  });
  async function pageQuery(transfers: string[], selected = key("selected")): Promise<Prisma.Sql> {
    let actual: Prisma.Sql | undefined;
    mock.scope.mockImplementation(async (_identity, callback) => callback({
      transfer: { groupBy: async () => [], findMany: async () => [] },
      acatLinkRun: { findMany: async () => [{ id: key("menu-newer"), created_at: new Date("2026-09-28"), source_count: 0, target_count: 0, status: "PREPARED" }] },
      acatLinkDecision: { count: async () => transfers.length, findMany: async () => transfers.map((transfer_id, i) => ({
        id: `visible-${i}`, transfer_id, record_id: null, reason: "manual_hold", action: "exclude", disposition: "PENDING", review_version: 0,
        evidence_digest: "a".repeat(64), expected_target_version: 0, outcome: "PENDING", payload: {}, review_reason: null, reviewed_at: null, reviewed_by: null,
      })) },
      $queryRaw: async (q: Prisma.Sql) => { actual = q; return []; },
    }));
    await Page({ searchParams: Promise.resolve({ run: selected }) });
    if (!actual) throw new Error("page_query_not_captured");
    return actual;
  }
  async function read(transfers: string[], identity = OPS, selected?: string) {
    const q = await pageQuery(transfers.map(key), selected);
    return scope(identity, (tx) => tx.$queryRaw<Note[]>(q), { isolationLevel: "RepeatableRead", timeout: 30_000 });
  }
  beforeAll(async () => {
    const appUrl = localUrl(process.env.ACAT_RECONCILIATION_TEST_DATABASE_URL, "app_rw");
    expect(localUrl(process.env.DATABASE_URL, "app_rw")).toBe(appUrl);
    const ownerUrl = localUrl(process.env.ACAT_RECONCILIATION_TEST_OWNER_URL, "aoa");
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    ({ withUserScope: scope } = await vi.importActual<typeof import("@/lib/rls")>("@/lib/rls"));
    ({ prisma: app } = await import("@/lib/db"));
    expect(await owner.acatLinkRun.count({ where: { id: { startsWith: PREFIX } } })).toBe(0);
    const runs = [run("old", "2026-09-01T00:00:00Z"), run("selected", "2026-09-20T00:00:00Z"),
      run("equal", "2026-09-20T00:00:00Z"), run("future", "2026-09-21T00:00:00Z"), run("older", "2026-08-01T00:00:00Z")];
    for (let i = 0; i < 200; i++) runs.push(run(`hour-${i}`, new Date(Date.UTC(2026, 7, 1, i)).toISOString()));
    // Explicit synthetic read fixtures, not valid matching manifests or an application write-flow claim.
    seeded = true;
    await owner.acatLinkRun.createMany({ data: runs });
    const notes = [
      note("eligible", "old", "selection", "eligible old note", "2026-09-10T00:00:00Z"),
      note("same", "selected", "selection", "exclude same run", "2026-09-25T00:00:00Z"),
      note("equal", "equal", "selection", "exclude equal time", "2026-09-26T00:00:00Z"),
      note("future", "future", "selection", "exclude future run", "2026-09-27T00:00:00Z"),
      note("other", "old", "unrequested", "other transfer", "2026-09-29T00:00:00Z"),
      note("tracker", "old", null, "Tracker-only unrelated", "2026-09-30T00:00:00Z"),
      note("blank", "old", "blank", " \t\n ", "2026-09-12T00:00:00Z"),
      note("blank-valid", "older", "blank", "nonblank fallback", "2026-08-02T00:00:00Z"),
      note("tie-a", "old", "tie", "tie loser", "2026-09-11T00:00:00Z"),
      note("tie-z", "older", "tie", "tie winner", "2026-09-11T00:00:00Z"),
      note("tie-null", "old", "tie", "undated loses", null),
      note("undated", "old", "undated", "undated only", null),
      note("late-edit", "older", "edited", "edited after run selection date", "2026-09-23T00:00:00Z"),
      note("later-run-early-edit", "old", "edited", "older annotation time", "2026-09-02T00:00:00Z"),
    ];
    for (let t = 0; t < 50; t++) for (let h = 0; h < 200; h++) notes.push(note(`history-${t}-${h}`, `hour-${h}`, `load-${t}`, `synthetic history ${h}`, new Date(Date.UTC(2026, 7, 1, h)).toISOString()));
    // A busy transfer has 5,000 additional rows; a global LIMIT would hide other transfers.
    for (let i = 0; i < 5000; i++) notes.push(note(`busy-${i.toString().padStart(5, "0")}`, "old", "load-0", "busy annotation", "2026-09-11T00:00:00Z"));
    for (let i = 0; i < notes.length; i += 500) await owner.acatLinkDecision.createMany({ data: notes.slice(i, i + 500) });
    await owner.$executeRawUnsafe("ANALYZE app.acat_link_run");
    await owner.$executeRawUnsafe("ANALYZE app.acat_link_decision");
  }, 60_000);
  afterAll(async () => {
    try {
      if (seeded) {
        await owner.acatLinkDecision.deleteMany({ where: { run_id: { in: runIds } } });
        await owner.acatLinkRun.deleteMany({ where: { id: { in: runIds } } });
        expect(await owner.acatLinkRun.count({ where: { id: { startsWith: PREFIX } } })).toBe(0);
        expect(await owner.acatLinkDecision.count({ where: { id: { startsWith: PREFIX } } })).toBe(0);
      }
    } finally { await owner?.$disconnect(); await app?.$disconnect(); }
  });

  it("uses actual non-superuser app_rw with FORCE RLS on both queried tables", async () => {
    const flags = await scope(OPS, (tx) => tx.$queryRaw<Array<{ username: string; superuser: boolean; bypass: boolean; relname: string; enabled: boolean; forced: boolean }>>`
      SELECT current_user AS username, r.rolsuper AS superuser, r.rolbypassrls AS bypass, c.relname,
        c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
      FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname = current_user
        AND c.oid IN ('app.acat_link_run'::regclass, 'app.acat_link_decision'::regclass)`);
    expect(flags).toHaveLength(2);
    for (const row of flags) expect(row).toMatchObject({ username: "app_rw", superuser: false, bypass: false, enabled: true, forced: true });
  });
  it("uses the requested run outside the menu and excludes same/equal/future runs, unrelated transfers and source-only notes", async () => {
    const rows = await read(["selection", "no-history"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ transfer_id: key("selection"), run_id: key("old"), review_reason: "eligible old note" });
  });
  it("selects latest saved annotation with a deterministic ID tie and null dates last", async () => {
    const rows = new Map((await read(["tie", "undated", "edited", "blank"])).map((x) => [x.transfer_id, x]));
    expect(rows.get(key("tie"))?.review_reason).toBe("tie winner");
    expect(rows.get(key("undated"))?.reviewed_at).toBeNull();
    expect(rows.get(key("edited"))?.review_reason).toBe("edited after run selection date");
    expect(rows.get(key("blank"))?.review_reason).toBe("nonblank fallback");
  });
  it.each([{ role: "VIEWER", email: OPS.email }, { role: "ASSOCIATE", email: OPS.email }, { role: "OPERATIONS", email: "" }])("RLS denies $role with email '$email' despite existing notes", async (identity) => {
    expect(await read(["selection"], identity)).toEqual([]);
  });
  it("allows ADMIN and returns nothing for a nonexistent selected run", async () => {
    expect(await read(["selection"], { role: "ADMIN", email: OPS.email })).toHaveLength(1);
    expect(await read(["selection"], OPS, key("does-not-exist"))).toEqual([]);
  });
  it("returns one per visible transfer despite 5,000 rows for one, and measures the actual 50-transfer plan", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `load-${i}`);
    const rows = await read(ids);
    expect(rows).toHaveLength(50);
    expect(new Set(rows.map((r) => r.transfer_id)).size).toBe(50);
    const q = await pageQuery(ids.map(key));
    const plans = await scope(OPS, (tx) => tx.$queryRaw<Array<{ "QUERY PLAN": Array<{ "Execution Time": number; "Planning Time": number; Plan: unknown }> }>>(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q}`));
    const plan = plans[0]["QUERY PLAN"][0];
    expect(JSON.stringify(plan.Plan)).toContain("acat_link_decision_transfer_id_record_id_idx");
    expect(plan["Execution Time"]).toBeLessThan(1000);
    writeFileSync(join(tmpdir(), "acat-note-native-query-plan.json"), JSON.stringify({ syntheticOnly: true, runCount: 205, decisionCount: 15014, visibleTransfers: 50, returnedNotes: rows.length, plan }, null, 2) + "\n", { mode: 0o600 });
  });
});
