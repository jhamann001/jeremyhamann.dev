import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { runCrmMissingParentDiagnostics } from "@/lib/crm/parent-diagnostics";

vi.mock("server-only", () => ({}));

const gated =
  process.env.AUDIT_TEST_DB_URL && process.env.CRM_RECONCILER_DATABASE_URL
    ? describe
    : describe.skip;

const CONTACT = "CRM-P3A-CONTACT";
const HOUSEHOLD = "CRM-P3A-HOUSEHOLD";
const MISSING_HOUSEHOLD = "001288867315530AAA";
const EMAIL_ONE = "CRM-P3A-DIAG-EMAIL-1";
const EMAIL_TWO = "CRM-P3A-DIAG-EMAIL-2";
const ACTIVITY = "CRM-P3A-DIAG-ACTIVITY";
const TASK = "CRM-P3A-TASK";
const TASK_HOUSEHOLD = "001092155893454AAA";
const FEED_HOUSEHOLD = "001288867315530AAA";
const FEED_HOUSEHOLD_15 = FEED_HOUSEHOLD.slice(0, 15);

type RawCounts = {
  sources_seen: bigint;
  identities_created: bigint;
  mappings_created: bigint;
  mappings_refreshed: bigint;
  exceptions_opened: bigint;
  exceptions_reopened: bigint;
  exceptions_resolved: bigint;
};

function ownerClient(): PrismaClient {
  const url =
    process.env.AUDIT_TEST_CLEANUP_URL
    ?? `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/aoa?schema=app`;
  return new PrismaClient({ datasourceUrl: url });
}

function reconcilerClient(): PrismaClient {
  return new PrismaClient({ datasourceUrl: process.env.CRM_RECONCILER_DATABASE_URL! });
}

async function run(
  db: PrismaClient,
  runId: string,
  dryRun = false,
): Promise<RawCounts> {
  const rows = await db.$queryRaw<RawCounts[]>(Prisma.sql`
    SELECT * FROM app.reconcile_crm_identity_snapshot(${runId}, ${dryRun})
  `);
  if (!rows[0]) throw new Error("missing reconciliation result");
  return rows[0];
}

