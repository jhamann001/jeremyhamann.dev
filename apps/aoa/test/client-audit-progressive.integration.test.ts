import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
vi.mock("server-only", () => ({}));
const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));
import { GET as getClients } from "@/app/api/navigation/clients/route";
import { GET as getAudit } from "@/app/api/navigation/audit/route";
import { getClientDirectory } from "@/lib/data/clients";
import { listAuditLog } from "@/lib/data/audit-log";
import { listRowChanges } from "@/lib/data/row-changes";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const ADVISOR = { role: "ADVISOR", email: "progressive-client@example.invalid" };
const OPS = { role: "OPERATIONS", email: "progressive-audit@example.invalid" };
const filters = { query: "", stage: "client" as const, sortKey: "name" as const, sortDir: "asc" as const };
const request = (query = "") => new Request(`https://example.test/api/navigation/clients?${query}`);
const counts = (page: Awaited<ReturnType<typeof getClientDirectory>>) => page.counts;

gated("Client/Audit progressive contract against isolated PostgreSQL", () => {
  let owner: PrismaClient;
  async function cleanup() {
    await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id LIKE 'PC-SYN-%'`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE 'PC-SYN-%'`;
    await owner.$executeRaw`DELETE FROM audit."AuditLog" WHERE "entityType" = 'progressive_synthetic'`;
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE table_name = 'progressive_synthetic'`;
  }
  beforeAll(async () => {
    const raw = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!raw) throw new Error("explicit_synthetic_database_required");
    const target = new URL(raw);
    for (const [value, username] of [[raw, "aoa"], [process.env.DATABASE_URL, "app_rw"]]) {
      if (!value) throw new Error("explicit_synthetic_database_required");
      const url = new URL(value);
      const databaseAllowed = ["/aoa_rollout_synthetic", "/aoa_pagination_synthetic"].includes(url.pathname)
        || (process.env.CI === "true" && url.pathname === "/aoa");
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !databaseAllowed || url.username !== username
        || url.pathname !== target.pathname || url.hostname !== target.hostname || url.port !== target.port) {
        throw new Error("isolated_synthetic_database_required");
      }
    }
    owner = new PrismaClient({ datasourceUrl: raw });
    await cleanup();
  });
  beforeEach(async () => {
    await cleanup();
    auth.mockResolvedValue({ user: ADVISOR, navigationScope: "a".repeat(64) });
    await owner.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, stage, lead_advisor_email)
      SELECT 'PC-SYN-HH-' || i, 'Invented household ' || i,
        CASE WHEN i <= 205 THEN 'Client' ELSE 'Prospect' END, ${ADVISOR.email}
      FROM generate_series(1, 206) i`;
    await owner.$executeRaw`
      INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
      SELECT 'PC-SYN-C-' || lpad(i::text, 4, '0'), 'PC-SYN-HH-' || i, 'Invented', 'Person', ${ADVISOR.email}
      FROM generate_series(1, 206) i`;
    await owner.$executeRaw`
      INSERT INTO audit."AuditLog" (at, "actorEmail", "actorRole", action, "entityType", detail)
      SELECT '2026-09-01'::timestamptz + i * interval '1 second', ${OPS.email}, 'OPERATIONS', 'synthetic.progressive', 'progressive_synthetic', '{"invented":true}'
      FROM generate_series(1, 205) i`;
    await owner.$executeRaw`
      INSERT INTO audit.row_change (at, actor_email, actor_role, db_role, schema_name, table_name, op, row_pk, changed)
      SELECT '2026-09-01'::timestamptz, ${OPS.email}, 'OPERATIONS', 'app_rw', 'app', 'progressive_synthetic', 'UPDATE', 'PC-SYN-' || i, '{"name":{"from":"invented","to":"synthetic"}}'::jsonb
      FROM generate_series(1, 205) i`;
  });
  afterAll(async () => { if (owner) { await cleanup(); await owner.$disconnect(); } });

  it("Client pages100/100/5 preserve exact order and full stage counts", async () => {
    const pages = await Promise.all([1, 2, 3].map(page => getClientDirectory(ADVISOR, filters, page, 100)));
    expect(pages.map(page => page.rows.length)).toEqual([100, 100, 5]);
    expect(new Set(pages.flatMap(page => page.rows.map(row => row.sf_id))).size).toBe(205);
    expect(new Set(pages.map(page => page.snapshot)).size).toBe(1);
    expect(counts(pages[0])).toEqual({ all: 206, client: 205, prospect: 1, lost_client: 0, lost_prospect: 0 });
    expect((await getClientDirectory(ADVISOR, filters, 1, 999)).rows).toHaveLength(200);
  });
  it("invalidates Client summary-only changes outside the active stage", async () => {
    const first = await getClientDirectory(ADVISOR, filters, 1, 100);
    await owner.$executeRaw`UPDATE mirror.household SET stage = 'Lost Prospect' WHERE sf_id = 'PC-SYN-HH-206'`;
    const second = await getClientDirectory(ADVISOR, filters, 2, 100);
    expect(second.snapshot).not.toBe(first.snapshot);
    expect(second.counts.lost_prospect).toBe(1);
    expect((await getClients(request(`page=2&snapshot=${first.snapshot}`))).status).toBe(409);
  });
  it("reapplies current Client RLS before accepting another page", async () => {
    const first = await getClientDirectory(ADVISOR, filters, 1, 100);
    await owner.$executeRaw`UPDATE mirror.client SET lead_advisor_email = 'another@example.invalid' WHERE sf_id = 'PC-SYN-C-0001'`;
    expect((await getClients(request(`page=2&snapshot=${first.snapshot}`))).status).toBe(409);
    const other = await getClientDirectory({ role: "ADVISOR", email: "nobody@example.invalid" }, filters, 1, 100);
    expect(other.rows).toEqual([]); expect(other.total).toBe(0);
  });
  it("Audit events and changes append100/100/5 at their existing grains", async () => {
    for (const read of [
      (page: number) => listAuditLog(OPS, { action: "synthetic.progressive", page, pageSize: 100 }),
      (page: number) => listRowChanges(OPS, { table: "progressive_synthetic", page, pageSize: 100 }),
    ]) {
      const pages = await Promise.all([1, 2, 3].map(async number => await read(number)));
      for (const page of pages) expect(page.ok).toBe(true);
      const accepted = pages.filter(page => page.ok);
      expect(accepted.map(page => page.rows.length)).toEqual([100, 100, 5]);
      expect(new Set(accepted.flatMap(page => page.rows.map(row => row.id))).size).toBe(205);
      expect(new Set(accepted.map(page => page.snapshot)).size).toBe(1);
      const ids = accepted.flatMap(page => page.rows.map(row => BigInt(row.id)));
      expect(ids).toEqual([...ids].sort((a, b) => a > b ? -1 : a < b ? 1 : 0));
    }
  });
  it("new ingest runs invalidate an existing day even when displayed row count stays fixed; dry runs do not", async () => {
    const insert = (dry: boolean) => owner.$executeRaw`
      INSERT INTO audit."AuditLog" (at, "actorRole", action, "entityType", detail)
      VALUES ('2026-09-02'::timestamptz, 'INGEST', 'ingest.progressive_synthetic', 'progressive_synthetic', ${JSON.stringify({ dry_run: dry, upserted: 10 })})`;
    await insert(false);
    const first = await listAuditLog(OPS, { action: "ingest.progressive_synthetic", pageSize: 100 });
    await insert(true);
    const dry = await listAuditLog(OPS, { action: "ingest.progressive_synthetic", pageSize: 100 });
    await insert(false);
    const next = await listAuditLog(OPS, { action: "ingest.progressive_synthetic", pageSize: 100 });
    if (!first.ok || !dry.ok || !next.ok) throw new Error("expected_audit_access");
    expect([first.total, dry.total, next.total]).toEqual([1, 1, 1]);
    expect(dry.snapshot).toBe(first.snapshot); expect(next.snapshot).not.toBe(first.snapshot);
    expect(next.rows[0]).toMatchObject({ runCount: 2, upserted: 20 });
    auth.mockResolvedValue({ user: OPS, navigationScope: "a".repeat(64) });
    expect((await getAudit(request(`action=ingest.progressive_synthetic&snapshot=${first.snapshot}`))).status).toBe(409);
  });
  it("versions newly appended field changes and denies advisor audit access", async () => {
    const first = await listRowChanges(OPS, { table: "progressive_synthetic", pageSize: 100 });
    if (!first.ok) throw new Error("expected_audit_access");
    await owner.$executeRaw`INSERT INTO audit.row_change (actor_email, actor_role, db_role, schema_name, table_name, op, row_pk, changed)
      VALUES (${OPS.email}, 'OPERATIONS', 'app_rw', 'app', 'progressive_synthetic', 'DELETE', 'PC-SYN-NEW', '{}'::jsonb)`;
    const next = await listRowChanges(OPS, { table: "progressive_synthetic", pageSize: 100 });
    if (!next.ok) throw new Error("expected_audit_access");
    expect(next.snapshot).not.toBe(first.snapshot); expect(next.total).toBe(206);
    expect(await listAuditLog(ADVISOR)).toEqual({ ok: false, reason: "forbidden" });
    expect((await getAudit(request())).status).toBe(403);
  });
});
