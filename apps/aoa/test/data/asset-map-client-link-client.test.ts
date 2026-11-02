import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requestMock, getIdTokenClientMock, GoogleAuthMock } = vi.hoisted(() => {
  const requestMock = vi.fn();
  const getIdTokenClientMock = vi.fn(async () => ({ request: requestMock }));
  const GoogleAuthMock = vi.fn(function () {
    return { getIdTokenClient: getIdTokenClientMock };
  });
  return { requestMock, getIdTokenClientMock, GoogleAuthMock };
});
vi.mock("google-auth-library", () => ({ GoogleAuth: GoogleAuthMock }));

import {
  classifyClientLinkFailure,
  clientLinkIdempotencyKey,
  sendAssetMapClientLink,
  type ClientLinkRequest,
} from "@/lib/data/asset-map";
import type { ClientLinkDraft } from "@/lib/data/asset-map-client-link-contract";

const BASE = "https://pipeline.example.test";
const RUN = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const PREVIEW = "33333333-3333-4333-8333-333333333333";
const DRAFT: ClientLinkDraft = {
  action: "confirm", run_id: RUN, target_scope: "this_run", expected_identity_version: 0,
  people_ids: ["synthetic-person-1"], coverage: "complete", primary_user_id: "synthetic-person-1",
};

function errorBody(code: string, message = "Synthetic message.") {
  return { detail: { code, message, details: {} } };
}

