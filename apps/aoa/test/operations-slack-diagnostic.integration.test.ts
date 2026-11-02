import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Explicit local synthetic DB only. No ambient application/Cloud Run connection
// may be constructed before both URLs have passed these checks.
const run = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const PREFIX = "ops195-diagnostic-synthetic-";
const TEST_ID = "ops195-test-notification-20260926";
const IDS = [TEST_ID, ...["PENDING", "SENDING", "RETRY", "SENT", "FAILED", "UNCERTAIN"].map((status) => `${PREFIX}${status}`)];
const OPS = { role: "OPERATIONS", email: "ops195-diagnostic@example.invalid" };

function localUrl(raw: string | undefined, runtime: boolean): URL {
  if (!raw) throw new Error("explicit_ops195_synthetic_database_required");
  const url = new URL(raw);
  const port = url.port || "5432";
  const localFixture = url.hostname === "127.0.0.1" && port === "55495" && url.pathname === "/aoa_ops195_synthetic";
  const ciFixture = process.env.CI === "true" && ["localhost", "127.0.0.1"].includes(url.hostname)
    && port === "5432" && url.pathname === "/aoa";
  if (!["postgres:", "postgresql:"].includes(url.protocol) || (!localFixture && !ciFixture)
    || url.username !== (runtime ? "app_rw" : "aoa")
    || [...url.searchParams.keys()].some((key) => !["schema", "connection_limit", "pool_timeout"].includes(key))
    || url.hash || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE
    || ["dev", "development", "prod", "production"].includes(process.env.APP_ENV?.toLowerCase() ?? "")) {
    throw new Error("isolated_ops195_synthetic_database_required");
  }
  return url;
}

