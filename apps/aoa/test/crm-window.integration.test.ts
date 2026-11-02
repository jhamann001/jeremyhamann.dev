import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { listCrmIdentityWindow } from "@/lib/data/crm-explorer";
import { listCrmDuplicateWindow } from "@/lib/data/crm-duplicate-review";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const OPS = { role: "OPERATIONS", email: "crm-window@example.invalid" };
const initial = { firstPage: 1, pageSize: 100, loaded: 0, snapshot: null };
const key = (n: number) => `001WCR${String(n).padStart(9, "0")}AAA`;

gated("CRM window source-backed RLS and prefix consistency", () => {
  let owner: PrismaClient;
  async function cleanup() {
    await owner.$executeRaw`DELETE FROM app.crm_duplicate_candidate WHERE id LIKE 'dup_wcrm%'`;
    await owner.$executeRaw`DELETE FROM app.crm_source_mapping WHERE id LIKE 'wcrm-map-%'`;
    await owner.$executeRaw`DELETE FROM app.crm_identity WHERE id LIKE 'hld_wcrm%'`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE '001WCR%'`;
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE row_pk LIKE 'hld_wcrm%' OR row_pk LIKE 'wcrm-map-%' OR row_pk LIKE 'dup_wcrm%'`;
  }
  beforeAll(async () => {
    const raw = process.env.AUDIT_TEST_CLEANUP_URL, scoped = process.env.DATABASE_URL;
    if (!raw || !scoped) throw new Error("explicit_synthetic_database_required");
    const target = new URL(raw);
    for (const [value, username] of [[raw, "aoa"], [scoped, "app_rw"]]) {
      const url = new URL(value);
      if (!["postgresql:", "postgres:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        || !["5432", "55444"].includes(url.port) || url.username !== username || url.host !== target.host || url.pathname !== target.pathname
        || !(["/aoa_directory_contention_synthetic", "/aoa_loading_full_synthetic", "/aoa_pagination_synthetic"].includes(url.pathname) || (process.env.CI === "true" && url.pathname === "/aoa"))
        || [...url.searchParams.keys()].some(key => !["schema", "connection_limit", "pool_timeout"].includes(key))
        || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE || ["dev", "production", "prod"].includes(process.env.APP_ENV ?? "")) throw new Error("isolated_synthetic_database_required");
    }
    owner = new PrismaClient({ datasourceUrl: raw });
    vi.stubEnv("CRM_IDENTITY_READS", "1");
    await cleanup();
    await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, lead_advisor_email)
      SELECT '001WCR' || lpad(i::text,9,'0') || 'AAA', 'Invented Window Household ' || i, ${OPS.email} FROM generate_series(1,206) i`;
    await owner.$executeRaw`INSERT INTO app.crm_identity (id, identity_type, updated_at)
      SELECT 'hld_wcrm' || lpad(i::text,4,'0'), 'HOUSEHOLD', '2026-01-01'::timestamptz FROM generate_series(1,206) i`;
    await owner.$executeRaw`INSERT INTO app.crm_source_mapping (id, identity_id, source_system, source_namespace, source_key, updated_at)
      SELECT 'wcrm-map-' || i, 'hld_wcrm' || lpad(i::text,4,'0'), 'CRM', 'household', '001WCR' || lpad(i::text,9,'0') || 'AAA', now() FROM generate_series(1,206) i`;
    await owner.$executeRaw`INSERT INTO app.crm_duplicate_candidate (id, detector_key, entity_type, left_identity_id, right_identity_id, evidence_codes, detected_at, updated_at)
      SELECT 'dup_wcrm' || lpad(i::text,4,'0'), md5('wcrm-' || i) || md5('wcrm-' || i), 'HOUSEHOLD', 'hld_wcrm0001',
        'hld_wcrm' || lpad((i+1)::text,4,'0'), ARRAY['SHARED_CEDAR_RIDGE_USER_ID'], '2099-01-01'::timestamptz, now() FROM generate_series(1,205) i`;
  });
  afterAll(async () => { if (owner) { await cleanup(); await owner.$disconnect(); } vi.unstubAllEnvs(); });

  const read = (window = initial) => listCrmIdentityWindow(OPS, { q: "hld_wcrm" }, window);
  it("appends100/100/6 with exact counts and a new digest at each step", async () => {
    let window: { firstPage: number; pageSize: number; loaded: number; snapshot: string | null } = initial;
    const ids: string[] = [], sizes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const result = await listCrmIdentityWindow(OPS, { q: "hld_wcrm" }, window);
      if (!result.ok) throw new Error("expected_access");
      sizes.push(result.rows.length); ids.push(...result.rows.map(row => row.id));
      expect(result.meta.total).toBe(206);
      expect(result.snapshot).not.toBe(window.snapshot);
      window = { ...window, loaded: result.loaded, snapshot: result.snapshot };
    }
    expect(sizes).toEqual([100,100,6]); expect(new Set(ids).size).toBe(206);
  }, 20_000);
  it("restores a fresh200-row identity prefix in one read then appends normally", async () => {
    const restored = await listCrmIdentityWindow(OPS, { q: "hld_wcrm" }, { ...initial, restoreRows: 200 });
    if (!restored.ok) throw new Error("expected_access");
    expect(restored).toMatchObject({ loaded: 200, pageSize: 100, hasMore: true, meta: { total: 206 } });
    expect(restored.rows).toHaveLength(200);
    const next = await listCrmIdentityWindow(OPS, { q: "hld_wcrm" }, { ...initial, loaded: 200, snapshot: restored.snapshot });
    if (!next.ok) throw new Error("expected_access");
    expect(next.rows).toHaveLength(6);
    expect(next.loaded).toBe(206);
    expect(new Set([...restored.rows, ...next.rows].map(row => row.id)).size).toBe(206);
  }, 20_000);
  it("restores duplicate results with the same fresh prefix and continuation contract", async () => {
    const restored = await listCrmDuplicateWindow(OPS, "potential", "HOUSEHOLD", { ...initial, restoreRows: 200 });
    if (!restored.ok) throw new Error("expected_access");
    expect(restored).toMatchObject({ loaded: 200, pageSize: 100, hasMore: true });
    expect(restored.rows).toHaveLength(200);
    const next = await listCrmDuplicateWindow(OPS, "potential", "HOUSEHOLD", { ...initial, loaded: 200, snapshot: restored.snapshot });
    if (!next.ok) throw new Error("expected_access");
    expect(next.rows).toHaveLength(Math.min(100, restored.meta.total - 200));
    expect(new Set([...restored.rows, ...next.rows].map(row => row.id)).size).toBe(next.loaded);
  }, 20_000);
  it("rejects label changes/deletions in loaded rows but reads unseen labels freshly", async () => {
    const first = await read(); if (!first.ok) throw new Error("expected_access");
    const next = { ...initial, loaded: first.loaded, snapshot: first.snapshot };
    await owner.$executeRaw`UPDATE mirror.household SET name = 'Changed unseen synthetic label' WHERE sf_id = ${key(150)}`;
    const second = await listCrmIdentityWindow(OPS, { q: "hld_wcrm" }, next);
    expect(second.ok && second.rows.find(row => row.id === "hld_wcrm0150")?.mappings[0].displayName).toBe("Changed unseen synthetic label");
    await owner.$executeRaw`UPDATE mirror.household SET name = 'Changed loaded synthetic label' WHERE sf_id = ${key(1)}`;
    await expect(listCrmIdentityWindow(OPS, { q: "hld_wcrm" }, next)).rejects.toMatchObject({ kind: "changed" });
    const fresh = await read(); if (!fresh.ok) throw new Error("expected_access");
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id = ${key(2)}`;
    await expect(listCrmIdentityWindow(OPS, { q: "hld_wcrm" }, { ...initial, loaded: fresh.loaded, snapshot: fresh.snapshot })).rejects.toMatchObject({ kind: "changed" });
    await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, lead_advisor_email) VALUES (${key(2)}, 'Restored synthetic household', ${OPS.email})`;
  }, 30_000);
  it("rechecks roles and flags before every continuation", async () => {
    const first = await read(); if (!first.ok) throw new Error("expected_access");
    for (const role of ["VIEWER", "ADVISOR", "CLIENT_SERVICE", "INVALID_ROLE"]) {
      expect(await listCrmIdentityWindow({ ...OPS, role }, {}, { ...initial, loaded: first.loaded, snapshot: first.snapshot })).toEqual({ ok: false, reason: "forbidden" });
      expect(await listCrmIdentityWindow({ ...OPS, role }, {}, { ...initial, restoreRows: 200 })).toEqual({ ok: false, reason: "forbidden" });
      expect(await listCrmDuplicateWindow({ ...OPS, role }, "potential", "HOUSEHOLD", { ...initial, restoreRows: 200 })).toEqual({ ok: false, reason: "forbidden" });
    }
    vi.stubEnv("CRM_IDENTITY_READS", "0");
    expect(await read()).toEqual({ ok: false, reason: "disabled" });
    vi.stubEnv("CRM_IDENTITY_READS", "1");
  });
  it("revalidates duplicate labels/review state with the same contract", async () => {
    const first = await listCrmDuplicateWindow(OPS, "potential", "HOUSEHOLD", initial);
    if (!first.ok) throw new Error("expected_access");
    expect(first.rows.length).toBe(100);
    const candidate = first.rows.find(row => row.id.startsWith("dup_wcrm"));
    if (!candidate) throw new Error("isolated_duplicate_fixture_required");
    await owner.$executeRaw`UPDATE app.crm_duplicate_candidate SET status = 'NOT_DUPLICATE', decision_reason = 'DISTINCT_PEOPLE_OR_HOUSEHOLDS', review_version = review_version + 1 WHERE id = ${candidate.id}`;
    await expect(listCrmDuplicateWindow(OPS, "potential", "HOUSEHOLD", { ...initial, loaded: first.loaded, snapshot: first.snapshot })).rejects.toMatchObject({ kind: "changed" });
  });
});
