import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LINK_ERRORS, type AcatLinkKey } from "@/lib/data/acat-link";

const { authSpy, revalidateSpy, redirectSpy, trackerSpy, crmSignalSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(), revalidateSpy: vi.fn(), redirectSpy: vi.fn(),
  trackerSpy: vi.fn(), crmSignalSpy: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateSpy }));
vi.mock("next/navigation", () => ({ redirect: redirectSpy }));
vi.mock("@/lib/data/clients", () => ({ listClients: vi.fn() }));
vi.mock("@/lib/data/household-picker", () => ({ listHouseholdPickerTargets: vi.fn() }));
vi.mock("@/lib/data/transfers", () => ({ listTransfers: vi.fn() }));
vi.mock("@/lib/data/acat-status", () => ({
  getAcatStatus: trackerSpy, getAcatStatusByRecordId: trackerSpy,
}));
vi.mock("@/lib/crm/post-commit-signal", () => ({
  scheduleCrmIdentityReconciliation: crmSignalSpy,
}));

// Explicit opt-in only: never use an ambient development/production database.
// Provision this dedicated synthetic database with repository migrations first.
const RUN = process.env.ACAT_UNLINK_TEST_DATABASE_URL ? describe : describe.skip;
const PREFIX = "ZZTEST-ACAT-UNLINK-237";
const SUFFIXES = [
  "persist", "retry", "legacy", "record-only", "stale", "archived", "rollback", "rls",
  "ADMIN", "VIEWER", "ADVISOR", "CLIENT_SERVICE", "expired", "unknown",
  "race-record", "race-uuid", "race-archive", "race-unlink",
  "legacy-uppercase", "legacy-mixedcase",
] as const;
const IDS = SUFFIXES.map((suffix) => `${PREFIX}-${suffix}`);
const OPS = { role: "OPERATIONS", email: "zztest-acat-unlink-237@example.invalid" };
const CREATED_BY = "zztest-acat-unlink-seed@example.invalid";
const APPROVED_AT = new Date("2026-09-24T12:00:00.000Z");

function syntheticUrl(raw: string | undefined, role: "app_rw" | "aoa"): URL {
  if (!raw) throw new Error("explicit_acat_unlink_synthetic_database_required");
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.port !== "55437"
    || url.pathname !== "/aoa_tkt37_synthetic"
    || url.username !== role
    || [...url.searchParams.keys()].some((key) => !["schema", "connection_limit", "pool_timeout"].includes(key))
    || url.hash
    || process.env.K_SERVICE
    || process.env.CLOUD_RUN_SERVICE
    || ["dev", "development", "prod", "production"].includes(process.env.APP_ENV?.toLowerCase() ?? "")) {
    throw new Error("isolated_acat_unlink_synthetic_database_required");
  }
  return url;
}

function keyFor(id: string): AcatLinkKey {
  return { recordId: `${id}-tracker-record`, acatTransferId: `${id}-tracker-transfer` };
}

