import { beforeEach, describe, expect, it, vi } from "vitest";
const { auth, rows, metadata } = vi.hoisted(() => ({ auth: vi.fn(), rows: vi.fn(), metadata: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/data/row-changes", () => ({ listRowChangeWindow: rows, getRowChangeMetadata: metadata }));
vi.mock("@/lib/data/audit-log", () => ({ canReadAudit: (role: string) => ["ADMIN", "OPERATIONS"].includes(role) }));
import { GET as rowGet } from "@/app/api/navigation/audit/rows/route";
import { GET as metadataGet } from "@/app/api/navigation/audit/metadata/route";
const scope = "b".repeat(64), snapshot = "a".repeat(64);
const request = (query = "view=changes") => new Request(`https://example.invalid/api/navigation/audit/rows?${query}`);
describe.each([["rows", rowGet, rows], ["metadata", metadataGet, metadata]] as const)("Audit %s isolation", (_name, get, seam) => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "audit-window@example.invalid" }, navigationScope: scope });
    rows.mockResolvedValue({ ok: true, rows: [], firstPage: 1, pageSize: 100, loaded: 0, snapshot, hasMore: false, meta: {} });
    metadata.mockResolvedValue({ ok: true, total: 10, tables: ["synthetic"], ops: ["UPDATE"], actors: [] });
  });
  it("reauthorizes with private no-store scope headers and never invokes the other seam", async () => {
    const response = await get(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("x-aoa-navigation-scope")).toBe(scope);
    expect(seam).toHaveBeenCalledTimes(1);
    expect(seam === rows ? metadata : rows).not.toHaveBeenCalled();
  });
  it("rejects missing auth, denied roles and invalid filters without a read", async () => {
    auth.mockResolvedValue(null);
    expect((await get(request())).status).toBe(401);
    auth.mockResolvedValue({ user: { role: "ADVISOR" }, navigationScope: scope });
    expect((await get(request())).status).toBe(403);
    auth.mockResolvedValue({ user: { role: "OPERATIONS" }, navigationScope: scope });
    for (const query of ["view=events", "view=changes&op=UPSERT", "view=changes&table=x&table=y", "view=changes&action=private", "view=changes&unknown=x"]) {
      expect((await get(request(query))).status).toBe(400);
    }
    expect(seam).not.toHaveBeenCalled();
  });
  it("keeps auth and database failures literal and independent", async () => {
    auth.mockRejectedValue(new Error("private session value"));
    let response = await get(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
    auth.mockResolvedValue({ user: { role: "OPERATIONS" }, navigationScope: scope });
    seam.mockRejectedValue(new Error("private query details"));
    response = await get(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
  });
});

describe("Audit row continuation boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.mockResolvedValue({ user: { role: "OPERATIONS" }, navigationScope: scope });
  });
  it("returns a literal changed response and rejects malformed prefixes", async () => {
    rows.mockResolvedValue({ ok: false, reason: "changed" });
    expect((await rowGet(request(`view=changes&loaded=100&snapshot=${snapshot}`))).status).toBe(409);
    rows.mockClear();
    for (const query of ["loaded=100", "loaded=100&snapshot=" + "a".repeat(32), "loaded=5001", "loaded=-1", "loaded=99", "pageSize=150", "loaded=0&snapshot=" + snapshot,
      "restoreRows=0", "restoreRows=5001", "restoreRows=150", "restoreRows=300&loaded=100&snapshot=" + snapshot,
      "restoreRows=300&snapshot=" + snapshot, "restoreRows=300&restoreRows=400"]) {
      expect((await rowGet(request(`view=changes&${query}`))).status).toBe(400);
    }
    expect(rows).not.toHaveBeenCalled();
  });

  it("passes only a bounded fresh restore request to the row seam", async () => {
    rows.mockResolvedValue({ ok: true, rows: [], firstPage: 1, pageSize: 100, loaded: 0, snapshot, hasMore: false, meta: {} });
    expect((await rowGet(request("view=changes&restoreRows=300"))).status).toBe(200);
    expect(rows.mock.calls[0][1]).toMatchObject({ page: 1, pageSize: 100, loaded: 0, snapshot: null, restoreRows: 300 });
    rows.mockClear();
    expect((await rowGet(request("view=changes&restoreRows=5000"))).status).toBe(200);
    expect(rows.mock.calls[0][1]).toMatchObject({ restoreRows: 5000, loaded: 0, snapshot: null });
  });
  it("passes inclusive date filters only to the new row window, never metadata", async () => {
    rows.mockResolvedValue({ ok: true, rows: [], firstPage: 1, pageSize: 100, loaded: 0, snapshot, hasMore: false, meta: {} });
    const query = "view=changes&from=2025-01-01&to=2026-09-17&table=deal&actor=ops%40example.invalid";
    expect((await rowGet(request(query))).status).toBe(200);
    expect(rows.mock.calls[0][1]).toMatchObject({ from: "2025-01-01", to: "2026-09-17", table: "deal", actor: "ops@example.invalid" });
    expect((await metadataGet(request(query))).status).toBe(400);
    expect(metadata).not.toHaveBeenCalled();
    rows.mockClear();
    for (const dates of ["from=2026-02-30", "from=2026-09-18&to=2026-09-17", "to=2026-09-17&to=2026-09-18"]) {
      expect((await rowGet(request(`view=changes&${dates}`))).status).toBe(400);
    }
    expect(rows).not.toHaveBeenCalled();
    auth.mockResolvedValue({ user: { role: "ADVISOR" } });
    expect((await rowGet(request(query))).status).toBe(403);
    expect(rows).not.toHaveBeenCalled();
  });
});