run("Operations Slack diagnostic on isolated synthetic PostgreSQL", () => {
  let owner: PrismaClient | undefined;
  let app: typeof import("@/lib/db").prisma | undefined;
  let read: typeof import("@/lib/data/operations-slack-diagnostic").readOperationsSlackDiagnostic;
  let create: typeof import("@/lib/data/operations-slack-verification").createOperationsSlackVerification;
  let scope: typeof import("@/lib/rls").withUserScope;
  let claim: typeof import("@/lib/data/operations-slack-delivery").claimOperationsSlackNotification;
  let finish: typeof import("@/lib/data/operations-slack-delivery").finishOperationsSlackNotification;

  async function cleanup() {
    if (!owner) return;
    await owner.operationsSlackNotification.deleteMany({ where: { request_id: { in: IDS } } });
    await owner.operationsFeeRequestEvent.deleteMany({ where: { request_id: { in: IDS } } });
    await owner.operationsFeeRequest.deleteMany({ where: { id: { in: IDS } } });
    await owner.auditLog.deleteMany({ where: { entityType: "operations_fee_request", entityId: { in: IDS } } });
    await owner.rowChange.deleteMany({ where: { schema_name: "app", table_name: "operations_fee_request", row_pk: { in: IDS } } });
  }

  async function snapshot() {
    return {
      requests: await owner!.operationsFeeRequest.findMany({ where: { id: { in: IDS } }, orderBy: { id: "asc" } }),
      events: await owner!.operationsFeeRequestEvent.findMany({ where: { request_id: { in: IDS } }, orderBy: { id: "asc" } }),
      notifications: await owner!.operationsSlackNotification.findMany({ where: { request_id: { in: IDS } }, orderBy: { request_id: "asc" } }),
      audits: await owner!.auditLog.findMany({ where: { entityType: "operations_fee_request", entityId: { in: IDS } }, orderBy: { id: "asc" } }),
      versions: await owner!.$queryRaw<Array<{ id: string; version: string }>>`
        SELECT request_id AS id, xmin::text AS version FROM app.operations_slack_notification ORDER BY request_id`,
    };
  }

  beforeAll(async () => {
    const runtime = localUrl(process.env.DATABASE_URL, true);
    const ownerUrl = localUrl(process.env.AUDIT_TEST_CLEANUP_URL, false);
    if (ownerUrl.hostname !== runtime.hostname || (ownerUrl.port || "5432") !== (runtime.port || "5432")
      || ownerUrl.pathname !== runtime.pathname) {
      throw new Error("ops195_synthetic_connections_must_match");
    }
    owner = new PrismaClient({ datasourceUrl: ownerUrl.href });
    ({ readOperationsSlackDiagnostic: read } = await import("@/lib/data/operations-slack-diagnostic"));
    ({ createOperationsSlackVerification: create } = await import("@/lib/data/operations-slack-verification"));
    ({ withUserScope: scope } = await import("@/lib/rls"));
    ({ claimOperationsSlackNotification: claim, finishOperationsSlackNotification: finish } = await import("@/lib/data/operations-slack-delivery"));
    ({ prisma: app } = await import("@/lib/db"));
    const rows = await scope(OPS, (tx) => tx.$queryRaw<Array<{ name: string; database: string; username: string; superuser: boolean; bypassrls: boolean; rls: boolean; forced: boolean }>>`
      SELECT c.relname AS name, current_database() AS database, current_user AS username, r.rolsuper AS superuser,
        r.rolbypassrls AS bypassrls, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
      FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname = current_user
      AND c.oid IN ('app.operations_fee_request'::regclass, 'app.operations_fee_request_event'::regclass, 'app.operations_slack_notification'::regclass)`);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toMatchObject({ database: runtime.pathname.slice(1), username: "app_rw", superuser: false, bypassrls: false, rls: true, forced: true });
    // Refuse another suite's live work rather than erasing or claiming it.
    expect(await owner.operationsSlackNotification.count({ where: { request_id: { notIn: IDS } } })).toBe(0);
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    vi.stubEnv("APP_ENV", "dev");
    vi.stubEnv("OPERATIONS_SLACK_CAPTURE_ENABLED", "true");
    vi.stubEnv("OPERATIONS_SLACK_DELIVERY_ENABLED", "false");
    vi.stubEnv("AOA_WRITES_PAUSED", "false");
    vi.stubEnv("OPERATIONS_SLACK_BOT_TOKEN", "");
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected_ops195_network_call"); }));
  });

  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    try { await cleanup(); }
    finally { await owner?.$disconnect(); await app?.$disconnect(); }
  });

  it("returns actual zero counts and no test without creating any record", async () => {
    const before = await snapshot();
    expect(await read(OPS)).toEqual({
      counts: { PENDING: 0, SENDING: 0, RETRY: 0, SENT: 0, FAILED: 0, UNCERTAIN: 0 },
      needsReviewCount: 0, delayedRetryCount: 0, captureEnabled: true,
      deliveryEnabled: false, configurationValid: false, writesPaused: false, test: null,
    });
    expect(await snapshot()).toEqual(before);
  });

  it("reports every actual status and blocker count without ordinary request identifiers", async () => {
    for (const status of ["PENDING", "SENDING", "RETRY", "SENT", "FAILED", "UNCERTAIN"]) {
      const id = `${PREFIX}${status}`;
      await owner!.operationsFeeRequest.create({ data: {
        id, kind: "FEE_CREDIT", status: "PENDING", client_sf_id: "DEV-OPS195-DIAGNOSTIC",
        account_ids: ["TEST-OPS195-DIAGNOSTIC"], fee_types: ["Wire"], fee_amount: "1.00",
        reason: "Synthetic diagnostic fixture", submitted_by_email: OPS.email, submitted_by_role: OPS.role,
      } });
      const event = await owner!.operationsFeeRequestEvent.create({ data: {
        request_id: id, action: "SUBMITTED", actor_email: OPS.email, actor_role: OPS.role,
        from_status: null, to_status: "PENDING",
      } });
      await owner!.operationsSlackNotification.create({ data: {
        request_id: id, event_id: event.id, status, attempts: status === "PENDING" ? 0 : 1,
        claim_token: status === "SENDING" ? randomUUID() : null,
        claimed_at: status === "SENDING" ? new Date() : null,
        slack_ts: status === "SENT" ? "1790380800.000001" : null,
        next_attempt_at: status === "RETRY" ? new Date(Date.now() + 60_000) : new Date(),
      } });
    }
    const before = await snapshot();
    const result = await read(OPS);
    expect(result.counts).toEqual({ PENDING: 1, SENDING: 1, RETRY: 1, SENT: 1, FAILED: 1, UNCERTAIN: 1 });
    expect(result.needsReviewCount).toBe(2);
    expect(result.delayedRetryCount).toBe(1);
    expect(result.test).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/ops195-diagnostic-synthetic|DEV-OPS195|TEST-OPS195|example.invalid|claim_token/);
    expect(await snapshot()).toEqual(before);
  });

  it("reads only the valid fixed test receipt and preserves the queue and audit rows", async () => {
    await create(OPS);
    const pending = await read(OPS);
    expect(pending.test).toMatchObject({ requestId: TEST_ID, requestStatus: "CANCELLED", notificationStatus: "PENDING", attempts: 0, slackTs: null, submissionEventCount: 1, cancellationEventCount: 1 });
    const claimed = await claim();
    expect(claimed?.requestId).toBe(TEST_ID);
    await finish(claimed!, { status: "sent", channel: "C00OBJK6X0W", ts: "1790380800.123456" });
    const before = await snapshot();
    const result = await read(OPS);
    expect(result.counts.SENT).toBe(1);
    expect(result.test).toMatchObject({ notificationStatus: "SENT", attempts: 1, slackTs: "1790380800.123456", lastCode: null });
    expect(JSON.stringify(result)).not.toMatch(/DEV-OPS195|TEST-OPS195|example.invalid|claim_token|submission_digest|account_ids|client_sf_id/);
    expect(await snapshot()).toEqual(before);
    expect(await read({ role: "ADMIN", email: "ops195-admin@example.invalid" })).toEqual(result);
    // SET LOCAL caller scope must not survive connection-pool reuse.
    expect(await app!.operationsSlackNotification.findUnique({ where: { request_id: TEST_ID } })).toBeNull();
  });

  it("redacts unknown stored error text and keeps uncertain delivery explicit", async () => {
    await create(OPS);
    const claimed = await claim();
    await finish(claimed!, { status: "uncertain", code: "synthetic_private_code" });
    const result = await read(OPS);
    expect(result.needsReviewCount).toBe(1);
    expect(result.test).toMatchObject({ notificationStatus: "UNCERTAIN", slackTs: null, lastCode: "unrecognized_code" });
    expect(JSON.stringify(result)).not.toContain("synthetic_private_code");
  });

  it.each(["VIEWER", "ADVISOR", "CLIENT_SERVICE", "HEAD_OF_ADVISORY", "OPS", "UNKNOWN"])("rejects %s without touching the database", async (role) => {
    await create(OPS);
    const before = await snapshot();
    const transaction = vi.spyOn(app!, "$transaction");
    try {
      await expect(read({ ...OPS, role })).rejects.toThrow("forbidden");
      expect(transaction).not.toHaveBeenCalled();
    } finally { transaction.mockRestore(); }
    expect(await snapshot()).toEqual(before);
  });

  it("fails closed if the reserved request exists without its notification", async () => {
    await create(OPS);
    await owner!.operationsSlackNotification.deleteMany({ where: { request_id: TEST_ID } });
    await expect(read(OPS)).rejects.toThrow("operations_slack_verification_conflict");
  });
});
