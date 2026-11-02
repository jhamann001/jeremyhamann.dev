import { beforeEach, describe, expect, it, vi } from "vitest";
const { auth, read } = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/data/acat-workspace", () => ({ readAcatWorkspace: read }));
import { GET } from "@/app/api/acat-workspace/route";
import { libraryFixture } from "./fixtures/custodian-library";
const request = (query = "view=library") => new Request(`https://ops-portal.example.test/api/acat-workspace?${query}`);
beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "ops@example.test" }, navigationScope: "opaque-scope", expires: new Date(Date.now() + 600_000).toISOString() });
  const now = Date.now();
  read.mockResolvedValue({ view: "library", data: libraryFixture, checkedAt: now, expiresAt: now + 300_000 });
});
describe("authenticated workspace read endpoint", () => {
  it("returns projected data with private no-store headers", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect((await response.json()).scope).toBe("opaque-scope");
    expect(read).toHaveBeenCalledWith({ role: "OPERATIONS", email: "ops@example.test" }, "library", false);
  });
  it("passes only the exact refresh flag and server-derived identity", async () => {
    await GET(request("view=library&refresh=1"));
    expect(read).toHaveBeenLastCalledWith({ role: "OPERATIONS", email: "ops@example.test" }, "library", true);
  });
  it("denies signed-out sessions before source/cache access", async () => {
    auth.mockResolvedValue(null); const response = await GET(request());
    expect(response.status).toBe(401); expect(read).not.toHaveBeenCalled();
  });
  it.each(["ADVISOR", "CLIENT_SERVICE", "VIEWER", "UNKNOWN", undefined])("denies %s before reading a warm cache", async (role) => {
    await GET(request()); read.mockClear();
    auth.mockResolvedValue({ user: { role }, navigationScope: "opaque", expires: new Date(Date.now() + 600_000).toISOString() });
    expect((await GET(request())).status).toBe(403); expect(read).not.toHaveBeenCalled();
  });
  it.each(["", "view=other", "view=library&view=tracking", "view=library&refresh=0", "view=library&refresh=1&refresh=1", "view=library&role=ADMIN", "view=library&url=https://other.test"])("rejects unsupported selectors/identity/source inputs: %s", async (query) => {
    expect((await GET(request(query))).status).toBe(400); expect(read).not.toHaveBeenCalled();
  });
  it.each([{ navigationScope: "" }, { expires: "invalid" }, { expires: "2020-01-01T00:00:00Z" }])("fails closed for invalid session metadata %j", async (override) => {
    auth.mockResolvedValue({ user: { role: "ADMIN" }, navigationScope: "opaque", expires: new Date(Date.now() + 600_000).toISOString(), ...override });
    expect((await GET(request())).status).toBe(403); expect(read).not.toHaveBeenCalled();
  });
  it.each(["auth", "source"])("sanitizes %s failures without client/source details", async (where) => {
    (where === "auth" ? auth : read).mockRejectedValue(new Error("Bearer sensitive, client name"));
    const response = await GET(request()); expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"ACAT workspace unavailable"}');
  });
  it("rejects expired snapshots instead of renewing the browser lease", async () => {
    const now = Date.now(); read.mockResolvedValue({ view: "library", data: libraryFixture, checkedAt: now - 300_000, expiresAt: now });
    expect((await GET(request())).status).toBe(503);
  });
  it("rejects cross-site refresh requests", async () => {
    expect((await GET(new Request(request(), { headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(403);
    expect(auth).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });
});
