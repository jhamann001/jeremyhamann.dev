import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  applyLegacyImport, previewLegacyImport, type LegacyImportInput,
} from "@/lib/operations/legacy-import-engine";
import {
  LEGACY_BILLING_SOURCE, LEGACY_FEE_SOURCE, LEGACY_RECON_SOURCE,
  deterministicLegacyId, parseLegacyBillingExceptionsCsv,
  parseLegacyFeeCreditsCsv, parseLegacyTradeReconciliationCsv,
} from "@/lib/operations/legacy-import";

// Run only against the repository's explicitly opted-in disposable PostgreSQL
// database, using `npm run test:db` (no file parallelism). No export is loaded.
const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const HOUSEHOLD = "001KVT405354166AAA";
const OTHER_HOUSEHOLD = "001AVT203338185AAA";
const ANCHOR = "003KVT405354166AAA";
const PARTNER = "003AVT203338185AAA";
const OUTSIDER = "003VPG658680878AAA";
const ACCOUNT_A = "legacy-engine-synthetic-account-a";
const ACCOUNT_B = "legacy-engine-synthetic-account-b";
const ACCOUNT_OTHER = "legacy-engine-synthetic-account-other";
const EMAIL = "legacy-engine-synthetic@example.test";
const SOURCE_LABEL = "Synthetic Adah & Morgan original reference";
const RECON_IDS = ["987650001", "987650002"];
const REQUEST_IDS = [
  deterministicLegacyId(LEGACY_FEE_SOURCE, "26"),
  deterministicLegacyId(LEGACY_FEE_SOURCE, "27"),
  deterministicLegacyId(LEGACY_BILLING_SOURCE, "987650001"),
];
const RUN_IDS = RECON_IDS.map((id) => deterministicLegacyId(LEGACY_RECON_SOURCE, id));
const ZERO = { [LEGACY_FEE_SOURCE]: 0, [LEGACY_BILLING_SOURCE]: 0, [LEGACY_RECON_SOURCE]: 0 };
const EXPECTED = { [LEGACY_FEE_SOURCE]: 2, [LEGACY_BILLING_SOURCE]: 1, [LEGACY_RECON_SOURCE]: 2 };

function syntheticInput(): LegacyImportInput {
  const fee = parseLegacyFeeCreditsCsv([
    "id,submission_date,user_role,client_user_id,fee_type,fee_amount,account_numbers,waiver_reason,created_at,status,credited_date,client_name,apex_request,submitted_by",
    ...["26", "27"].map((id) => `${id},2026-01-02,OPERATIONS,synthetic-legacy-engine-bridge,Wire,20.00,"LEN1111,LEN2222",Synthetic historical reason,2026-01-02,Rejected,,${SOURCE_LABEL},,Synthetic Importer`),
  ].join("\n"));
  const billing = parseLegacyBillingExceptionsCsv([
    "id,client_name,waiver_start_month,waiver_start_year,waiver_duration,waiver_reason,relevant_tickets,account_1,account_2,account_3,account_4,account_5,account_6,created_at,approval_status,approved_by,approval_date,exception_type,indefinite_duration",
    "987650001,Adah Synthetic,January,2026,6,Synthetic historical billing reason,https://example.invalid/synthetic-ticket,LEN1111,,,,,,2026-01-02,Pending Approval,,,Billing Exception,f",
  ].join("\n"));
  const recon = parseLegacyTradeReconciliationCsv([
    "id,trade_date,run_time,total_apex,total_meridian,perfect_matches,breaks,unmatched_apex,unmatched_meridian,match_rate,Notes",
    `${RECON_IDS[0]},2026-07-01,7/2/2026 6:30:00 AM,71,68,68,0,3,0,95.7746,Synthetic first run note`,
    `${RECON_IDS[1]},2026-07-01,7/2/2026 7:45:00 AM,72,68,68,1,4,0,94.4444,Synthetic second run note`,
  ].join("\n"));
  return {
    requests: [...fee.rows, ...billing.rows],
    reviewedMappings: [
      ...["26", "27"].map((legacyId) => ({
        source: LEGACY_FEE_SOURCE, legacyId, scope: "HOUSEHOLD" as const,
        clientSfId: ANCHOR, householdSfId: HOUSEHOLD, accountIds: [ACCOUNT_A, ACCOUNT_B],
      })),
      { source: LEGACY_BILLING_SOURCE, legacyId: "987650001", scope: "CLIENT",
        clientSfId: ANCHOR, householdSfId: null, accountIds: [ACCOUNT_A] },
    ],
    reconciliations: recon.rows,
    issues: [...fee.issues, ...billing.issues, ...recon.issues],
  };
}

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

