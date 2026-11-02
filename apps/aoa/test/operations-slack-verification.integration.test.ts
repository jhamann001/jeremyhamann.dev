import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createOperationsSlackVerification } from "@/lib/data/operations-slack-verification";
import { captureOperationsSlackNotification } from "@/lib/data/operations-slack-capture";
import { claimOperationsSlackNotification, finishOperationsSlackNotification, runOperationsSlackDelivery } from "@/lib/data/operations-slack-delivery";
import { withUserScope } from "@/lib/rls";
import {
  assertOperationsSlackVerificationRecord,
  OPERATIONS_SLACK_VERIFICATION_REQUEST_ID as ID,
  OPERATIONS_SLACK_VERIFICATION_CLIENT_ID as CLIENT,
  OPERATIONS_SLACK_VERIFICATION_ACCOUNT_ID as ACCOUNT,
  OPERATIONS_SLACK_VERIFICATION_REASON as REASON,
} from "@/lib/operations/operations-slack-verification";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const EMAIL = "ops195-synthetic@example.test";
const actor = { role: "OPERATIONS", email: EMAIL };
const BLOCKER = "ops195-test-unrelated-synthetic";

gated("Operations Slack single-use canary: PostgreSQL forced RLS", () => {
  let owner: PrismaClient;
  let cleanupAllowed = false;

  async function cleanup() {
    await owner.$executeRaw`DROP TRIGGER IF EXISTS test_ops195_cancel_failure ON app.operations_fee_request_event`;
    await owner.$executeRaw`DROP FUNCTION IF EXISTS app.test_ops195_cancel_failure()`;
    await owner.operationsSlackNotification.deleteMany({ where: { request_id: { in: [ID, BLOCKER] } } });
    await owner.auditLog.deleteMany({ where: { entityType: "operations_fee_request", entityId: { in: [ID, BLOCKER] } } });
    await owner.operationsFeeRequestEvent.deleteMany({ where: { request_id: { in: [ID, BLOCKER] } } });
    await owner.operationsFeeRequest.deleteMany({ where: { id: { in: [ID, BLOCKER] } } });
  }

  beforeAll(async () => {
    const url = process.env.AUDIT_TEST_CLEANUP_URL;
    const runtimeUrl = process.env.DATABASE_URL;
    if (!url || !runtimeUrl) throw new Error("Disposable runtime and cleanup database URLs are required");
    const cleanupUrl = new URL(url);
    const runtime = new URL(runtimeUrl);
    const port = cleanupUrl.port || "5432";
    const localFixture = cleanupUrl.hostname === "127.0.0.1" && port === "55495"
      && cleanupUrl.pathname === "/aoa_ops195_synthetic";
    const ciFixture = process.env.CI === "true" && ["localhost", "127.0.0.1"].includes(cleanupUrl.hostname)
      && port === "5432" && cleanupUrl.pathname === "/aoa";
    if ((!localFixture && !ciFixture) || cleanupUrl.username !== "aoa" || runtime.username !== "app_rw"
      || runtime.hostname !== cleanupUrl.hostname || (runtime.port || "5432") !== port
      || runtime.pathname !== cleanupUrl.pathname) throw new Error("Refusing a non-disposable or mismatched database target");
    owner = new PrismaClient({ datasources: { db: { url } } });
    const connection = await withUserScope(actor, (tx) => tx.$queryRaw<Array<{ role: string; database: string }>>`
      SELECT current_user AS role, current_database() AS database`);
    expect(connection).toEqual([{ role: "app_rw", database: cleanupUrl.pathname.slice(1) }]);
    expect(await owner.operationsSlackNotification.count({ where: { request_id: { notIn: [ID, BLOCKER] } } })).toBe(0);
    expect(await owner.$queryRaw`SELECT sf_id FROM mirror.client WHERE sf_id = ${CLIENT}`).toEqual([]);
    expect(await owner.$queryRaw`SELECT custodian_account_id FROM mirror.client_account_aum WHERE custodian_account_id = ${ACCOUNT}`).toEqual([]);
    cleanupAllowed = true;
  });

  beforeEach(async () => {
    await cleanup();
    vi.stubEnv("APP_ENV", "dev");
    vi.stubEnv("AOA_WRITES_PAUSED", "false");
    vi.stubEnv("OPERATIONS_SLACK_CAPTURE_ENABLED", "true");
    vi.stubEnv("OPERATIONS_SLACK_DELIVERY_ENABLED", "false");
    vi.stubEnv("OPERATIONS_SLACK_BOT_TOKEN", "");
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network call from synthetic canary test"); }));
  });

  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  afterAll(async () => { if (owner) { if (cleanupAllowed) await cleanup(); await owner.$disconnect(); } });

  async function saved() {
    return owner.operationsFeeRequest.findUniqueOrThrow({ where: { id: ID }, include: { events: true, slack_notification: true } });
  }

  async function assertExactlyOne() {
    const record = await saved();
    expect(() => assertOperationsSlackVerificationRecord(record)).not.toThrow();
    expect(record.status).toBe("CANCELLED");
    expect(record.fee_amount).toBeNull();
    expect(record.reason).toBe(REASON);
    expect(record.events.map((event) => event.action).sort()).toEqual(["CANCELLED", "SUBMITTED"]);
    expect(await owner.operationsFeeRequest.count({ where: { id: ID } })).toBe(1);
    expect(await owner.operationsSlackNotification.count({ where: { request_id: ID } })).toBe(1);
    expect(await owner.auditLog.count({ where: { entityType: "operations_fee_request", entityId: ID } })).toBe(2);
    expect(await owner.$queryRaw`SELECT sf_id FROM mirror.client WHERE sf_id = ${CLIENT}`).toEqual([]);
    expect(await owner.$queryRaw`SELECT custodian_account_id FROM mirror.client_account_aum WHERE custodian_account_id = ${ACCOUNT}`).toEqual([]);
    return record;
  }

  async function blocker(status = "PENDING") {
    const request = await owner.operationsFeeRequest.create({ data: {
      id: BLOCKER, kind: "SERVICE_GUARANTEE", client_sf_id: "DEV-OPS195-UNRELATED",
      account_ids: ["TEST-OPS195-UNRELATED"], waiver_start: new Date("2026-09-01T00:00:00Z"),
      waiver_duration_months: 1, reason: "Synthetic unrelated queue guard", submitted_by_email: EMAIL,
      submitted_by_role: "OPERATIONS", submission_key: randomUUID(), submission_digest: "f".repeat(64),
    } });
    const event = await owner.operationsFeeRequestEvent.create({ data: {
      request_id: request.id, action: "SUBMITTED", actor_email: EMAIL, actor_role: "OPERATIONS", to_status: "PENDING",
    } });
    // Exercise the real capture insert so the deadline uses the database clock,
    // rather than Prisma's slightly future client-side @default(now()) value.
    await owner.$transaction((tx) => captureOperationsSlackNotification(tx, request.id, event.id));
    if (status !== "PENDING") {
      const claim = await claimOperationsSlackNotification();
      expect(claim?.requestId).toBe(BLOCKER);
      if (status === "FAILED") await finishOperationsSlackNotification(claim!, { status: "failed", code: "invalid_auth" });
      if (status === "UNCERTAIN") await finishOperationsSlackNotification(claim!, { status: "uncertain", code: "http_ambiguous" });
      if (status === "RETRY") await finishOperationsSlackNotification(claim!, { status: "retry", retryAfterSeconds: 60, code: "rate_limited" });
    }
    return event;
  }

  it("uses non-superuser app_rw with forced RLS", async () => {
    const rows = await withUserScope(actor, (tx) => tx.$queryRaw<Array<{ role: string; superuser: boolean; bypass: boolean; forced: boolean }>>`
      SELECT current_user AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypass, c.relforcerowsecurity AS forced
      FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname = current_user
      AND c.oid IN ('app.operations_fee_request'::regclass, 'app.operations_fee_request_event'::regclass, 'app.operations_slack_notification'::regclass)`);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toEqual({ role: "app_rw", superuser: false, bypass: false, forced: true });
  });

  it("atomically captures and cancels one non-financial request without touching mirror rows or sending", async () => {
    expect(await createOperationsSlackVerification(actor)).toBe(ID);
    const record = await assertExactlyOne();
    expect(record.slack_notification).toMatchObject({ status: "PENDING", attempts: 0, slack_ts: null });
    expect(fetch).not.toHaveBeenCalled();
    expect(await runOperationsSlackDelivery()).toMatchObject({ skipped: true, sent: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("collapses concurrent confirmations across actors and repeated confirmation into the same record", async () => {
    const results = await Promise.all([
      createOperationsSlackVerification(actor), createOperationsSlackVerification(actor),
      createOperationsSlackVerification({ role: "ADMIN", email: "other-synthetic@example.test" }),
    ]);
    expect(results).toEqual([ID, ID, ID]);
    const before = await assertExactlyOne();
    expect(await createOperationsSlackVerification(actor)).toBe(ID);
    expect(await saved()).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["PENDING", "RETRY", "SENDING", "FAILED", "UNCERTAIN"])("leaves unrelated %s work untouched and refuses capture", async (status) => {
    await blocker(status);
    const before = await owner.operationsSlackNotification.findUniqueOrThrow({ where: { request_id: BLOCKER } });
    await expect(createOperationsSlackVerification(actor)).rejects.toThrow("operations_slack_verification_queue_blocked");
    expect(await owner.operationsFeeRequest.findUnique({ where: { id: ID } })).toBeNull();
    expect(await owner.operationsSlackNotification.findUniqueOrThrow({ where: { request_id: BLOCKER } })).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rolls back capture and the request if cancellation cannot be recorded", async () => {
    await owner.$executeRawUnsafe(`CREATE FUNCTION app.test_ops195_cancel_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.request_id = 'ops195-test-notification-20260926' AND NEW.action = 'CANCELLED' THEN RAISE EXCEPTION 'synthetic_cancel_failure'; END IF;
      RETURN NEW; END $$`);
    await owner.$executeRawUnsafe(`CREATE TRIGGER test_ops195_cancel_failure BEFORE INSERT ON app.operations_fee_request_event
      FOR EACH ROW EXECUTE FUNCTION app.test_ops195_cancel_failure()`);
    await expect(createOperationsSlackVerification(actor)).rejects.toThrow();
    expect(await owner.operationsFeeRequest.count({ where: { id: ID } })).toBe(0);
    expect(await owner.operationsFeeRequestEvent.count({ where: { request_id: ID } })).toBe(0);
    expect(await owner.operationsSlackNotification.count({ where: { request_id: ID } })).toBe(0);
    expect(await owner.auditLog.count({ where: { entityId: ID } })).toBe(0);
  });

  it("refuses an incomplete reserved record without reconstructing or replaying it", async () => {
    await createOperationsSlackVerification(actor);
    await owner.operationsSlackNotification.delete({ where: { request_id: ID } });
    await expect(createOperationsSlackVerification(actor)).rejects.toThrow("operations_slack_verification_conflict");
    expect(await owner.operationsSlackNotification.count({ where: { request_id: ID } })).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("worker refuses a malformed reserved record before claiming or sending", async () => {
    await createOperationsSlackVerification(actor);
    await owner.operationsFeeRequestEvent.deleteMany({ where: { request_id: ID, action: "CANCELLED" } });
    const before = await owner.operationsSlackNotification.findUniqueOrThrow({ where: { request_id: ID } });
    await expect(claimOperationsSlackNotification()).rejects.toThrow("operations_slack_verification_conflict");
    expect(await owner.operationsSlackNotification.findUniqueOrThrow({ where: { request_id: ID } })).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains database rejection of historical captures through the shared helper", async () => {
    const event = await blocker();
    await owner.operationsSlackNotification.delete({ where: { request_id: BLOCKER } });
    await expect(withUserScope(actor, (tx) => captureOperationsSlackNotification(tx, BLOCKER, event.id))).rejects.toThrow();
    expect(await owner.operationsSlackNotification.count()).toBe(0);
  });

  it.each(["ADVISOR", "VIEWER"])("refuses %s, and capture-off preserves an empty database", async (role) => {
    await expect(createOperationsSlackVerification({ ...actor, role })).rejects.toThrow("operations_slack_verification_forbidden");
    vi.stubEnv("OPERATIONS_SLACK_CAPTURE_ENABLED", "false");
    await expect(createOperationsSlackVerification(actor)).rejects.toThrow("operations_slack_verification_disabled");
    expect(await owner.operationsFeeRequest.count({ where: { id: ID } })).toBe(0);
  });

  function enableMockedProduction() {
    vi.stubEnv("APP_ENV", "prod");
    vi.stubEnv("OPERATIONS_SLACK_DELIVERY_ENABLED", "true");
    vi.stubEnv("OPERATIONS_SLACK_BOT_TOKEN", "xoxb-synthetic-never-a-real-token");
  }

  it("uses the real worker and receipt path once, with a mocked Slack transport, and never replays after confirmation", async () => {
    await createOperationsSlackVerification(actor);
    enableMockedProduction();
    const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, channel: "C00OBJK6X0W", ts: "1790424000.000001" }), { status: 200 }));
    vi.stubGlobal("fetch", transport);
    expect(await runOperationsSlackDelivery()).toMatchObject({ processed: 1, sent: 1, failed: 0, uncertain: 0 });
    expect(transport).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(transport.mock.calls[0][1].body);
    expect(payload.channel).toBe("C00OBJK6X0W");
    expect(payload.text).toMatch(/TEST/);
    expect(payload.text).not.toContain(CLIENT);
    expect(payload.text).not.toContain(ACCOUNT);
    expect(payload.text).not.toContain(EMAIL);
    const before = await assertExactlyOne();
    expect(before.slack_notification).toMatchObject({ status: "SENT", attempts: 1, slack_ts: "1790424000.000001" });
    expect(await createOperationsSlackVerification(actor)).toBe(ID);
    // Cross the worker's destination-wide one-second success throttle so a
    // zero-send second run proves terminal-state non-replay, not throttling.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await owner.$queryRaw`SELECT updated_at < now() - interval '1 second' AS past_throttle
      FROM app.operations_slack_notification WHERE request_id = ${ID}`).toEqual([{ past_throttle: true }]);
    expect(await runOperationsSlackDelivery()).toMatchObject({ processed: 0, sent: 0 });
    expect(await saved()).toEqual(before);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("preserves an ambiguous delivery as UNCERTAIN and does not resend it", async () => {
    await createOperationsSlackVerification(actor);
    enableMockedProduction();
    const transport = vi.fn().mockRejectedValue(new Error("synthetic transport uncertainty"));
    vi.stubGlobal("fetch", transport);
    expect(await runOperationsSlackDelivery()).toMatchObject({ processed: 1, uncertain: 1, blocked: true });
    const before = await assertExactlyOne();
    expect(before.slack_notification).toMatchObject({ status: "UNCERTAIN", attempts: 1, slack_ts: null });
    expect(await createOperationsSlackVerification(actor)).toBe(ID);
    expect(await runOperationsSlackDelivery()).toMatchObject({ processed: 0, blocked: true });
    expect(await saved()).toEqual(before);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