async function runWithParents(
  db: PrismaClient,
  runId: string,
  dryRun = false,
): Promise<RawCounts> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT * FROM app.reconcile_crm_parent_source(${dryRun})`;
    return run(tx as PrismaClient, runId, dryRun);
  });
}

async function previewCombined(
  db: PrismaClient,
  runId: string,
): Promise<RawCounts> {
  const rows = await db.$queryRaw<RawCounts[]>(Prisma.sql`
    SELECT * FROM app.preview_crm_identity_reconciliation(${runId})
  `);
  if (!rows[0]) throw new Error("missing reconciliation preview result");
  return rows[0];
}

async function runCombined(
  db: PrismaClient,
  runId: string,
): Promise<RawCounts> {
  return db.$transaction(async (tx) => {
    const parentRows = await tx.$queryRaw<Array<{
      sources_seen: bigint;
      identities_created: bigint;
      mappings_created: bigint;
      mappings_refreshed: bigint;
    }>>`SELECT * FROM app.reconcile_crm_parent_source(false)`;
    const snapshot = await run(tx as PrismaClient, runId, false);
    const parent = parentRows[0];
    if (!parent) throw new Error("missing parent reconciliation result");
    return {
      sources_seen: parent.sources_seen + snapshot.sources_seen,
      identities_created: parent.identities_created + snapshot.identities_created,
      mappings_created: parent.mappings_created + snapshot.mappings_created,
      mappings_refreshed: parent.mappings_refreshed + snapshot.mappings_refreshed,
      exceptions_opened: snapshot.exceptions_opened,
      exceptions_reopened: snapshot.exceptions_reopened,
      exceptions_resolved: snapshot.exceptions_resolved,
    };
  });
}

async function persistentCrmCounts(db: PrismaClient): Promise<Record<string, bigint>> {
  const [counts] = await db.$queryRaw<Array<Record<string, bigint>>>`
    SELECT
      (SELECT count(*)::bigint FROM app.crm_identity) AS identities,
      (SELECT count(*)::bigint FROM app.crm_source_mapping) AS mappings,
      (SELECT count(*)::bigint FROM app.crm_identity_exception) AS exceptions,
      (SELECT count(*)::bigint FROM audit."AuditLog"
        WHERE "action" = 'crm.identity.reconcile') AS reconcile_audits,
      (SELECT count(*)::bigint FROM audit.row_change) AS row_changes
  `;
  if (!counts) throw new Error("missing persistent CRM counts");
  return counts;
}

async function cleanup(db: PrismaClient): Promise<void> {
  await db.$executeRaw`
    DELETE FROM mirror.email WHERE sf_id IN (${EMAIL_ONE}, ${EMAIL_TWO})`;
  await db.$executeRaw`
    DELETE FROM mirror.activity WHERE sf_id = ${ACTIVITY}`;
  await db.$executeRaw`
    DELETE FROM mirror.task WHERE sf_id = ${TASK}`;
  await db.$executeRaw`
    DELETE FROM mirror.crm_parent_source
     WHERE parent_type = 'HOUSEHOLD' AND normalized_key = ${FEED_HOUSEHOLD_15}`;

  const mappings = await db.$queryRaw<Array<{ id: string; identity_id: string }>>`
    SELECT id, identity_id
      FROM app.crm_source_mapping
     WHERE source_key IN (
       ${CONTACT}, ${HOUSEHOLD}, ${FEED_HOUSEHOLD}, ${FEED_HOUSEHOLD_15},
       ${EMAIL_ONE}, ${EMAIL_TWO}, ${ACTIVITY}, ${TASK}, ${TASK_HOUSEHOLD}
     )`;
  const mappingIds = mappings.map((row) => row.id);
  const identityIds = [...new Set(mappings.map((row) => row.identity_id))];
  const exceptions = mappingIds.length > 0
    ? await db.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT id
                     FROM app.crm_identity_exception
                    WHERE source_mapping_id IN (${Prisma.join(mappingIds)})`,
      )
    : [];
  const exceptionIds = exceptions.map((row) => row.id);

  if (mappingIds.length > 0) {
    await db.$executeRaw(
      Prisma.sql`DELETE FROM app.crm_identity_exception
                  WHERE source_mapping_id IN (${Prisma.join(mappingIds)})`,
    );
    await db.$executeRaw(
      Prisma.sql`DELETE FROM app.crm_source_mapping
                  WHERE id IN (${Prisma.join(mappingIds)})`,
    );
  }
  if (identityIds.length > 0) {
    await db.$executeRaw(
      Prisma.sql`DELETE FROM app.crm_identity
                  WHERE id IN (${Prisma.join(identityIds)})`,
    );
  }

  await db.$executeRaw`DELETE FROM mirror.client WHERE sf_id = ${CONTACT}`;
  await db.$executeRaw`
    DELETE FROM mirror.household WHERE sf_id IN (${HOUSEHOLD}, ${TASK_HOUSEHOLD})`;
  await db.$executeRaw`
    DELETE FROM audit."AuditLog"
     WHERE "action" = 'crm.identity.reconcile'
       AND "entityType" = 'crm_reconciliation_run'
       AND "entityId" LIKE '00000000-0000-4000-8000-0000000000%'`;

  const auditRowIds = [...mappingIds, ...identityIds, ...exceptionIds];
  if (auditRowIds.length > 0) {
    await db.$executeRaw(
      Prisma.sql`DELETE FROM audit.row_change
                  WHERE row_pk IN (${Prisma.join(auditRowIds)})`,
    );
  }
}

