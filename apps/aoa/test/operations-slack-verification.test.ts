import { afterEach, describe, expect, it, vi } from "vitest";
const scope = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: scope }));
import { createOperationsSlackVerification } from "@/lib/data/operations-slack-verification";
import {
  assertOperationsSlackVerificationRecord,
  OPERATIONS_SLACK_VERIFICATION_REQUEST_ID as ID,
  OPERATIONS_SLACK_VERIFICATION_CLIENT_ID as CLIENT,
  OPERATIONS_SLACK_VERIFICATION_ACCOUNT_ID as ACCOUNT,
  OPERATIONS_SLACK_VERIFICATION_SUBMISSION_KEY as KEY,
  OPERATIONS_SLACK_VERIFICATION_DIGEST as DIGEST,
  OPERATIONS_SLACK_VERIFICATION_REASON as REASON,
  type OperationsSlackVerificationRecord,
} from "@/lib/operations/operations-slack-verification";

function record(): OperationsSlackVerificationRecord {
  const at = new Date("2026-09-26T12:00:00Z");
  return {
    id: ID, kind: "SERVICE_GUARANTEE", status: "CANCELLED", scope: "CLIENT", client_sf_id: CLIENT,
    account_ids: [ACCOUNT], fee_types: [], fee_amount: null, waiver_start: new Date("2026-09-01T00:00:00Z"),
    waiver_duration_months: 1, indefinite_duration: false, reason: REASON, relevant_ticket_refs: [],
    submitted_by_email: "synthetic@example.test", submitted_by_role: "ADMIN", submitted_by_name: null,
    submitted_at: at, reviewed_by_email: "synthetic@example.test", reviewed_by_name: null, reviewed_at: at,
    credited_at: null, apex_request_id: null, legacy_apex_request_text: null,
    completed_by_email: null, completed_by_name: null, completed_at: null,
    legacy_source: null, legacy_source_id: null, legacy_source_digest: null,
    legacy_household_sf_id: null, legacy_client_name: null,
    submission_key: KEY, submission_digest: DIGEST, created_at: at, updated_at: at,
    events: [
      { id: 1n, request_id: ID, action: "SUBMITTED", actor_email: "synthetic@example.test", actor_name: null,
        actor_role: "ADMIN", from_status: null, to_status: "PENDING", detail: { verification: "ticket" }, at },
      { id: 2n, request_id: ID, action: "CANCELLED", actor_email: "synthetic@example.test", actor_name: null,
        actor_role: "ADMIN", from_status: "PENDING", to_status: "CANCELLED", detail: { verification: "ticket" }, at },
    ],
    slack_notification: { request_id: ID, event_id: 1n, channel_id: "C00OBJK6X0W", status: "PENDING", attempts: 0,
      next_attempt_at: at, claim_token: null, claimed_at: null, last_code: null, slack_ts: null,
      acknowledged_at: null, acknowledged_by_email: null, created_at: at, updated_at: at },
  };
}

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("fixed Operations Slack verification identity", () => {
  it("accepts the fully cancelled captured canary and its eventual saved receipt", () => {
    const fixture = record();
    expect(() => assertOperationsSlackVerificationRecord(fixture)).not.toThrow();
    Object.assign(fixture.slack_notification!, { status: "SENT", attempts: 1, slack_ts: "1790424000.000001" });
    expect(() => assertOperationsSlackVerificationRecord(fixture)).not.toThrow();
  });

  it.each([
    ["similar ID", (value: OperationsSlackVerificationRecord) => { value.id += "-other"; }],
    ["ordinary client", (value: OperationsSlackVerificationRecord) => { value.client_sf_id = "003REAL000000001AAA"; }],
    ["ordinary account", (value: OperationsSlackVerificationRecord) => { value.account_ids = ["another-account"]; }],
    ["actionable request", (value: OperationsSlackVerificationRecord) => { value.status = "PENDING"; }],
    ["changed content", (value: OperationsSlackVerificationRecord) => { value.reason += " extra"; }],
    ["changed digest", (value: OperationsSlackVerificationRecord) => { value.submission_digest = "a".repeat(64); }],
    ["missing cancellation", (value: OperationsSlackVerificationRecord) => { value.events.pop(); }],
    ["wrong event identity", (value: OperationsSlackVerificationRecord) => { value.slack_notification!.event_id = 2n; }],
    ["extra event data", (value: OperationsSlackVerificationRecord) => { value.events[0].detail = { verification: "ticket", text: "unapproved" }; }],
    ["missing outbox", (value: OperationsSlackVerificationRecord) => { value.slack_notification = null; }],
    ["wrong destination", (value: OperationsSlackVerificationRecord) => { value.slack_notification!.channel_id = "COTHER"; }],
    ["invalid receipt", (value: OperationsSlackVerificationRecord) => { value.slack_notification!.status = "SENT"; }],
  ])("rejects %s instead of classifying it from a prefix", (_name, change) => {
    const fixture = record();
    change(fixture);
    expect(() => assertOperationsSlackVerificationRecord(fixture)).toThrow("operations_slack_verification_conflict");
  });
});

describe("verification creation entry gates", () => {
  it.each(["ADVISOR", "VIEWER", "", "admin"])("refuses %s before a database read", async (role) => {
    await expect(createOperationsSlackVerification({ role, email: "synthetic@example.test" }))
      .rejects.toThrow("operations_slack_verification_forbidden");
    expect(scope).not.toHaveBeenCalled();
  });
  it("requires a nonempty actor", async () => {
    await expect(createOperationsSlackVerification({ role: "ADMIN", email: " " }))
      .rejects.toThrow("operations_slack_verification_forbidden");
    expect(scope).not.toHaveBeenCalled();
  });
  it.each([
    { APP_ENV: "prod", OPERATIONS_SLACK_CAPTURE_ENABLED: "false" },
    { APP_ENV: "unknown", OPERATIONS_SLACK_CAPTURE_ENABLED: "true" },
    { APP_ENV: "dev", OPERATIONS_SLACK_CAPTURE_ENABLED: "true", AOA_WRITES_PAUSED: "true" },
    { APP_ENV: "prod", OPERATIONS_SLACK_CAPTURE_ENABLED: "true", OPERATIONS_SLACK_DELIVERY_ENABLED: "false" },
    { APP_ENV: "prod", OPERATIONS_SLACK_CAPTURE_ENABLED: "true", OPERATIONS_SLACK_DELIVERY_ENABLED: "true", OPERATIONS_SLACK_BOT_TOKEN: "" },
  ])("refuses disabled or invalid configuration before DB: %j", async (environment) => {
    vi.stubEnv("AOA_WRITES_PAUSED", "false");
    for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
    await expect(createOperationsSlackVerification({ role: "ADMIN", email: "synthetic@example.test" }))
      .rejects.toThrow("operations_slack_verification_disabled");
    expect(scope).not.toHaveBeenCalled();
  });
});
