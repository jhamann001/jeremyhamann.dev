import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { withUserScope } from "@/lib/rls";
import { runCrmRelationshipSnapshot } from "@/lib/crm/relationships";
import { crmReconcilerClient } from "@/lib/crm/reconciler-db";

vi.mock("server-only", () => ({}));

const gated =
  process.env.AUDIT_TEST_DB_URL && process.env.CRM_RECONCILER_DATABASE_URL
    ? describe
    : describe.skip;

const HOUSEHOLD_KEY_15 = "001170837395544";
const HOUSEHOLD_KEY_18 = `${HOUSEHOLD_KEY_15}AAA`;
const HOUSEHOLD_KEY_AMBIGUOUS = `${HOUSEHOLD_KEY_15}BBB`;
const CONTACT_KEY = "003170837395544AAA";
const DEAL_KEY = "phase-four-c-deal";
const TRANSFER_KEY = "phase-four-c-transfer";

const HOUSEHOLD_ID = "hld_phasefourchousehold";
const CONTACT_ID = "con_phasefourccontact";
const DEAL_ID = "dea_phasefourcdeal";
const TRANSFER_ID = "xfr_phasefourctransfer";
const EXTRA_HOUSEHOLD_ID = "hld_phasefourcextrahousehold";
const HOUSEHOLD_SURVIVOR_ID = "hld_phasefourchouseholdsurvivor";
const CONTACT_SURVIVOR_ID = "con_phasefourccontactsurvivor";

const HOUSEHOLD_MAP = "cphasefourchouseholdmap";
const CONTACT_MAP = "cphasefourccontactmap";
const DEAL_MAP = "cphasefourcdealmap";
const TRANSFER_MAP = "cphasefourctransfermap";
const EXTRA_HOUSEHOLD_MAP = "cphasefourcextrahouseholdmap";

const RUN_PREFIX = "40000000-0000-4000-8000-";

type RawCounts = {
  derivation_code: string;
  snapshot_complete: boolean;
  candidates: bigint;
  created: bigint;
  refreshed: bigint;
  reactivated: bigint;
  inactivated: bigint;
  missing_endpoint: bigint;
  ambiguous_endpoint: bigint;
  rejected_type: bigint;
};

type Completeness = {
  contact: boolean;
  deal: boolean;
  transfer: boolean;
};

const COMPLETE: Completeness = { contact: true, deal: true, transfer: true };

function ownerClient(): PrismaClient {
  const url =
    process.env.AUDIT_TEST_CLEANUP_URL
    ?? `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/aoa?schema=app`;
  return new PrismaClient({ datasourceUrl: url });
}

function reconcilerClient(): PrismaClient {
  return new PrismaClient({
    datasourceUrl: process.env.CRM_RECONCILER_DATABASE_URL!,
  });
}

async function runSnapshot(
  db: PrismaClient,
  runId: string,
  dryRun: boolean,
  complete: Completeness = COMPLETE,
): Promise<RawCounts[]> {
  if (dryRun) {
    return db.$queryRaw<RawCounts[]>(Prisma.sql`
      SELECT * FROM app.preview_crm_relationship_snapshot(
        ${runId}, ${complete.contact}, ${complete.deal}, ${complete.transfer}
      )
    `);
  }
  return db.$queryRaw<RawCounts[]>(Prisma.sql`
    SELECT * FROM app.reconcile_crm_relationship_snapshot(
      ${runId}, ${complete.contact}, ${complete.deal}, ${complete.transfer}
    )
  `);
}

function byDerivation(rows: RawCounts[]): Map<string, RawCounts> {
  return new Map(rows.map((row) => [row.derivation_code, row]));
}

async function persistentCounts(db: PrismaClient): Promise<Record<string, bigint>> {
  const [counts] = await db.$queryRaw<Array<Record<string, bigint>>>`
    SELECT
      (SELECT count(*)::bigint FROM app.crm_relationship) AS relationships,
      (SELECT count(*)::bigint FROM audit."AuditLog"
        WHERE "action" = 'crm.relationship.reconcile') AS business_audits,
      (SELECT count(*)::bigint FROM audit.row_change
        WHERE table_name = 'crm_relationship') AS row_change_audits
  `;
  if (!counts) throw new Error("missing relationship persistence counts");
  return counts;
}

