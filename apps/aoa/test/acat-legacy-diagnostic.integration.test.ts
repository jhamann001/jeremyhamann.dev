import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Deliberate opt-in to a separately provisioned local synthetic database only.
// Never inherit an ambient application database or production cloud identity.
const RUN = process.env.ACAT_LEGACY_DIAGNOSTIC_TEST_DATABASE_URL ? describe : describe.skip;
const PREFIX = "ZZTEST-ACAT-LEGACY-228";
const SUFFIXES = [
  "00-archived", "10-archived", "20-discovery", "30-accounts", "40-decision",
  "50-in-transfer", "60-funded", "record-only", "both", "unlinked", "empty-record",
  "non-uuid", "empty-transfer",
] as const;
const IDS = SUFFIXES.map((suffix) => `${PREFIX}-${suffix}`);
const OPS = { role: "OPERATIONS", email: "zztest-acat-legacy-228@example.invalid" };
const ADMIN = { role: "ADMIN", email: "zztest-acat-legacy-admin@example.invalid" };
const CREATED_BY = "zztest-acat-legacy-seed@example.invalid";
const FIXED_AT = new Date("2026-09-25T12:00:00.000Z");

function syntheticUrl(raw: string | undefined, role: "app_rw" | "aoa"): URL {
  if (!raw) throw new Error("explicit_acat_legacy_synthetic_database_required");
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.port !== "55438"
    || url.pathname !== "/aoa_tkt28_synthetic"
    || url.username !== role
    || [...url.searchParams.keys()].some((key) => !["schema", "connection_limit", "pool_timeout"].includes(key))
    || url.hash
    || process.env.K_SERVICE
    || process.env.CLOUD_RUN_SERVICE
    || ["dev", "development", "prod", "production"].includes(process.env.APP_ENV?.toLowerCase() ?? "")) {
    throw new Error("isolated_acat_legacy_synthetic_database_required");
  }
  return url;
}

