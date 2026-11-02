import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sourceFixture from "./fixtures/transfer-linkage-v1.json";
vi.mock("server-only", () => ({}));

// Keyless OIDC layer stub: no real token is minted and no network is reached.
const { getRequestHeaders, getIdTokenClient, GoogleAuthMock } = vi.hoisted(() => {
  const getRequestHeaders = vi.fn(async () => ({ Authorization: "Bearer synthetic-token" }));
  const getIdTokenClient = vi.fn(async () => ({ getRequestHeaders }));
  const GoogleAuthMock = vi.fn(function () { return { getIdTokenClient }; });
  return { getRequestHeaders, getIdTokenClient, GoogleAuthMock };
});
vi.mock("google-auth-library", () => ({ GoogleAuth: GoogleAuthMock }));
import { fetchTransferLinkageSnapshot } from "@/lib/data/acat-match-source";

const fetchMock = vi.fn();
const reason = (code: string, why: string, httpStatus?: number) =>
  expect.objectContaining({ name: "LinkageError", code, reason: why, httpStatus, message: code });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TRANSFER_LINKAGE_URL", "https://synthetic.example.invalid");
  vi.stubEnv("TRANSFER_LINKAGE_INSTALLATION_ID", sourceFixture.source.installationId);
  vi.stubEnv("TRANSFER_LINKAGE_ENVIRONMENT", "synthetic");
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("linkage snapshot fetch failure reasons (ticket)", () => {
  it("returns the validated snapshot from a healthy source", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T12:00:01.000Z"));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(sourceFixture), { status: 200 }));
    expect(await fetchTransferLinkageSnapshot()).toEqual(sourceFixture);
    expect(fetchMock).toHaveBeenCalledWith("https://synthetic.example.invalid/api/machine/transfer-linkage",
      expect.objectContaining({ redirect: "error", cache: "no-store" }));
  });

  it("separates a slow token mint from a failed one", async () => {
    getIdTokenClient.mockRejectedValueOnce(new Error("synthetic credential failure"));
    await expect(fetchTransferLinkageSnapshot()).rejects.toEqual(reason("SOURCE_UNAVAILABLE", "auth_failed"));
    vi.useFakeTimers();
    getRequestHeaders.mockImplementationOnce(() => new Promise(() => {}));
    const pending = expect(fetchTransferLinkageSnapshot()).rejects.toEqual(reason("SOURCE_UNAVAILABLE", "auth_timeout"));
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("separates a request timeout from a transport failure", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    await expect(fetchTransferLinkageSnapshot()).rejects.toEqual(reason("SOURCE_UNAVAILABLE", "request_timeout"));
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(fetchTransferLinkageSnapshot()).rejects.toEqual(reason("SOURCE_UNAVAILABLE", "request_failed"));
  });

  it("classifies a body-read timeout as a request timeout", async () => {
    const body = new ReadableStream({ pull(controller) {
      controller.error(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    } });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));
    await expect(fetchTransferLinkageSnapshot()).rejects.toEqual(reason("SOURCE_UNAVAILABLE", "request_timeout"));
  });

  it("records the source's HTTP status, including the cold-start 503 and 504", async () => {
    for (const status of [503, 504, 403]) {
      fetchMock.mockResolvedValueOnce(new Response("synthetic upstream text", { status }));
      await expect(fetchTransferLinkageSnapshot()).rejects.toEqual(reason("SOURCE_UNAVAILABLE", "http_status", status));
    }
  });

  it("classifies unreadable bodies and invalid snapshots", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 200 }));
    await expect(fetchTransferLinkageSnapshot()).rejects.toEqual(reason("SOURCE_UNAVAILABLE", "invalid_body"));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 1 }), { status: 200 }));
    await expect(fetchTransferLinkageSnapshot()).rejects.toEqual(reason("SOURCE_UNAVAILABLE", "invalid_snapshot"));
  });
});