async function cleanup(db: PrismaClient): Promise<void> {
  const relationships = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM app.crm_relationship
     WHERE evidence_mapping_id IN (
       ${HOUSEHOLD_MAP}, ${CONTACT_MAP}, ${DEAL_MAP}, ${TRANSFER_MAP},
       ${EXTRA_HOUSEHOLD_MAP}
     )`;
  const relationshipIds = relationships.map((row) => row.id);

  await db.$executeRaw`
    DELETE FROM app.crm_relationship
     WHERE evidence_mapping_id IN (
       ${HOUSEHOLD_MAP}, ${CONTACT_MAP}, ${DEAL_MAP}, ${TRANSFER_MAP},
       ${EXTRA_HOUSEHOLD_MAP}
     )`;
  await db.$executeRaw`
    DELETE FROM app.crm_source_mapping
     WHERE id IN (
       ${HOUSEHOLD_MAP}, ${CONTACT_MAP}, ${DEAL_MAP}, ${TRANSFER_MAP},
       ${EXTRA_HOUSEHOLD_MAP}
     )`;

  await db.$executeRaw`
    DELETE FROM app.crm_identity
     WHERE id IN (
       ${HOUSEHOLD_ID}, ${CONTACT_ID}, ${DEAL_ID}, ${TRANSFER_ID},
       ${EXTRA_HOUSEHOLD_ID}
     )`;
  await db.$executeRaw`
    DELETE FROM app.crm_identity
     WHERE id IN (${HOUSEHOLD_SURVIVOR_ID}, ${CONTACT_SURVIVOR_ID})`;

  await db.$executeRaw`DELETE FROM mirror.client WHERE sf_id = ${CONTACT_KEY}`;
  await db.$executeRaw`
    DELETE FROM mirror.household
     WHERE sf_id IN (${HOUSEHOLD_KEY_18}, ${HOUSEHOLD_KEY_AMBIGUOUS})`;
  await db.$executeRaw`DELETE FROM app.deal WHERE id = ${DEAL_KEY}`;
  await db.$executeRaw`DELETE FROM app.transfer WHERE id = ${TRANSFER_KEY}`;

  await db.$executeRaw`
    DELETE FROM audit."AuditLog"
     WHERE "action" = 'crm.relationship.reconcile'
       AND "entityId" LIKE ${`${RUN_PREFIX}%`}`;

  const controlledIds = [
    HOUSEHOLD_ID,
    CONTACT_ID,
    DEAL_ID,
    TRANSFER_ID,
    EXTRA_HOUSEHOLD_ID,
    HOUSEHOLD_SURVIVOR_ID,
    CONTACT_SURVIVOR_ID,
    HOUSEHOLD_MAP,
    CONTACT_MAP,
    DEAL_MAP,
    TRANSFER_MAP,
    EXTRA_HOUSEHOLD_MAP,
    DEAL_KEY,
    TRANSFER_KEY,
    ...relationshipIds,
  ];
  await db.$executeRaw(
    Prisma.sql`DELETE FROM audit.row_change
                WHERE row_pk IN (${Prisma.join(controlledIds)})`,
  );
}

async function seed(db: PrismaClient): Promise<void> {
  await db.$executeRaw`
    INSERT INTO mirror.household (sf_id, name, lead_advisor_email, synced_at)
    VALUES (${HOUSEHOLD_KEY_18}, 'Phase Four C Household',
            'phase-four-c@example.test', now())`;
  await db.$executeRaw`
    INSERT INTO mirror.client
      (sf_id, household_id, first_name, last_name, lead_advisor_email, synced_at)
    VALUES
      (${CONTACT_KEY}, ${HOUSEHOLD_KEY_18}, 'Phase', 'Four C',
       'phase-four-c@example.test', now())`;
  await db.$executeRaw`
    INSERT INTO app.deal
      (id, source, name, client_first_name, client_last_name,
       household_sf_id, amount, stage, created_date, updated_at)
    VALUES
      (${DEAL_KEY}, 'APP', 'Phase Four C Deal', 'Phase', 'Four C',
       ${HOUSEHOLD_KEY_18}, 1000, 'COMMITTED', '2026-08-07', now())`;
  await db.$executeRaw`
    INSERT INTO app.transfer
      (id, source, client_first_name, client_last_name,
       household_sf_id, value, stage, owner_kind, updated_at)
    VALUES
      (${TRANSFER_KEY}, 'APP', 'Phase', 'Four C',
       ${HOUSEHOLD_KEY_18}, 1000, 'DECISION', 'OPERATIONS', now())`;

  await db.$executeRaw`
    INSERT INTO app.crm_identity
      (id, identity_type, lifecycle_state, updated_at)
    VALUES
      (${HOUSEHOLD_ID}, 'HOUSEHOLD', 'ACTIVE', now()),
      (${CONTACT_ID}, 'CONTACT', 'ACTIVE', now()),
      (${DEAL_ID}, 'DEAL', 'ACTIVE', now()),
      (${TRANSFER_ID}, 'TRANSFER', 'ACTIVE', now())`;
  await db.$executeRaw`
    INSERT INTO app.crm_source_mapping
      (id, identity_id, source_system, source_namespace, source_key, updated_at)
    VALUES
      (${HOUSEHOLD_MAP}, ${HOUSEHOLD_ID}, 'CRM', 'household',
       ${HOUSEHOLD_KEY_15}, now()),
      (${CONTACT_MAP}, ${CONTACT_ID}, 'CRM', 'contact', ${CONTACT_KEY}, now()),
      (${DEAL_MAP}, ${DEAL_ID}, 'AOA', 'deal', ${DEAL_KEY}, now()),
      (${TRANSFER_MAP}, ${TRANSFER_ID}, 'AOA', 'transfer', ${TRANSFER_KEY}, now())`;
}

gated("CRM Phase 4C relationship snapshot", () => {
  let owner: PrismaClient;
  let reconciler: PrismaClient;
  let secondReconciler: PrismaClient;

  beforeAll(() => {
    // Validate every actual connection target before any fixture cleanup/seed
    // or the table-lock test can run. Do not inherit the owner's legacy fallback.
    if (["K_SERVICE", "CLOUD_RUN_SERVICE", "K_REVISION", "GOOGLE_CLOUD_PROJECT",
      "GCLOUD_PROJECT", "GCP_PROJECT", "PGHOST", "PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE"]
      .some((key) => Boolean(process.env[key]))
      || process.env.NODE_ENV === "production"
      || (process.env.APP_ENV && process.env.APP_ENV !== "local")) {
      throw new Error("relationship_fixture_requires_local_environment");
    }
    const allowedParameters = new Set(["schema", "connection_limit", "pool_timeout"]);
    const targets = [
      [process.env.AUDIT_TEST_CLEANUP_URL, "aoa"],
      [process.env.CRM_RECONCILER_DATABASE_URL, "identity_reconciler"],
      [process.env.DATABASE_URL, "app_rw"],
    ].map(([raw, role]) => {
      let url: URL;
      try { url = new URL(raw ?? ""); }
      catch { throw new Error("relationship_fixture_requires_explicit_database"); }
      if (!["postgres:", "postgresql:"].includes(url.protocol)
        || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        || !["5432", "55444"].includes(url.port) || url.username !== role || url.hash
        || !(url.pathname === "/aoa_pagination_synthetic" || (process.env.CI === "true" && url.pathname === "/aoa"))
        || [...url.searchParams.keys()].some((key) => !allowedParameters.has(key))) {
        throw new Error("relationship_fixture_requires_isolated_synthetic_database");
      }
      return url;
    });
    if (targets.some((url) => url.host !== targets[0].host || url.pathname !== targets[0].pathname)) {
      throw new Error("relationship_fixture_database_targets_differ");
    }
    owner = ownerClient();
    reconciler = reconcilerClient();
    secondReconciler = reconcilerClient();
  });

  beforeEach(async () => {
    await cleanup(owner);
    await seed(owner);
  });

  afterAll(async () => {
    if (!owner) return;
    await cleanup(owner);
    await secondReconciler.$disconnect();
    await reconciler.$disconnect();
    await crmReconcilerClient().$disconnect();
    await owner.$disconnect();
  });

  it("previews the exact three-edge backfill and rolls back both audit layers", async () => {
    const before = await persistentCounts(owner);
    const rows = await runSnapshot(
      reconciler,
      `${RUN_PREFIX}000000000001`,
      true,
    );
    const counts = byDerivation(rows);

    expect(rows).toHaveLength(3);
    for (const derivation of [
      "CRM_CONTACT_HOUSEHOLD",
      "AOA_DEAL_HOUSEHOLD",
      "AOA_TRANSFER_HOUSEHOLD",
    ]) {
      expect(counts.get(derivation)).toMatchObject({
        snapshot_complete: true,
        candidates: 1n,
        created: 1n,
        refreshed: 0n,
        reactivated: 0n,
        inactivated: 0n,
        missing_endpoint: 0n,
        ambiguous_endpoint: 0n,
        rejected_type: 0n,
      });
    }
    await expect(persistentCounts(owner)).resolves.toEqual(before);
  });

  it("creates exact typed edges once and refreshes the same IDs on replay", async () => {
    const first = byDerivation(await runSnapshot(
      reconciler,
      `${RUN_PREFIX}000000000002`,
      false,
    ));
    expect([...first.values()].map((row) => row.created)).toEqual([1n, 1n, 1n]);

    const relationships = await owner.$queryRaw<Array<{
      id: string;
      relationship_type: string;
      from_identity_id: string;
      to_identity_id: string;
      evidence_mapping_id: string;
    }>>`
      SELECT id, relationship_type, from_identity_id, to_identity_id,
             evidence_mapping_id
        FROM app.crm_relationship
       WHERE evidence_mapping_id IN (${CONTACT_MAP}, ${DEAL_MAP}, ${TRANSFER_MAP})
       ORDER BY relationship_type`;
    expect(relationships).toHaveLength(3);
    expect(relationships.every((row) => /^rel_c[0-9a-f]{24}$/.test(row.id))).toBe(true);
    expect(relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relationship_type: "HOUSEHOLD_HAS_MEMBER",
        from_identity_id: HOUSEHOLD_ID,
        to_identity_id: CONTACT_ID,
        evidence_mapping_id: CONTACT_MAP,
      }),
      expect.objectContaining({
        relationship_type: "DEAL_FOR_HOUSEHOLD",
        from_identity_id: DEAL_ID,
        to_identity_id: HOUSEHOLD_ID,
        evidence_mapping_id: DEAL_MAP,
      }),
      expect.objectContaining({
        relationship_type: "TRANSFER_FOR_HOUSEHOLD",
        from_identity_id: TRANSFER_ID,
        to_identity_id: HOUSEHOLD_ID,
        evidence_mapping_id: TRANSFER_MAP,
      }),
    ]));

    const second = byDerivation(await runSnapshot(
      reconciler,
      `${RUN_PREFIX}000000000003`,
      false,
    ));
    expect([...second.values()].map((row) => row.created)).toEqual([0n, 0n, 0n]);
    expect([...second.values()].map((row) => row.refreshed)).toEqual([1n, 1n, 1n]);

    const replayIds = await owner.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM app.crm_relationship
       WHERE evidence_mapping_id IN (${CONTACT_MAP}, ${DEAL_MAP}, ${TRANSFER_MAP})
       ORDER BY relationship_type`;
    expect(replayIds.map((row) => row.id)).toEqual(
      relationships.map((row) => row.id),
    );

    const audits = await owner.$queryRaw<Array<{ detail: string }>>`
      SELECT detail FROM audit."AuditLog"
       WHERE "action" = 'crm.relationship.reconcile'
         AND "entityId" = ${`${RUN_PREFIX}000000000002`}`;
    expect(audits).toHaveLength(1);
    expect(audits[0].detail).toContain("CRM_CONTACT_HOUSEHOLD");
    expect(audits[0].detail).not.toContain(HOUSEHOLD_KEY_15);
    expect(audits[0].detail).not.toContain(CONTACT_KEY);
  });

  it("requires completeness before inactivation and reactivates the same evidence", async () => {
    await runSnapshot(reconciler, `${RUN_PREFIX}000000000004`, false);
    const [original] = await owner.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM app.crm_relationship
       WHERE evidence_mapping_id = ${CONTACT_MAP}`;

    await owner.$executeRaw`
      UPDATE mirror.client SET household_id = NULL, synced_at = now()
       WHERE sf_id = ${CONTACT_KEY}`;
    const incomplete = byDerivation(await runSnapshot(
      reconciler,
      `${RUN_PREFIX}000000000005`,
      false,
      { contact: false, deal: true, transfer: true },
    ));
    expect(incomplete.get("CRM_CONTACT_HOUSEHOLD")).toMatchObject({
      snapshot_complete: false,
      inactivated: 0n,
      missing_endpoint: 1n,
    });
    await expect(owner.$queryRaw<Array<{ relationship_state: string }>>`
      SELECT relationship_state FROM app.crm_relationship WHERE id = ${original.id}
    `).resolves.toEqual([{ relationship_state: "ACTIVE" }]);

    const complete = byDerivation(await runSnapshot(
      reconciler,
      `${RUN_PREFIX}000000000006`,
      false,
      COMPLETE,
    ));
    expect(complete.get("CRM_CONTACT_HOUSEHOLD")?.inactivated).toBe(1n);

    await owner.$executeRaw`
      UPDATE mirror.client SET household_id = ${HOUSEHOLD_KEY_18}, synced_at = now()
       WHERE sf_id = ${CONTACT_KEY}`;
    const restored = byDerivation(await runSnapshot(
      reconciler,
      `${RUN_PREFIX}000000000007`,
      false,
      COMPLETE,
    ));
    expect(restored.get("CRM_CONTACT_HOUSEHOLD")?.reactivated).toBe(1n);
    await expect(owner.$queryRaw<Array<{ id: string; relationship_state: string }>>`
      SELECT id, relationship_state FROM app.crm_relationship WHERE id = ${original.id}
    `).resolves.toEqual([{ id: original.id, relationship_state: "ACTIVE" }]);
  });

  it("fails closed when a canonical Salesforce parent resolves ambiguously", async () => {
    await owner.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, lead_advisor_email, synced_at)
      VALUES (${HOUSEHOLD_KEY_AMBIGUOUS}, 'Ambiguous Phase Four C Household',
              'phase-four-c@example.test', now())`;
    await owner.$executeRaw`
      INSERT INTO app.crm_identity (id, identity_type, lifecycle_state, updated_at)
      VALUES (${EXTRA_HOUSEHOLD_ID}, 'HOUSEHOLD', 'ACTIVE', now())`;
    await owner.$executeRaw`
      INSERT INTO app.crm_source_mapping
        (id, identity_id, source_system, source_namespace, source_key, updated_at)
      VALUES
        (${EXTRA_HOUSEHOLD_MAP}, ${EXTRA_HOUSEHOLD_ID},
         'CRM', 'household', ${HOUSEHOLD_KEY_AMBIGUOUS}, now())`;

    const counts = byDerivation(await runSnapshot(
      reconciler,
      `${RUN_PREFIX}000000000008`,
      true,
    ));
    for (const row of counts.values()) {
      expect(row).toMatchObject({
        candidates: 1n,
        created: 0n,
        ambiguous_endpoint: 1n,
      });
    }
    await expect(owner.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM app.crm_relationship
       WHERE evidence_mapping_id IN (${CONTACT_MAP}, ${DEAL_MAP}, ${TRANSFER_MAP})
    `).resolves.toEqual([{ n: 0n }]);
  });

  it("resolves same-type merged evidence and parent endpoints to active survivors", async () => {
    await owner.$executeRaw`
      INSERT INTO app.crm_identity (id, identity_type, lifecycle_state, updated_at)
      VALUES
        (${HOUSEHOLD_SURVIVOR_ID}, 'HOUSEHOLD', 'ACTIVE', now()),
        (${CONTACT_SURVIVOR_ID}, 'CONTACT', 'ACTIVE', now())`;
    await owner.$executeRaw`
      UPDATE app.crm_identity
         SET lifecycle_state = 'MERGED', merged_into_id = ${HOUSEHOLD_SURVIVOR_ID},
             updated_at = now()
       WHERE id = ${HOUSEHOLD_ID}`;
    await owner.$executeRaw`
      UPDATE app.crm_identity
         SET lifecycle_state = 'MERGED', merged_into_id = ${CONTACT_SURVIVOR_ID},
             updated_at = now()
       WHERE id = ${CONTACT_ID}`;

    await runSnapshot(reconciler, `${RUN_PREFIX}000000000009`, false);
    await expect(owner.$queryRaw<Array<{
      from_identity_id: string;
      to_identity_id: string;
      evidence_mapping_id: string;
    }>>`
      SELECT from_identity_id, to_identity_id, evidence_mapping_id
        FROM app.crm_relationship
       WHERE relationship_type = 'HOUSEHOLD_HAS_MEMBER'
         AND evidence_mapping_id = ${CONTACT_MAP}
    `).resolves.toEqual([{
      from_identity_id: HOUSEHOLD_SURVIVOR_ID,
      to_identity_id: CONTACT_SURVIVOR_ID,
      evidence_mapping_id: CONTACT_MAP,
    }]);
  });

  it("allows only constrained snapshot execution to the reconciler", async () => {
    await expect(
      reconciler.$queryRaw`SELECT id FROM app.crm_relationship LIMIT 1`,
    ).rejects.toThrow();
    await expect(
      reconciler.$queryRaw`SELECT app.crm_active_identity_survivor(${HOUSEHOLD_ID}, 'HOUSEHOLD')`,
    ).rejects.toThrow();
    await expect(
      withUserScope({ role: "OPERATIONS", email: "phase-four-c@example.test" },
        (tx) => tx.$queryRaw`
          SELECT * FROM app.preview_crm_relationship_snapshot(
            '40000000-0000-4000-8000-000000000010', true, true, true
          )`),
    ).rejects.toThrow();
    await expect(runSnapshot(
      reconciler,
      `${RUN_PREFIX}000000000011`,
      true,
    )).resolves.toHaveLength(3);
  });

  it("serializes concurrent live runs without duplicate evidence coordinates", async () => {
    const [left, right] = await Promise.all([
      runSnapshot(reconciler, `${RUN_PREFIX}000000000012`, false),
      runSnapshot(secondReconciler, `${RUN_PREFIX}000000000013`, false),
    ]);
    const created = [...left, ...right].reduce(
      (sum, row) => sum + row.created,
      0n,
    );
    expect(created).toBe(3n);
    await expect(owner.$queryRaw<Array<{ n: bigint; coordinates: bigint }>>`
      SELECT count(*)::bigint AS n,
             count(DISTINCT (
               relationship_type, from_identity_id, to_identity_id,
               evidence_mapping_id
             ))::bigint AS coordinates
        FROM app.crm_relationship
       WHERE evidence_mapping_id IN (${CONTACT_MAP}, ${DEAL_MAP}, ${TRANSFER_MAP})
    `).resolves.toEqual([{ n: 3n, coordinates: 3n }]);
  });

  it("cancels a blocked snapshot in PostgreSQL, rolls back all edges/audits, and recovers the reconciler", async () => {
    // beforeAll verifies the exact synthetic targets before opening clients.
    const db = crmReconcilerClient();
    const settings = () => db.$queryRaw<Array<{ statement: string; lock: string; role: string }>>`
      SELECT current_setting('statement_timeout') AS statement,
             current_setting('lock_timeout') AS lock,
             current_user AS role`;
    const beforeSettings = await settings();
    expect(beforeSettings[0].role).toBe("identity_reconciler");
    const before = await persistentCounts(owner);

    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const acquired = new Promise<void>((resolve) => { ready = resolve; });
    const hold = owner.$transaction(async (tx) => {
      // The snapshot writes business audit evidence AFTER its relationship
      // changes. Blocking that final insert proves earlier writes roll back.
      await tx.$executeRaw`SELECT set_config('lock_timeout', '2000', true)`;
      await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
      await tx.$executeRaw`LOCK TABLE audit."AuditLog" IN ACCESS EXCLUSIVE MODE`;
      ready();
      await held;
    }, { timeout: 15_000 });
    try {
      await Promise.race([acquired, hold]);
      const started = performance.now();
      await expect(runCrmRelationshipSnapshot(
        `${RUN_PREFIX}000000000014`, false, COMPLETE, 31_000,
      )).rejects.toMatchObject({ code: "P2010", meta: { code: "57014" } });
      // The SQL deadline is 1s; the distinct 5s lock and 31s Prisma deadlines
      // must not be what releases the waiting statement. Allow CI headroom.
      expect(performance.now() - started).toBeLessThan(4_500);
    } finally {
      release();
      await hold;
    }
    expect(await persistentCounts(owner)).toEqual(before);
    expect(await settings()).toEqual(beforeSettings);

    const recovered = await runCrmRelationshipSnapshot(
      `${RUN_PREFIX}000000000015`, false, COMPLETE,
    );
    expect(recovered.map((row) => row.derivation).sort()).toEqual([
      "AOA_DEAL_HOUSEHOLD", "AOA_TRANSFER_HOUSEHOLD", "CRM_CONTACT_HOUSEHOLD",
    ]);
    expect(recovered.every((row) => row.created === 1 && row.snapshotComplete)).toBe(true);
    await expect(db.$queryRaw`SELECT id FROM app.crm_relationship LIMIT 1`).rejects.toThrow();
    expect(await settings()).toEqual(beforeSettings);
  }, 20_000);
});
