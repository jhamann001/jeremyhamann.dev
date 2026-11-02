import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseClientDirectoryQuery } from "@/lib/navigation/client-query";
import { parseAuditNavigationQuery } from "@/lib/navigation/audit-query";
const { auth, clients, events, changes } = vi.hoisted(() => ({ auth: vi.fn(), clients: vi.fn(), events: vi.fn(), changes: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/data/clients", () => ({ getClientDirectory: clients }));
vi.mock("@/lib/data/audit-log", () => ({ listAuditLog: events, canReadAudit: (role: string) => ["ADMIN", "OPERATIONS"].includes(role) }));
vi.mock("@/lib/data/row-changes", () => ({ listRowChanges: changes }));
import { GET as getClients } from "@/app/api/navigation/clients/route";
import { GET as getAudit } from "@/app/api/navigation/audit/route";
const snapshot = "a".repeat(32);
const scope = "b".repeat(64);
const page = { ok: true, rows: [{ id: "synthetic" }], page: 1, pageSize: 100, total: 201, pageCount: 3,
  snapshot, counts: {}, actions: [], actors: [], tables: [], ops: [] };
const request = (q = "") => new Request(`https://example.test/api/navigation/clients?${q}`);

describe("Client and Audit query boundaries", () => {
  it.each(["page=2", "pageSize=99", "pageSize=201", "page=1&page=2", "snapshot=bad", "q=%00", "sort=private"])("rejects invalid Client query %s", q => {
    expect(() => parseClientDirectoryQuery(new URLSearchParams(q), true)).toThrow();
  });
  it.each(["page=2", "pageSize=99", "view=private", "view=changes&action=deal", "table=deal", "op=UPDATE", "view=changes&op=UPSERT", "actor=x&actor=y", "view=changes&from=2025-01-01", "view=changes&to=2026-09-17"])("rejects invalid Audit query %s", q => {
    expect(() => parseAuditNavigationQuery(new URLSearchParams(q), true)).toThrow();
  });
  it("keeps Audit view filters separate and applies a bounded first100", () => {
    expect(parseAuditNavigationQuery(new URLSearchParams())).toMatchObject({ view: "events", pageSize: 100, href: "/audit-log" });
    expect(parseAuditNavigationQuery(new URLSearchParams("view=changes&table=deal"))).toMatchObject({ view: "changes", table: "deal" });
  });
});

describe.each([["Client", getClients, clients], ["Audit", getAudit, events]] as const)("%s navigation API", (_name, get, seam) => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "synthetic@example.test" }, navigationScope: scope });
    for (const mock of [clients, events, changes]) mock.mockResolvedValue(page);
  });
  async function privateBody(response: Response) {
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.has("x-aoa-navigation-scope")).toBe(true);
    return response.json();
  }
  it("reauthenticates each bounded page and rejects stale sequences", async () => {
    const first = await get(request());
    expect((await privateBody(first)).rows).toEqual(page.rows);
    const changed = await get(request(`page=2&snapshot=${"c".repeat(32)}`));
    expect(changed.status).toBe(409);
    expect(await privateBody(changed)).not.toHaveProperty("rows");
    expect(auth).toHaveBeenCalledTimes(2);
    expect(seam.mock.calls[0][0]).toEqual({ role: "OPERATIONS", email: "synthetic@example.test" });
  });
  it("does not query for absent auth or invalid input", async () => {
    auth.mockResolvedValue(null);
    const absent = await get(request()); expect(absent.status).toBe(401); await privateBody(absent);
    expect(seam).not.toHaveBeenCalled();
    auth.mockResolvedValue({ user: { role: "OPERATIONS" } });
    const invalid = await get(request("page=0")); expect(invalid.status).toBe(400); await privateBody(invalid);
    expect(seam).not.toHaveBeenCalled();
  });
  it("keeps auth lookup and database failures within the safe error envelope", async () => {
    auth.mockRejectedValue(new Error("private auth details"));
    const denied = await get(request()); expect(denied.status).toBe(503);
    expect(JSON.stringify(await privateBody(denied))).not.toContain("private auth details");
    auth.mockResolvedValue({ user: { role: "OPERATIONS" }, navigationScope: scope });
    seam.mockRejectedValue(new Error("private query"));
    const failed = await get(request()); expect(failed.status).toBe(503);
    expect(JSON.stringify(await privateBody(failed))).not.toContain("private query");
  });
});