gated("CRM Phase 3A continuous reconciliation", () => {
  let owner: PrismaClient;
  let reconciler: PrismaClient;

  beforeAll(() => {
    owner = ownerClient();
    reconciler = reconcilerClient();
  });

  beforeEach(async () => {
    await cleanup(owner);
    await owner.$executeRaw`
      INSERT INTO mirror.client
        (sf_id, household_id, first_name, last_name, lead_advisor_email, synced_at)
      VALUES
        (${CONTACT}, NULL, 'Synthetic', 'Reconciliation',
         'crm-phase3a@example.test', now())`;
  });

  afterAll(async () => {
    await cleanup(owner);
    await reconciler.$disconnect();
    await owner.$disconnect();
  });

  it("previews without writes, assigns a durable ID, and opens an unresolved parent", async () => {
    const preview = await run(
      reconciler,
      "00000000-0000-4000-8000-000000000001",
      true,
    );
    expect(Number(preview.identities_created)).toBeGreaterThanOrEqual(1);
    expect(Number(preview.exceptions_opened)).toBeGreaterThanOrEqual(1);

    const before = await owner.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n
        FROM app.crm_source_mapping WHERE source_key = ${CONTACT}`;
    expect(Number(before[0].n)).toBe(0);

    const live = await run(
      reconciler,
      "00000000-0000-4000-8000-000000000002",
    );
    expect(Number(live.identities_created)).toBeGreaterThanOrEqual(1);
    expect(Number(live.exceptions_opened)).toBeGreaterThanOrEqual(1);

    const rows = await owner.$queryRaw<
      Array<{ identity_id: string; exception_state: string; resolution_code: string | null }>
    >`
      SELECT m.identity_id, e.exception_state, e.resolution_code
        FROM app.crm_source_mapping m
        JOIN app.crm_identity_exception e ON e.source_mapping_id = m.id
       WHERE m.source_system = 'CRM'
         AND m.source_namespace = 'contact'
         AND m.source_key = ${CONTACT}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].identity_id).toMatch(/^con_c[0-9a-f]{24}$/);
    expect(rows[0]).toMatchObject({
      exception_state: "OPEN",
      resolution_code: null,
    });
  });

  it("auto-resolves an exact parent, preserves IDs on replay, and reopens if the link disappears", async () => {
    await run(reconciler, "00000000-0000-4000-8000-000000000003");
    const [first] = await owner.$queryRaw<Array<{ identity_id: string }>>`
      SELECT identity_id FROM app.crm_source_mapping
       WHERE source_system = 'CRM'
         AND source_namespace = 'contact'
         AND source_key = ${CONTACT}`;

    await owner.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, lead_advisor_email, synced_at)
      VALUES (${HOUSEHOLD}, 'Synthetic Household', 'crm-phase3a@example.test', now())`;
    await owner.$executeRaw`
      UPDATE mirror.client SET household_id = ${HOUSEHOLD}, synced_at = now()
       WHERE sf_id = ${CONTACT}`;

    const resolved = await run(
      reconciler,
      "00000000-0000-4000-8000-000000000004",
    );
    expect(Number(resolved.exceptions_resolved)).toBeGreaterThanOrEqual(1);

    const [exception] = await owner.$queryRaw<
      Array<{ exception_state: string; resolution_code: string | null; resolved_at: Date | null }>
    >`
      SELECT e.exception_state, e.resolution_code, e.resolved_at
        FROM app.crm_identity_exception e
        JOIN app.crm_source_mapping m ON m.id = e.source_mapping_id
       WHERE m.source_key = ${CONTACT}
         AND e.reason_code = 'MISSING_PARENT_MAPPING'`;
    expect(exception).toMatchObject({
      exception_state: "RESOLVED",
      resolution_code: "PARENT_MAPPED",
    });
    expect(exception.resolved_at).toBeInstanceOf(Date);

    const replay = await run(
      reconciler,
      "00000000-0000-4000-8000-000000000005",
    );
    expect(Number(replay.identities_created)).toBe(0);
    expect(Number(replay.mappings_created)).toBe(0);
    expect(Number(replay.exceptions_resolved)).toBe(0);
    const [second] = await owner.$queryRaw<Array<{ identity_id: string }>>`
      SELECT identity_id FROM app.crm_source_mapping
       WHERE source_key = ${CONTACT}`;
    expect(second.identity_id).toBe(first.identity_id);

    await owner.$executeRaw`
      UPDATE mirror.client SET household_id = NULL, synced_at = now()
       WHERE sf_id = ${CONTACT}`;
    const reopened = await run(
      reconciler,
      "00000000-0000-4000-8000-000000000006",
    );
    expect(Number(reopened.exceptions_reopened)).toBeGreaterThanOrEqual(1);

    const [openAgain] = await owner.$queryRaw<
      Array<{ exception_state: string; resolution_code: string | null; resolved_at: Date | null }>
    >`
      SELECT e.exception_state, e.resolution_code, e.resolved_at
        FROM app.crm_identity_exception e
        JOIN app.crm_source_mapping m ON m.id = e.source_mapping_id
       WHERE m.source_key = ${CONTACT}
         AND e.reason_code = 'MISSING_PARENT_MAPPING'`;
    expect(openAgain).toEqual({
      exception_state: "OPEN",
      resolution_code: null,
      resolved_at: null,
    });
  });

  it("assigns a CRM task ID and resolves only through its exact household key", async () => {
    await owner.$executeRaw`
      INSERT INTO mirror.task
        (sf_id, household_sf_id, subject, status, priority, description, synced_at)
      VALUES
        (${TASK}, ${TASK_HOUSEHOLD}, 'Private task title', 'Open', 'Normal',
         'Private task description', now())`;

    const opened = await run(
      reconciler,
      "00000000-0000-4000-8000-000000000016",
    );
    expect(Number(opened.identities_created)).toBeGreaterThanOrEqual(1);
    expect(Number(opened.exceptions_opened)).toBeGreaterThanOrEqual(1);

    const [registered] = await owner.$queryRaw<Array<{
      identity_id: string;
      identity_type: string;
      exception_state: string;
    }>>`
      SELECT m.identity_id, i.identity_type, e.exception_state
        FROM app.crm_source_mapping m
        JOIN app.crm_identity i ON i.id = m.identity_id
        JOIN app.crm_identity_exception e ON e.source_mapping_id = m.id
       WHERE m.source_system = 'CRM'
         AND m.source_namespace = 'task'
         AND m.source_key = ${TASK}`;
    expect(registered).toMatchObject({
      identity_type: "TASK",
      exception_state: "OPEN",
    });
    expect(registered.identity_id).toMatch(/^tsk_c[0-9a-f]{24}$/);

    await owner.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, lead_advisor_email, synced_at)
      VALUES (${TASK_HOUSEHOLD}, 'Task Household', 'crm-phase3a@example.test', now())`;
    const resolved = await run(
      reconciler,
      "00000000-0000-4000-8000-000000000017",
    );
    expect(Number(resolved.exceptions_resolved)).toBeGreaterThanOrEqual(1);

    const [after] = await owner.$queryRaw<Array<{
      identity_id: string;
      exception_state: string;
      resolution_code: string | null;
    }>>`
      SELECT m.identity_id, e.exception_state, e.resolution_code
        FROM app.crm_source_mapping m
        JOIN app.crm_identity_exception e ON e.source_mapping_id = m.id
       WHERE m.source_system = 'CRM'
         AND m.source_namespace = 'task'
         AND m.source_key = ${TASK}`;
    expect(after).toEqual({
      identity_id: registered.identity_id,
      exception_state: "RESOLVED",
      resolution_code: "PARENT_MAPPED",
    });

    const replay = await run(
      reconciler,
      "00000000-0000-4000-8000-000000000018",
    );
    expect(Number(replay.identities_created)).toBe(0);
    expect(Number(replay.mappings_created)).toBe(0);
  });

  it("cannot read client names or mutate source, mapping identity, lifecycle, or rows", async () => {
    await expect(
      reconciler.$queryRawUnsafe("SELECT first_name FROM mirror.client LIMIT 1"),
    ).rejects.toThrow();
    await expect(
      reconciler.$queryRawUnsafe("SELECT subject FROM mirror.task LIMIT 1"),
    ).rejects.toThrow();
    await expect(
      reconciler.$executeRawUnsafe(
        "UPDATE mirror.client SET household_id = NULL WHERE sf_id = 'none'",
      ),
    ).rejects.toThrow();
    await expect(
      reconciler.$executeRawUnsafe(
        "UPDATE mirror.crm_parent_source SET synced_at = now() WHERE false",
      ),
    ).rejects.toThrow();
    await expect(
      reconciler.$executeRawUnsafe(
        "UPDATE app.crm_source_mapping SET identity_id = identity_id WHERE false",
      ),
    ).rejects.toThrow();
    await expect(
      reconciler.$executeRawUnsafe(
        "UPDATE app.crm_identity SET lifecycle_state = 'ARCHIVED' WHERE false",
      ),
    ).rejects.toThrow();
    await expect(
      reconciler.$executeRawUnsafe("DELETE FROM app.crm_identity WHERE false"),
    ).rejects.toThrow();
  });

  it("classifies missing household keys by shape and cross-domain reuse without returning keys", async () => {
    const before = await runCrmMissingParentDiagnostics();

    await owner.$executeRaw`
      INSERT INTO mirror.email (sf_id, household_sf_id, synced_at)
      VALUES
        (${EMAIL_ONE}, ${MISSING_HOUSEHOLD}, now()),
        (${EMAIL_TWO}, ${MISSING_HOUSEHOLD}, now())`;
    await owner.$executeRaw`
      INSERT INTO mirror.activity (sf_id, household_sf_id, synced_at)
      VALUES (${ACTIVITY}, ${MISSING_HOUSEHOLD}, now())`;

    const after = await runCrmMissingParentDiagnostics();
    expect(after.summary.unresolved_records - before.summary.unresolved_records).toBe(3);
    expect(after.summary.would_open - before.summary.would_open).toBe(3);
    expect(
      after.summary.distinct_unresolved_household_keys
      - before.summary.distinct_unresolved_household_keys,
    ).toBe(1);

    const finding = (value: typeof after) => value.household_key_findings.find(
      (row) => row.exception_action === "WOULD_OPEN"
        && row.finding === "VALID_ACCOUNT_KEY_ABSENT",
    );
    expect((finding(after)?.records ?? 0) - (finding(before)?.records ?? 0)).toBe(3);
    expect(
      (finding(after)?.distinct_keys ?? 0) - (finding(before)?.distinct_keys ?? 0),
    ).toBe(1);

    const coverage = (value: typeof after) => value.household_cross_domain.find(
      (row) => row.exception_action === "WOULD_OPEN"
        && row.coverage === "EMAIL_AND_ACTIVITY",
    );
    expect((coverage(after)?.records ?? 0) - (coverage(before)?.records ?? 0)).toBe(3);
    expect(
      (coverage(after)?.distinct_keys ?? 0) - (coverage(before)?.distinct_keys ?? 0),
    ).toBe(1);

    expect(JSON.stringify(after)).not.toContain(MISSING_HOUSEHOLD);
    expect(JSON.stringify(after)).not.toContain(EMAIL_ONE);
    expect(JSON.stringify(after)).not.toContain(ACTIVITY);

    const mappings = await owner.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n
        FROM app.crm_source_mapping
       WHERE source_key IN (${EMAIL_ONE}, ${EMAIL_TWO}, ${ACTIVITY})`;
    expect(Number(mappings[0].n)).toBe(0);
  });

  it("mints one parent identity across Salesforce widths and auto-resolves child exceptions", async () => {
    await owner.$executeRaw`
      INSERT INTO mirror.email (sf_id, household_sf_id, synced_at)
      VALUES (${EMAIL_ONE}, ${FEED_HOUSEHOLD}, now())`;

    await run(reconciler, "00000000-0000-4000-8000-000000000010");
    const before = await runCrmMissingParentDiagnostics();
    expect(before.summary.already_open).toBeGreaterThanOrEqual(1);

    await owner.$executeRaw`
      INSERT INTO mirror.crm_parent_source (parent_type, source_key, synced_at)
      VALUES ('HOUSEHOLD', ${FEED_HOUSEHOLD}, now())`;

    const covered = await runCrmMissingParentDiagnostics();
    expect(covered.summary.unresolved_records).toBe(before.summary.unresolved_records - 1);
    expect(covered.summary.would_resolve).toBe(before.summary.would_resolve + 1);

    const resolved = await runWithParents(
      reconciler,
      "00000000-0000-4000-8000-000000000011",
    );
    expect(Number(resolved.exceptions_resolved)).toBeGreaterThanOrEqual(1);

    const mappings = await owner.$queryRaw<Array<{
      identity_id: string;
      source_key: string;
      identity_type: string;
    }>>`
      SELECT m.identity_id, m.source_key, i.identity_type
        FROM app.crm_source_mapping m
        JOIN app.crm_identity i ON i.id = m.identity_id
       WHERE m.source_system = 'CRM'
         AND m.source_namespace = 'household'
         AND m.source_key IN (${FEED_HOUSEHOLD}, ${FEED_HOUSEHOLD_15})
       ORDER BY m.source_key`;
    expect(mappings).toHaveLength(2);
    expect(new Set(mappings.map((row) => row.identity_id)).size).toBe(1);
    expect(mappings.every((row) => row.identity_type === "HOUSEHOLD")).toBe(true);

    const [exception] = await owner.$queryRaw<Array<{
      exception_state: string;
      resolution_code: string | null;
    }>>`
      SELECT e.exception_state, e.resolution_code
        FROM app.crm_identity_exception e
        JOIN app.crm_source_mapping m ON m.id = e.source_mapping_id
       WHERE m.source_system = 'CRM'
         AND m.source_namespace = 'email'
         AND m.source_key = ${EMAIL_ONE}`;
    expect(exception).toEqual({
      exception_state: "RESOLVED",
      resolution_code: "PARENT_MAPPED",
    });

    const replay = await runWithParents(
      reconciler,
      "00000000-0000-4000-8000-000000000012",
    );
    expect(Number(replay.identities_created)).toBe(0);
    expect(Number(replay.mappings_created)).toBe(0);
    expect(Number(replay.exceptions_resolved)).toBe(0);
  });

  it("returns live-equivalent combined counts while rolling every preview write back", async () => {
    await owner.$executeRaw`
      INSERT INTO mirror.email (sf_id, household_sf_id, synced_at)
      VALUES (${EMAIL_ONE}, ${FEED_HOUSEHOLD}, now())`;
    await owner.$executeRaw`
      INSERT INTO mirror.crm_parent_source (parent_type, source_key, synced_at)
      VALUES ('HOUSEHOLD', ${FEED_HOUSEHOLD}, now())`;

    const before = await persistentCrmCounts(owner);
    const preview = await previewCombined(
      reconciler,
      "00000000-0000-4000-8000-000000000013",
    );
    expect(await persistentCrmCounts(owner)).toEqual(before);

    const live = await runCombined(
      reconciler,
      "00000000-0000-4000-8000-000000000014",
    );
    expect(live).toEqual(preview);

    const replay = await previewCombined(
      reconciler,
      "00000000-0000-4000-8000-000000000015",
    );
    expect(Number(replay.identities_created)).toBe(0);
    expect(Number(replay.mappings_created)).toBe(0);
    expect(Number(replay.exceptions_opened)).toBe(0);
    expect(Number(replay.exceptions_reopened)).toBe(0);
    expect(Number(replay.exceptions_resolved)).toBe(0);
  });
});
