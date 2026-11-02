import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
vi.mock("server-only", () => ({}));
import { applyCrmExplorerDatabaseBounds, readCrmWindowStats } from "@/lib/data/crm-explorer";
import { withUserScope } from "@/lib/rls";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const email = "summary-counts@example.invalid";
gated("CRM summary policy-equivalent single mapping scan", () => {
  let owner: PrismaClient;
  async function cleanup() {
    await owner.$executeRaw`DELETE FROM app.crm_source_mapping WHERE id LIKE 'smcounts-%'`;
    await owner.$executeRaw`UPDATE app.crm_identity SET lifecycle_state='ACTIVE',merged_into_id=NULL WHERE id LIKE 'hld_smcounts%'`;
    await owner.$executeRaw`DELETE FROM app.crm_identity WHERE id LIKE 'hld_smcounts%'`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE '001SMC%'`;
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE row_pk LIKE 'hld_smcounts%' OR row_pk LIKE 'smcounts-%'`;
  }
  beforeAll(async () => {
    const raw = process.env.AUDIT_TEST_CLEANUP_URL, scoped = process.env.DATABASE_URL;
    if (!raw || !scoped) throw new Error("explicit_synthetic_database_required");
    const expected = new URL(raw);
    for (const [value, username] of [[raw, "aoa"], [scoped, "app_rw"]]) {
      const url = new URL(value);
      if (!["postgres:", "postgresql:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        || !["5432", "55444"].includes(url.port) || url.host !== expected.host || url.pathname !== expected.pathname || url.username !== username
        || !(url.pathname.endsWith("_synthetic") || (process.env.CI === "true" && url.pathname === "/aoa"))
        || [...url.searchParams.keys()].some(key => !["schema", "connection_limit", "pool_timeout"].includes(key))
        || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE || ["prod", "production", "dev"].includes(process.env.APP_ENV ?? "")) {
        throw new Error("isolated_synthetic_database_required");
      }
    }
    owner = new PrismaClient({ datasourceUrl: raw });
    await cleanup();
    await owner.$executeRaw`INSERT INTO mirror.household(sf_id,name,lead_advisor_email)
      VALUES ('001SMC000000001AAA','Invented owned summary household',${email}),
             ('001SMC000000002AAA','Invented different book','another@example.invalid')`;
    await owner.$executeRaw`INSERT INTO app.crm_identity(id,identity_type,lifecycle_state,updated_at)
      VALUES ('hld_smcounts1','HOUSEHOLD','ACTIVE',now()), ('hld_smcounts2','HOUSEHOLD','ARCHIVED',now()),
             ('hld_smcounts3','HOUSEHOLD','ACTIVE',now()), ('hld_smcounts4','HOUSEHOLD','ACTIVE',now()),
             ('hld_smcounts5','HOUSEHOLD','ACTIVE',now())`;
    await owner.$executeRaw`UPDATE app.crm_identity SET lifecycle_state='MERGED',merged_into_id='hld_smcounts1' WHERE id='hld_smcounts3'`;
    await owner.$executeRaw`INSERT INTO app.crm_source_mapping
      (id,identity_id,source_system,source_namespace,source_key,mapping_state,first_seen_at,last_seen_at,superseded_at,updated_at)
      VALUES ('smcounts-1','hld_smcounts1','CRM','household','001SMC000000001AAA','ACTIVE','2026-01-01','2026-01-01',NULL,now()),
        ('smcounts-alias','hld_smcounts1','CRM','household','001SMC000000001','ACTIVE','2026-01-01','2026-01-02',NULL,now()),
        ('smcounts-2','hld_smcounts2','CRM','household','001SMC000000002AAA','ACTIVE','2026-01-01','2026-01-03',NULL,now()),
        ('smcounts-3','hld_smcounts3','CRM','household','001SMC000000002','SUPERSEDED','2026-01-01','2026-01-04','2026-01-04',now()),
        ('smcounts-missing','hld_smcounts4','CRM','household','001SMC000000003AAA','ACTIVE','2026-01-01','2099-01-01',NULL,now())`;
  });
  afterAll(async () => { if (owner) { await cleanup(); await owner.$disconnect(); } });

  it("locks in the identity EXISTS-visible-mapping policy and validated non-null FK invariant", async () => {
    const policies = await owner.$queryRaw<Array<{ policyname: string; qual: string }>>`
      SELECT policyname,qual FROM pg_policies WHERE schemaname='app' AND tablename='crm_identity'
        AND cmd IN ('SELECT','ALL') AND EXISTS(SELECT 1 FROM unnest(roles) role_name
          WHERE CASE WHEN role_name='public' THEN true ELSE pg_has_role('app_rw',role_name,'MEMBER') END)
        ORDER BY policyname`;
    expect(policies).toHaveLength(1);
    expect(policies[0].policyname).toBe("crm_identity_app_read");
    expect(policies[0].qual.replace(/\s+/g," ").trim()).toBe("(EXISTS ( SELECT 1 FROM app.crm_source_mapping m WHERE (m.identity_id = crm_identity.id)))");
    const [constraint] = await owner.$queryRaw<Array<{ validated: boolean; not_null: boolean; target: string }>>`
      SELECT c.convalidated AS validated,a.attnotnull AS not_null,c.confrelid::regclass::text AS target
      FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
      WHERE c.conrelid='app.crm_source_mapping'::regclass AND c.conname='crm_source_mapping_identity_id_fkey'`;
    expect(constraint).toEqual({validated:true,not_null:true,target:"app.crm_identity"});
  });

  it.each(["ADMIN","OPERATIONS","ADVISOR","CLIENT_SERVICE","VIEWER","UNKNOWN","HEAD_OF_ADVISORY"])("matches direct scoped counts for %s, including lifecycle, aliases and invisible/orphan sources", async role => {
    await withUserScope({role,email},async tx => {
      await applyCrmExplorerDatabaseBounds(tx);
      const [baseline] = await tx.$queryRaw<Array<{ identities: bigint; aliases: bigint; exceptions: bigint; duplicates: bigint; latest: Date | null }>>`
        SELECT (SELECT count(*) FROM app.crm_identity) AS identities,
          (SELECT count(*) FROM app.crm_source_mapping) AS aliases,
          (SELECT count(*) FROM app.crm_identity_exception WHERE exception_state='OPEN') AS exceptions,
          (SELECT count(*) FROM app.crm_duplicate_candidate WHERE source_active
            AND (status='NEW' OR(status='SNOOZED' AND snoozed_until<=now()))) AS duplicates,
          (SELECT max(last_seen_at) FROM app.crm_source_mapping) AS latest`;
      expect(await readCrmWindowStats(tx)).toEqual({identities:Number(baseline.identities),sourceAliases:Number(baseline.aliases),
        openExceptions:Number(baseline.exceptions),potentialDuplicates:Number(baseline.duplicates),latestSeenAt:baseline.latest?.toISOString() ?? null});
      if (role === "ADMIN" || role === "OPERATIONS") {
        const fixture = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM app.crm_identity WHERE id LIKE 'hld_smcounts%' ORDER BY id`;
        expect(fixture.map(row=>row.id)).toEqual(["hld_smcounts1","hld_smcounts2","hld_smcounts3"]);
      }
    },{timeout:15_000,maxWait:5_000,isolationLevel:"RepeatableRead"});
  });
});
