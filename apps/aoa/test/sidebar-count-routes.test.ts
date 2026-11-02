import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { auth, counts, list, tracking } = vi.hoisted(() => ({ auth: vi.fn(), counts: vi.fn(), list: vi.fn(), tracking: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/data/nav-counts", () => ({ navCounts: counts }));
vi.mock("@/lib/data/acat-status", () => ({ fetchAcatList: list }));
vi.mock("@/lib/data/acat-tracking", () => ({ buildAcatTracking: tracking }));
import { GET as badges } from "@/app/api/navigation/badges/route";
import { GET as acats } from "@/app/api/navigation/acat-count/route";
const request = (path = "") => new Request(`https://example.invalid/api/navigation/badges${path}`);
describe("read-only sidebar GET boundaries", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "ops@example.invalid" }, navigationScope: "scope" });
    counts.mockResolvedValue({ households: 1, clients: 2, openDeals: 3, activeTransfers: 4, crmOpenExceptions: 5 });
    list.mockResolvedValue([]); tracking.mockReturnValue({ summary: { inFlight: 6 } });
  });
  afterEach(() => vi.useRealTimers());
  it.each([badges, acats])("authenticates first and never caches a response", async handler => {
    auth.mockResolvedValue(null);
    const res = await handler(request("?role=ADMIN"));
    expect(res.status).toBe(401); expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Vary")).toBe("Cookie");
    expect(res.headers.get("X-AOA-Navigation-Scope")).toBe("");
    expect(counts).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
  });
  it.each([badges, acats])("rejects caller-selected identity/query inputs", async handler => {
    const res = await handler(request("?email=other@example.invalid"));
    expect(res.status).toBe(400); expect(counts).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
  });
  it("returns exact authorized nav counts without starting ACAT work", async () => {
    const res = await badges(request()); expect(res.status).toBe(200);
    expect(res.headers.get("X-AOA-Navigation-Scope")).toBe("scope");
    expect(await res.json()).toEqual(await counts.mock.results[0].value);
    expect(counts).toHaveBeenCalledWith({ role: "OPERATIONS", email: "ops@example.invalid" });
    expect(list).not.toHaveBeenCalled();
  });
  it("fails closed for missing role/email and enforces ACAT permissions separately", async () => {
    auth.mockResolvedValue({ user: {} });
    await badges(request()); expect(counts).toHaveBeenCalledWith({ role: "VIEWER", email: null });
    expect((await acats(request())).status).toBe(403); expect(list).not.toHaveBeenCalled();
  });
  it.each([badges, acats])("uses generic unavailable responses for auth/data errors", async handler => {
    auth.mockRejectedValueOnce(new Error("secret-auth"));
    const authFailure = await handler(request()); expect(authFailure.status).toBe(503);
    expect(await authFailure.text()).not.toContain("secret");
    counts.mockRejectedValue(new Error("secret-database")); list.mockRejectedValue(new Error("secret-token"));
    const res = await handler(request()); expect(res.status).toBe(503); expect(await res.text()).not.toContain("secret");
  });
  it("returns only the ACAT count, not source ticket/client payloads", async () => {
    list.mockResolvedValue([{ clientName: "never sent" }]);
    const res = await acats(request()); expect(await res.json()).toEqual({ count: 6 });
    expect(list.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
    expect(counts).not.toHaveBeenCalled();
  });
  it("aborts ACAT I/O after five seconds and does not retry automatically", async () => {
    vi.useFakeTimers();
    list.mockImplementation(({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("synthetic timeout")), { once: true });
    }));
    const pending = acats(request()); await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).status).toBe(503); expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0][0].signal.aborted).toBe(true);
  });
  it("does not start a scoped read after the requesting client has aborted", async () => {
    const controller = new AbortController(); controller.abort();
    expect((await badges(new Request("https://example.invalid/api/navigation/badges", { signal: controller.signal }))).status).toBe(503);
    expect(counts).not.toHaveBeenCalled();
  });
});
