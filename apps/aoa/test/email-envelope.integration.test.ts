import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import * as auditWriter from "@/lib/audit";
vi.mock("server-only", () => ({}));
import { POST as ingest } from "@/app/api/ingest/emails/route";
import { POST as reconcile } from "@/app/api/ingest/email-envelopes/route";
import { searchHouseholdEmails } from "@/lib/data/household-email-search";
import type { EmailEnvelope } from "@/lib/email-search/envelope";
const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const HH = "001MAE265423797", OTHER = "001GVG043259402", ID = "00TENV000000700";
const TOKEN = "synthetic-envelope-token";
const OPS = { role: "OPERATIONS", email: "ops-env@example.invalid" };
const ADVISOR = { role: "ADVISOR", email: "advisor-env@example.invalid" };
const observation = (over: Partial<EmailEnvelope> = {}): EmailEnvelope => ({ version: 1, state: "MATCHED", task_sf_id: ID,
  message_sf_id: "02sENV000000001", observed_at: "2026-10-16T00:00:00.000Z", source_modified_at: "2026-10-15T00:00:00.000Z",
  sender: { name: "Invented Sender", address: "sender-env@example.invalid" },
  to: [{ name: "Invented Recipient", address: "recipient-env@example.invalid" }, { name: null, address: "second-env@example.invalid" }],
  cc: [{ name: "Invented Copy", address: "copy-env@example.invalid" }], ...over });
const item = (email_envelope = observation(), extra: Record<string, unknown> = {}) => ({ sf_id: ID, household_sf_id: HH, email_envelope, ...extra });
const request = (body: unknown) => new Request("https://example.invalid/api/ingest/email-envelopes", {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body),
});
const run = async (items: unknown[], mode?: string) => {
  const response = await reconcile(request({ source: "crm", run_id: "env-syn-run-1", items, ...(mode ? { mode } : {}) }));
  expect(response.status).toBe(200); return response.json();
};

