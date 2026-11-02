import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  crmNavigationParams, normalizeCrmNavigationFilters, parseCrmNavigationRequest,
} from "@/components/crm/crm-navigation-query";

const { auth, identities, candidates } = vi.hoisted(() => ({
  auth: vi.fn(), identities: vi.fn(), candidates: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/data/crm-explorer", () => ({ listCrmIdentities: identities }));
vi.mock("@/lib/data/crm-duplicate-review", () => ({ listCrmDuplicateCandidates: candidates }));
import { GET as getIdentities } from "@/app/api/navigation/crm/route";
import { GET as getCandidates } from "@/app/api/navigation/crm-duplicates/route";

const snapshot = "a".repeat(32);
const page = {
  ok: true, rows: [{ id: "hld_synthetic" }], total: 201, page: 1, pageSize: 100,
  pageCount: 3, snapshot, stats: { identities: 201 },
};
const request = (query = "") => new Request(`https://example.test/api/navigation/crm?${query}`);

describe("CRM progressive request boundaries", () => {
  it("normalizes independent view filters and removes unsupported duplicate filters", () => {
    const filters = normalizeCrmNavigationFilters(new URLSearchParams("duplicates=potential&type=CONTACT&q=abc&state=ACTIVE&exceptions=open"));
    expect(crmNavigationParams(filters).toString()).toBe("type=CONTACT&duplicates=potential");
    expect(parseCrmNavigationRequest(new URLSearchParams("pageSize=200"), false).pageSize).toBe(200);
    expect(parseCrmNavigationRequest(new URLSearchParams(), true).filters.duplicateView).toBe("potential");
  });

  it.each([
    "page=0", "page=-1", "page=2", "page=1000001", "page=Infinity", "page=1&page=2",
    "pageSize=99", "pageSize=201", "snapshot=broken", "scope=admin", "q=%00", "type=invalid",
    "q=" + "x".repeat(201), "exceptions=closed", "state=invalid",
  ])("rejects unbounded or ambiguous identity input %s", (query) => {
    expect(() => parseCrmNavigationRequest(new URLSearchParams(query), false)).toThrow();
  });

  it.each(["pageSize=200", "q=abc", "state=ACTIVE", "exceptions=open", "duplicates=unknown", "type=DEAL"])(
    "enforces the fixed candidate contract %s", (query) => {
      expect(() => parseCrmNavigationRequest(new URLSearchParams(query), true)).toThrow();
    },
  );
});

describe.each([["identities", getIdentities, identities], ["candidates", getCandidates, candidates]] as const)(
  "CRM %s API", (_label, get, seam) => {
    beforeEach(() => {
      vi.clearAllMocks();
      auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "ops@example.test" }, navigationScope: "login-fingerprint" });
      seam.mockResolvedValue(page);
    });

    async function checkHeaders(response: Response) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("vary")).toBe("Cookie");
      expect(response.headers.has("x-aoa-navigation-scope")).toBe(true);
      return response.json();
    }

    it("authenticates each page and exposes only the bounded envelope", async () => {
      const first = await get(request());
      expect(await checkHeaders(first)).toEqual({
        rows: page.rows, total: 201, page: 1, pageSize: 100, pageCount: 3, snapshot, meta: page.stats,
      });
      seam.mockResolvedValue({ ...page, page: 2 });
      await get(request(`page=2&snapshot=${snapshot}`));
      expect(auth).toHaveBeenCalledTimes(2);
      expect(seam.mock.calls[1][0]).toEqual({ role: "OPERATIONS", email: "ops@example.test" });
    });

    it("rejects changed and out-of-range sequences with no rows", async () => {
      const stale = await get(request(`page=2&snapshot=${"b".repeat(32)}`));
      expect(stale.status).toBe(409);
      expect(await checkHeaders(stale)).not.toHaveProperty("rows");
      seam.mockResolvedValue({ ...page, page: 4 });
      const range = await get(request(`page=4&snapshot=${snapshot}`));
      expect(range.status).toBe(416);
      await checkHeaders(range);
    });

    it("denies absent sessions and refreshes role/feature restrictions", async () => {
      auth.mockResolvedValue(null);
      const absent = await get(request());
      expect(absent.status).toBe(401);
      await checkHeaders(absent);
      expect(seam).not.toHaveBeenCalled();
      auth.mockResolvedValue({ user: { role: "ADVISOR" }, navigationScope: "new-login" });
      seam.mockResolvedValue({ ok: false, reason: "forbidden" });
      const denied = await get(request());
      expect(denied.status).toBe(403);
      expect(denied.headers.get("x-aoa-navigation-scope")).toBe("new-login");
      await checkHeaders(denied);
      seam.mockResolvedValue({ ok: false, reason: "disabled" });
      const disabled = await get(request());
      expect(disabled.status).toBe(404);
      await checkHeaders(disabled);
    });

    it("keeps invalid requests and auth/database errors private and uncacheable", async () => {
      const invalid = await get(request("page=2"));
      expect(invalid.status).toBe(400);
      await checkHeaders(invalid);
      expect(seam).not.toHaveBeenCalled();
      seam.mockRejectedValue(new Error("private row or SQL"));
      const failed = await get(request());
      expect(failed.status).toBe(503);
      expect(JSON.stringify(await checkHeaders(failed))).not.toContain("private row");
      auth.mockRejectedValue(new Error("credential"));
      const authFailed = await get(request());
      expect(authFailed.status).toBe(503);
      await checkHeaders(authFailed);
    });
  },
);