gated.sequential("legacy import engine: real PostgreSQL owner-shaped acceptance", () => {
  let cleanupOwner: PrismaClient;
  let importer: PrismaClient;
  let migrationOwner = "";
  const fixtureRole = `aoa_legacy_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let roleCreated = false;
  let fixturesOwned = false;
  const queries: string[] = [];
  let fetchSpy: ReturnType<typeof vi.fn>;

  async function clearImportedRows() {
    await cleanupOwner.operationsSlackNotification.deleteMany({ where: { request_id: { in: REQUEST_IDS } } });
    await cleanupOwner.operationsFeeRequestEvent.deleteMany({ where: { request_id: { in: REQUEST_IDS } } });
    await cleanupOwner.operationsFeeRequest.deleteMany({ where: { id: { in: REQUEST_IDS } } });
    await cleanupOwner.tradeReconciliationNoteEvent.deleteMany({ where: { run_id: { in: RUN_IDS } } });
    await cleanupOwner.tradeReconciliationReviewEvent.deleteMany({ where: { run_id: { in: RUN_IDS } } });
    await cleanupOwner.tradeReconciliationRun.deleteMany({ where: { id: { in: RUN_IDS } } });
  }

  async function counts() {
    return {
      requests: await cleanupOwner.operationsFeeRequest.count({ where: { id: { in: REQUEST_IDS } } }),
      events: await cleanupOwner.operationsFeeRequestEvent.count({ where: { request_id: { in: REQUEST_IDS } } }),
      runs: await cleanupOwner.tradeReconciliationRun.count({ where: { id: { in: RUN_IDS } } }),
      notes: await cleanupOwner.tradeReconciliationNoteEvent.count({ where: { run_id: { in: RUN_IDS } } }),
      notifications: await cleanupOwner.operationsSlackNotification.count({ where: { request_id: { in: REQUEST_IDS } } }),
    };
  }

  const emptyCounts = { requests: 0, events: 0, runs: 0, notes: 0, notifications: 0 };

  async function verifyFixtureTarget(tx: Prisma.TransactionClient) {
    const [identity] = await tx.$queryRaw<Array<{
      current_role: string; session_role: string; rolsuper: boolean; rolbypassrls: boolean;
    }>>`SELECT current_user AS current_role, session_user AS session_role, r.rolsuper, r.rolbypassrls
        FROM pg_roles r WHERE r.rolname = current_user`;
    expect(identity).toEqual({
      current_role: fixtureRole, session_role: fixtureRole, rolsuper: false, rolbypassrls: false,
    });
  }

  const approve = async () => {};

  async function withSyntheticEventTrigger(action: "fail_second" | "enqueue", test: () => Promise<void>) {
    const triggerName = `${fixtureRole}_${action}`;
    const functionName = `app.${quotedIdentifier(triggerName)}`;
    // Fault injection is installed only in the opted-in disposable database,
    // restricted to this suite's deterministic synthetic IDs, and always removed.
    // No production policy is changed or disabled. The definer models an
    // accidental future enqueue hook so the engine's final invariant is tested.
    const body = action === "fail_second"
      ? `IF NEW.request_id = '${REQUEST_IDS[1]}' THEN RAISE EXCEPTION 'synthetic_mid_batch_failure'; END IF;`
      : `IF NEW.request_id = '${REQUEST_IDS[0]}' THEN INSERT INTO app.operations_slack_notification (request_id, event_id) VALUES (NEW.request_id, NEW.id); END IF;`;
    await cleanupOwner.$executeRawUnsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $fixture$
      BEGIN ${body} RETURN NEW; END; $fixture$`);
    try {
      await cleanupOwner.$executeRawUnsafe(`REVOKE ALL ON FUNCTION ${functionName}() FROM PUBLIC`);
      await cleanupOwner.$executeRawUnsafe(`CREATE TRIGGER ${quotedIdentifier(triggerName)}
        AFTER INSERT ON app.operations_fee_request_event FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      await test();
    } finally {
      await cleanupOwner.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${quotedIdentifier(triggerName)} ON app.operations_fee_request_event`);
      await cleanupOwner.$executeRawUnsafe(`DROP FUNCTION ${functionName}()`);
    }
  }

  beforeAll(async () => {
    const cleanupUrl = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!cleanupUrl) throw new Error("AUDIT_TEST_CLEANUP_URL is required for disposable fixture setup");
    const url = new URL(cleanupUrl);
    // Match CI's localhost PostgreSQL service and isolated workstation PG. This
    // suite deliberately cannot use a remote/cloud/shared database URL.
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new Error("legacy_import_tests_require_loopback_disposable_database");
    }
    cleanupOwner = new PrismaClient({ datasources: { db: { url: cleanupUrl } } });
    const [owner] = await cleanupOwner.$queryRaw<Array<{ owner_role: string; rolsuper: boolean }>>`
      SELECT pg_get_userbyid(c.relowner) AS owner_role, r.rolsuper
      FROM pg_class c JOIN pg_roles r ON r.rolname = current_user
      WHERE c.oid = 'app.operations_fee_request'::regclass`;
    if (!owner?.rolsuper) throw new Error("disposable_fixture_setup_requires_superuser_cleanup_connection");
    migrationOwner = owner.owner_role;
    // Abort rather than overwrite other suites' source-key fixtures. Database
    // test jobs run files serially, and each suite must clean up its own rows.
    expect(await counts()).toEqual(emptyCounts);
    const collisions = await cleanupOwner.$queryRaw<Array<{ sf_id: string }>>`
      SELECT sf_id FROM mirror.client WHERE sf_id IN (${ANCHOR}, ${PARTNER}, ${OUTSIDER})
      UNION ALL SELECT sf_id FROM mirror.household WHERE sf_id IN (${HOUSEHOLD}, ${OTHER_HOUSEHOLD})`;
    expect(collisions).toEqual([]);
    const password = crypto.randomBytes(24).toString("hex");
    await cleanupOwner.$executeRawUnsafe(`CREATE ROLE ${quotedIdentifier(fixtureRole)} LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
    roleCreated = true;
    // PG16 membership inherits privileges/policy applicability, never the
    // owner's SUPERUSER/BYPASSRLS attributes, and cannot SET ROLE to that owner.
    await cleanupOwner.$executeRawUnsafe(`GRANT ${quotedIdentifier(migrationOwner)} TO ${quotedIdentifier(fixtureRole)} WITH INHERIT TRUE, SET FALSE`);
    url.username = fixtureRole;
    url.password = password;
    url.searchParams.set("schema", "app");
    url.searchParams.set("connection_limit", "3");
    const client = new PrismaClient({
      datasources: { db: { url: url.toString() } }, log: [{ emit: "event", level: "query" }],
    });
    // Query text only; never collect parameters or connection credentials.
    client.$on("query", (event) => queries.push(event.query));
    importer = client;
    fixturesOwned = true;
    await cleanupOwner.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, lead_advisor_email)
      VALUES (${HOUSEHOLD}, 'Synthetic engine household', ${EMAIL}),
             (${OTHER_HOUSEHOLD}, 'Synthetic outside household', ${EMAIL})`;
    await cleanupOwner.$executeRaw`
      INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
      VALUES (${ANCHOR}, ${HOUSEHOLD}, 'Adah', 'Synthetic', ${EMAIL}),
             (${PARTNER}, ${HOUSEHOLD}, 'Morgan', 'Synthetic', ${EMAIL}),
             (${OUTSIDER}, ${OTHER_HOUSEHOLD}, 'Other', 'Synthetic', ${EMAIL})`;
    await cleanupOwner.$executeRaw`
      INSERT INTO mirror.client_account_aum
        (custodian_account_id, apex_account_number, client_sf_id, household_sf_id,
         account_type, account_status, source_present)
      VALUES (${ACCOUNT_A}, 'LEN1111', ${ANCHOR}, ${HOUSEHOLD}, 'Brokerage', 'OPEN', true),
             (${ACCOUNT_B}, 'LEN2222', ${PARTNER}, ${HOUSEHOLD}, 'IRA', 'CLOSED', false),
             (${ACCOUNT_OTHER}, 'LEN3333', ${OUTSIDER}, ${OTHER_HOUSEHOLD}, 'Brokerage', 'OPEN', true)`;
  }, 30_000);

  beforeEach(async () => {
    await clearImportedRows();
    expect(syntheticInput().issues).toEqual([]);
    vi.stubEnv("APP_ENV", "dev");
    vi.stubEnv("OPERATIONS_SLACK_CAPTURE_ENABLED", "true");
    fetchSpy = vi.fn(() => { throw new Error("synthetic_import_must_not_call_network"); });
    vi.stubGlobal("fetch", fetchSpy);
    queries.length = 0;
  });

  afterEach(async () => {
    try {
      expect(fetchSpy).not.toHaveBeenCalled();
      if (fixturesOwned) await clearImportedRows();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  afterAll(async () => {
    try {
      if (fixturesOwned) {
        await clearImportedRows();
        await cleanupOwner.$executeRaw`DELETE FROM mirror.client_account_aum WHERE custodian_account_id IN (${ACCOUNT_A}, ${ACCOUNT_B}, ${ACCOUNT_OTHER})`;
        await cleanupOwner.$executeRaw`DELETE FROM mirror.client WHERE sf_id IN (${ANCHOR}, ${PARTNER}, ${OUTSIDER})`;
        await cleanupOwner.$executeRaw`DELETE FROM mirror.household WHERE sf_id IN (${HOUSEHOLD}, ${OTHER_HOUSEHOLD})`;
      }
    } finally {
      await importer?.$disconnect();
      if (roleCreated) {
        await cleanupOwner.$executeRawUnsafe(`REVOKE ${quotedIdentifier(migrationOwner)} FROM ${quotedIdentifier(fixtureRole)}`);
        await cleanupOwner.$executeRawUnsafe(`DROP ROLE ${quotedIdentifier(fixtureRole)}`);
      }
      await cleanupOwner?.$disconnect();
    }
  }, 30_000);

  it("uses a separate nonsuperuser login inheriting owner policy rights without SET ROLE or RLS bypass", async () => {
    await importer.$transaction(verifyFixtureTarget);
    const membership = await importer.$queryRaw<Array<{ inherit_option: boolean; set_option: boolean }>>`
      SELECT inherit_option, set_option FROM pg_auth_members
      WHERE member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
        AND roleid = (SELECT oid FROM pg_roles WHERE rolname = ${migrationOwner})`;
    expect(membership).toEqual([{ inherit_option: true, set_option: false }]);
    const tables = await importer.$queryRaw<Array<{
      relname: string; owner_role: string; relrowsecurity: boolean; relforcerowsecurity: boolean;
    }>>`
      SELECT relname, pg_get_userbyid(relowner) AS owner_role, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid IN ('app.operations_fee_request'::regclass, 'app.operations_fee_request_event'::regclass,
        'app.trade_reconciliation_run'::regclass, 'app.trade_reconciliation_note_event'::regclass,
        'app.operations_slack_notification'::regclass)`;
    expect(tables).toHaveLength(5);
    for (const table of tables) expect(table).toMatchObject({
      owner_role: migrationOwner, relrowsecurity: true, relforcerowsecurity: true,
    });
    await expect(importer.$transaction((tx) =>
      tx.$executeRawUnsafe(`SET LOCAL ROLE ${quotedIdentifier(migrationOwner)}`),
    )).rejects.toThrow(/permission denied to set role/);
  });

  it("previews inside a database-enforced READ ONLY REPEATABLE READ transaction", async () => {
    const preview = await previewLegacyImport(importer, syntheticInput(), async (tx) => {
      await verifyFixtureTarget(tx);
      const [settings] = await tx.$queryRaw<Array<{ read_only: string; isolation: string }>>`
        SELECT current_setting('transaction_read_only') AS read_only,
               current_setting('transaction_isolation') AS isolation`;
      expect(settings).toEqual({ read_only: "on", isolation: "repeatable read" });
    });
    expect(preview).toMatchObject({ parsed: EXPECTED, ready: EXPECTED, existing: ZERO, issues: [], unresolved: [] });
    expect(await counts()).toEqual(emptyCounts);
  });

  it("rejects an attempted write even from the preview's target-verification callback", async () => {
    await expect(previewLegacyImport(importer, syntheticInput(), async (tx) => {
      await verifyFixtureTarget(tx);
      await tx.$executeRaw`UPDATE mirror.client SET first_name = first_name WHERE sf_id = ${ANCHOR}`;
    })).rejects.toThrow(/read-only transaction/);
    expect(await counts()).toEqual(emptyCounts);
  });

  it.each(["preview", "apply"] as const)("verifies the %s target before any source/directory data access", async (mode) => {
    const wrongTarget = vi.fn(async () => { throw new Error("synthetic_wrong_target"); });
    const approved = vi.fn(approve);
    await expect(mode === "preview"
      ? previewLegacyImport(importer, syntheticInput(), wrongTarget)
      : applyLegacyImport(importer, syntheticInput(), wrongTarget, approved),
    ).rejects.toThrow("synthetic_wrong_target");
    expect(wrongTarget).toHaveBeenCalledOnce();
    expect(approved).not.toHaveBeenCalled();
    expect(queries.filter((query) => /(?:\bmirror\.|"mirror"\.|"app"\.|\bapp\.)/.test(query))).toEqual([]);
    expect(await counts()).toEqual(emptyCounts);
  });

  it("aborts an unapproved plan in SERIALIZABLE before inserting any history", async () => {
    const approved = vi.fn(async (preview) => {
      expect(preview).toMatchObject({ ready: EXPECTED, existing: ZERO, issues: [] });
      throw new Error("synthetic_approval_digest_mismatch");
    });
    await expect(applyLegacyImport(importer, syntheticInput(), async (tx) => {
      await verifyFixtureTarget(tx);
      const [settings] = await tx.$queryRaw<Array<{ read_only: string; isolation: string }>>`
        SELECT current_setting('transaction_read_only') AS read_only,
               current_setting('transaction_isolation') AS isolation`;
      expect(settings).toEqual({ read_only: "off", isolation: "serializable" });
    }, approved)).rejects.toThrow("synthetic_approval_digest_mismatch");
    expect(approved).toHaveBeenCalledOnce();
    expect(queries.some((query) => query.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(queries.some((query) => /^INSERT /i.test(query))).toBe(false);
    expect(await counts()).toEqual(emptyCounts);
  });

  it("applies actual parsed history once, preserves duplicate-content source IDs, scope and notes, and never notifies", async () => {
    const input = syntheticInput();
    expect(await applyLegacyImport(importer, input, verifyFixtureTarget, approve)).toEqual({ inserted: EXPECTED, existing: ZERO });
    expect(await counts()).toEqual({ requests: 3, events: 3, runs: 2, notes: 2, notifications: 0 });
    const requests = await cleanupOwner.operationsFeeRequest.findMany({
      where: { id: { in: REQUEST_IDS } }, orderBy: [{ legacy_source: "asc" }, { legacy_source_id: "asc" }],
    });
    const fee = requests.filter((row) => row.legacy_source === LEGACY_FEE_SOURCE);
    expect(fee.map((row) => row.legacy_source_id)).toEqual(["26", "27"]);
    expect(fee[0].id).not.toBe(fee[1].id);
    for (const row of fee) {
      expect(row).toMatchObject({ scope: "HOUSEHOLD", client_sf_id: ANCHOR,
        legacy_household_sf_id: HOUSEHOLD, legacy_client_name: SOURCE_LABEL,
        account_ids: [ACCOUNT_A, ACCOUNT_B], status: "REJECTED",
        submitted_by_email: null, submitted_by_name: "Synthetic Importer",
        reviewed_by_email: null, reviewed_by_name: null, reviewed_at: null,
        submission_key: null, submitted_at: new Date("2026-01-02T00:00:00Z") });
      expect(row.fee_amount?.toString()).toBe("20");
      expect(row.legacy_source_digest).toBe(input.requests.find((draft) => draft.legacyId === row.legacy_source_id)!.sourceDigest);
    }
    expect(requests.find((row) => row.legacy_source === LEGACY_BILLING_SOURCE)).toMatchObject({
      scope: "CLIENT", client_sf_id: ANCHOR, legacy_household_sf_id: null,
      account_ids: [ACCOUNT_A], status: "PENDING", reviewed_by_name: null, reviewed_at: null,
      relevant_ticket_refs: ["https://example.invalid/synthetic-ticket"],
    });
    const events = await cleanupOwner.operationsFeeRequestEvent.findMany({ where: { request_id: { in: REQUEST_IDS } } });
    for (const event of events) expect(event).toMatchObject({ action: "LEGACY_IMPORTED", actor_email: null, from_status: null });
    const runs = await cleanupOwner.tradeReconciliationRun.findMany({
      where: { id: { in: RUN_IDS } }, include: { note_events: true }, orderBy: { legacy_source_id: "asc" },
    });
    for (const [index, run] of runs.entries()) {
      expect(run).toMatchObject({ algorithm_version: "legacy-summary-v1", source_scope_version: "legacy-run-summary-v1",
        source_commit_sha: "legacy-import", payload: [], completed_by: null, legacy_source: LEGACY_RECON_SOURCE,
        legacy_source_id: RECON_IDS[index], business_date: new Date("2026-07-01T00:00:00Z"),
        run_date: new Date("2026-07-02T00:00:00Z") });
      expect(run.note_events).toHaveLength(1);
      expect(run.note_events[0]).toMatchObject({ note: input.reconciliations[index].runNote,
        author_email: null, created_at: new Date(input.reconciliations[index].completedAt) });
    }
    const before = await counts();
    expect(await applyLegacyImport(importer, input, verifyFixtureTarget, approve)).toEqual({ inserted: ZERO, existing: EXPECTED });
    expect(await counts()).toEqual(before);
    expect(await previewLegacyImport(importer, input, verifyFixtureTarget)).toMatchObject({ existing: EXPECTED, issues: [] });
  });

  it.each(["request", "reconciliation"] as const)("blocks changed %s source content on a rerun without writing", async (kind) => {
    await applyLegacyImport(importer, syntheticInput(), verifyFixtureTarget, approve);
    const changed = syntheticInput();
    const draft = kind === "request" ? changed.requests[0] : changed.reconciliations[0];
    draft.sourceDigest = "f".repeat(64);
    const approved = vi.fn(approve);
    const before = await counts();
    const preview = await previewLegacyImport(importer, changed, verifyFixtureTarget);
    expect(preview.issues).toContainEqual({ source: draft.source, legacyId: draft.legacyId,
      field: "source_digest", code: "existing_record_drift" });
    await expect(applyLegacyImport(importer, changed, verifyFixtureTarget, approved)).rejects.toThrow("blocking_issues_present");
    expect(approved).not.toHaveBeenCalled();
    expect(await counts()).toEqual(before);
  });

  it("blocks reviewed mapping drift even when source content and household accounts are unchanged", async () => {
    await applyLegacyImport(importer, syntheticInput(), verifyFixtureTarget, approve);
    const changed = syntheticInput();
    changed.reviewedMappings[0].clientSfId = PARTNER;
    const preview = await previewLegacyImport(importer, changed, verifyFixtureTarget);
    expect(preview.issues).toContainEqual({ source: LEGACY_FEE_SOURCE, legacyId: "26", field: "mapping", code: "existing_mapping_drift" });
    await expect(applyLegacyImport(importer, changed, verifyFixtureTarget, approve)).rejects.toThrow("blocking_issues_present");
    expect(await counts()).toEqual({ requests: 3, events: 3, runs: 2, notes: 2, notifications: 0 });
  });

  it("rejects cross-household reviewed ownership before approval or insertion", async () => {
    const changed = syntheticInput();
    changed.reviewedMappings[0].accountIds = [ACCOUNT_A, ACCOUNT_OTHER];
    const preview = await previewLegacyImport(importer, changed, verifyFixtureTarget);
    expect(preview.unresolved).toHaveLength(1);
    expect(preview.issues).toContainEqual(expect.objectContaining({ source: LEGACY_FEE_SOURCE, legacyId: "26", field: "account_ids" }));
    const approved = vi.fn(approve);
    await expect(applyLegacyImport(importer, changed, verifyFixtureTarget, approved)).rejects.toThrow("blocking_issues_present");
    expect(approved).not.toHaveBeenCalled();
    expect(await counts()).toEqual(emptyCounts);
  });

  it("rolls back requests, events, an earlier run and its note when a later reconciliation violates a real DB constraint", async () => {
    const input = syntheticInput();
    // Deliberately corrupt the parsed draft after parsing to inject a failure
    // past the first request/run inserts, exercising the actual DB transaction.
    input.reconciliations[1].rawMatchRate = "101.0000";
    const approved = vi.fn(approve);
    await expect(applyLegacyImport(importer, input, verifyFixtureTarget, approved)).rejects.toThrow(/trade_reconciliation_run_rate_check/);
    expect(approved).toHaveBeenCalledOnce();
    expect(queries.some((query) => /INSERT INTO "app"\."operations_fee_request"/.test(query))).toBe(true);
    expect(queries.some((query) => /INSERT INTO "app"\."operations_fee_request_event"/.test(query))).toBe(true);
    expect(queries.some((query) => /INSERT INTO "app"\."trade_reconciliation_note_event"/.test(query))).toBe(true);
    expect(await counts()).toEqual(emptyCounts);
  });

  it("rolls back an already inserted request and event after an injected mid-batch database failure", async () => {
    await withSyntheticEventTrigger("fail_second", async () => {
      await expect(applyLegacyImport(importer, syntheticInput(), verifyFixtureTarget, approve))
        .rejects.toThrow("synthetic_mid_batch_failure");
      expect(queries.filter((query) => /INSERT INTO "app"\."operations_fee_request_event"/.test(query)).length).toBeGreaterThanOrEqual(2);
      expect(await counts()).toEqual(emptyCounts);
    });
    // Cleanup leaves both schema and ordinary behavior intact for a safe retry.
    expect(await applyLegacyImport(importer, syntheticInput(), verifyFixtureTarget, approve))
      .toEqual({ inserted: EXPECTED, existing: ZERO });
  });

  it("rejects and rolls back the entire import if a future hook accidentally enqueues a historical notification", async () => {
    await withSyntheticEventTrigger("enqueue", async () => {
      await expect(applyLegacyImport(importer, syntheticInput(), verifyFixtureTarget, approve))
        .rejects.toThrow("import_notification_invariant_failed");
      expect(await counts()).toEqual(emptyCounts);
    });
  });
});
