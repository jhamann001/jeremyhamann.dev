import { beforeEach, describe, expect, it, vi } from "vitest";

const { scope, execute, query, findUnique, classify, captureEnabled, config, writesPaused } = vi.hoisted(() => ({
  scope: vi.fn(), execute: vi.fn(), query: vi.fn(), findUnique: vi.fn(), classify: vi.fn(),
  captureEnabled: vi.fn(), config: vi.fn(), writesPaused: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: scope }));
vi.mock("@/lib/maintenance", () => ({ appWritesPaused: writesPaused }));
vi.mock("@/lib/slack/operations-fee-notifications", () => ({
  operationsSlackCaptureEnabled: captureEnabled, getOperationsSlackDeliveryConfig: config,
}));
vi.mock("@/lib/operations/operations-slack-verification", () => ({
  OPERATIONS_SLACK_VERIFICATION_REQUEST_ID: "ops195-test-notification-20260926",
  assertOperationsSlackVerificationRecord: classify,
}));
import { readOperationsSlackDiagnostic } from "@/lib/data/operations-slack-diagnostic";

const identity = { role: "OPERATIONS", email: "ops@example.test" };
const emptyCounts = { total: 0, PENDING: 0, SENDING: 0, RETRY: 0, SENT: 0, FAILED: 0, UNCERTAIN: 0, needsReviewCount: 0, delayedRetryCount: 0 };
function fixedRecord() {
  return {
    id: "ops195-test-notification-20260926", status: "CANCELLED",
    client_sf_id: "DEV-SYNTHETIC-PRIVATE", account_ids: ["SYNTHETIC-PRIVATE-ACCOUNT"],
    submitted_by_email: "synthetic-private@example.test",
    events: [{ action: "SUBMITTED" }, { action: "CANCELLED" }],
    slack_notification: {
      request_id: "ops195-test-notification-20260926", status: "SENT", attempts: 1, channel_id: "C00OBJK6X0W",
      slack_ts: "1790380800.123456", last_code: null as string | null,
      claim_token: "SYNTHETIC-PRIVATE-CLAIM", acknowledged_by_email: "synthetic-private@example.test",
      created_at: new Date("2026-09-26T00:00:00.000Z"), updated_at: new Date("2026-09-26T00:01:00.000Z"),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("OPERATIONS_SLACK_DELIVERY_ENABLED", "true");
  query.mockResolvedValue([emptyCounts]);
  findUnique.mockResolvedValue(null);
  captureEnabled.mockReturnValue(true);
  config.mockReturnValue({ botToken: "synthetic-private-token" });
  writesPaused.mockReturnValue(false);
  classify.mockImplementation(() => undefined);
  scope.mockImplementation(async (_identity, fn) => fn({ $executeRaw: execute, $queryRaw: query, operationsFeeRequest: { findUnique } }));
});

describe("Operations Slack diagnostic bounded reader", () => {
  it("uses caller RLS, one repeatable snapshot, bounded timeouts and only a fixed request lookup", async () => {
    const result = await readOperationsSlackDiagnostic(identity);
    expect(result).toEqual({
      counts: { PENDING: 0, SENDING: 0, RETRY: 0, SENT: 0, FAILED: 0, UNCERTAIN: 0 },
      needsReviewCount: 0, delayedRetryCount: 0, captureEnabled: true, deliveryEnabled: true,
      configurationValid: true, writesPaused: false, test: null,
    });
    expect(scope).toHaveBeenCalledWith(identity, expect.any(Function), { maxWait: 2000, timeout: 8000, isolationLevel: "RepeatableRead" });
    expect(execute).toHaveBeenCalledTimes(1);
    const settings = execute.mock.calls[0][0].join("");
    expect(settings).toContain("set_config('statement_timeout', '5000', true)");
    expect(settings).toContain("set_config('lock_timeout', '1000', true)");
    expect(settings).not.toMatch(/\b(insert|update|delete)\b/i);
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0].join("");
    expect(sql).toContain("count(*)");
    expect(sql).not.toMatch(/\b(request_id|event_id|claim_token|email|client_sf_id|account_ids)\b/);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "ops195-test-notification-20260926" }, include: { events: { take: 3, orderBy: { id: "asc" } }, slack_notification: true },
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it.each([
    { role: "VIEWER", email: identity.email }, { role: "ADVISOR", email: identity.email },
    { role: "CLIENT_SERVICE", email: identity.email }, { role: "HEAD_OF_ADVISORY", email: identity.email },
    { role: "OPS", email: identity.email }, { role: null, email: identity.email },
    { role: "ADMIN", email: "" }, { role: "OPERATIONS", email: "  " }, { role: "OPERATIONS", email: null },
  ])("rejects unauthorized identity $role/$email before database access", async (actor) => {
    await expect(readOperationsSlackDiagnostic(actor)).rejects.toThrow("forbidden");
    expect(scope).not.toHaveBeenCalled();
  });

  it("validates the fixed synthetic record then returns only its allowed receipt", async () => {
    const record = fixedRecord();
    query.mockResolvedValue([{ ...emptyCounts, total: 1, SENT: 1 }]);
    findUnique.mockResolvedValue(record);
    const result = await readOperationsSlackDiagnostic(identity);
    expect(classify).toHaveBeenCalledWith(record);
    expect(result.test).toEqual({
      requestId: "ops195-test-notification-20260926", requestStatus: "CANCELLED", notificationStatus: "SENT",
      attempts: 1, channelId: "C00OBJK6X0W", slackTs: "1790380800.123456", lastCode: null,
      capturedAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:01:00.000Z",
      submissionEventCount: 1, cancellationEventCount: 1,
    });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private|claim_token|client_sf_id|account_ids|botToken|email/);
  });

  it("retains queue blockers as counts without ordinary request IDs", async () => {
    query.mockResolvedValue([{ total: 10, PENDING: 1, SENDING: 1, RETRY: 2, SENT: 2, FAILED: 2, UNCERTAIN: 2, needsReviewCount: 3, delayedRetryCount: 1 }]);
    const result = await readOperationsSlackDiagnostic(identity);
    expect(result.counts).toEqual({ PENDING: 1, SENDING: 1, RETRY: 2, SENT: 2, FAILED: 2, UNCERTAIN: 2 });
    expect(result.needsReviewCount).toBe(3);
    expect(result.delayedRetryCount).toBe(1);
    expect(result.test).toBeNull();
  });

  it("reads gates on each request without returning credential material", async () => {
    captureEnabled.mockReturnValue(false);
    vi.stubEnv("OPERATIONS_SLACK_DELIVERY_ENABLED", "false");
    config.mockReturnValue(null);
    writesPaused.mockReturnValue(true);
    const result = await readOperationsSlackDiagnostic(identity);
    expect(result).toMatchObject({ captureEnabled: false, deliveryEnabled: false, configurationValid: false, writesPaused: true });
  });

  it("redacts an unknown persisted last_code rather than returning its content", async () => {
    const record = fixedRecord();
    Object.assign(record.slack_notification, { status: "UNCERTAIN", slack_ts: null, last_code: "synthetic_private_payload" });
    query.mockResolvedValue([{ ...emptyCounts, total: 1, UNCERTAIN: 1, needsReviewCount: 1 }]);
    findUnique.mockResolvedValue(record);
    const result = await readOperationsSlackDiagnostic(identity);
    expect(result.test?.lastCode).toBe("unrecognized_code");
    expect(JSON.stringify(result)).not.toContain("synthetic_private_payload");
  });

  it("does not turn a reserved-record collision into an empty result", async () => {
    findUnique.mockResolvedValue(fixedRecord());
    classify.mockImplementation(() => { throw new Error("operations_slack_verification_conflict"); });
    await expect(readOperationsSlackDiagnostic(identity)).rejects.toThrow("operations_slack_verification_conflict");
  });

  it("does not turn a missing notification for an existing test into success", async () => {
    findUnique.mockResolvedValue({ ...fixedRecord(), slack_notification: null });
    await expect(readOperationsSlackDiagnostic(identity)).rejects.toThrow("unavailable");
  });

  it.each([[], [emptyCounts, emptyCounts], [{ ...emptyCounts, total: 1 }], [{ ...emptyCounts, total: -1, PENDING: -1 }]].map((rows) => ({ rows })))("rejects incomplete or inconsistent aggregate output %#", async ({ rows }) => {
    query.mockResolvedValue(rows);
    await expect(readOperationsSlackDiagnostic(identity)).rejects.toThrow();
  });

  it("does not turn database or timeout failure into zero counts", async () => {
    query.mockRejectedValue(new Error("statement timeout"));
    await expect(readOperationsSlackDiagnostic(identity)).rejects.toThrow("statement timeout");
    expect(findUnique).not.toHaveBeenCalled();
  });
});
