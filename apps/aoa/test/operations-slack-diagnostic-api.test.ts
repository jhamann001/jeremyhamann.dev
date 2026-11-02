import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, read } = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/data/operations-slack-diagnostic", () => ({ readOperationsSlackDiagnostic: read }));
import { GET } from "@/app/api/diagnostics/operations-slack/route";

const request = (query = "") => new Request(`https://ops-portal.example.test/api/diagnostics/operations-slack${query}`);
const validSession = () => ({ user: { role: "OPERATIONS", email: "ops@example.test" }, navigationScope: "synthetic-scope", expires: new Date(Date.now() + 60_000).toISOString() });
const empty = {
  counts: { PENDING: 0, SENDING: 0, RETRY: 0, SENT: 0, FAILED: 0, UNCERTAIN: 0 },
  needsReviewCount: 0, delayedRetryCount: 0,
  captureEnabled: true, deliveryEnabled: true, configurationValid: true, writesPaused: false,
  test: null,
};
const receipt = {
  requestId: "ops195-test-notification-20260926", requestStatus: "CANCELLED", notificationStatus: "SENT",
  attempts: 1, channelId: "C00OBJK6X0W", slackTs: "1790380800.123456", lastCode: null,
  capturedAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:01:00.000Z",
  submissionEventCount: 1, cancellationEventCount: 1,
};
const result = { ...empty, counts: { ...empty.counts, SENT: 1 }, test: receipt };

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue(validSession());
  read.mockResolvedValue(result);
});

describe("bounded Operations Slack diagnostic", () => {
  it.each(["ADMIN", "OPERATIONS"])("returns only counts and the fixed test receipt for %s with no caching", async (role) => {
    auth.mockResolvedValue({ ...validSession(), user: { role, email: "ops@example.test" } });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(read).toHaveBeenCalledWith({ role, email: "ops@example.test" });
  });

  it("preserves an empty queue and missing test without claiming delivery", async () => {
    read.mockResolvedValue(empty);
    expect(await (await GET(request())).json()).toEqual(empty);
  });

  it("denies a missing session before database access", async () => {
    auth.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["VIEWER", "ADVISOR", "CLIENT_SERVICE", "HEAD_OF_ADVISORY", "OPS", "UNKNOWN", undefined])("denies %s before database access", async (role) => {
    auth.mockResolvedValue({ ...validSession(), user: { role, email: "ops@example.test" } });
    expect((await GET(request())).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "", "  "])("requires a nonempty session identity: %s", async (email) => {
    auth.mockResolvedValue({ ...validSession(), user: { role: "ADMIN", email } });
    expect((await GET(request())).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([{ navigationScope: "" }, { expires: "bad" }, { expires: "2020-01-01T00:00:00Z" }])("rejects invalid session metadata %j", async (override) => {
    auth.mockResolvedValue({ ...validSession(), ...override });
    expect((await GET(request())).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["?role=ADMIN", "?status=SENT", "?requestId=ordinary-request", "?channel=C123", "?sql=SELECT+1"])("rejects selectors: %s", async (query) => {
    expect((await GET(request(query))).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects cross-site requests before authentication and reads", async () => {
    expect((await GET(new Request(request(), { headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(403);
    expect(auth).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["auth", "read"])("returns a generic unavailable response for %s failures", async (failure) => {
    (failure === "auth" ? auth : read).mockRejectedValue(new Error("Synthetic private source payload"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Operations Slack diagnostic unavailable" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it.each([
    { ...result, clientId: "synthetic-private-id" },
    { ...result, counts: { ...result.counts, PENDING: -1 } },
    { ...result, counts: { ...result.counts, UNKNOWN: 2 } },
    { ...result, needsReviewCount: 1 },
    { ...result, delayedRetryCount: 1 },
    { ...result, test: { ...receipt, requestId: "ordinary-request" } },
    { ...result, test: { ...receipt, requestStatus: "PENDING" } },
    { ...result, test: { ...receipt, notificationStatus: "SENT", slackTs: null } },
    { ...result, test: { ...receipt, notificationStatus: "PENDING" } },
    { ...result, test: { ...receipt, notificationStatus: null } },
    { ...result, test: { ...receipt, channelId: "C123" } },
    { ...result, test: { ...receipt, lastCode: "synthetic_private_error" } },
    { ...result, test: { ...receipt, claimToken: "synthetic-private-id" } },
    { ...result, test: { ...receipt, submissionEventCount: 2 } },
  ])("fails closed for malformed or excessive output %#", async (data) => {
    read.mockResolvedValue(data);
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("synthetic-private");
  });

  it("discards results when the session expires during the read", async () => {
    read.mockImplementation(async () => {
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
      return result;
    });
    try { expect((await GET(request())).status).toBe(503); }
    finally { vi.restoreAllMocks(); }
  });

  it("does not start a read for an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await GET(new Request(request(), { signal: controller.signal }))).status).toBe(503);
    expect(read).not.toHaveBeenCalled();
  });

  it("discards results if the request is aborted during a read", async () => {
    const controller = new AbortController();
    read.mockImplementation(async () => { controller.abort(); return result; });
    expect((await GET(new Request(request(), { signal: controller.signal }))).status).toBe(503);
  });
});