RUN("ACAT unlink on an isolated synthetic PostgreSQL database", () => {
  let owner: PrismaClient | undefined;
  let appPrisma: typeof import("@/lib/db").prisma | undefined;
  let withUserScope: typeof import("@/lib/rls").withUserScope;
  let unlinkAction: typeof import("@/app/(authenticated)/acat-tracking/actions").unlinkAcatFromExistingTransfer;
  let unlinkHelper: typeof import("@/lib/data/acat-link").unlinkAcatFromTransfer;

  async function removeAuditFault() {
    if (!owner) return;
    await owner.$executeRaw`DROP TRIGGER IF EXISTS zztest_tkt37_unlink_reject_audit ON audit."AuditLog"`;
    await owner.$executeRaw`DROP FUNCTION IF EXISTS audit.zztest_tkt37_unlink_reject_audit()`;
  }

  async function cleanup() {
    if (!owner) return;
    await removeAuditFault();
    // Only these explicitly owned fixtures and their child/audit rows are removed.
    await owner.transferFundingPlanApproval.deleteMany({ where: { transfer_id: { in: IDS } } });
    await owner.transferDecision.deleteMany({ where: { transfer_id: { in: IDS } } });
    await owner.transferTask.deleteMany({ where: { transfer_id: { in: IDS } } });
    await owner.transfer.deleteMany({ where: { id: { in: IDS } } });
    await owner.auditLog.deleteMany({ where: { entityType: "transfer", entityId: { in: IDS } } });
    const rowIds = IDS.flatMap((id) => [id, `${id}-task`, `${id}-decision`, `${id}-approval`]);
    await owner.rowChange.deleteMany({ where: { schema_name: "app", row_pk: { in: rowIds } } });
  }

  async function seed(id: string, overrides: Partial<Prisma.TransferCreateInput> = {}) {
    const key = keyFor(id);
    return owner!.transfer.create({
      data: {
        id, source: "APP", client_first_name: "ZZTEST", client_last_name: "ACAT Unlink Synthetic",
        client_sf_id: `${id}-client`, household_sf_id: `${id}-household`,
        household_name: "ZZTEST synthetic household", value: "237.00", stage: "DECISION",
        stage_entered_at: APPROVED_AT, owner_kind: "OPERATIONS", owner_name: "Synthetic operator",
        next_step: "Keep this unrelated synthetic step", next_step_owner: "Operations",
        acat_record_id: key.recordId, acat_transfer_id: key.acatTransferId,
        funding_type: "ACAT_FULL", accounts_opened_at_apex: true, funding_plan_complete: true,
        funding_plan_version: 1, funding_plan_approved_at: APPROVED_AT, funding_plan_approved_by: CREATED_BY,
        asset_map_folder_id: `${id}-folder`, asset_map_custodian: "ZZTEST synthetic custodian",
        asset_map_account_number: "SYNTHETIC-1234", asset_map_account_type: "Traditional IRA",
        created_by: CREATED_BY, updated_by: CREATED_BY,
        tasks: { create: { id: `${id}-task`, title: "Synthetic task remains", sort_order: 0 } },
        decisions: { create: {
          id: `${id}-decision`, symbol: "ZZTEST", description: "Synthetic position only",
          value: "237.00", cost_basis: "200.00",
        } },
        funding_plan_approvals: { create: {
          id: `${id}-approval`, version: 1, funding_type: "ACAT_FULL", approved_by: CREATED_BY,
          snapshot: { source: "synthetic", positions: [] }, note: "ZZTEST approval remains",
        } },
        ...overrides,
      },
    });
  }

  // Every reload uses a new real user-scoped transaction after the action
  // completed; action return values are not evidence of persistence.
  async function reload(id: string) {
    return withUserScope(OPS, async (tx) => ({
      transfer: await tx.transfer.findUniqueOrThrow({
        where: { id }, include: { tasks: true, decisions: true, funding_plan_approvals: true },
      }),
      audits: await tx.auditLog.findMany({
        where: { entityType: "transfer", entityId: id }, orderBy: { id: "asc" },
      }),
      rowChanges: await tx.rowChange.findMany({
        where: { schema_name: "app", table_name: "transfer", row_pk: id }, orderBy: { id: "asc" },
      }),
    }));
  }

  beforeAll(async () => {
    const explicit = syntheticUrl(process.env.ACAT_UNLINK_TEST_DATABASE_URL, "app_rw");
    const runtime = syntheticUrl(process.env.DATABASE_URL, "app_rw");
    const cleanupUrl = syntheticUrl(process.env.ACAT_UNLINK_TEST_CLEANUP_URL, "aoa");
    if (runtime.href !== explicit.href
      || runtime.host !== cleanupUrl.host
      || runtime.pathname !== cleanupUrl.pathname) {
      throw new Error("acat_unlink_synthetic_connections_must_match");
    }

    // Import DB-bound code only after all connection destinations are validated.
    owner = new PrismaClient({ datasourceUrl: cleanupUrl.href });
    ({ withUserScope } = await import("@/lib/rls"));
    ({ unlinkAcatFromExistingTransfer: unlinkAction } = await import("@/app/(authenticated)/acat-tracking/actions"));
    ({ unlinkAcatFromTransfer: unlinkHelper } = await import("@/lib/data/acat-link"));
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
      database: "aoa_tkt37_synthetic", username: "app_rw", superuser: false, bypassrls: false,
      role: OPS.role, email: OPS.email, rls: true, forced: true,
    });
    await cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    authSpy.mockResolvedValue({ user: { email: OPS.email, role: OPS.role } });
    trackerSpy.mockRejectedValue(new Error("Synthetic tracker unavailable; unlink must not consult it"));
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await owner?.$disconnect();
      await appPrisma?.$disconnect();
    }
  });

  it("commits only the exact references and updater, preserving approval, task, decision and transfer fields", async () => {
    const id = `${PREFIX}-persist`;
    await seed(id);
    const before = await reload(id);

    expect(await unlinkAction(id, keyFor(id))).toEqual({ ok: true });

    const after = await reload(id);
    expect(after.transfer).toEqual({
      ...before.transfer, acat_record_id: null, acat_transfer_id: null,
      updated_by: OPS.email, updated_at: after.transfer.updated_at,
    });
    expect(after.transfer.updated_at.getTime()).toBeGreaterThanOrEqual(before.transfer.updated_at.getTime());
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]).toMatchObject({
      actorEmail: OPS.email, actorRole: OPS.role, action: "transfer.update", entityType: "transfer", entityId: id,
    });
    expect(JSON.parse(after.audits[0].detail!)).toEqual({ changes: {
      acat_record_id: { from: keyFor(id).recordId, to: null },
      acat_transfer_id: { from: keyFor(id).acatTransferId, to: null },
    } });
    expect(after.rowChanges).toHaveLength(before.rowChanges.length + 1);
    expect(after.rowChanges.at(-1)).toMatchObject({ op: "UPDATE", actor_email: OPS.email, actor_role: OPS.role });
    // PostgreSQL tuple transaction IDs prove row update and audit insert committed
    // in the same transaction, rather than merely both existing after the call.
    const [transactions] = await owner!.$queryRaw<Array<{ transfer_xid: string; audit_xid: string }>>`
      SELECT t.xmin::text AS transfer_xid, a.xmin::text AS audit_xid
      FROM app.transfer t JOIN audit."AuditLog" a ON a."entityId" = t.id
      WHERE t.id = ${id} AND a."entityType" = 'transfer'`;
    expect(transactions.transfer_xid).toBe(transactions.audit_xid);
    expect(revalidateSpy.mock.calls).toEqual([
      ["/acat-tracking"], ["/asset-transfer"], [`/asset-transfer/${id}`],
    ]);
    expect(trackerSpy).not.toHaveBeenCalled();
    expect(crmSignalSpy).not.toHaveBeenCalled();
    expect(redirectSpy).not.toHaveBeenCalled();
  });

  it("makes a lost-response retry a persisted no-op with no duplicate audit or timestamp change", async () => {
    const id = `${PREFIX}-retry`;
    await seed(id);
    expect(await unlinkAction(id, keyFor(id))).toEqual({ ok: true });
    const once = await reload(id);
    expect(await unlinkAction(id, keyFor(id))).toEqual({ ok: true });
    expect(await reload(id)).toEqual(once);
    expect(once.audits).toHaveLength(1);
  });

  it.each(["legacy", "record-only"] as const)("removes a persisted %s link with only the changed audit field", async (kind) => {
    const id = `${PREFIX}-${kind}`;
    const legacy = kind === "legacy";
    await seed(id, legacy ? { acat_record_id: null } : { acat_transfer_id: null });
    expect(await unlinkAction(id, keyFor(id))).toEqual({ ok: true });
    const after = await reload(id);
    expect(after.transfer).toMatchObject({ acat_record_id: null, acat_transfer_id: null });
    expect(after.audits).toHaveLength(1);
    expect(JSON.parse(after.audits[0].detail!)).toEqual({ changes: legacy
      ? { acat_transfer_id: { from: keyFor(id).acatTransferId, to: null } }
      : { acat_record_id: { from: keyFor(id).recordId, to: null } } });
  });

  it("rejects a different record ID even if the drawer has the stored legacy transfer ID", async () => {
    const id = `${PREFIX}-stale`;
    await seed(id);
    const before = await reload(id);
    expect(await unlinkAction(id, { ...keyFor(id), recordId: `${id}-wrong-record` }))
      .toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_LINK_CHANGED] });
    expect(await reload(id)).toEqual(before);
    expect(revalidateSpy).not.toHaveBeenCalled();
  });

  it.each([
    { suffix: "legacy-uppercase", stored: "ABCDEF12-ABCD-4ABC-8ABC-ABCDEF123456" },
    { suffix: "legacy-mixedcase", stored: "AbCdEf12-AbCd-4aBc-8AbC-aBcDeF123457" },
  ])("removes a persisted $suffix UUID and audits the original stored casing", async ({ suffix, stored }) => {
    const id = `${PREFIX}-${suffix}`;
    await seed(id, { acat_record_id: null, acat_transfer_id: stored });
    const before = await reload(id);
    expect(await unlinkAction(id, { ...keyFor(id), acatTransferId: stored.toLowerCase() }))
      .toEqual({ ok: true });
    const after = await reload(id);
    expect(after.transfer).toEqual({
      ...before.transfer, acat_transfer_id: null, updated_by: OPS.email,
      updated_at: after.transfer.updated_at,
    });
    expect(after.audits).toHaveLength(1);
    expect(JSON.parse(after.audits[0].detail!)).toEqual({ changes: {
      acat_transfer_id: { from: stored, to: null },
    } });
  });

  it("rejects an archived target without touching its link, audit or timestamps", async () => {
    const id = `${PREFIX}-archived`;
    await seed(id, { archived_at: APPROVED_AT, archived_by: CREATED_BY, archived_reason: "Synthetic archive" });
    const before = await reload(id);
    expect(await unlinkAction(id, keyFor(id)))
      .toEqual({ ok: false, errors: [LINK_ERRORS.TRANSFER_ARCHIVED] });
    expect(await reload(id)).toEqual(before);
    expect(revalidateSpy).not.toHaveBeenCalled();
  });

  it("returns not-found for a missing target without adding an audit", async () => {
    const id = `${PREFIX}-missing`;
    expect(await unlinkAction(id, keyFor(id)))
      .toEqual({ ok: false, errors: [LINK_ERRORS.TRANSFER_NOT_FOUND] });
    expect(await owner!.auditLog.count({ where: { entityId: id } })).toBe(0);
    expect(revalidateSpy).not.toHaveBeenCalled();
  });

  it("permits an authenticated Admin through the real scoped transaction", async () => {
    const id = `${PREFIX}-ADMIN`;
    await seed(id);
    authSpy.mockResolvedValue({ user: { email: OPS.email, role: "ADMIN" } });
    expect(await unlinkAction(id, keyFor(id))).toEqual({ ok: true });
    const after = await reload(id);
    expect(after.transfer).toMatchObject({ acat_record_id: null, acat_transfer_id: null });
    expect(after.audits[0]).toMatchObject({ actorRole: "ADMIN" });
  });

  it.each(["VIEWER", "ADVISOR", "CLIENT_SERVICE", "expired", "unknown"] as const)(
    "denies %s at the action boundary with the real database unchanged", async (role) => {
      const id = `${PREFIX}-${role}`;
      await seed(id);
      const before = await reload(id);
      authSpy.mockResolvedValue(role === "expired" ? null : { user: { email: OPS.email, role } });
      expect(await unlinkAction(id, keyFor(id))).toEqual({
        ok: false, errors: [{ field: "form", message: "You do not have permission to unlink ACATs." }],
      });
      expect(await reload(id)).toEqual(before);
      expect(revalidateSpy).not.toHaveBeenCalled();
      expect(redirectSpy).not.toHaveBeenCalled();
    },
  );

  it("enforces the actual RLS write backstop and clears user scope after the transaction", async () => {
    const id = `${PREFIX}-rls`;
    await seed(id);
    const before = await reload(id);
    const viewer = { role: "VIEWER", email: "zztest-viewer@example.invalid" };
    // Transfer reads are intentionally firm-wide, not per advisor/book. VIEWER
    // can see this row but cannot update it even when bypassing the action gate.
    expect(await withUserScope(viewer, (tx) => tx.transfer.findUnique({ where: { id } }))).not.toBeNull();
    expect(await withUserScope(viewer, (tx) => unlinkHelper(tx, viewer, id, keyFor(id))))
      .toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_LINK_CHANGED] });
    expect(await reload(id)).toEqual(before);
    // SET LOCAL from the successful Operations reload cannot escape its scope.
    expect(await appPrisma!.transfer.findUnique({ where: { id } })).toBeNull();
  });

  it("rolls the real link update and row-change audit back when the semantic audit insert fails", async () => {
    const id = `${PREFIX}-rollback`;
    await seed(id);
    const before = await reload(id);
    // An isolated, test-owned fault targets this one fixture only. No production
    // policies, grants, application implementations or database clients are mocked.
    await owner!.$executeRaw`CREATE FUNCTION audit.zztest_tkt37_unlink_reject_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."entityId" = 'ZZTEST-ACAT-UNLINK-237-rollback' THEN
          RAISE EXCEPTION 'synthetic_acat_unlink_audit_failure';
        END IF;
        RETURN NEW;
      END $$`;
    await owner!.$executeRaw`CREATE TRIGGER zztest_tkt37_unlink_reject_audit
      BEFORE INSERT ON audit."AuditLog" FOR EACH ROW
      EXECUTE FUNCTION audit.zztest_tkt37_unlink_reject_audit()`;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await unlinkAction(id, keyFor(id))).toEqual({
        ok: false, errors: [{ field: "form", message: "Unlink failed. Refresh the page and try again." }],
      });
      expect(await reload(id)).toEqual(before);
      expect(revalidateSpy).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith("[acat-link] unlink_failed");
    } finally {
      log.mockRestore();
      await removeAuditFault();
    }
    // The same persisted link remains actionable once the synthetic fault is gone.
    expect(await unlinkAction(id, keyFor(id))).toEqual({ ok: true });
    expect((await reload(id)).audits).toHaveLength(1);
  });

  it.each(["record", "uuid", "archive", "unlink"] as const)(
    "does not overwrite a concurrently committed %s change between its read and conditional update", async (race) => {
      const id = `${PREFIX}-race-${race}`;
      await seed(id);
      const concurrentData = race === "record" ? { acat_record_id: `${id}-new-record` }
        : race === "uuid" ? { acat_transfer_id: `${id}-new-transfer` }
          : race === "archive" ? { archived_at: APPROVED_AT }
            : { acat_record_id: null, acat_transfer_id: null };
      let concurrentState: Awaited<ReturnType<typeof reload>> | undefined;
      let readCount = 0;
      const result = await withUserScope(OPS, async (tx) => {
        // The proxy only coordinates scheduling. Both the original read and all
        // writes are real SQL; a separate connection commits the competing edit.
        const transfer = new Proxy(tx.transfer, {
          get(target, property, receiver) {
            if (property === "findUnique") return async (args: Prisma.TransferFindUniqueArgs) => {
              const current = await target.findUnique(args);
              readCount += 1;
              await owner!.transfer.update({ where: { id }, data: concurrentData });
              concurrentState = await reload(id);
              return current;
            };
            return Reflect.get(target, property, receiver);
          },
        });
        const coordinated = new Proxy(tx, {
          get(target, property, receiver) {
            return property === "transfer" ? transfer : Reflect.get(target, property, receiver);
          },
        });
        return unlinkHelper(coordinated, OPS, id, keyFor(id));
      }, { timeout: 10_000 });

      expect(readCount).toBe(1);
      expect(result).toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_LINK_CHANGED] });
      expect(await reload(id)).toEqual(concurrentState);
      expect(concurrentState!.audits).toEqual([]);
    },
  );
});
