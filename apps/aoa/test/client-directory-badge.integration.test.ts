import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { getClientDirectory } from "@/lib/data/clients";
import { prisma } from "@/lib/db";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const ADVISOR = { role: "ADVISOR", email: "client-badge-query@example.test" };
const filters = { query: "Invented Badge Query", stage: "all" as const, sortKey: "name" as const, sortDir: "asc" as const };
const household = "001THK016747937AAA";
const client = (n: number) => `003CBQ00000000${n}AAA`;
const identity = (n: number) => `con_cbquery${n}`;
const upload = "client-badge-query-upload";

gated("Client directory current badge snapshot", () => {
  let owner: PrismaClient;

  async function cleanup() {
    await owner.$executeRaw`DELETE FROM app.employee_client_status WHERE source_upload_id = ${upload}`;
    await owner.$executeRaw`DELETE FROM app.employee_contact_mapping WHERE id LIKE 'client-badge-query-%'`;
    await owner.$executeRaw`DELETE FROM app.employee_roster_upload WHERE id = ${upload}`;
    await owner.$executeRaw`DELETE FROM app.crm_source_mapping WHERE id LIKE 'client-badge-query-%'`;
    await owner.$executeRaw`DELETE FROM app.crm_identity WHERE id LIKE 'con_cbquery%'`;
    await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id LIKE '003CBQ%'`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id = ${household}`;
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE
      (table_name = 'crm_identity' AND row_pk LIKE 'con_cbquery%') OR
      (table_name = 'crm_source_mapping' AND row_pk LIKE 'client-badge-query-%')`;
  }

  beforeAll(async () => {
    const raw = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!raw || !process.env.DATABASE_URL) throw new Error("Explicit synthetic database URLs required");
    const target = new URL(raw);
    for (const [value, username] of [[raw, "aoa"], [process.env.DATABASE_URL, "app_rw"]]) {
      const parsed = new URL(value);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
        || !(["/aoa_directory_scale_synthetic", "/aoa_pagination_synthetic"].includes(parsed.pathname)
          || (process.env.CI === "true" && parsed.pathname === "/aoa"))
        || parsed.username !== username || parsed.pathname !== target.pathname
        || parsed.hostname !== target.hostname || parsed.port !== target.port) {
        throw new Error("Client badge query test requires its isolated loopback synthetic database");
      }
    }
    owner = new PrismaClient({ datasourceUrl: raw });
    await cleanup();
    vi.stubEnv("CRM_IDENTITY_READS", "1");
    await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, stage, lead_advisor_email)
      VALUES (${household}, 'Invented Badge Query Household', 'Client', ${ADVISOR.email})`;
    await owner.$executeRaw`INSERT INTO app.employee_roster_upload
      (id, file_sha256, effective_date, parser_version, row_count, employee_count,
       dependent_row_count, active_count, former_count, uploaded_by, updated_at)
      VALUES (${upload}, ${"8".repeat(64)}, '2026-09-17', 'client-query-test', 2, 2, 0, 1, 1, ${ADVISOR.email}, now())`;
    for (const n of [1, 2, 3]) {
      await owner.$executeRaw`INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
        VALUES (${client(n)}, ${household}, 'Invented Badge Query', ${String(n)}, ${ADVISOR.email})`;
      await owner.crmIdentity.create({ data: { id: identity(n), identity_type: "CONTACT" } });
      await owner.crmSourceMapping.create({ data: {
        id: `client-badge-query-source-${n}`, identity_id: identity(n), source_system: "CRM", source_namespace: "contact", source_key: client(n),
      } });
      if (n < 3) {
        await owner.employeeContactMapping.create({ data: {
          id: `client-badge-query-map-${n}`, employee_id: `client-badge-query-employee-${n}`,
          contact_identity_id: identity(n), client_sf_id: client(n), state: "CONFIRMED",
          evidence: "MANUAL_SEARCH", reviewed_by: ADVISOR.email,
        } });
        await owner.employeeClientStatus.create({ data: {
          client_sf_id: client(n), employment_state: n === 1 ? "ACTIVE" : "FORMER",
          effective_date: new Date("2026-09-17"), source_upload_id: upload,
        } });
      }
    }
  });

  afterAll(async () => {
    if (owner) { await cleanup(); await owner.$disconnect(); }
    vi.unstubAllEnvs();
  });

  it("restores JIT on the same pooled connection after the directory transaction", async () => {
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set("connection_limit", "1");
    const reader = new PrismaClient({ datasourceUrl: url.toString() });
    // Exercise the real withUserScope and directory callback on a dedicated
    // single-connection pool so the post-transaction check cannot use a new
    // connection and accidentally conceal a leaked session setting.
    const transaction = vi.spyOn(prisma, "$transaction")
      .mockImplementation(reader.$transaction.bind(reader) as typeof prisma.$transaction);
    try {
      await reader.$executeRaw`SET jit = 'on'`;
      const [before] = await reader.$queryRaw<Array<{ pid: number; jit: string }>>`
        SELECT pg_backend_pid() AS pid, current_setting('jit') AS jit`;
      expect((await getClientDirectory(ADVISOR, filters, 1, 2)).rows).toHaveLength(2);
      const [after] = await reader.$queryRaw<Array<{ pid: number; jit: string }>>`
        SELECT pg_backend_pid() AS pid, current_setting('jit') AS jit`;
      expect(after).toEqual(before);
      expect(after.jit).toBe("on");
    } finally {
      transaction.mockRestore();
      await reader.$disconnect();
    }
  });

  it("preserves current/absent badges and versions freshness changes outside the requested page", async () => {
    const first = await getClientDirectory(ADVISOR, filters, 1, 2);
    const second = await getClientDirectory(ADVISOR, filters, 2, 2);
    expect(first.rows.map(row => row.employeeStatus)).toEqual(["ACTIVE", "FORMER"]);
    expect(second.rows.map(row => row.employeeStatus)).toEqual([null]);
    expect(first.total).toBe(3);
    expect(second.snapshot).toBe(first.snapshot);

    await owner.employeeContactMapping.update({ where: { id: "client-badge-query-map-1" }, data: { state: "INVALIDATED" } });
    const changed = await getClientDirectory(ADVISOR, filters, 2, 2);
    expect(changed.snapshot).not.toBe(first.snapshot);
    expect(changed.rows).toEqual(second.rows);
    const refreshed = await getClientDirectory(ADVISOR, filters, 1, 2);
    expect(refreshed.rows.map(row => row.employeeStatus)).toEqual([null, "FORMER"]);

    const outsideBook = await getClientDirectory({ role: "ADVISOR", email: "other-client-badge@example.test" }, filters, 1, 2);
    expect(outsideBook.rows).toEqual([]);
    expect(outsideBook.total).toBe(0);
    expect(outsideBook.snapshot).not.toBe(changed.snapshot);
  });
});
