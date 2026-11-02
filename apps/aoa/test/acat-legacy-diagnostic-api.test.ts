import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, read } = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/data/acat-legacy-diagnostic", () => ({ readAcatLegacyDiagnostic: read }));
import { GET } from "@/app/api/diagnostics/acat-legacy-links/route";

const request = (query = "") => new Request(`https://ops-portal.example.test/api/diagnostics/acat-legacy-links${query}`);
const validSession = () => ({ user: { role: "OPERATIONS", email: "ops@example.test" }, navigationScope: "synthetic-scope", expires: new Date(Date.now() + 60_000).toISOString() });
const result = { legacyOnlyCount: 3, archivedLegacyOnlyCount: 2, candidateTransferId: "synthetic-transfer-1" };

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue(validSession());
  read.mockResolvedValue(result);
});

describe("minimal legacy ACAT diagnostic", () => {
  it.each(["ADMIN", "OPERATIONS"])("returns only counts and one ID for %s with no caching", async (role) => {
    auth.mockResolvedValue({ ...validSession(), user: { role, email: "ops@example.test" } });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(read).toHaveBeenCalledWith({ role, email: "ops@example.test" });
  });

  it("preserves a real zero result", async () => {
    const empty = { legacyOnlyCount: 0, archivedLegacyOnlyCount: 0, candidateTransferId: null };
    read.mockResolvedValue(empty);
    expect(await (await GET(request())).json()).toEqual(empty);
  });

  it("denies a missing session before database access", async () => {
    auth.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["VIEWER", "ADVISOR", "CLIENT_SERVICE", "HEAD_OF_ADVISORY", "UNKNOWN", undefined])("denies %s before database access", async (role) => {
    auth.mockResolvedValue({ ...validSession(), user: { role, email: "ops@example.test" } });
    expect((await GET(request())).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "", "  "])("requires a nonempty session identity: %s", async (email) => {
    auth.mockResolvedValue({ ...validSession(), user: { role: "ADMIN", email } });
    expect((await GET(request())).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([{ navigationScope: "" }, { expires: "bad" }, { expires: "2020-01-01T00:00:00Z" }])("rejects invalid session metadata %j", async (override) => {
    auth.mockResolvedValue({ ...validSession(), ...override });
    expect((await GET(request())).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["?role=ADMIN", "?includeArchived=0", "?id=synthetic", "?url=https://example.test", "?sql=SELECT+1"])("rejects request selectors: %s", async (query) => {
    expect((await GET(request(query))).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects cross-site requests before authentication and reads", async () => {
    expect((await GET(new Request(request(), { headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(403);
    expect(auth).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["auth", "read"])("returns a generic unavailable response for %s failures", async (failure) => {
    (failure === "auth" ? auth : read).mockRejectedValue(new Error("Synthetic private source payload"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "ACAT legacy diagnostic unavailable" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it.each([
    { ...result, upstreamId: "synthetic-private-id" },
    { ...result, archivedLegacyOnlyCount: 4 },
    { ...result, candidateTransferId: null },
    { ...result, legacyOnlyCount: -1 },
  ])("fails closed for a malformed or excessive response", async (data) => {
    read.mockResolvedValue(data);
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("synthetic-private-id");
  });

  it("discards results when the session expires during the read", async () => {
    read.mockImplementation(async () => {
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
      return result;
    });
    try { expect((await GET(request())).status).toBe(503); }
    finally { vi.restoreAllMocks(); }
  });

  it("does not start a database read for an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await GET(new Request(request(), { signal: controller.signal }))).status).toBe(503);
    expect(read).not.toHaveBeenCalled();
  });
});
