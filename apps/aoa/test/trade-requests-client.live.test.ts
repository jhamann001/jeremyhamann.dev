import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Runs only against a locally started Trade Request service in HS256 mode:
// TRADE_REQUEST_DELEGATED_LIVE_URL, TRADE_REQUEST_DELEGATED_LIVE_KEY and a
// synthetic, seeded DATABASE_URL. Skipped everywhere else (including CI).
vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: m.auth }));

import { callTradeRequestService, resetDelegatedClientState } from "@/lib/trade-requests/client";
import { prisma } from "@/lib/db";

const LIVE_URL = process.env.TRADE_REQUEST_DELEGATED_LIVE_URL;
const NOT_SET_UP = "Your account is not set up for Trade Requests — contact Operations.";

async function signIn(email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  m.auth.mockResolvedValue({ user: { id: user.id, email } });
}

describe.skipIf(!LIVE_URL)("delegated client against a local Trade Request service", () => {
  beforeEach(() => {
    resetDelegatedClientState();
    vi.restoreAllMocks();
    vi.stubEnv("TRADE_REQUEST_API_URL", LIVE_URL ?? "");
    vi.stubEnv("TRADE_REQUEST_DELEGATED_AUDIENCE", "");
    vi.stubEnv("TRADE_REQUEST_DELEGATED_LOCAL_KEY", process.env.TRADE_REQUEST_DELEGATED_LIVE_KEY ?? "");
  });
  afterAll(() => vi.unstubAllEnvs());

  it("ADVISOR reads counts as themselves", async () => {
    await signIn("avery@example.com");
    const result = await callTradeRequestService<Record<string, unknown>>({
      operation: "requestCounts", method: "GET", path: "/requests/counts", defaultMessage: "Failed to load counts",
    });
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(result.ok && typeof result.data === "object" && result.data !== null).toBe(true);
  });

  it("OPERATIONS lists requests", async () => {
    await signIn("ops@example.com");
    const result = await callTradeRequestService({
      operation: "listRequests", method: "GET", path: "/requests", query: { limit: 1 }, defaultMessage: "Failed to load requests",
    });
    expect(result).toMatchObject({ ok: true, status: 200 });
  });

  it("VIEWER is refused with the AC-22 message", async () => {
    await signIn("view@example.com");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await callTradeRequestService({
      operation: "requestCounts", method: "GET", path: "/requests/counts", defaultMessage: "Failed to load counts",
    });
    expect(result).toEqual({ ok: false, outcome: "not_set_up", message: NOT_SET_UP });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a wrong local key is refused with the AC-22 message", async () => {
    vi.stubEnv("TRADE_REQUEST_DELEGATED_LOCAL_KEY", "wrong-synthetic-key");
    await signIn("ops@example.com");
    const result = await callTradeRequestService({
      operation: "requestCounts", method: "GET", path: "/requests/counts", defaultMessage: "Failed to load counts",
    });
    expect(result).toEqual({ ok: false, outcome: "not_set_up", message: NOT_SET_UP });
  });

  it("an unreachable service is the action failure outcome after three attempts", async () => {
    vi.stubEnv("TRADE_REQUEST_API_URL", "http://127.0.0.1:9");
    await signIn("ops@example.com");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await callTradeRequestService({
      operation: "requestCounts", method: "GET", path: "/requests/counts", defaultMessage: "Failed to load counts",
    });
    expect(result).toEqual({ ok: false, outcome: "failed", status: null, message: "Network Error" });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