RUN("legacy ACAT diagnostic on an isolated synthetic PostgreSQL database", () => {
  let owner: PrismaClient | undefined;
  let appPrisma: typeof import("@/lib/db").prisma | undefined;
  let withUserScope: typeof import("@/lib/rls").withUserScope;
  let readDiagnostic: typeof import("@/lib/data/acat-legacy-diagnostic").readAcatLegacyDiagnostic;

  async function cleanup() {
    if (!owner) return;
    // Every deletion is constrained to this test's explicitly owned fixtures.
    await owner.transfer.deleteMany({ where: { id: { in: IDS } } });
    await owner.auditLog.deleteMany({ where: { entityType: "transfer", entityId: { in: IDS } } });
    await owner.rowChange.deleteMany({ where: { schema_name: "app", table_name: "transfer", row_pk: { in: IDS } } });
  }

  async function seed(suffix: typeof SUFFIXES[number], overrides: Partial<Prisma.TransferCreateInput> = {}) {
    const id = `${PREFIX}-${suffix}`;
    return owner!.transfer.create({ data: {
      id, source: "APP", client_first_name: "ZZTEST", client_last_name: "Legacy Diagnostic Synthetic",
      value: "228.00", stage: "DECISION", stage_entered_at: FIXED_AT,
      owner_kind: "OPERATIONS", next_step: "Synthetic existing step remains",
      acat_record_id: null, acat_transfer_id: `${id}-tracker-transfer`,
      created_by: CREATED_BY, updated_by: CREATED_BY,
      ...overrides,
    } });
  }

  async function snapshot() {
    return {
      transfers: await owner!.transfer.findMany({ orderBy: { id: "asc" } }),
      // xmin changes even for an otherwise invisible UPDATE of an existing row.
      versions: await owner!.$queryRaw<Array<{ id: string; version: string }>>`
        SELECT id, xmin::text AS version FROM app.transfer ORDER BY id`,
      audits: await owner!.auditLog.findMany({ orderBy: { id: "asc" } }),
      rowChanges: await owner!.rowChange.findMany({ orderBy: { id: "asc" } }),
    };
  }

  beforeAll(async () => {
    const explicit = syntheticUrl(process.env.ACAT_LEGACY_DIAGNOSTIC_TEST_DATABASE_URL, "app_rw");
    const runtime = syntheticUrl(process.env.DATABASE_URL, "app_rw");
    const cleanupUrl = syntheticUrl(process.env.ACAT_LEGACY_DIAGNOSTIC_TEST_CLEANUP_URL, "aoa");
    if (runtime.href !== explicit.href || runtime.host !== cleanupUrl.host || runtime.pathname !== cleanupUrl.pathname) {
      throw new Error("acat_legacy_synthetic_connections_must_match");
    }

    // No DB-bound application import or connection precedes destination checks.
    owner = new PrismaClient({ datasourceUrl: cleanupUrl.href });
    ({ withUserScope } = await import("@/lib/rls"));
    ({ readAcatLegacyDiagnostic: readDiagnostic } = await import("@/lib/data/acat-legacy-diagnostic"));
    ({ prisma: appPrisma } = await import("@/lib/db"));
    const [scope] = await withUserScope(OPS, (tx) => tx.$queryRaw<Array<{
      database: string; username: string; superuser: boolean; bypassrls: boolean;
      role: string; email: string; rls: boolean; forced: boolean;
    }>>`SELECT current_database() AS database, current_user AS username,
      r.rolsuper AS superuser, r.rolbypassrls AS bypassrls,
      current_setting('app.user_role') AS role, current_setting('app.user_email') AS email,
      c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
      FROM pg_roles r CROSS JOIN pg_class c
      WHERE r.rolname = current_user AND c.oid = 'app.transfer'::regclass`);
    expect(scope).toEqual({
      database: "aoa_tkt28_synthetic", username: "app_rw", superuser: false, bypassrls: false,
      role: OPS.role, email: OPS.email, rls: true, forced: true,
    });
    await cleanup();
    // A foreign fixture must fail the test, never be deleted to force zero counts.
    expect(await owner.transfer.count()).toBe(0);
  });

  beforeEach(async () => { await cleanup(); });

  afterAll(async () => {
    try { await cleanup(); }
    finally { await owner?.$disconnect(); await appPrisma?.$disconnect(); }
  });

  it("returns zero counts and no candidate when no legacy-only rows exist", async () => {
    expect(await readDiagnostic(OPS)).toEqual({
      legacyOnlyCount: 0, archivedLegacyOnlyCount: 0, candidateTransferId: null,
    });
    await seed("record-only", { acat_record_id: "synthetic-record-only", acat_transfer_id: null });
    await seed("both", { acat_record_id: "synthetic-both" });
    await seed("unlinked", { acat_transfer_id: null });
    // Eligibility is literal SQL NULL, not JavaScript truthiness.
    await seed("empty-record", { acat_record_id: "" });
    expect(await readDiagnostic(OPS)).toEqual({
      legacyOnlyCount: 0, archivedLegacyOnlyCount: 0, candidateTransferId: null,
    });
  });

  it("counts all lifecycle stages and archived legacy rows while excluding other linkage shapes", async () => {
    await seed("00-archived", { stage: "FUNDED", archived_at: FIXED_AT });
    await seed("60-funded", { stage: "FUNDED" });
    await seed("50-in-transfer", { stage: "IN_TRANSFER" });
    await seed("40-decision", { stage: "DECISION" });
    await seed("30-accounts", { stage: "ACCOUNTS_OPEN" });
    await seed("20-discovery", { stage: "DISCOVERY" });
    await seed("record-only", { acat_record_id: "synthetic-record-only", acat_transfer_id: null });
    await seed("both", { acat_record_id: "synthetic-both", archived_at: FIXED_AT });
    await seed("unlinked", { acat_transfer_id: null, stage: "FUNDED" });
    const before = await snapshot();

    expect(await readDiagnostic(OPS)).toEqual({
      legacyOnlyCount: 6, archivedLegacyOnlyCount: 1, candidateTransferId: `${PREFIX}-20-discovery`,
    });
    expect(await snapshot()).toEqual(before);
  });

  it("does not narrow eligibility by UUID format, nonempty strings or upstream existence", async () => {
    await seed("non-uuid", { acat_transfer_id: "synthetic-not-a-uuid-or-upstream-record" });
    await seed("empty-transfer", { acat_transfer_id: "" });
    expect(await readDiagnostic(OPS)).toEqual({
      legacyOnlyCount: 2, archivedLegacyOnlyCount: 0, candidateTransferId: `${PREFIX}-empty-transfer`,
    });
  });

  it("deterministically prefers the smallest nonarchived ID, falling back to the smallest archived ID", async () => {
    await seed("10-archived", { archived_at: FIXED_AT });
    await seed("00-archived", { archived_at: FIXED_AT });
    expect(await readDiagnostic(OPS)).toEqual({
      legacyOnlyCount: 2, archivedLegacyOnlyCount: 2, candidateTransferId: `${PREFIX}-00-archived`,
    });
    await seed("50-in-transfer", { stage: "IN_TRANSFER" });
    await seed("40-decision");
    const before = await snapshot();
    const expected = { legacyOnlyCount: 4, archivedLegacyOnlyCount: 2, candidateTransferId: `${PREFIX}-40-decision` };
    expect(await readDiagnostic(OPS)).toEqual(expected);
    expect(await readDiagnostic(ADMIN)).toEqual(expected);
    expect(await readDiagnostic(OPS)).toEqual(expected);
    expect(await snapshot()).toEqual(before);
    // The helper's scoped role/email cannot leak into the pooled connection.
    expect(await appPrisma!.transfer.findUnique({ where: { id: `${PREFIX}-40-decision` } })).toBeNull();
  });

  it.each([
    { role: "VIEWER", email: OPS.email }, { role: "ADVISOR", email: OPS.email },
    { role: "CLIENT_SERVICE", email: OPS.email }, { role: "unknown", email: OPS.email },
    { role: null, email: OPS.email }, { role: "OPERATIONS", email: null },
    { role: "ADMIN", email: "" }, { role: "OPERATIONS", email: "   " },
  ])("rejects unauthorized identity $role/$email before a DB transaction", async (identity) => {
    await seed("non-uuid");
    const before = await snapshot();
    const transaction = vi.spyOn(appPrisma!, "$transaction");
    try {
      await expect(readDiagnostic(identity)).rejects.toThrow();
      expect(transaction).not.toHaveBeenCalled();
    } finally { transaction.mockRestore(); }
    expect(await snapshot()).toEqual(before);
  });
});