gated("ticket email metadata against real synthetic PostgreSQL/RLS", () => {
  let owner: PrismaClient;
  const row = async () => (await owner.$queryRaw<Array<Record<string, unknown>>>`SELECT *, xmin::text AS version FROM mirror.email WHERE sf_id = ${ID}`)[0];
  const seed = async (id = ID, household = HH) => owner.$executeRaw`INSERT INTO mirror.email (sf_id, household_sf_id, subject, body, sent_at, source_modified_at)
    VALUES (${id}, ${household}, 'Synthetic original subject', 'Synthetic original body', '2026-10-01', '2026-10-02')`;
  async function cleanup() {
    await owner.$executeRaw`DELETE FROM mirror.email WHERE sf_id LIKE '00TENV%'`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id IN (${HH}, ${OTHER})`;
    await owner.$executeRaw`DELETE FROM audit."AuditLog" WHERE "entityId" LIKE 'env-syn-run-%'`;
  }
  beforeAll(async () => {
    const raw = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!raw || !process.env.DATABASE_URL || !process.env.INGEST_DATABASE_URL) throw new Error("explicit_synthetic_database_required");
    const expected = new URL(raw);
    for (const [value, user] of [[raw, "aoa"], [process.env.DATABASE_URL, "app_rw"], [process.env.INGEST_DATABASE_URL, "ingest_rw"]]) {
      const url = new URL(value);
      if (!["postgresql:", "postgres:"].includes(url.protocol) || !['localhost','127.0.0.1'].includes(url.hostname) ||
        !url.port || url.host !== expected.host || url.pathname !== expected.pathname || url.username !== user ||
        !['/aoa_pagination_synthetic','/aoa_rollout_synthetic', ...(process.env.CI === 'true' ? ['/aoa'] : [])].includes(url.pathname) ||
        ['host','hostaddr','service','servicefile'].some(key => url.searchParams.has(key)) ||
        process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE || ['dev','prod'].includes(process.env.APP_ENV ?? '')) throw new Error("isolated_synthetic_database_required");
    }
    owner = new PrismaClient({ datasourceUrl: raw });
  });
  beforeEach(async () => {
    vi.stubEnv("INGEST_TOKEN", TOKEN); await cleanup();
    await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, lead_advisor_email)
      VALUES (${HH}, 'Synthetic envelope household', ${ADVISOR.email}), (${OTHER}, 'Synthetic other book', 'other-env@example.invalid')`;
  });
  afterAll(async () => { await cleanup(); await owner.$disconnect(); vi.unstubAllEnvs(); });

  it("keeps FORCE RLS and rejects Bcc keys at the database boundary", async () => {
    const [flags] = await owner.$queryRaw<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'mirror.email'::regclass`;
    expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    await seed();
    await expect(owner.$executeRaw`UPDATE mirror.email SET email_envelope = ${JSON.stringify({ ...observation(), bcc: [] })}::jsonb WHERE sf_id = ${ID}`).rejects.toThrow();
    expect((await row()).email_envelope).toBeNull();
  });
  it("ingests verified metadata, strips logged Bcc and finds sender/To/Cc names or addresses once per message", async () => {
    const response = await ingest(request({ source: "crm", run_id: "env-syn-run-2", items: [item(observation(), {
      subject: "Synthetic envelope", body: "BCC: hidden-env@example.invalid\n folded-env@example.invalid\nVisible synthetic body" })] }));
    expect(response.status).toBe(200);
    expect((await row()).body).toBe("Visible synthetic body");
    for (const term of ["INVENTED SENDER", "sender-env@", "Invented Recipient", "second-env@", "Invented Copy", "copy-env@"]) {
      const result = await searchHouseholdEmails(ADVISOR, HH, term);
      expect(result?.total).toBe(1); expect(result?.rows.map(row => row.sf_id)).toEqual([ID]);
      expect(result?.metadataCoverage).toMatchObject({ matched: 1, enriched: 1, unknown: 0 });
    }
    expect((await searchHouseholdEmails(ADVISOR, HH, "hidden-env"))?.total).toBe(0);
    expect((await searchHouseholdEmails(ADVISOR, HH, "example.invalid"))?.total).toBe(1);
  });
  it("preserves metadata on legacy payloads and refuses stale observations or regressed source versions", async () => {
    await seed(); await run([item()], "apply");
    const original = (await row()).email_envelope;
    await ingest(request({ source: "crm", run_id: "env-syn-run-3", items: [{ sf_id: ID, household_sf_id: HH, subject: "Legacy" }] }));
    expect((await row()).email_envelope).toEqual(original);
    const stale = observation({ observed_at: "2026-10-14T00:00:00.000Z", sender: { name: "Stale", address: null } });
    expect(await run([item(stale)], "apply")).toMatchObject({ stale: 1, updated: 0 });
    const regressed = observation({ observed_at: "2026-10-17T00:00:00.000Z", source_modified_at: "2026-10-13T00:00:00.000Z", sender: { name: "Regressed", address: null } });
    expect(await run([item(regressed)], "apply")).toMatchObject({ stale: 1, updated: 0 });
    expect((await row()).email_envelope).toEqual(original);
  });
  it("previews without touching the message, applies once, then preserves xmin on replay", async () => {
    await seed(); const before = await row();
    expect(await run([item()])).toMatchObject({ dry_run: true, wouldUpdate: 1, updated: 0 });
    expect(await row()).toEqual(before);
    expect(await run([item()], "apply")).toMatchObject({ dry_run: false, updated: 1 });
    const after = await row();
    expect(await run([item(observation({ observed_at: "2026-10-17T00:00:00.000Z" }))], "apply")).toMatchObject({ unchanged: 1, updated: 0 });
    expect(await row()).toEqual(after);
    for (const key of ['sf_id','household_sf_id','subject','body','sent_at','source_modified_at','synced_at']) expect(after[key]).toEqual(before[key]);
  });
  it("never creates missing emails, moves households or guesses between conflicting source or stored rows", async () => {
    expect(await run([item()], "apply")).toMatchObject({ missingStored: 1, updated: 0 });
    await seed();
    expect(await run([item(observation(), { household_sf_id: OTHER })], "apply")).toMatchObject({ householdMismatch: 1, updated: 0 });
    expect(await run([item(), item(observation({ sender: { name: "Conflict", address: null } }))], "apply")).toMatchObject({ received: 2, distinct: 1, duplicateRows: 1, conflictingRecords: 1, updated: 0 });
    await seed(ID + "AAA");
    expect(await run([item()], "apply")).toMatchObject({ ambiguousStored: 1, updated: 0 });
    expect((await row()).email_envelope).toBeNull();
  });
  it("reconciles duplicate input and full stored unknown coverage without returning identifiers or email content", async () => {
    await seed(); await seed("00TENV000000701");
    const result = await run([item(), item()], "apply");
    expect(result).toMatchObject({ received: 2, distinct: 1, duplicateRows: 1, updated: 1, coverage: { total: 2, matched: 1, unknown: 1 } });
    expect(result.received).toBe(result.distinct + result.duplicateRows);
    expect(result.distinct).toBe(result.conflictingRecords + result.ambiguousStored + result.missingStored + result.householdMismatch + result.stale + result.unchanged + result.wouldUpdate);
    for (const secret of [ID, HH, "sender-env", "Synthetic original"]) expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("counts recognizable legacy Bcc headers without returning or changing message text", async () => {
    const bodies = ["BCC: hidden-one@example.invalid\nVisible", "Visible\nbCc: hidden-two@example.invalid\n folded@example.invalid", "Visible\rBCC: hidden-three@example.invalid", "Visible\r\n\tBcc : hidden-four@example.invalid", "Visible text mentions bcc: as prose", null];
    for (let i = 0; i < bodies.length; i++) {
      const sfId = `00TENV${String(i + 100).padStart(9, '0')}`;
      await seed(sfId);
      await owner.$executeRaw`UPDATE mirror.email SET body = ${bodies[i]} WHERE sf_id = ${sfId}`;
    }
    const before = await owner.$queryRaw`SELECT sf_id, body, xmin::text FROM mirror.email WHERE household_sf_id = ${HH} ORDER BY sf_id`;
    const result = await run([], "preview");
    expect(result).toMatchObject({ dry_run: true, received: 0, updated: 0, coverage: { total: 6, unknown: 6, loggedBccHeaderRows: 4 } });
    expect(await owner.$queryRaw`SELECT sf_id, body, xmin::text FROM mirror.email WHERE household_sf_id = ${HH} ORDER BY sf_id`).toEqual(before);
    for (const secret of [HH, "hidden-", "folded@", "Visible text"]) expect(JSON.stringify(result)).not.toContain(secret);
  });
  const cleanBody = (mode?: string, expected_remaining?: number) => reconcile(request({ source: "crm", run_id: "env-syn-run-cleanup",
    operation: "strip_logged_bcc", items: [], ...(mode ? { mode } : {}), ...(expected_remaining === undefined ? {} : { expected_remaining }) }));
  it("previews logged-header cleanup, changes only eligible bodies and records counts without content", async () => {
    const bodies = ["Bcc: hidden-clean@example.invalid\r\n\tfolded-clean@example.invalid\r\nVisible clean body", "Visible\rBCC : hidden-cr@example.invalid", "Bcc: only-clean@example.invalid\r\n", "Visible prose bcc: stays", null];
    for (let i = 0; i < bodies.length; i++) {
      const id = i ? `00TENV${String(200 + i).padStart(9, '0')}` : ID;
      await seed(id); await owner.$executeRaw`UPDATE mirror.email SET body = ${bodies[i]} WHERE sf_id = ${id}`;
    }
    await run([item()], "apply");
    const rows = () => owner.$queryRaw<Array<Record<string, unknown>>>`SELECT *, xmin::text AS version FROM mirror.email WHERE household_sf_id = ${HH} ORDER BY sf_id`;
    const before = await rows();
    const preview = await cleanBody(); expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ operation: "strip_logged_bcc", dry_run: true, eligible: 3, wouldUpdate: 3, updated: 0, remaining: 3 });
    expect(await rows()).toEqual(before);
    const response = await cleanBody("apply", 3); expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ dry_run: false, eligible: 3, wouldUpdate: 3, updated: 3, remaining: 0, coverage: { total: 5, matched: 1, unknown: 4, loggedBccHeaderRows: 0 } });
    const after = await rows();
    expect(after.find(row => row.sf_id === ID)?.body).toBe("Visible clean body");
    expect(after.find(row => row.sf_id === "00TENV000000201")?.body).toBe("Visible");
    expect(after.find(row => row.sf_id === "00TENV000000202")?.body).toBeNull();
    for (const next of after) {
      const prior = before.find(row => row.sf_id === next.sf_id)!;
      for (const key of Object.keys(next).filter(key => !['body','version'].includes(key))) expect(next[key]).toEqual(prior[key]);
      if (next.sf_id === "00TENV000000203" || next.sf_id === "00TENV000000204") expect(next).toEqual(prior);
    }
    expect((await cleanBody("apply", 0)).status).toBe(200); expect(await rows()).toEqual(after);
    const audit = await owner.$queryRaw<Array<{ action: string; detail: unknown }>>`SELECT action, detail FROM audit."AuditLog" WHERE "entityId" = 'env-syn-run-cleanup'`;
    expect(audit.length).toBe(3); expect(audit.every(row => row.action === 'ingest.email_body_cleanup')).toBe(true);
    for (const sensitive of [ID, HH, 'hidden-', 'folded-', 'Visible', 'example.invalid']) {
      expect(JSON.stringify(result)).not.toContain(sensitive); expect(JSON.stringify(audit)).not.toContain(sensitive);
    }
  });
  it("rolls a body cleanup back when its aggregate audit cannot commit", async () => {
    await seed(); await owner.$executeRaw`UPDATE mirror.email SET body = 'Bcc: rollback-clean@example.invalid' WHERE sf_id = ${ID}`;
    const before = await row();
    const failure = vi.spyOn(auditWriter, 'writeAudit').mockRejectedValueOnce(new Error('synthetic audit failure'));
    try {
      const response = await cleanBody('apply', 1);
      expect(response.status).toBe(500); expect(await response.json()).toEqual({error:'internal'});
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await row()).toEqual(before);
      expect(await owner.$queryRaw`SELECT count(*)::int AS count FROM audit."AuditLog" WHERE "entityId" = 'env-syn-run-cleanup'`).toEqual([{count:0}]);
    } finally { failure.mockRestore(); }
  });
  it("caps cleanup at 500, rejects stale counts and finishes in an idempotent second batch", async () => {
    await owner.$executeRaw`INSERT INTO mirror.email (sf_id, household_sf_id, body)
      SELECT '00TENV' || lpad(n::text, 9, '0'), ${HH}, 'Bcc: batch-synthetic@example.invalid' FROM generate_series(1000, 1502) n`;
    expect(await (await cleanBody()).json()).toMatchObject({ eligible: 503, wouldUpdate: 500, updated: 0, remaining: 503 });
    expect(await (await cleanBody("apply", 503)).json()).toMatchObject({ eligible: 503, wouldUpdate: 500, updated: 500, remaining: 3 });
    expect((await cleanBody("apply", 503)).status).toBe(409);
    expect(await (await cleanBody("apply", 3)).json()).toMatchObject({ eligible: 3, updated: 3, remaining: 0 });
    expect(await (await cleanBody("apply", 0)).json()).toMatchObject({ updated: 0, remaining: 0 });
    expect(await owner.$queryRaw`SELECT count(*)::int AS count FROM mirror.email WHERE household_sf_id = ${HH} AND body IS NULL`).toEqual([{count:503}]);
  });
  it("rejects mixed/invalid cleanup requests and permits only one concurrent matching apply", async () => {
    const base = { source: 'crm', run_id: 'env-syn-run-invalid', operation: 'strip_logged_bcc', items: [] };
    for (const change of [{ operation:'unknown' }, { items:[item()] }, { mode:'apply' }, { mode:'apply', expected_remaining:-1 },
      { mode:'apply', expected_remaining:1.5 }, { mode:'apply', expected_remaining:'1' }, { expected_remaining:0 }, { extra:true }]) {
      expect((await reconcile(request({ ...base,...change }))).status).toBe(400);
    }
    expect((await reconcile(request({ source:'crm', run_id:'env-syn-run-invalid', items:[], expected_remaining:0 }))).status).toBe(400);
    expect((await reconcile(new Request('https://example.invalid', { method:'POST', body:JSON.stringify({...base,mode:'apply',expected_remaining:1}) }))).status).toBe(401);
    await seed(); await owner.$executeRaw`UPDATE mirror.email SET body = 'BCC: concurrent-clean@example.invalid' WHERE sf_id = ${ID}`;
    const replies = await Promise.all([cleanBody('apply',1), cleanBody('apply',1)]);
    expect(replies.map(r=>r.status).sort()).toEqual([200,409]);
    expect((await row()).body).toBeNull();
    expect((await run([], 'preview')).coverage).toMatchObject({ total:1, unknown:1, loggedBccHeaderRows:0 });
  });
  it("records missing/unavailable/ambiguous coverage explicitly and stops matching removed metadata", async () => {
    await seed(); await run([item()], "apply");
    const missing = observation({ state: "MISSING", message_sf_id: null, source_modified_at: null, observed_at: "2026-10-17T00:00:00.000Z", sender: null, to: [], cc: [] });
    expect(await run([item(missing)], "apply")).toMatchObject({ updated: 1, coverage: { missing: 1, matched: 0 } });
    expect((await searchHouseholdEmails(ADVISOR, HH, "sender-env"))?.total).toBe(0);
    expect((await searchHouseholdEmails(ADVISOR, HH, "Synthetic"))?.metadataCoverage).toMatchObject({ missing: 1, matched: 0 });
  });
  it("keeps metadata within household RLS and rejects forbidden or mismatched observations", async () => {
    await seed(); await run([item()], "apply");
    expect(await searchHouseholdEmails({ role: "VIEWER", email: ADVISOR.email }, HH, "sender-env")).toBeNull();
    expect(await searchHouseholdEmails({ role: "ADVISOR", email: "outsider@example.invalid" }, HH, "sender-env")).toBeNull();
    expect((await searchHouseholdEmails(OPS, HH, "sender-env"))?.total).toBe(1);
    const invalid = { ...observation(), bcc: [] };
    expect((await reconcile(request({ source: "crm", run_id: "env-syn-run-4", items: [item(invalid as never)], mode: "apply" }))).status).toBe(400);
    expect((await reconcile(request({ source: "crm", run_id: "env-syn-run-5", items: [item(observation({ task_sf_id: "00TENV000000701" }))], mode: "apply" }))).status).toBe(400);
    expect((await reconcile(new Request("https://example.invalid", { method: "POST", body: '{}' }))).status).toBe(401);
  });
  it("keeps one winner for concurrent replay and equal-time conflicting observations", async () => {
    await seed();
    const results = await Promise.all([run([item()], "apply"), run([item()], "apply")]);
    expect(results.reduce((sum, result) => sum + result.updated, 0)).toBe(1);
    const conflict = observation({ sender: { name: "Conflicting same-time source", address: null } });
    expect(await run([item(conflict)], "apply")).toMatchObject({ stale: 1, updated: 0 });
    expect((await row()).email_envelope).toEqual(observation());
  });
  it("paginates metadata-only matches once per message across all stored rows", async () => {
    const observations = [];
    for (let i = 1; i <= 60; i += 1) {
      const id = '00TENV' + String(i).padStart(9, '0');
      await seed(id);
      observations.push({ sf_id: id, household_sf_id: HH, email_envelope: observation({ task_sf_id: id,
        message_sf_id: '02sENV' + String(i).padStart(9, '0') }) });
    }
    expect(await run(observations, "apply")).toMatchObject({ updated: 60 });
    const first = await searchHouseholdEmails(ADVISOR, HH, "example.invalid");
    expect(first).toMatchObject({ total: 60, pageCount: 2, metadataCoverage: { matched: 60, enriched: 60 } });
    const second = await searchHouseholdEmails(ADVISOR, HH, "example.invalid", { page: 2 });
    expect(second?.snapshot).toBe(first?.snapshot);
    const ids = [...(first?.rows ?? []), ...(second?.rows ?? [])].map(row => row.sf_id);
    expect(ids).toHaveLength(60); expect(new Set(ids).size).toBe(60);
  });
  it("binds coverage changes outside the matching set to the search snapshot", async () => {
    await seed(); await seed("00TENV000000701"); await run([item()], "apply");
    const first = await searchHouseholdEmails(ADVISOR, HH, "sender-env");
    const missing = observation({ task_sf_id: "00TENV000000701", state: "MISSING", message_sf_id: null, source_modified_at: null, sender: null, to: [], cc: [] });
    await run([{ sf_id: "00TENV000000701", household_sf_id: HH, email_envelope: missing }], "apply");
    const next = await searchHouseholdEmails(ADVISOR, HH, "sender-env");
    expect(next?.total).toBe(first?.total); expect(next?.snapshot).not.toBe(first?.snapshot);
    expect(next?.metadataCoverage).toMatchObject({ unknown: 0, missing: 1, matched: 1 });
  });

});
