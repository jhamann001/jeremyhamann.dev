import { beforeEach, describe, expect, it, vi } from "vitest";
const { auth, identities, duplicates } = vi.hoisted(() => ({ auth: vi.fn(), identities: vi.fn(), duplicates: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/data/crm-explorer", () => ({ listCrmIdentityWindow: identities }));
vi.mock("@/lib/data/crm-duplicate-review", () => ({ listCrmDuplicateWindow: duplicates }));
import { GET as getIdentities } from "@/app/api/navigation/crm/window/route";
import { GET as getDuplicates } from "@/app/api/navigation/crm-duplicates/window/route";
import { WindowPageError } from "@/lib/navigation/window-page";

const scope = "c".repeat(64), snapshot = "a".repeat(64);
const page = { ok: true, rows: [], firstPage: 1, pageSize: 100, loaded: 100, snapshot, hasMore: true, meta: { total: 201, pageCount: 3 } };
const request = (query = "") => new Request(`https://example.test/api/navigation/crm/window?${query}`);
describe.each([["identities", getIdentities, identities], ["duplicates", getDuplicates, duplicates]] as const)("CRM %s window endpoint", (_name, get, seam) => {
  beforeEach(() => { vi.clearAllMocks(); auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "ops@example.invalid" }, navigationScope: scope }); seam.mockResolvedValue(page); });
  it("authorizes every request and returns private fresh window metadata without internal flags", async () => {
    const response = await get(request(`loaded=100&snapshot=${snapshot}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("x-aoa-navigation-scope")).toBe(scope);
    expect(await response.json()).not.toHaveProperty("ok");
    expect(seam.mock.calls[0][0]).toEqual({ role: "OPERATIONS", email: "ops@example.invalid" });
    expect(seam.mock.calls[0].at(-1)).toEqual({ firstPage: 1, pageSize: 100, loaded: 100, snapshot });
  });
  it("rejects changed prefixes but lets a fresh empty terminal window offer return-to-first", async () => {
    seam.mockRejectedValueOnce(new WindowPageError("changed"));
    const changed = await get(request(`loaded=100&snapshot=${snapshot}`));
    expect(changed.status).toBe(409); expect(await changed.json()).not.toHaveProperty("rows");
    seam.mockResolvedValue({ ...page, rows: [], firstPage: 4, loaded: 0, hasMore: false });
    const empty = await get(request("page=4"));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ rows: [], firstPage: 4, loaded: 0, hasMore: false, meta: { total: 201, pageCount: 3 } });
  });
  it("keeps malformed requests, missing sessions, revoked roles and disabled features fail-closed", async () => {
    expect((await get(request("loaded=5001"))).status).toBe(400);
    expect((await get(request(`loaded=100&snapshot=${"a".repeat(32)}`))).status).toBe(400);
    expect(seam).not.toHaveBeenCalled();
    auth.mockResolvedValue(null); expect((await get(request())).status).toBe(401);
    auth.mockResolvedValue({ user: { role: "ADVISOR" }, navigationScope: scope });
    seam.mockResolvedValue({ ok: false, reason: "forbidden" }); expect((await get(request())).status).toBe(403);
    seam.mockResolvedValue({ ok: false, reason: "disabled" }); expect((await get(request())).status).toBe(404);
  });
  it("passes a bounded fresh restoration through the same authenticated read seam", async () => {
    const response = await get(request("restoreRows=5000"));
    expect(response.status).toBe(200);
    expect(seam.mock.calls[0].at(-1)).toEqual({ firstPage: 1, pageSize: 100, loaded: 0, snapshot: null, restoreRows: 5000 });
    seam.mockClear();
    for (const query of ["restoreRows=5001", "restoreRows=99", "restoreRows=100&restoreRows=200", `loaded=100&snapshot=${snapshot}&restoreRows=200`]) {
      expect((await get(request(query))).status).toBe(400);
    }
    expect(seam).not.toHaveBeenCalled();
  });
  it("does not leak SQL/identity payloads in a database or authentication failure", async () => {
    seam.mockRejectedValue(new Error("sensitive SQL fixture"));
    const failed = await get(request()); expect(failed.status).toBe(503);
    expect(JSON.stringify(await failed.json())).not.toContain("sensitive");
    auth.mockRejectedValue(new Error("credential fixture"));
    const denied = await get(request()); expect(denied.status).toBe(503);
    expect(JSON.stringify(await denied.json())).not.toContain("credential");
  });
});
