import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const { auth, search } = vi.hoisted(() => ({ auth: vi.fn(), search: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/data/household-email-search", () => ({ searchHouseholdEmails: search }));
import { parseHouseholdEmailSearchRequest } from "@/lib/navigation/household-email-search-api";
import * as route from "@/app/api/navigation/household-email/search/route";

const URL_BASE = "https://example.test/api/navigation/household-email/search";
const TERM = "synthetic-term-should-never-echo";
const post = (body: unknown, { url = URL_BASE, type = "application/json" } = {}) => new Request(url, {
  method: "POST", headers: { "content-type": type }, body: typeof body === "string" ? body : JSON.stringify(body),
});
const page = (over = {}) => ({ rows: [], page: 1, pageSize: 50, total: 0, pageCount: 1, searched: 3, snapshot: "a".repeat(64), ...over });

describe("ticket household email search request", () => {
  it("accepts only a JSON body with known keys and never a URL query", () => {
    expect(parseHouseholdEmailSearchRequest(URL_BASE, "application/json", JSON.stringify({ household: "hh1", q: "  fee  " })))
      .toEqual({ householdId: "hh1", term: "fee", page: 1, snapshot: null });
    for (const [url, type, raw] of [
      [`${URL_BASE}?q=${TERM}`, "application/json", JSON.stringify({ household: "hh1", q: "fee" })],
      [`${URL_BASE}?household=hh1`, "application/json", JSON.stringify({ household: "hh1", q: "fee" })],
      [URL_BASE, "text/plain", JSON.stringify({ household: "hh1", q: "fee" })],
      [URL_BASE, "application/json", "not json"],
      [URL_BASE, "application/json", JSON.stringify(["fee"])],
      [URL_BASE, "application/json", JSON.stringify({ household: "hh1", q: "fee", extra: 1 })],
      [URL_BASE, "application/json", JSON.stringify({ household: "../x", q: "fee" })],
      [URL_BASE, "application/json", JSON.stringify({ household: "hh1", q: "f" })],
      [URL_BASE, "application/json", JSON.stringify({ household: "hh1", q: "fee", page: 2 })],
      [URL_BASE, "application/json", JSON.stringify({ household: "hh1", q: "fee", page: 1.5 })],
      [URL_BASE, "application/json", JSON.stringify({ household: "hh1", q: "fee", snapshot: "nope" })],
      [URL_BASE, "application/json", JSON.stringify({ household: "hh1", q: "x".repeat(5000) })],
    ] as const) expect(() => parseHouseholdEmailSearchRequest(url, type, raw)).toThrow();
  });
});

describe("POST /api/navigation/household-email/search", () => {
  beforeEach(() => {
    auth.mockReset(); search.mockReset();
    auth.mockResolvedValue({ user: { role: "ADVISOR", email: "advisor@example.invalid" }, navigationScope: "b".repeat(64) });
  });

  it("is POST only; other verbs are 405 and private", async () => {
    for (const verb of [route.GET, route.PUT, route.PATCH, route.DELETE]) {
      const response = verb();
      expect(response.status).toBe(405);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("Allow")).toBe("POST");
    }
  });

  it("returns the scoped page privately with the caller identity", async () => {
    search.mockResolvedValue(page({ total: 1 }));
    const response = await route.POST(post({ household: "hh1", q: "fee" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-AOA-Navigation-Scope")).toBe("b".repeat(64));
    expect(search).toHaveBeenCalledWith({ role: "ADVISOR", email: "advisor@example.invalid" }, "hh1", "fee", { page: 1 });
  });

  it("maps session loss, invalid input, unavailable households, drift and paging bounds", async () => {
    auth.mockResolvedValueOnce(null);
    expect((await route.POST(post({ household: "hh1", q: "fee" }))).status).toBe(401);
    expect((await route.POST(post({ household: "hh1", q: "fee" }, { url: `${URL_BASE}?q=fee` }))).status).toBe(400);
    search.mockResolvedValueOnce(null);
    expect((await route.POST(post({ household: "hh1", q: "fee" }))).status).toBe(404);
    search.mockResolvedValueOnce(page({ page: 2, total: 60, pageCount: 2, snapshot: "c".repeat(64) }));
    expect((await route.POST(post({ household: "hh1", q: "fee", page: 2, snapshot: "d".repeat(64) }))).status).toBe(409);
    search.mockResolvedValueOnce(page({ page: 1, snapshot: "d".repeat(64) }));
    expect((await route.POST(post({ household: "hh1", q: "fee", page: 3, snapshot: "d".repeat(64) }))).status).toBe(416);
    search.mockRejectedValueOnce(new Error(TERM));
    expect((await route.POST(post({ household: "hh1", q: "fee" }))).status).toBe(503);
  });

  it("never echoes or logs the term", async () => {
    const logs: string[] = [];
    for (const method of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => { logs.push(args.join(" ")); });
    }
    search.mockRejectedValueOnce(new Error(TERM));
    const bodies = [
      await (await route.POST(post({ household: "hh1", q: TERM }))).text(),
      await (await route.POST(post({ household: "hh1", q: TERM, junk: TERM }))).text(),
      await (await route.POST(post({ household: "hh1", q: TERM }, { url: `${URL_BASE}?q=${TERM}` }))).text(),
    ];
    for (const body of bodies) expect(body).not.toContain(TERM);
    expect(logs.join("\n")).not.toContain(TERM);
    vi.restoreAllMocks();
  });
});
