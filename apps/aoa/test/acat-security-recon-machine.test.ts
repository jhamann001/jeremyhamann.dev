import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data/acat-workspace", () => ({ markAcatBookStale: vi.fn() }));

const { requestMock, getIdTokenClientMock, GoogleAuthMock } = vi.hoisted(() => {
  const requestMock = vi.fn();
  const getIdTokenClientMock = vi.fn(async () => ({ request: requestMock }));
  const GoogleAuthMock = vi.fn(function () {
    return { getIdTokenClient: getIdTokenClientMock };
  });
  return { requestMock, getIdTokenClientMock, GoogleAuthMock };
});
vi.mock("google-auth-library", () => ({ GoogleAuth: GoogleAuthMock }));

import { callReconMachine } from "@/lib/data/acat-security-recon-server";

const SUITE = "acat-security-recon-machine";
const BASE = "https://transfers.jeremyhamann.dev";
const PATH = "/api/machine/acats/by-record/rec-1/security-recon";

beforeEach(() => {
  requestMock.mockReset();
  getIdTokenClientMock.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("security recon machine client", () => {
  it("tkt334 machine: a read reaches the tracker with the id token audience, no-store headers, and its timeout", async () => {
    requestMock.mockResolvedValue({ status: 200, data: { acatId: "rec-1" }, headers: new Headers() });
    const res = await callReconMachine("GET", PATH, undefined, 12_000);
    expect(res).toEqual({ status: 200, data: { acatId: "rec-1" }, refusal: null });
    expect(getIdTokenClientMock).toHaveBeenCalledWith(BASE);
    expect(requestMock).toHaveBeenCalledWith({
      url: `${BASE}${PATH}`,
      method: "GET",
      validateStatus: expect.any(Function),
      retry: false,
      timeout: 12_000,
      headers: { "Cache-Control": "no-store" },
    });
    expect(requestMock.mock.calls[0][0]).not.toHaveProperty("data");
    requestMock.mockResolvedValue({ status: 200, data: {}, headers: new Headers() });
    await callReconMachine("POST", PATH, { action: "refresh" }, 55_000);
    expect(requestMock.mock.calls[1][0]).toMatchObject({ method: "POST", data: { action: "refresh" }, timeout: 55_000 });
    markCase(SUITE, "tkt334 machine: a read reaches the tracker with the id token audience, no-store headers, and its timeout");
  });

  it("tkt334 machine: the refusal header is read from a Headers object and from a plain object", async () => {
    requestMock.mockResolvedValueOnce({ status: 422, data: {}, headers: new Headers({ "x-recon-refusal": "Mapping CSV must be 2 MB or smaller." }) });
    expect((await callReconMachine("POST", PATH, {}, 1000)).refusal).toBe("Mapping CSV must be 2 MB or smaller.");
    requestMock.mockResolvedValueOnce({ status: 404, data: {}, headers: { "x-recon-refusal": "Not available" } });
    expect((await callReconMachine("POST", PATH, {}, 1000)).refusal).toBe("Not available");
    requestMock.mockResolvedValueOnce({ status: 404, data: {}, headers: { "x-recon-refusal": ["first", "second"] } });
    expect((await callReconMachine("POST", PATH, {}, 1000)).refusal).toBe("first");
    requestMock.mockResolvedValueOnce({ status: 500, data: {}, headers: undefined });
    expect((await callReconMachine("POST", PATH, {}, 1000)).refusal).toBeNull();
    markCase(SUITE, "tkt334 machine: the refusal header is read from a Headers object and from a plain object");
  });

  it("tkt334 machine: a transport failure returns status null", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    requestMock.mockRejectedValue(new Error("socket hang up"));
    expect(await callReconMachine("GET", PATH, undefined, 1000)).toEqual({ status: null, data: null, refusal: null });
    getIdTokenClientMock.mockRejectedValueOnce(new Error("no credentials"));
    expect(await callReconMachine("GET", PATH, undefined, 1000)).toEqual({ status: null, data: null, refusal: null });
    markCase(SUITE, "tkt334 machine: a transport failure returns status null");
  });

  it("tkt334 machine: fixture mode makes no request", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ACAT_FIXTURE", "1");
    expect(await callReconMachine("GET", PATH, undefined, 1000)).toEqual({ status: null, data: null, refusal: null });
    expect(requestMock).not.toHaveBeenCalled();
    expect(getIdTokenClientMock).not.toHaveBeenCalled();
    vi.stubEnv("NODE_ENV", "production");
    requestMock.mockResolvedValue({ status: 200, data: {}, headers: new Headers() });
    await callReconMachine("GET", PATH, undefined, 1000);
    expect(requestMock).toHaveBeenCalledTimes(1);
    markCase(SUITE, "tkt334 machine: fixture mode makes no request");
  });

  it("tkt334 machine: logs carry only static markers", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    requestMock.mockRejectedValue(new Error("secret-token-123 for rec-1 Pat Example"));
    await callReconMachine("POST", PATH, { action: "upload", kind: "apex", filename: "a.csv", text: "client data" }, 1000);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]).toEqual(["[acat-security-recon] transport_failed"]);
    markCase(SUITE, "tkt334 machine: logs carry only static markers");
  });
});
