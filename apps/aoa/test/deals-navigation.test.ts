import { beforeEach, describe, expect, it, vi } from "vitest";
import { dealsHref, parseDealsQuery } from "@/lib/navigation/deals-query";
const { auth, directory, exportRows } = vi.hoisted(() => ({ auth: vi.fn(), directory: vi.fn(), exportRows: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/data/deals", () => ({ getDealDirectory: directory, exportMatchingDeals: exportRows }));
import { GET } from "@/app/api/navigation/deals/route";

const snapshot = "a".repeat(32), scope = "b".repeat(64);
const page = { rows: [], page: 1, pageSize: 100, total: 301, pageCount: 4, snapshot, meta: {} };
const request = (q = "") => new Request(`https://example.test/api/navigation/deals?${q}`);

describe("Deals URL contract", () => {
  it("normalizes list filters while keeping modal keys out of navigation memory", () => {
    const query = parseDealsQuery(new URLSearchParams("q=++Invented++&stage=WON&sort=amount&dir=desc&page=3&deal=deal-1"));
    expect(query).toMatchObject({ page: 3, pageSize: 100, modalDealId: "deal-1", wantsNew: false });
    expect(query.href).toBe("/deals?dir=desc&page=3&q=Invented&sort=amount&stage=WON");
    expect(parseDealsQuery(new URLSearchParams("new=1")).href).toBe("/deals");
    expect(dealsHref({ query: "", stage: "all", sortKey: null, sortDir: "asc", archived: false })).toBe("/deals");
  });
  it.each(["page=0", "page=2", "pageSize=99", "pageSize=201", "page=1&page=2", "q=%00", "q=" + "x".repeat(257),
    "stage=BEER", "sort=owner", "dir=desc", "sort=amount&dir=sideways", "archived=0", "archived=1&stage=WON",
    "owner=secret", "snapshot=bad", "deal=deal-1", "format=xml", "format=csv&page=1", "format=csv&archived=1",
    "format=csv&pageSize=100"])("rejects invalid API query %s", query => {
    expect(() => parseDealsQuery(new URLSearchParams(query), true)).toThrow();
  });
  it.each(["deal=../private", "new=0", "new=1&deal=deal-1", "deal=one&deal=two"])("rejects invalid modal query %s", query => {
    expect(() => parseDealsQuery(new URLSearchParams(query))).toThrow();
  });
  it("accepts bounded continuation and explicit all-match export", () => {
    expect(parseDealsQuery(new URLSearchParams(`page=2&pageSize=200&snapshot=${snapshot}`), true)).toMatchObject({ page: 2, pageSize: 200, snapshot });
    expect(parseDealsQuery(new URLSearchParams("q=Invented&format=csv"), true)).toMatchObject({ exportCsv: true, href: "/deals?q=Invented" });
  });
});

describe("Deals navigation API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "synthetic@example.invalid" }, navigationScope: scope });
    directory.mockResolvedValue(page);
    exportRows.mockResolvedValue([]);
  });
  it("fresh auth and RLS identity accompany every request", async () => {
    const response = await GET(request());
    expect(await response.json()).toEqual(page);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
    expect(response.headers.get("X-AOA-Navigation-Scope")).toBe(scope);
    await GET(request(`page=2&snapshot=${snapshot}`));
    expect(auth).toHaveBeenCalledTimes(2);
    expect(directory.mock.calls[1]).toMatchObject([{ role: "OPERATIONS", email: "synthetic@example.invalid" }, {}, 2, 100]);
  });
  it("rejects a changed snapshot and an exhausted numbered page", async () => {
    expect((await GET(request(`page=2&snapshot=${"c".repeat(32)}`))).status).toBe(409);
    expect((await GET(request(`page=5&snapshot=${snapshot}`))).status).toBe(416);
  });
  it("checks auth and Removed permission before data reads", async () => {
    auth.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
    auth.mockResolvedValue({ user: { role: "VIEWER" }, navigationScope: scope });
    expect((await GET(request("archived=1"))).status).toBe(403);
    expect((await GET(request("sort=private"))).status).toBe(400);
    expect(directory).not.toHaveBeenCalled();
    expect(exportRows).not.toHaveBeenCalled();
  });
  it("exports through the full matching seam, not the mounted directory", async () => {
    const response = await GET(request("q=Invented&stage=WON&format=csv"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    expect(response.headers.get("X-AOA-Navigation-Scope")).toBe(scope);
    expect(await response.text()).toContain("Deal: Deal Name");
    expect(exportRows.mock.calls[0][1]).toMatchObject({ query: "Invented", stage: "WON", archived: false });
    expect(directory).not.toHaveBeenCalled();
  });
  it("returns generic failures without query or auth details", async () => {
    auth.mockRejectedValueOnce(new Error("private credential"));
    expect(await (await GET(request())).json()).toEqual({ error: "deals_unavailable" });
    directory.mockRejectedValueOnce(new Error("private SQL"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "deals_unavailable" });
  });
});
