import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));
const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));

import { applyCrmExplorerDatabaseBounds, listCrmIdentities } from "@/lib/data/crm-explorer";
import { listCrmDuplicateCandidates, updateCrmDuplicateReview } from "@/lib/data/crm-duplicate-review";
import { GET as getIdentities } from "@/app/api/navigation/crm/route";
import { GET as getCandidates } from "@/app/api/navigation/crm-duplicates/route";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const OPS = { role: "OPERATIONS", email: "crm-progressive@example.test" };
const id = (n: number) => `hld_pgcrm${String(n).padStart(4, "0")}`;
const candidateId = (n: number) => `dup_ccc01${String(n).padStart(20, "0")}`;
const household = "001CRMPG0000001";
const request = (query = "") => new Request(`https://example.test/api/navigation/crm?${query}`);

gated("CRM progressive paging against synthetic PostgreSQL", () => {
  let owner: PrismaClient;
  async function cleanup() {
    await owner.$executeRaw`DELETE FROM app.crm_duplicate_candidate_event WHERE candidate_id LIKE 'dup_ccc01%'`;
    await owner.$executeRaw`DELETE FROM app.crm_duplicate_candidate WHERE id LIKE 'dup_ccc01%'`;
    await owner.$executeRaw`DELETE FROM app.crm_identity_exception WHERE source_mapping_id LIKE 'pgcrm-map-%'`;
    await owner.$executeRaw`DELETE FROM app.crm_source_mapping WHERE id LIKE 'pgcrm-map-%'`;
    await owner.$executeRaw`DELETE FROM app.crm_identity WHERE id LIKE 'hld_pgcrm%'`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE '001CRMPG%'`;
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE
      (table_name = 'crm_identity' AND row_pk LIKE 'hld_pgcrm%') OR
      (table_name = 'crm_duplicate_candidate' AND row_pk LIKE 'dup_ccc01%') OR
      (table_name = 'crm_source_mapping' AND row_pk LIKE 'pgcrm-map-%')`;
    await owner.$executeRaw`DELETE FROM audit."AuditLog" WHERE "actorEmail" = ${OPS.email} AND "entityType" = 'crm_duplicate_candidate'`;
  }

  beforeAll(async () => {
    const url = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!url) throw new Error("CRM paging fixtures require an explicit cleanup URL");
    const target = new URL(url);
    for (const [connection, username] of [[url, "aoa"], [process.env.DATABASE_URL, "app_rw"]]) {
      if (!connection) throw new Error("CRM paging fixtures require explicit scoped database URLs");
      const parsed = new URL(connection);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
        || !(parsed.pathname.endsWith("_synthetic") || (process.env.CI === "true" && parsed.pathname === "/aoa"))
        || parsed.username !== username) throw new Error("CRM paging fixtures require a loopback synthetic database");
      if (parsed.pathname !== target.pathname || parsed.hostname !== target.hostname || parsed.port !== target.port) throw new Error("CRM paging fixture connections must share a database");
    }
    owner = new PrismaClient({ datasourceUrl: url });
    await cleanup();
  });

  beforeEach(async () => {
    vi.stubEnv("CRM_IDENTITY_READS", "1");
    auth.mockResolvedValue({ user: OPS, navigationScope: "synthetic-crm-login" });
    await cleanup();
    await owner.$executeRaw`
      INSERT INTO app.crm_identity (id, identity_type, updated_at)
      SELECT 'hld_pgcrm' || lpad(i::text, 4, '0'), 'HOUSEHOLD', '2026-01-01T00:00:00Z'
      FROM generate_series(0, 205) i`;
    await owner.$executeRaw`
      INSERT INTO app.crm_duplicate_candidate (
        id, detector_key, entity_type, left_identity_id, right_identity_id, evidence_codes, detected_at, updated_at
      ) SELECT 'dup_ccc01' || lpad(i::text, 20, '0'), 'cc01' || lpad(i::text, 60, '0'),
        'HOUSEHOLD', 'hld_pgcrm0000', 'hld_pgcrm' || lpad(i::text, 4, '0'),
        ARRAY['SHARED_CEDAR_RIDGE_USER_ID'], '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
      FROM generate_series(1, 205) i`;
    await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, lead_advisor_email)
      SELECT '001CRMPG' || lpad(i::text, 7, '0'), 'Invented CRM Paging Household', 'crm-advisor@example.test'
      FROM generate_series(0, 205) i`;
    await owner.$executeRaw`INSERT INTO app.crm_source_mapping (id, identity_id, source_system, source_namespace, source_key, updated_at)
      SELECT 'pgcrm-map-' || lpad(i::text, 4, '0'), 'hld_pgcrm' || lpad(i::text, 4, '0'),
        'CRM', 'household', '001CRMPG' || lpad(i::text, 7, '0'), now()
      FROM generate_series(0, 205) i`;
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { if (owner) { await cleanup(); await owner.$disconnect(); } });

  it("keeps CRM query settings local to the transaction on a reused connection", async () => {
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set("connection_limit", "1");
    const reader = new PrismaClient({ datasourceUrl: url.toString() });
    type Settings = { jit: string; statement: string; lock: string };
    const settings = (tx: Pick<PrismaClient, "$queryRaw">) => tx.$queryRaw<Settings[]>`
      SELECT current_setting('jit') AS jit,
             current_setting('statement_timeout') AS statement,
             current_setting('lock_timeout') AS lock`;
    try {
      const before = await settings(reader);
      await reader.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('jit', 'on', true)`;
        expect((await settings(tx))[0].jit).toBe("on");
        await applyCrmExplorerDatabaseBounds(tx);
        expect(await settings(tx)).toEqual([{ jit: "off", statement: "10s", lock: "2s" }]);
      });
      expect(await settings(reader)).toEqual(before);
    } finally {
      await reader.$disconnect();
    }
  });

  it("returns 100/100/6 ordered identities with full counts and a stable content version", async () => {
    const pages = await Promise.all([1, 2, 3].map((page) => listCrmIdentities(OPS, { page, q: "hld_pgcrm" })));
    if (pages.some((page) => !page.ok)) throw new Error("Expected allowed CRM reads");
    const allowed = pages.filter((page) => page.ok);
    expect(allowed.map((page) => page.rows.length)).toEqual([100, 100, 6]);
    expect(allowed.map((page) => page.snapshot)).toEqual(Array(3).fill(allowed[0].snapshot));
    expect(allowed.flatMap((page) => page.rows.map((row) => row.id))).toEqual(Array.from({ length: 206 }, (_, n) => id(n)));
    expect(allowed[0].total).toBe(206);
    expect(allowed[0].stats.identities).toBeGreaterThanOrEqual(206);
    const bounded = await listCrmIdentities(OPS, { q: "hld_pgcrm", pageSize: 100_000 });
    expect(bounded.ok && bounded.rows.length).toBe(200);
  });

  it("continues all 205 candidate reviews through the separate fixed-100 contract", async () => {
    const first = await getCandidates(request("duplicates=potential&type=HOUSEHOLD"));
    expect(first.status).toBe(200);
    const firstPage = await first.json();
    const pages = [firstPage];
    for (const page of [2, 3]) {
      const response = await getCandidates(request(`duplicates=potential&type=HOUSEHOLD&page=${page}&snapshot=${firstPage.snapshot}`));
      expect(response.status).toBe(200);
      pages.push(await response.json());
    }
    expect(pages.map((page) => page.rows.length)).toEqual([100, 100, 5]);
    expect(firstPage.total).toBe(205);
    const rows = pages.flatMap((page) => page.rows);
    expect(new Set(rows.map((row) => row.id)).size).toBe(205);
    expect(rows[204].id).toBe(candidateId(205));
    const contacts = await listCrmDuplicateCandidates(OPS, "potential", "CONTACT");
    expect(contacts.ok && contacts.total).toBe(0);
    const outOfRange = await getCandidates(request(`duplicates=potential&page=4&snapshot=${firstPage.snapshot}`));
    expect(outOfRange.status).toBe(416);
  });

  // Each content change is independent. Keep its real source reads and the
  // standard per-case timeout, rather than sharing one budget across all three.
  it("rejects stale source labels before appending and rereads the current label", async () => {
    const first = await listCrmIdentities(OPS, { q: "hld_pgcrm" });
    if (!first.ok) throw new Error("Expected allowed CRM read");
    await owner.$executeRaw`UPDATE mirror.household SET name = 'Invented Renamed Household' WHERE sf_id = ${household}`;
    const stale = await getIdentities(request(`q=hld_pgcrm&page=2&snapshot=${first.snapshot}`));
    expect(stale.status).toBe(409);
    expect(await stale.json()).not.toHaveProperty("rows");
    const renamed = await listCrmIdentities(OPS, { q: "hld_pgcrm" });
    if (!renamed.ok) throw new Error("Expected allowed CRM read");
    expect(renamed.rows.find((row) => row.id === id(1))?.mappings[0].displayName).toBe("Invented Renamed Household");
  });

  it("rejects stale source mappings before appending", async () => {
    const first = await listCrmIdentities(OPS, { q: "hld_pgcrm" });
    if (!first.ok) throw new Error("Expected allowed CRM read");
    await owner.$executeRaw`UPDATE app.crm_source_mapping SET last_seen_at = last_seen_at + interval '1 second' WHERE id = 'pgcrm-map-0001'`;
    const stale = await getIdentities(request(`q=hld_pgcrm&page=2&snapshot=${first.snapshot}`));
    expect(stale.status).toBe(409);
    expect(await stale.json()).not.toHaveProperty("rows");
  });

  it("rejects stale identity membership before appending", async () => {
    const first = await listCrmIdentities(OPS, { q: "hld_pgcrm" });
    if (!first.ok) throw new Error("Expected allowed CRM read");
    await owner.$executeRaw`UPDATE app.crm_identity SET lifecycle_state = 'ARCHIVED' WHERE id = ${id(205)}`;
    const stale = await getIdentities(request(`q=hld_pgcrm&page=2&snapshot=${first.snapshot}`));
    expect(stale.status).toBe(409);
    expect(await stale.json()).not.toHaveProperty("rows");
  });

  it("rereads a synthetic human decision and rejects the prior candidate sequence", async () => {
    const first = await getCandidates(request("duplicates=potential"));
    const before = await first.json();
    expect(await updateCrmDuplicateReview(OPS, {
      candidateId: candidateId(1), expectedReviewVersion: 0, decision: "NOT_DUPLICATE",
      snoozedUntil: null, decisionReason: "DISTINCT_PEOPLE_OR_HOUSEHOLDS", canonicalIdentityId: null,
    })).toBe("updated");
    const stale = await getCandidates(request(`duplicates=potential&page=2&snapshot=${before.snapshot}`));
    expect(stale.status).toBe(409);
    const current = await getCandidates(request("duplicates=potential"));
    const body = await current.json();
    expect(body.total).toBe(204);
    expect(body.rows.some((row: { id: string }) => row.id === candidateId(1))).toBe(false);
    expect(body.meta.potentialDuplicates).toBe(204);
  });

  it("rechecks Ops/Admin authorization and the feature flag on every page", async () => {
    const first = await getIdentities(request());
    const { snapshot } = await first.json();
    for (const role of ["ADVISOR", "VIEWER", "HEAD_OF_ADVISORY"]) {
      auth.mockResolvedValue({ user: { ...OPS, role }, navigationScope: "changed-login" });
      const response = await getIdentities(request(`page=2&snapshot=${snapshot}`));
      expect(response.status).toBe(403);
      expect(await response.json()).not.toHaveProperty("rows");
      expect(response.headers.get("x-aoa-navigation-scope")).toBe("changed-login");
    }
    auth.mockResolvedValue({ user: OPS, navigationScope: "synthetic-crm-login" });
    vi.stubEnv("CRM_IDENTITY_READS", "0");
    expect((await getCandidates(request())).status).toBe(404);
    auth.mockResolvedValue(null);
    expect((await getCandidates(request())).status).toBe(401);
  });
});
