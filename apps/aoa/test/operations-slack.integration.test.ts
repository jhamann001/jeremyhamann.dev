import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));

import { OPERATIONS_FEE_REQUEST_CREATE } from "@/lib/audit";
import { createOperationsFeeRequest, transitionOperationsFeeRequest } from "@/lib/data/operations-fee-requests";
import {
  claimOperationsSlackNotification,
  expireOperationsSlackClaims,
  finishOperationsSlackNotification,
  runOperationsSlackDelivery,
} from "@/lib/data/operations-slack-delivery";
import type { ParsedOperationsFeeRequest } from "@/lib/operations/fee-request";
import { feeSubmissionDigest } from "@/lib/operations/fee-submission";
import { operationsSlackPreview } from "@/lib/data/operations-slack-preview";
import { withUserScope } from "@/lib/rls";
import { OPERATIONS_SLACK_CHANNEL, type OperationsSlackResult } from "@/lib/slack/operations-fee-notifications";

// Opt in exactly like the database CI suites: DATABASE_URL must be app_rw,
// AUDIT_TEST_DB_URL enables execution, and AUDIT_TEST_CLEANUP_URL is the owner
// connection to the same disposable database. No export/snapshot is loaded.
const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const PREFIX = "ops-slack-synthetic-";
const HOUSEHOLD = "001TZN109503622AAA";
const CLIENT = "003TZN109503622AAA";
const ACCOUNT = `${PREFIX}account`;
const EMAIL = "ops-slack-synthetic@example.test";
const OTHER_EMAIL = "ops-slack-other-synthetic@example.test";
const identity = { role: "OPERATIONS", email: EMAIL };
const worker = { role: "OPERATIONS", email: "operations-slack-delivery@system" };

function input(overrides: Partial<ParsedOperationsFeeRequest> = {}): ParsedOperationsFeeRequest {
  return {
    kind: "FEE_CREDIT", clientSfId: CLIENT, accountIds: [ACCOUNT], feeTypes: ["Wire"],
    feeAmount: "1.00", waiverStart: null, waiverDurationMonths: null,
    indefiniteDuration: false, reason: "Synthetic integration fixture", relevantTicketRefs: [],
    ...overrides,
  };
}

function requestData(email = EMAIL, role = "OPERATIONS"): Prisma.OperationsFeeRequestUncheckedCreateInput {
  return {
    kind: "FEE_CREDIT", status: "PENDING", client_sf_id: CLIENT,
    account_ids: [ACCOUNT], fee_types: ["Wire"], fee_amount: "1.00",
    reason: "Synthetic database policy fixture", submitted_by_email: email, submitted_by_role: role,
    submission_key: randomUUID(), submission_digest: feeSubmissionDigest(input()),
  };
}

async function livePair(tx: Prisma.TransactionClient, email = EMAIL, role = "OPERATIONS") {
  const request = await tx.operationsFeeRequest.create({ data: requestData(email, role) });
  const event = await tx.operationsFeeRequestEvent.create({ data: {
    request_id: request.id, action: "SUBMITTED", actor_email: email, actor_role: role,
    from_status: null, to_status: "PENDING",
  } });
  return { request, event };
}