beforeEach(() => {
  requestMock.mockReset();
  requestMock.mockResolvedValue({ status: 200, data: {} });
  getIdTokenClientMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendAssetMapClientLink", () => {
  it("routes each request to its pipeline path and method", async () => {
    const cases: [ClientLinkRequest, string, string][] = [
      [{ kind: "config" }, "GET", "/api/config"],
      [{ kind: "queue", q: "", reviewState: null, cursor: null, limit: 50 }, "GET", "/api/client-links"],
      [{ kind: "run", runId: RUN }, "GET", `/api/households/${RUN}/client-link`],
      [{ kind: "search", q: "synthetic" }, "GET", "/api/client-directory/search"],
      [{ kind: "preview", draft: DRAFT }, "POST", "/api/client-links/preview"],
      [{ kind: "apply", previewId: PREVIEW, payloadHash: "h", idempotencyKey: "aoa-key-0001" }, "POST", "/api/client-links/apply"],
      [{ kind: "retry", runId: RUN }, "POST", `/api/households/${RUN}/client-link/retry`],
      [{ kind: "batch", batchId: BATCH }, "GET", `/api/client-links/batches/${BATCH}`],
      [{ kind: "revertPreview", batchId: BATCH }, "POST", `/api/client-links/batches/${BATCH}/revert-preview`],
    ];
    for (const [req, method, path] of cases) {
      requestMock.mockClear();
      await sendAssetMapClientLink(BASE, req);
      const arg = requestMock.mock.calls[0][0];
      expect([arg.method, arg.url]).toEqual([method, `${BASE}${path}`]);
    }
  });

  it("encodes run and batch ids in the path", async () => {
    await sendAssetMapClientLink(BASE, { kind: "run", runId: "a/b c" });
    expect(requestMock.mock.calls[0][0].url).toBe(`${BASE}/api/households/a%2Fb%20c/client-link`);
    await sendAssetMapClientLink(BASE, { kind: "batch", batchId: "x?y" });
    expect(requestMock.mock.calls[1][0].url).toBe(`${BASE}/api/client-links/batches/x%3Fy`);
  });

  it("sends the queue filters, cursor, and limit as query parameters", async () => {
    await sendAssetMapClientLink(BASE, { kind: "queue", q: "synthetic", reviewState: "partial", cursor: "c-1", limit: 25 });
    expect(requestMock.mock.calls[0][0].params).toEqual({ q: "synthetic", review_state: "partial", cursor: "c-1", limit: "25" });
    await sendAssetMapClientLink(BASE, { kind: "queue", q: "", reviewState: null, cursor: null, limit: 50 });
    expect(requestMock.mock.calls[1][0].params).toEqual({ q: "", limit: "50" });
  });

  it("sends the draft body unchanged for preview", async () => {
    await sendAssetMapClientLink(BASE, { kind: "preview", draft: DRAFT });
    expect(requestMock.mock.calls[0][0].data).toEqual(DRAFT);
  });

  it("sends acknowledged and the derived idempotency key for apply", async () => {
    const key = clientLinkIdempotencyKey(PREVIEW, "synthetic-hash");
    await sendAssetMapClientLink(BASE, { kind: "apply", previewId: PREVIEW, payloadHash: "synthetic-hash", idempotencyKey: key });
    expect(requestMock.mock.calls[0][0].data).toEqual({
      preview_id: PREVIEW, payload_hash: "synthetic-hash", idempotency_key: key, acknowledged: true,
    });
  });

  it("derives the same idempotency key for the same preview and hash", () => {
    const key = clientLinkIdempotencyKey(PREVIEW, "synthetic-hash");
    expect(clientLinkIdempotencyKey(PREVIEW, "synthetic-hash")).toBe(key);
    expect(clientLinkIdempotencyKey(PREVIEW, "other-hash")).not.toBe(key);
    expect(key).toHaveLength(68);
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(key.length).toBeLessThanOrEqual(128);
  });

  it("uses the pipeline base URL as the token audience", async () => {
    await sendAssetMapClientLink(BASE, { kind: "config" });
    expect(getIdTokenClientMock).toHaveBeenCalledWith(BASE);
    expect(requestMock.mock.calls[0][0].timeout).toBe(15000);
  });

  it("maps feature_disabled to disabled and writes_disabled to writes_disabled", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    requestMock.mockResolvedValueOnce({ status: 404, data: errorBody("feature_disabled", "Client linking is disabled.") });
    await expect(sendAssetMapClientLink(BASE, { kind: "config" }))
      .resolves.toEqual({ ok: false, reason: "disabled", message: "Client linking is disabled." });
    requestMock.mockResolvedValueOnce({ status: 503, data: errorBody("writes_disabled", "Client linking changes are disabled.") });
    await expect(sendAssetMapClientLink(BASE, { kind: "preview", draft: DRAFT }))
      .resolves.toEqual({ ok: false, reason: "writes_disabled", message: "Client linking changes are disabled." });
  });

  it("maps preview_expired, preview_stale, and idempotency_conflict to stale", () => {
    expect(classifyClientLinkFailure(410, errorBody("preview_expired")).reason).toBe("stale");
    expect(classifyClientLinkFailure(409, errorBody("preview_stale")).reason).toBe("stale");
    expect(classifyClientLinkFailure(409, errorBody("idempotency_conflict")).reason).toBe("stale");
  });

  it("maps other 4xx to rejected with the service message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    requestMock.mockResolvedValueOnce({ status: 400, data: errorBody("batch_too_large", "Too many folders.") });
    await expect(sendAssetMapClientLink(BASE, { kind: "preview", draft: DRAFT }))
      .resolves.toEqual({ ok: false, reason: "rejected", message: "Too many folders." });
    expect(classifyClientLinkFailure(403, { detail: "Operations role required" }))
      .toEqual({ reason: "rejected", message: "Operations role required" });
  });

  it("maps 5xx, timeout, and transport failure to unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    requestMock.mockResolvedValueOnce({ status: 502, data: "<html>" });
    await expect(sendAssetMapClientLink(BASE, { kind: "config" })).resolves.toEqual({ ok: false, reason: "unavailable", message: null });
    requestMock.mockRejectedValueOnce(Object.assign(new Error("timeout of 15000ms exceeded"), { code: "ECONNABORTED" }));
    await expect(sendAssetMapClientLink(BASE, { kind: "config" })).resolves.toEqual({ ok: false, reason: "unavailable", message: null });
    requestMock.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(sendAssetMapClientLink(BASE, { kind: "config" })).resolves.toEqual({ ok: false, reason: "unavailable", message: null });
  });

  it("logs only static markers", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    requestMock.mockResolvedValueOnce({ status: 409, data: errorBody("preview_stale", "Synthetic Client A stale") });
    await sendAssetMapClientLink(BASE, { kind: "search", q: "Synthetic Client A" });
    requestMock.mockRejectedValueOnce(new Error(`${BASE} Bearer synthetic-token`));
    await sendAssetMapClientLink(BASE, { kind: "run", runId: RUN });
    expect(spy).toHaveBeenCalledTimes(2);
    for (const args of spy.mock.calls) {
      expect(args).toHaveLength(1);
      expect(args[0]).toMatch(/^\[asset-map\] client_link_(status=\d+|transport_failed) kind=\w+$/);
    }
  });
});
