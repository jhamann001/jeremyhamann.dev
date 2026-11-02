import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  buildOperationsSlackMessage,
  getOperationsSlackDeliveryConfig,
  operationsSlackCaptureEnabled,
  OPERATIONS_SLACK_CHANNEL,
  OPERATIONS_SLACK_ORIGIN,
  sendOperationsSlackNotification,
  type OperationsSlackDeliveryConfig,
  type OperationsSlackRequestKind,
} from "@/lib/slack/operations-fee-notifications";

const requestId = "cmdevsyntheticrequest0001";
const token = "xoxb-synthetic-unit-test-token-only";
const input = { kind: "FEE_CREDIT" as const, requestId };
const requestUrl = `https://aoa.jeremyhamann.dev/operations/fee-requests?request=${requestId}#request-${requestId}`;
const config = (): OperationsSlackDeliveryConfig => {
  const value = getOperationsSlackDeliveryConfig();
  if (!value) throw new Error("synthetic config missing");
  return value;
};
const jsonResponse = (value: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(value), { status, headers });
const sendResponse = (response: Response) => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  return sendOperationsSlackNotification(input, config(), fetchMock);
};

beforeEach(() => {
  vi.stubEnv("APP_ENV", "prod");
  vi.stubEnv("OPERATIONS_SLACK_CAPTURE_ENABLED", "true");
  vi.stubEnv("OPERATIONS_SLACK_DELIVERY_ENABLED", "true");
  vi.stubEnv("OPERATIONS_SLACK_BOT_TOKEN", token);
  // Every enabled test injects a mock; accidental external sends fail locally.
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Real network forbidden in this suite"); }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("disabled-first operations Slack configuration", () => {
  it.each([undefined, "false", "TRUE", "1", " true "])("capture fails closed for %s", (value) => {
    vi.stubEnv("OPERATIONS_SLACK_CAPTURE_ENABLED", value);
    expect(operationsSlackCaptureEnabled()).toBe(false);
    expect(getOperationsSlackDeliveryConfig()).toBeNull();
  });

  it.each([undefined, "test", "preview", "production", "DEV"])("rejects an unrecognized APP_ENV %s", (value) => {
    vi.stubEnv("APP_ENV", value);
    expect(operationsSlackCaptureEnabled()).toBe(false);
    expect(getOperationsSlackDeliveryConfig()).toBeNull();
  });

  it("permits explicit synthetic dev capture but never dev delivery", async () => {
    const previouslyEnabled = config();
    vi.stubEnv("APP_ENV", "dev");
    expect(operationsSlackCaptureEnabled()).toBe(true);
    expect(getOperationsSlackDeliveryConfig()).toBeNull();
    expect(await sendOperationsSlackNotification(input, previouslyEnabled)).toEqual({ status: "failed", code: "delivery_disabled" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, "false", "TRUE", "1"])("delivery stays disabled for %s", async (value) => {
    const previouslyEnabled = config();
    vi.stubEnv("OPERATIONS_SLACK_DELIVERY_ENABLED", value);
    expect(getOperationsSlackDeliveryConfig()).toBeNull();
    expect(await sendOperationsSlackNotification(input, previouslyEnabled)).toEqual({ status: "failed", code: "delivery_disabled" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "xoxb-short", " xoxb-synthetic-test-token", "xoxb-synthetic-test-token\n", "xoxp-synthetic-user-token", `xoxb-${"x".repeat(512)}`])("requires a bounded dedicated bot token (%s)", (value) => {
    vi.stubEnv("OPERATIONS_SLACK_BOT_TOKEN", value);
    vi.stubEnv("SLACK_BOT_TOKEN", token);
    expect(getOperationsSlackDeliveryConfig()).toBeNull();
  });

  it("uses only the approved channel and origin, ignoring generic/environment-controlled destinations", () => {
    vi.stubEnv("AUTH_URL", "https://attacker.example/");
    vi.stubEnv("OPERATIONS_SLACK_CHANNEL", "COTHERCHANNEL");
    vi.stubEnv("OPERATIONS_SLACK_ORIGIN", "https://attacker.example/");
    expect(config()).toEqual({ botToken: token, channel: "C00OBJK6X0W", origin: "https://aoa.jeremyhamann.dev" });
    expect(Object.isFrozen(config())).toBe(true);
  });

  it("refuses null and stale tokens without a request", async () => {
    const stale = config();
    vi.stubEnv("OPERATIONS_SLACK_BOT_TOKEN", "xoxb-synthetic-replacement-token");
    expect(await sendOperationsSlackNotification(input, null)).toEqual({ status: "failed", code: "delivery_disabled" });
    expect(await sendOperationsSlackNotification(input, stale)).toEqual({ status: "failed", code: "delivery_disabled" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { channel: "CATTACKER" },
    { origin: "https://aoa.jeremyhamann.dev.attacker.example" },
  ])("rejects a forged delivery config %j", async (override) => {
    const forged = { ...config(), ...override } as OperationsSlackDeliveryConfig;
    expect(await sendOperationsSlackNotification(input, forged)).toEqual({ status: "failed", code: "delivery_disabled" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("exact approved messages", () => {
  it.each([
    ["FEE_CREDIT", "fee credit"],
    ["SERVICE_GUARANTEE", "service guarantee"],
    ["BILLING_EXCEPTION", "billing exception"],
    ["LARGE_HOUSEHOLD_EXCEPTION", "$10M+ household billing exception"],
  ] as const)("renders %s verbatim", (kind, label) => {
    expect(buildOperationsSlackMessage(kind, requestId)).toBe(`New ${label} request — pending review.\nRequest ID: ${requestId}\nReview in AOA: ${requestUrl}`);
  });

  it.each(["", "short", "x".repeat(65), `${requestId}\n`, `${requestId}/path`, `${requestId}?next=x`, `${requestId}#x`, "<!channel>requestId", "client@example.com", "<@U123456789012345>"])("rejects an unsafe opaque ID %j", (id) => {
    expect(() => buildOperationsSlackMessage("FEE_CREDIT", id)).toThrow("invalid_operations_slack_request");
  });

  it("accepts bounded opaque IDs including underscores and hyphens", () => {
    expect(buildOperationsSlackMessage("FEE_CREDIT", "abcdefghijklmn_-")).toContain("Request ID: abcdefghijklmn_-");
    expect(buildOperationsSlackMessage("FEE_CREDIT", "x".repeat(64))).toContain(`Request ID: ${"x".repeat(64)}`);
  });

  it.each(["UNKNOWN", "toString", "__proto__", "<!channel>"])("never interpolates unknown categories %s", (kind) => {
    expect(() => buildOperationsSlackMessage(kind as OperationsSlackRequestKind, requestId)).toThrow("invalid_operations_slack_request");
  });

  it("invalid inputs produce a static failure without calling Slack", async () => {
    expect(await sendOperationsSlackNotification({ ...input, requestId: "invalid" }, config())).toEqual({ status: "failed", code: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("bounded Slack transport", () => {
  it("posts only the approved fields to the fixed HTTPS endpoint and accepts a complete receipt", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true, ts: "1789414000.123456", channel: OPERATIONS_SLACK_CHANNEL }));
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    expect(await sendOperationsSlackNotification(input, config(), fetchMock)).toEqual({ status: "sent", ts: "1789414000.123456", channel: "C00OBJK6X0W" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(options).toMatchObject({ method: "POST", redirect: "error", headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` } });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
    expect(JSON.parse(options?.body as string)).toEqual({
      channel: "C00OBJK6X0W",
      text: buildOperationsSlackMessage("FEE_CREDIT", requestId),
      mrkdwn: false,
      link_names: false,
      unfurl_links: false,
      unfurl_media: false,
      unfurl_app_links: false,
    });
    // Omitting parse preserves the approved clickable URL; parse:none removes
    // links according to Slack's API documentation. No free text is accepted.
    expect(JSON.parse(options?.body as string)).not.toHaveProperty("parse");
    expect(JSON.stringify(options?.body)).not.toContain(token);
  });

  it.each([["120", 120], ["0", 1], ["86400", 86400], [null, 60], ["-10", 60], ["1.5", 60], ["tomorrow", 60]] as const)("honors bounded Retry-After %s", async (header, seconds) => {
    const headers = header === null ? undefined : { "Retry-After": header };
    expect(await sendResponse(new Response("rate limited", { status: 429, headers }))).toEqual({ status: "retry", retryAfterSeconds: seconds, code: "rate_limited" });
  });

  it.each(["86401", "99999999999999999999999999999"])("stops for an excessive Retry-After instead of retrying early (%s)", async (value) => {
    expect(await sendResponse(new Response(null, { status: 429, headers: { "Retry-After": value } }))).toEqual({ status: "failed", code: "retry_after_exceeds_limit" });
  });

  it.each(["rate_limited", "ratelimited"])("only retries explicit Slack rate-limit rejection %s", async (error) => {
    expect(await sendResponse(jsonResponse({ ok: false, error }, 200, { "Retry-After": "37" }))).toEqual({ status: "retry", retryAfterSeconds: 37, code: "rate_limited" });
  });

  it.each(["invalid_auth", "not_in_channel", "missing_scope", "token_revoked", "is_archived", "channel_not_found", "restricted_action", "request_timeout"])("retains a known safe terminal code %s", async (error) => {
    expect(await sendResponse(jsonResponse({ ok: false, error }))).toEqual({ status: "failed", code: error });
  });

  it.each(["internal_error", "fatal_error", "service_unavailable", "unknown_error", `secret-${token}`])("does not automatically replay potentially partial Slack failure %s", async (error) => {
    expect(await sendResponse(jsonResponse({ ok: false, error }))).toEqual({ status: "uncertain", code: "slack_ambiguous" });
  });

  it.each([500, 502, 503, 504, 408, 301, 302])("treats HTTP %s as ambiguous without trusting a claimed body success", async (status) => {
    expect(await sendResponse(jsonResponse({ ok: true, channel: OPERATIONS_SLACK_CHANNEL, ts: "1789414000.123456" }, status))).toEqual({ status: "uncertain", code: "http_ambiguous" });
  });

  it.each([400, 401, 403, 404])("treats HTTP %s rejection as terminal without persisting its body", async (status) => {
    expect(await sendResponse(new Response(token, { status }))).toEqual({ status: "failed", code: "http_rejected" });
  });

  it.each([
    { ok: true, channel: "COTHERCHANNEL", ts: "1789414000.123456" },
    { ok: true, channel: OPERATIONS_SLACK_CHANNEL },
    { ok: true, channel: OPERATIONS_SLACK_CHANNEL, ts: "1789414000.123456\n" },
    { ok: true, channel: OPERATIONS_SLACK_CHANNEL, ts: 1789414000.123456 },
    { ok: true, channel: OPERATIONS_SLACK_CHANNEL, ts: token },
  ])("requires the approved channel and a valid timestamp receipt (%j)", async (value) => {
    expect(await sendResponse(jsonResponse(value))).toEqual({ status: "uncertain", code: "invalid_receipt" });
  });

  it.each([null, [], {}, { ok: "true" }, { ok: false }, { ok: false, error: { token } }])("rejects malformed JSON structures (%j)", async (value) => {
    expect(await sendResponse(jsonResponse(value))).toEqual({ status: "uncertain", code: "invalid_response" });
  });

  it.each(["not-json", "", "x".repeat(16_385)])("does not replay malformed or oversized response bodies (case %#)", async (body) => {
    expect(await sendResponse(new Response(body))).toEqual({ status: "uncertain", code: "transport_or_response_ambiguous" });
  });

  it.each([new DOMException("Timed out", "TimeoutError"), new TypeError("fetch failed"), new Error(`sensitive-${token}`)])("sanitizes transport failures without retry or logging (case %#)", async (error) => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(error);
    const errorLog = vi.spyOn(console, "error");
    const warnLog = vi.spyOn(console, "warn");
    const infoLog = vi.spyOn(console, "log");
    expect(await sendOperationsSlackNotification(input, config(), fetchMock)).toEqual({ status: "uncertain", code: "transport_or_response_ambiguous" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errorLog).not.toHaveBeenCalled();
    expect(warnLog).not.toHaveBeenCalled();
    expect(infoLog).not.toHaveBeenCalled();
  });

  it("matches the trusted deployed AOA origin", () => {
    expect(new URL(requestUrl).origin).toBe(OPERATIONS_SLACK_ORIGIN);
  });
});