gated("Operations Slack outbox: real PostgreSQL transactions and forced RLS", () => {
  let owner: PrismaClient;

  async function removeFailureTrigger() {
    await owner.$executeRaw`DROP TRIGGER IF EXISTS test_ops_slack_capture_failure ON app.operations_slack_notification`;
    await owner.$executeRaw`DROP FUNCTION IF EXISTS app.test_ops_slack_capture_failure()`;
    await owner.$executeRaw`DROP TRIGGER IF EXISTS test_ops_slack_database_clock ON app.operations_slack_notification`;
    await owner.$executeRaw`DROP FUNCTION IF EXISTS app.test_ops_slack_database_clock()`;
  }

  async function cleanup() {
    await removeFailureTrigger();
    await owner.$executeRaw`
      DELETE FROM app.operations_slack_notification WHERE request_id IN (
        SELECT id FROM app.operations_fee_request WHERE client_sf_id = ${CLIENT})`;
    await owner.$executeRaw`
      DELETE FROM audit."AuditLog" WHERE "entityType" = 'operations_fee_request'
        AND "entityId" IN (SELECT id FROM app.operations_fee_request WHERE client_sf_id = ${CLIENT})`;
    await owner.$executeRaw`
      DELETE FROM app.operations_fee_request_event WHERE request_id IN (
        SELECT id FROM app.operations_fee_request WHERE client_sf_id = ${CLIENT})`;
    await owner.$executeRaw`DELETE FROM app.operations_fee_request WHERE client_sf_id = ${CLIENT}`;
    await owner.$executeRaw`DELETE FROM mirror.client_account_aum WHERE custodian_account_id = ${ACCOUNT}`;
    await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id = ${CLIENT}`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id = ${HOUSEHOLD}`;
  }

  beforeAll(async () => {
    const url = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!url) throw new Error("AUDIT_TEST_CLEANUP_URL is required for synthetic fixture cleanup");
    owner = new PrismaClient({ datasources: { db: { url } } });
    // Worker selection intentionally scans its queue. Refuse a database with
    // unrelated pending work instead of claiming another suite's notification.
    expect(await owner.operationsSlackNotification.count({
      where: { request: { client_sf_id: { not: CLIENT } } },
    })).toBe(0);
  });

  beforeEach(async () => {
    await cleanup();
    vi.stubEnv("APP_ENV", "dev");
    vi.stubEnv("OPERATIONS_TOOLS", "1");
    vi.stubEnv("OPERATIONS_FEE_REQUESTS", "1");
    vi.stubEnv("OPERATIONS_SLACK_CAPTURE_ENABLED", "true");
    vi.stubEnv("OPERATIONS_SLACK_DELIVERY_ENABLED", "false");
    vi.stubEnv("OPERATIONS_SLACK_BOT_TOKEN", "");
    // Any unexpected outbound attempt fails this suite. Prisma uses its native
    // Postgres transport, so this does not replace the actual database path.
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network call in PostgreSQL integration test"); }));
    await owner.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, lead_advisor_email)
      VALUES (${HOUSEHOLD}, 'Synthetic Operations household', ${EMAIL})`;
    await owner.$executeRaw`
      INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
      VALUES (${CLIENT}, ${HOUSEHOLD}, 'Synthetic', 'Operations', ${EMAIL})`;
    await owner.$executeRaw`
      INSERT INTO mirror.client_account_aum
        (custodian_account_id, apex_account_number, client_sf_id, household_sf_id,
         account_type, account_status, source_present)
      VALUES (${ACCOUNT}, 'SYN0001', ${CLIENT}, ${HOUSEHOLD}, 'Brokerage', 'OPEN', true)`;
  });

  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (owner) {
      await cleanup();
      await owner.$disconnect();
    }
  });

  it("reads actual captured metadata under the signed-in RLS context without changing queue evidence", async () => {
    const id = await createOperationsFeeRequest(identity, input(), randomUUID());
    const before = await owner.operationsSlackNotification.findUniqueOrThrow({ where: { request_id: id } });
    vi.stubEnv("OPERATIONS_SLACK_CAPTURE_ENABLED", "false");
    const preview = await operationsSlackPreview(identity, id);
    expect(preview).toMatchObject({ requestId: id, captureEnabled: false, deliveryFlagEnabled: false,
      notification: { status: "PENDING", attempts: 0, eventId: before.event_id.toString(),
        capturedAt: before.created_at.toISOString(), receiptPresent: false } });
    expect(preview?.message).toContain(`Request ID: ${id}`);
    expect(await operationsSlackPreview({ ...identity, role: "ADVISOR" }, id)).toBeNull();
    expect(await operationsSlackPreview(identity, "synthetic_missing_request_0001")).toBeNull();
    expect(await owner.operationsSlackNotification.findUniqueOrThrow({ where: { request_id: id } })).toEqual(before);
  });

  it("never reconstructs an uncaptured submission when capture is later enabled", async () => {
    vi.stubEnv("OPERATIONS_SLACK_CAPTURE_ENABLED", "false");
    const id = await createOperationsFeeRequest(identity, input(), randomUUID());
    vi.stubEnv("OPERATIONS_SLACK_CAPTURE_ENABLED", "true");
    expect(await operationsSlackPreview(identity, id)).toMatchObject({ captureEnabled: true, notification: null });
    expect(await owner.operationsSlackNotification.count({ where: { request_id: id } })).toBe(0);
  });

  async function assertOneSubmission(id: string, notifications = 1) {
    expect(await owner.operationsFeeRequest.count({ where: { client_sf_id: CLIENT } })).toBe(1);
    const events = await owner.operationsFeeRequestEvent.findMany({ where: { request_id: id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "SUBMITTED", to_status: "PENDING", actor_email: EMAIL });
    expect(await owner.auditLog.count({ where: {
      entityType: "operations_fee_request", entityId: id, action: OPERATIONS_FEE_REQUEST_CREATE,
    } })).toBe(1);
    const queue = await owner.operationsSlackNotification.findMany({ where: { request_id: id } });
    expect(queue).toHaveLength(notifications);
    if (notifications) expect(queue[0]).toMatchObject({
      event_id: events[0].id, status: "PENDING", attempts: 0, channel_id: OPERATIONS_SLACK_CHANNEL,
      claim_token: null, claimed_at: null, last_code: null, slack_ts: null,
    });
  }

  it("runs as non-superuser app_rw with forced row security on all three tables", async () => {
    const rows = await withUserScope(identity, (tx) => tx.$queryRaw<Array<{
      relation: string; current_role: string; rolsuper: boolean; rolbypassrls: boolean; relforcerowsecurity: boolean;
    }>>`
      SELECT relation.relname AS relation, current_user AS current_role,
             role.rolsuper, role.rolbypassrls, relation.relforcerowsecurity
      FROM pg_roles role CROSS JOIN pg_class relation
      WHERE role.rolname = current_user AND relation.oid IN (
        'app.operations_fee_request'::regclass, 'app.operations_fee_request_event'::regclass,
        'app.operations_slack_notification'::regclass)`);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toMatchObject({
      current_role: "app_rw", rolsuper: false, rolbypassrls: false, relforcerowsecurity: true,
    });
  });

  it("collapses simultaneous identical actor/key submissions to one request, event, audit and outbox row", async () => {
    const key = randomUUID();
    const ids = await Promise.all(Array.from({ length: 5 }, () => createOperationsFeeRequest(identity, input(), key)));
    expect(new Set(ids).size).toBe(1);
    await assertOneSubmission(ids[0]);
  });

  it("rejects changed payload reuse without changing the original request or duplicating its event", async () => {
    const key = randomUUID();
    const id = await createOperationsFeeRequest(identity, input(), key);
    await expect(createOperationsFeeRequest(identity, input({ reason: "Changed synthetic reason" }), key))
      .rejects.toThrow("submission_conflict");
    expect((await owner.operationsFeeRequest.findUniqueOrThrow({ where: { id } })).reason).toBe(input().reason);
    await assertOneSubmission(id);
  });

  it("allows different actors to use the same form key independently", async () => {
    const key = randomUUID();
    const ids = await Promise.all([
      createOperationsFeeRequest(identity, input(), key),
      createOperationsFeeRequest({ role: "OPERATIONS", email: OTHER_EMAIL }, input(), key),
    ]);
    expect(new Set(ids).size).toBe(2);
    const rows = await owner.operationsFeeRequest.findMany({ where: { id: { in: ids } } });
    expect(rows.map((row) => row.submitted_by_email).sort()).toEqual([EMAIL, OTHER_EMAIL].sort());
    expect(await owner.operationsSlackNotification.count({ where: { request_id: { in: ids } } })).toBe(2);
    expect(await owner.operationsFeeRequestEvent.count({ where: { request_id: { in: ids }, action: "SUBMITTED" } })).toBe(2);
  });

  it("does not backfill a request created with capture off when the same key is retried after activation", async () => {
    const key = randomUUID();
    vi.stubEnv("OPERATIONS_SLACK_CAPTURE_ENABLED", "false");
    const id = await createOperationsFeeRequest(identity, input(), key);
    vi.stubEnv("OPERATIONS_SLACK_CAPTURE_ENABLED", "true");
    expect(await createOperationsFeeRequest(identity, input(), key)).toBe(id);
    await assertOneSubmission(id, 0);
    expect(await claimOperationsSlackNotification()).toBeNull();
  });

  it.each(["FEE_CREDIT", "SERVICE_GUARANTEE", "BILLING_EXCEPTION", "LARGE_HOUSEHOLD_EXCEPTION"] as const)(
    "captures one pending notification for the approved %s category", async (kind) => {
      const value = kind === "FEE_CREDIT" ? input() : input({
        kind, feeTypes: [], feeAmount: null, waiverStart: "2026-10-01", waiverDurationMonths: 1,
      });
      const id = await createOperationsFeeRequest(identity, value, randomUUID());
      await assertOneSubmission(id);
      expect((await claimOperationsSlackNotification())?.kind).toBe(kind);
    },
  );

  it("never queues imported history or an ordinary review transition", async () => {
    const imported = await owner.operationsFeeRequest.create({ data: {
      ...requestData(), id: `${PREFIX}legacy`, submitted_by_email: null,
      submitted_by_name: "Synthetic Importer", submission_key: null, submission_digest: null,
      legacy_source: "fee_store_fee_credits", legacy_source_id: `${PREFIX}legacy-source`,
      legacy_source_digest: "a".repeat(64), legacy_client_name: "Synthetic imported client",
    } });
    await owner.operationsFeeRequestEvent.create({ data: {
      request_id: imported.id, action: "LEGACY_IMPORTED", actor_name: "Synthetic Importer",
      actor_role: "OPERATIONS", to_status: "PENDING",
    } });
    vi.stubEnv("OPERATIONS_SLACK_CAPTURE_ENABLED", "false");
    const liveId = await createOperationsFeeRequest(identity, input(), randomUUID());
    vi.stubEnv("OPERATIONS_SLACK_CAPTURE_ENABLED", "true");
    await transitionOperationsFeeRequest(identity, {
      requestId: liveId, action: "APPROVE", note: "",
      creditedDate: null, apexRequestId: null,
    });
    expect(await owner.operationsSlackNotification.count({ where: { request_id: { in: [imported.id, liveId] } } })).toBe(0);
    expect(await claimOperationsSlackNotification()).toBeNull();
  });

  it("rolls back the request and SUBMITTED event when actual outbox insertion fails", async () => {
    await owner.$executeRaw`
      CREATE FUNCTION app.test_ops_slack_capture_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('app.user_email', true) = 'ops-slack-synthetic@example.test' THEN
          RAISE EXCEPTION 'synthetic_capture_failure';
        END IF;
        RETURN NEW;
      END;
      $$`;
    await owner.$executeRaw`
      CREATE TRIGGER test_ops_slack_capture_failure BEFORE INSERT ON app.operations_slack_notification
      FOR EACH ROW EXECUTE FUNCTION app.test_ops_slack_capture_failure()`;
    try {
      await expect(createOperationsFeeRequest(identity, input(), randomUUID())).rejects.toThrow("synthetic_capture_failure");
      expect(await owner.operationsFeeRequest.count({ where: { client_sf_id: CLIENT } })).toBe(0);
      expect(await owner.operationsFeeRequestEvent.count({ where: { actor_email: EMAIL } })).toBe(0);
      expect(await owner.operationsSlackNotification.count()).toBe(0);
      expect(await owner.auditLog.count({ where: { actorEmail: EMAIL, action: OPERATIONS_FEE_REQUEST_CREATE } })).toBe(0);
    } finally {
      await removeFailureTrigger();
    }
  });

  it.each(["ADMIN", "OPERATIONS"])("allows %s to capture and read its real live submission", async (role) => {
    const id = await createOperationsFeeRequest({ role, email: EMAIL }, input(), randomUUID());
    const rows = await withUserScope({ role, email: EMAIL }, (tx) => tx.operationsSlackNotification.findMany({ where: { request_id: id } }));
    expect(rows).toHaveLength(1);
  });

  it.each(["ADVISOR", "CLIENT_SERVICE", "VIEWER", "unknown"])(
    "denies %s request creation and outbox visibility/insertion", async (role) => {
      await createOperationsFeeRequest(identity, input(), randomUUID());
      await expect(createOperationsFeeRequest({ role, email: EMAIL }, input(), randomUUID())).rejects.toThrow("actor_unavailable");
      expect(await withUserScope({ role, email: EMAIL }, (tx) => tx.operationsSlackNotification.findMany())).toEqual([]);
      // Give the denied role an otherwise-valid, freshly created pair so that
      // the assertion cannot pass because of duplicate IDs or capture age.
      await expect(owner.$transaction(async (tx) => {
        const pair = await livePair(tx);
        await tx.$executeRaw`SET LOCAL ROLE app_rw`;
        await tx.$executeRaw`SELECT set_config('app.user_role', ${role}, true)`;
        await tx.$executeRaw`SELECT set_config('app.user_email', ${EMAIL}, true)`;
        await tx.operationsSlackNotification.create({ data: { request_id: pair.request.id, event_id: pair.event.id } });
      })).rejects.toThrow(/row-level security/);
    },
  );

  it("keeps outbox rows hidden without an authenticated email", async () => {
    await createOperationsFeeRequest(identity, input(), randomUUID());
    expect(await withUserScope({ role: "OPERATIONS" }, (tx) => tx.operationsSlackNotification.findMany())).toEqual([]);
  });

  it("rejects mismatched request/event linkage inside the same live transaction", async () => {
    await expect(withUserScope(identity, async (tx) => {
      const first = await livePair(tx);
      const second = await livePair(tx);
      await tx.operationsSlackNotification.create({ data: { request_id: first.request.id, event_id: second.event.id } });
    })).rejects.toThrow(/row-level security/);
    expect(await owner.operationsFeeRequest.count({ where: { client_sf_id: CLIENT } })).toBe(0);
  });

  it("rejects a different actor capturing another actor's newly submitted event", async () => {
    await expect(owner.$transaction(async (tx) => {
      const pair = await livePair(tx);
      await tx.$executeRaw`SET LOCAL ROLE app_rw`;
      await tx.$executeRaw`SELECT set_config('app.user_role', 'OPERATIONS', true)`;
      await tx.$executeRaw`SELECT set_config('app.user_email', ${OTHER_EMAIL}, true)`;
      await tx.operationsSlackNotification.create({ data: { request_id: pair.request.id, event_id: pair.event.id } });
    })).rejects.toThrow(/row-level security/);
  });

  it("rejects delayed direct capture even when the request has a valid submission key", async () => {
    vi.stubEnv("OPERATIONS_SLACK_CAPTURE_ENABLED", "false");
    const id = await createOperationsFeeRequest(identity, input(), randomUUID());
    const event = await owner.operationsFeeRequestEvent.findFirstOrThrow({ where: { request_id: id } });
    await expect(withUserScope(identity, (tx) => tx.operationsSlackNotification.create({ data: {
      request_id: id, event_id: event.id,
    } }))).rejects.toThrow(/row-level security/);
  });

  it.each(["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE", "VIEWER"])(
    "prevents ordinary %s users from claiming, deleting or rewriting outbox identity", async (role) => {
      const id = await createOperationsFeeRequest(identity, input(), randomUUID());
      const scoped = { role, email: EMAIL };
      expect(await withUserScope(scoped, (tx) => tx.operationsSlackNotification.updateMany({
        where: { request_id: id }, data: { status: "FAILED", last_code: "forged" },
      }))).toEqual({ count: 0 });
      await expect(withUserScope(scoped, (tx) => tx.operationsSlackNotification.deleteMany({ where: { request_id: id } }))).rejects.toThrow(/permission denied/);
      await expect(withUserScope(scoped, (tx) => tx.operationsSlackNotification.updateMany({
        where: { request_id: id }, data: { channel_id: "C0000000000" },
      }))).rejects.toThrow(/permission denied/);
      expect((await owner.operationsSlackNotification.findUniqueOrThrow({ where: { request_id: id } })).status).toBe("PENDING");
    },
  );

  it("allows only one active channel claim across concurrent workers", async () => {
    const ids = await Promise.all(Array.from({ length: 4 }, () => createOperationsFeeRequest(identity, input(), randomUUID())));
    const claims = await Promise.all(Array.from({ length: 6 }, () => claimOperationsSlackNotification()));
    const claimed = claims.filter((claim) => claim !== null);
    expect(claimed).toHaveLength(1);
    expect(ids).toContain(claimed[0].requestId);
    expect(claimed[0].claimToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(claimed.every((claim) => claim.attempts === 1)).toBe(true);
    expect(await owner.operationsSlackNotification.count({ where: { status: "PENDING" } })).toBe(3);
    expect(await expireOperationsSlackClaims()).toBe(0);
    expect(await claimOperationsSlackNotification()).toBeNull();
  });

  it("skips a row locked by another transaction without blocking delivery of another request", async () => {
    const lockedId = await createOperationsFeeRequest(identity, input(), randomUUID());
    const availableId = await createOperationsFeeRequest(identity, input(), randomUUID());
    let unlock!: () => void;
    let notifyLocked!: () => void;
    const locked = new Promise<void>((resolve) => { notifyLocked = resolve; });
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const transaction = owner.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT request_id FROM app.operations_slack_notification WHERE request_id = ${lockedId} FOR UPDATE`;
      notifyLocked();
      await release;
    }, { timeout: 10_000 });
    try {
      await locked;
      const claim = await claimOperationsSlackNotification();
      expect(claim?.requestId).toBe(availableId);
    } finally {
      unlock();
      await transaction;
    }
    expect(await claimOperationsSlackNotification()).toBeNull();
    expect((await owner.operationsSlackNotification.findUniqueOrThrow({ where: { request_id: lockedId } })).status).toBe("PENDING");
  });

  it.each([
    ["SENT", { status: "sent", ts: "1700000000.123456", channel: OPERATIONS_SLACK_CHANNEL }],
    ["FAILED", { status: "failed", code: "not_in_channel" }],
    ["UNCERTAIN", { status: "uncertain", code: "transport_or_response_ambiguous" }],
  ] satisfies Array<[string, OperationsSlackResult]>)("finalizes %s once and forbids terminal requeue", async (status, result) => {
    const id = await createOperationsFeeRequest(identity, input(), randomUUID());
    const claim = await claimOperationsSlackNotification();
    expect(claim).not.toBeNull();
    if (!claim) throw new Error("missing synthetic claim");
    expect(await finishOperationsSlackNotification({ ...claim, claimToken: randomUUID() }, result)).toBe(false);
    expect(await finishOperationsSlackNotification(claim, result)).toBe(true);
    expect(await finishOperationsSlackNotification(claim, result)).toBe(false);
    const row = await owner.operationsSlackNotification.findUniqueOrThrow({ where: { request_id: id } });
    expect(row).toMatchObject({ status, attempts: 1, claim_token: null, claimed_at: null });
    expect(row.slack_ts).toBe(result.status === "sent" ? result.ts : null);
    expect(await claimOperationsSlackNotification()).toBeNull();
    const nextId = await createOperationsFeeRequest(identity, input(), randomUUID());
    expect(await claimOperationsSlackNotification()).toBeNull();
    expect((await owner.operationsSlackNotification.findUniqueOrThrow({ where: { request_id: nextId } })).status).toBe("PENDING");
    await expect(withUserScope(worker, (tx) => tx.operationsSlackNotification.updateMany({
      where: { request_id: id }, data: { status: "PENDING", slack_ts: null },
    }))).rejects.toThrow("operations_slack_transition_invalid");
  });

  it("uses the database transaction clock for the initial notification deadline", async () => {
    // The probe enforces the invariant at insert time, before client-side
    // timestamp precision or a later query can hide the clock mismatch.
    await owner.$executeRaw`
      CREATE FUNCTION app.test_ops_slack_database_clock() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
      BEGIN
        IF current_setting('app.user_email', true) = 'ops-slack-synthetic@example.test'
          AND NEW.next_attempt_at IS DISTINCT FROM transaction_timestamp() THEN
          RAISE EXCEPTION 'synthetic_outbox_schedule_not_database_clock';
        END IF;
        RETURN NEW;
      END;
      $$`;
    try {
      await owner.$executeRaw`
        CREATE TRIGGER test_ops_slack_database_clock
        BEFORE INSERT ON app.operations_slack_notification
        FOR EACH ROW EXECUTE FUNCTION app.test_ops_slack_database_clock()`;
      const id = await createOperationsFeeRequest(identity, input(), randomUUID());
      const claim = await claimOperationsSlackNotification();
      expect(claim?.requestId).toBe(id);
    } finally {
      await removeFailureTrigger();
    }
  });

  it("claims 250 sequential live submissions immediately without sleeps or retries", async () => {
    for (let index = 0; index < 250; index++) {
      const id = await createOperationsFeeRequest(identity, input(), randomUUID());
      const claim = await claimOperationsSlackNotification();
      expect(claim?.requestId, `synthetic immediate claim ${index}`).toBe(id);
      expect(claim?.attempts).toBe(1);
      // Owner-only cleanup of this exact synthetic outbox row lets the next
      // iteration exercise a fresh claim without bypassing channel blocking.
      await owner.operationsSlackNotification.delete({ where: { request_id: id } });
    }
  }, 30_000);

  it("defers explicit rate-limit retries until their persisted next-attempt time", async () => {
    const id = await createOperationsFeeRequest(identity, input(), randomUUID());
    const claim = await claimOperationsSlackNotification();
    if (!claim) {
      const timing = await owner.$queryRaw`
        SELECT status, next_attempt_at, clock_timestamp(),
               extract(epoch FROM next_attempt_at - clock_timestamp()) AS seconds_until_due
        FROM app.operations_slack_notification WHERE request_id = ${id}`;
      throw new Error(`missing synthetic claim: ${JSON.stringify(timing)}`);
    }
    const before = Date.now();
    expect(await finishOperationsSlackNotification(claim, { status: "retry", code: "rate_limited", retryAfterSeconds: 60 })).toBe(true);
    const row = await owner.operationsSlackNotification.findUniqueOrThrow({ where: { request_id: id } });
    expect(row).toMatchObject({ status: "RETRY", attempts: 1, claim_token: null, claimed_at: null, last_code: "rate_limited" });
    expect(row.next_attempt_at.getTime()).toBeGreaterThanOrEqual(before + 59_000);
    await createOperationsFeeRequest(identity, input(), randomUUID());
    expect(await claimOperationsSlackNotification()).toBeNull();
  });

  it.each(["FAILED", "UNCERTAIN"])("owner acknowledgment of %s unblocks the channel without requeuing that notification", async (status) => {
    const id = await createOperationsFeeRequest(identity, input(), randomUUID());
    const nextId = await createOperationsFeeRequest(identity, input(), randomUUID());
    const claim = await claimOperationsSlackNotification();
    if (!claim) throw new Error("missing synthetic claim");
    expect(claim.requestId).toBe(id);
    await finishOperationsSlackNotification(claim, status === "FAILED"
      ? { status: "failed", code: "not_in_channel" }
      : { status: "uncertain", code: "transport_or_response_ambiguous" });
    expect(await claimOperationsSlackNotification()).toBeNull();
    await expect(withUserScope(worker, (tx) => tx.operationsSlackNotification.updateMany({
      where: { request_id: id }, data: { acknowledged_at: new Date(), acknowledged_by_email: EMAIL },
    }))).rejects.toThrow(/permission denied/);
    await owner.operationsSlackNotification.update({
      where: { request_id: id }, data: { acknowledged_at: new Date(), acknowledged_by_email: EMAIL },
    });
    expect((await owner.operationsSlackNotification.findUniqueOrThrow({ where: { request_id: id } })))
      .toMatchObject({ status, attempts: 1, acknowledged_by_email: EMAIL });
    expect((await claimOperationsSlackNotification())?.requestId).toBe(nextId);
  });

  it("turns a fifth explicit rejection into FAILED instead of scheduling a sixth attempt", async () => {
    vi.stubEnv("OPERATIONS_SLACK_CAPTURE_ENABLED", "false");
    const id = await createOperationsFeeRequest(identity, input(), randomUUID());
    const event = await owner.operationsFeeRequestEvent.findFirstOrThrow({ where: { request_id: id } });
    // Synthetic persisted retry history; the tested claim/finalization still
    // uses the real worker role, grants and transition guard.
    await owner.operationsSlackNotification.create({ data: {
      request_id: id, event_id: event.id, status: "RETRY", attempts: 4,
      next_attempt_at: new Date("2026-01-01T00:00:00Z"), last_code: "rate_limited",
    } });
    const claim = await claimOperationsSlackNotification();
    if (!claim) throw new Error("missing synthetic claim");
    expect(claim.attempts).toBe(5);
    expect(await finishOperationsSlackNotification(claim, { status: "retry", code: "rate_limited", retryAfterSeconds: 60 })).toBe(true);
    expect((await owner.operationsSlackNotification.findUniqueOrThrow({ where: { request_id: id } })))
      .toMatchObject({ status: "FAILED", attempts: 5, last_code: "retry_exhausted", claim_token: null });
    expect(await claimOperationsSlackNotification()).toBeNull();
  });

  it("expires stale sending claims to UNCERTAIN and rejects a late receipt from the old worker", async () => {
    const id = await createOperationsFeeRequest(identity, input(), randomUUID());
    const token = randomUUID();
    // Exercise the real PENDING -> SENDING trigger, with an already-old worker
    // timestamp. No clocks/sleeps or disabled database protections are needed.
    await owner.$executeRaw`
      UPDATE app.operations_slack_notification
      SET status = 'SENDING', attempts = 1, claim_token = ${token}::uuid,
          claimed_at = now() - interval '1 day'
      WHERE request_id = ${id}`;
    expect(await expireOperationsSlackClaims()).toBe(1);
    expect(await expireOperationsSlackClaims()).toBe(0);
    expect((await owner.operationsSlackNotification.findUniqueOrThrow({ where: { request_id: id } })))
      .toMatchObject({ status: "UNCERTAIN", attempts: 1, claim_token: null, claimed_at: null });
    expect(await claimOperationsSlackNotification()).toBeNull();
    expect(await finishOperationsSlackNotification({ requestId: id, kind: "FEE_CREDIT", claimToken: token, attempts: 1 }, {
      status: "sent", ts: "1700000000.123456", channel: OPERATIONS_SLACK_CHANNEL,
    })).toBe(false);
  });

  it("leaves captured requests unclaimed and makes no network call when delivery is disabled", async () => {
    const id = await createOperationsFeeRequest(identity, input(), randomUUID());
    await runOperationsSlackDelivery();
    expect((await owner.operationsSlackNotification.findUniqueOrThrow({ where: { request_id: id } })))
      .toMatchObject({ status: "PENDING", attempts: 0, claim_token: null, claimed_at: null });
  });

  it("reports intended activation with missing credentials as blocked without claiming work", async () => {
    const id = await createOperationsFeeRequest(identity, input(), randomUUID());
    vi.stubEnv("APP_ENV", "prod");
    vi.stubEnv("OPERATIONS_SLACK_DELIVERY_ENABLED", "true");
    vi.stubEnv("OPERATIONS_SLACK_BOT_TOKEN", "");
    expect(await runOperationsSlackDelivery()).toMatchObject({ blocked: true, configurationInvalid: true, skipped: false, processed: 0 });
    expect((await owner.operationsSlackNotification.findUniqueOrThrow({ where: { request_id: id } })))
      .toMatchObject({ status: "PENDING", attempts: 0, claim_token: null });
  });
});
