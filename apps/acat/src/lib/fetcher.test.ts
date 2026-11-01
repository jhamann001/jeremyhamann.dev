import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockSignOut = vi.fn();
const mockGetSession = vi.fn();
vi.mock("next-auth/react", () => ({
  signOut: (...args: unknown[]) => mockSignOut(...args),
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

import { jsonFetcher, __resetFetcherGuardForTests } from "./fetcher";

function mockFetchResponse(init: {
  ok: boolean;
  status: number;
  json?: unknown;
}): void {
  const response = {
    ok: init.ok,
    status: init.status,
    json: async () => init.json ?? {},
  };
  vi.stubGlobal("fetch", vi.fn(async () => response));
}

// Drain the microtask queue so the fire-and-forget
// verifySessionAndMaybeSignOut() in jsonFetcher has a chance to run.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  __resetFetcherGuardForTests();
  mockSignOut.mockReset();
  mockGetSession.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("jsonFetcher", () => {
  it("returns parsed JSON on 200", async () => {
    mockFetchResponse({ ok: true, status: 200, json: { hello: "world" } });
    await expect(
      jsonFetcher<{ hello: string }>("/api/thing")
    ).resolves.toEqual({ hello: "world" });
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("throws HTTP <status> on non-OK responses other than 401", async () => {
    mockFetchResponse({ ok: false, status: 500 });
    await expect(jsonFetcher("/api/thing")).rejects.toThrow("HTTP 500");
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("verifies session on 401 and signs out when session is truly gone", async () => {
    mockFetchResponse({ ok: false, status: 401 });
    mockGetSession.mockResolvedValue(null);

    await expect(jsonFetcher("/api/thing")).rejects.toThrow("HTTP 401");
    await flushMicrotasks();

    expect(mockGetSession).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledWith({
      callbackUrl: "/login?reason=expired",
    });
  });

  it("does NOT sign out when a 401 is transient and the session is still valid", async () => {
    mockFetchResponse({ ok: false, status: 401 });
    mockGetSession.mockResolvedValue({
      user: { email: "jeremy@example.com" },
    });

    await expect(jsonFetcher("/api/thing")).rejects.toThrow("HTTP 401");
    await flushMicrotasks();

    expect(mockGetSession).toHaveBeenCalledTimes(1);
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("re-verifies on a later 401 after a transient one cleared", async () => {
    mockFetchResponse({ ok: false, status: 401 });
    mockGetSession
      .mockResolvedValueOnce({ user: { email: "a@b.com" } }) // transient
      .mockResolvedValueOnce(null); // real expiry

    await expect(jsonFetcher("/api/a")).rejects.toThrow("HTTP 401");
    await flushMicrotasks();
    expect(mockSignOut).not.toHaveBeenCalled();

    await expect(jsonFetcher("/api/b")).rejects.toThrow("HTTP 401");
    await flushMicrotasks();
    expect(mockGetSession).toHaveBeenCalledTimes(2);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it("collapses concurrent 401s into a single verify+signOut", async () => {
    mockFetchResponse({ ok: false, status: 401 });
    mockGetSession.mockResolvedValue(null);

    await Promise.allSettled([
      jsonFetcher("/api/a"),
      jsonFetcher("/api/b"),
      jsonFetcher("/api/c"),
    ]);
    await flushMicrotasks();

    expect(mockGetSession).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it("does not sign out if the session check itself errors", async () => {
    mockFetchResponse({ ok: false, status: 401 });
    mockGetSession.mockRejectedValue(new Error("network down"));

    await expect(jsonFetcher("/api/thing")).rejects.toThrow("HTTP 401");
    await flushMicrotasks();

    expect(mockGetSession).toHaveBeenCalledTimes(1);
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("forwards cache: 'no-store' to fetch", async () => {
    mockFetchResponse({ ok: true, status: 200, json: {} });
    await jsonFetcher("/api/thing");
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith("/api/thing", { cache: "no-store" });
  });
});
