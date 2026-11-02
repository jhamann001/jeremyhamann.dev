import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { navCounts } from "@/lib/data/nav-counts";
import { previousNavCounts } from "@/test/fixtures/nav-counts-before-batch";

vi.mock("server-only", () => ({}));
const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const email = "nav-batch-advisor@example.test";
const households = ["001NCB000000001AAA", "001NCB000000002AAA", "001NCB000000003AAA"];
const contacts = ["003NCB000000001AAA", "003NCB000000002AAA", "003NCB000000003AAA"];
const cases = ["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE", "VIEWER", "HEAD_OF_ADVISORY", "UNKNOWN", undefined]
  .flatMap(role => [false, true].flatMap(canonical => [false, true].map(hideDemo => ({ role, canonical, hideDemo }))));

gated("single-statement navigation counts retain the previous five-query semantics", () => {
  let owner: PrismaClient;
  let beforeRaw: Awaited<ReturnType<typeof navCounts>>;
  let beforeCanonical: Awaited<ReturnType<typeof navCounts>>;
  let beforeHidden: Awaited<ReturnType<typeof navCounts>>;
  const timings = { previous: [] as number[], batched: [] as number[] };

  async function cleanup() {
    await owner.$executeRaw`DELETE FROM app.crm_duplicate_candidate_event WHERE candidate_id LIKE 'NAV-BATCH-%'`;
    await owner.$executeRaw`DELETE FROM app.crm_duplicate_candidate WHERE id LIKE 'NAV-BATCH-%'`;
    await owner.$executeRaw`DELETE FROM app.crm_source_mapping WHERE id LIKE 'NAV-BATCH-%'`;
    await owner.$executeRaw`DELETE FROM app.crm_identity WHERE id IN ('hld_navbatch1','hld_navbatch2','con_navbatch1','con_navbatch2')`;
    await owner.$executeRaw`DELETE FROM app.transfer WHERE id LIKE 'NAV-BATCH-%' OR id='DEMO-T-NAV-BATCH'`;
    await owner.$executeRaw`DELETE FROM app.deal WHERE id LIKE 'NAV-BATCH-%'`;
    await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id LIKE '003NCB%'`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE '001NCB%'`;
    await owner.$executeRaw`DELETE FROM audit.row_change
      WHERE row_pk LIKE 'NAV-BATCH-%' OR row_pk LIKE '001NCB%' OR row_pk LIKE '003NCB%' OR row_pk='DEMO-T-NAV-BATCH'
        OR row_pk IN ('hld_navbatch1','hld_navbatch2','con_navbatch1','con_navbatch2')`;
  }

  beforeAll(async () => {
    const readerUrl = process.env.DATABASE_URL, ownerUrl = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!readerUrl || !ownerUrl) throw new Error("explicit_nav_batch_synthetic_urls_required");
    const target = new URL(ownerUrl);
    for (const [value, user] of [[readerUrl, "app_rw"], [ownerUrl, "aoa"]]) {
      const parsed = new URL(value);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
        || !(parsed.pathname.endsWith("_synthetic") || (process.env.CI === "true" && parsed.pathname === "/aoa"))
        || parsed.username !== user || parsed.host !== target.host || parsed.pathname !== target.pathname) {
        throw new Error("loopback_nav_batch_synthetic_database_required");
      }
    }
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    await cleanup();
    // The full suite may retain other legitimate synthetic demo/canonical
    // records. Assert only this fixture's delta, never a global empty-DB total.
    vi.stubEnv("CRM_IDENTITY_READS", "0");
    vi.stubEnv("HIDE_DEMO_TRANSFER_CARDS", "0");
    beforeRaw = await navCounts({ role: "OPERATIONS", email });
    vi.stubEnv("CRM_IDENTITY_READS", "1");
    beforeCanonical = await navCounts({ role: "OPERATIONS", email });
    vi.stubEnv("HIDE_DEMO_TRANSFER_CARDS", "1");
    beforeHidden = await navCounts({ role: "OPERATIONS", email });
    await owner.$executeRaw`INSERT INTO mirror.household (sf_id,name,stage,lead_advisor_email)
      VALUES (${households[0]},'Invented Nav Batch One',' Client ',${email}),
        (${households[1]},'Invented Nav Batch Two','client',${email}),
        (${households[2]},'Invented Nav Batch Other','Client','other-nav-batch@example.test')`;
    await owner.$executeRaw`INSERT INTO mirror.client (sf_id,household_id,first_name,stage,lead_advisor_email)
      VALUES (${contacts[0]},${households[0]},'Invented One','Client',${email}),
        (${contacts[1]},${households[0]},'Invented Two','Client',${email}),
        (${contacts[2]},${households[2]},'Invented Other','Client','other-nav-batch@example.test')`;
    await owner.$executeRaw`INSERT INTO app.crm_identity (id,identity_type,updated_at)
      VALUES ('hld_navbatch1','HOUSEHOLD',now()),('hld_navbatch2','HOUSEHOLD',now()),
        ('con_navbatch1','CONTACT',now()),('con_navbatch2','CONTACT',now())`;
    await owner.$executeRaw`INSERT INTO app.crm_source_mapping
      (id,identity_id,source_system,source_namespace,source_key,updated_at)
      VALUES ('NAV-BATCH-MH1','hld_navbatch1','CRM','household',${households[0]},now()),
        ('NAV-BATCH-MH2','hld_navbatch2','CRM','household',${households[1]},now()),
        ('NAV-BATCH-MC1','con_navbatch1','CRM','contact',${contacts[0]},now()),
        ('NAV-BATCH-MC2','con_navbatch2','CRM','contact',${contacts[1]},now())`;
    await owner.$executeRaw`INSERT INTO app.crm_duplicate_candidate
      (id,detector_key,entity_type,left_identity_id,right_identity_id,evidence_codes,status,canonical_identity_id,updated_at)
      VALUES ('NAV-BATCH-HH',${"aabac001".padStart(64,"0")},'HOUSEHOLD','hld_navbatch1','hld_navbatch2',
        ARRAY['SHARED_CEDAR_RIDGE_USER_ID'],'READY_FOR_FOLLOW_UP','hld_navbatch1',now()),
        ('NAV-BATCH-CC',${"aabac002".padStart(64,"0")},'CONTACT','con_navbatch1','con_navbatch2',
        ARRAY['SHARED_CEDAR_RIDGE_USER_ID'],'READY_FOR_FOLLOW_UP','con_navbatch1',now())`;
    await owner.$executeRaw`INSERT INTO app.deal
      (id,source,name,client_first_name,client_last_name,amount,stage,created_date,updated_at,sf_deal_id)
      VALUES ('NAV-BATCH-D','APP','Invented Nav','Invented','Nav',0,'COMMITTED',now(),now(),'DEMO-NAV-BATCH')`;
    await owner.$executeRaw`INSERT INTO app.transfer
      (id,source,value,updated_at,client_first_name,client_last_name,stage,owner_kind,deal_id)
      VALUES ('NAV-BATCH-T','APP',0,now(),'Invented','Nav','DECISION','OPERATIONS',NULL),
        ('DEMO-T-NAV-BATCH','APP',0,now(),'Invented','Nav','IN_TRANSFER','OPERATIONS',NULL),
        ('NAV-BATCH-TD','APP',0,now(),'Invented','Nav','DECISION','OPERATIONS','NAV-BATCH-D')`;
  });

  afterAll(async () => {
    if (owner) { await cleanup(); await owner.$disconnect(); }
    vi.unstubAllEnvs();
    if (process.env.NAV_COUNT_TIMING === "1" && timings.previous.length) {
      const median = (samples: number[]) => samples.toSorted((a,b) => a-b)[Math.floor(samples.length/2)];
      console.info(JSON.stringify({ fixture: "small_local_synthetic_nav_batch", samples: timings.previous.length,
        previousMedianMs: median(timings.previous), batchedMedianMs: median(timings.batched) }));
    }
  });

  it.each(cases)("matches prior seam for role=$role canonical=$canonical hideDemo=$hideDemo", async ({ role, canonical, hideDemo }) => {
    vi.stubEnv("CRM_IDENTITY_READS", canonical ? "1" : "0");
    vi.stubEnv("HIDE_DEMO_TRANSFER_CARDS", hideDemo ? "1" : "0");
    const identity = { role, email };
    const started = performance.now();
    const prior = await previousNavCounts(identity);
    const between = performance.now();
    const batched = await navCounts(identity);
    timings.previous.push(between-started);
    timings.batched.push(performance.now()-between);
    expect(batched).toEqual(prior);
  });

  it("suppresses both confirmed household and contact shells only with canonical reads enabled", async () => {
    vi.stubEnv("HIDE_DEMO_TRANSFER_CARDS", "0");
    vi.stubEnv("CRM_IDENTITY_READS", "0");
    const raw = await navCounts({ role: "OPERATIONS", email });
    vi.stubEnv("CRM_IDENTITY_READS", "1");
    const canonical = await navCounts({ role: "OPERATIONS", email });
    expect(raw.households - beforeRaw.households).toBe(3);
    expect(raw.clients - beforeRaw.clients).toBe(3);
    expect(canonical.households - beforeCanonical.households).toBe(2);
    expect(canonical.clients - beforeCanonical.clients).toBe(2);
  });

  it("retains the two demo-transfer exclusions and book-scoped directory counts", async () => {
    vi.stubEnv("CRM_IDENTITY_READS", "1");
    vi.stubEnv("HIDE_DEMO_TRANSFER_CARDS", "0");
    const visible = await navCounts({ role: "OPERATIONS", email });
    vi.stubEnv("HIDE_DEMO_TRANSFER_CARDS", "1");
    const hidden = await navCounts({ role: "OPERATIONS", email });
    expect(visible.activeTransfers - beforeCanonical.activeTransfers).toBe(3);
    expect(hidden.activeTransfers - beforeHidden.activeTransfers).toBe(1);
    const advisor = await navCounts({ role: "ADVISOR", email });
    const viewer = await navCounts({ role: "VIEWER", email });
    expect(advisor.households).toBeGreaterThan(0);
    expect(advisor.clients).toBeGreaterThan(0);
    expect(viewer.households).toBe(0);
    expect(viewer.clients).toBe(0);
  });
});
