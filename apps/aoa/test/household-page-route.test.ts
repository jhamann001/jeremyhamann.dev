import { beforeEach, describe, expect, it, vi } from "vitest";

const { authMock, directoryMock } = vi.hoisted(() => ({ authMock: vi.fn(), directoryMock: vi.fn() }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/data/households", () => ({ getHouseholdDirectory: directoryMock }));

import { GET } from "@/app/api/households/route";

const VERSION = "a".repeat(32);
const SCOPE = "b".repeat(64);
const envelope = () => ({
  snapshot: VERSION,
  rows: [{ sf_id: "synthetic-household", name: "Synthetic Household", aum: 100 }],
  total: 205, page: 1, pageCount: 3, pageSize: 100,
  counts: { all: 210, client: 205, lost_client: 5 },
  summaryCounts: { clients: 205, prospects: 0, lost: 5 },
  advisorOptions: [{ value: "advisor@example.test", label: "Advisor" }], statusOptions: ["Active"],
  aumSplit: { total: 100, firm: 0, employee: 0, available: true },
});

const request = (query = "") => new Request(`https://ops-portal.example.test/api/households?${query}`);

describe("Households paging API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { role: "ADVISOR", email: "one@example.test" }, navigationScope: SCOPE });
    directoryMock.mockResolvedValue(envelope());
  });

  it("authenticates before validation or any database read", async () => {
    authMock.mockResolvedValue(null);
    const response = await GET(request("role=ADMIN"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(directoryMock).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.has("X-AOA-Navigation-Scope")).toBe(false);
  });

  it("returns a bounded page with complete scoped totals/options and no caching", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...envelope(), queryKey: "" });
    expect(response.headers.get("Vary")).toBe("Cookie");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-AOA-Navigation-Scope")).toBe(SCOPE);
    expect(directoryMock).toHaveBeenCalledWith(
      { role: "ADVISOR", email: "one@example.test" },
      { query: "", stage: "client", advisor: "", status: "", sortKey: "name", sortDir: "asc" },
      1, 100,
    );
  });

  it("returns the fresh opaque login scope even when a new login sees identical content", async () => {
    const first = await GET(request());
    const nextScope = "c".repeat(64);
    authMock.mockResolvedValue({
      user: { role: "ADVISOR", email: "one@example.test" }, navigationScope: nextScope,
      sessionToken: "private-synthetic-session-credential",
    });
    directoryMock.mockResolvedValue({ ...envelope(), page: 2 });
    const second = await GET(request(`page=2&snapshot=${VERSION}`));
    expect(first.headers.get("X-AOA-Navigation-Scope")).toBe(SCOPE);
    expect(second.status).toBe(200);
    expect(second.headers.get("X-AOA-Navigation-Scope")).toBe(nextScope);
    expect(JSON.stringify([...second.headers])).not.toContain("private-synthetic-session-credential");
    expect(await second.json()).toEqual({ ...envelope(), page: 2, queryKey: "" });
  });

  it.each([undefined, null])("uses an empty no-memory scope for a legacy JWT: %s", async (navigationScope) => {
    authMock.mockResolvedValue({ user: { role: "ADVISOR", email: "one@example.test" }, navigationScope });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("X-AOA-Navigation-Scope")).toBe("");
  });

  it("reauthorizes every append, taking identity only from the current session", async () => {
    await GET(request());
    authMock.mockResolvedValue({ user: { role: "VIEWER", email: "two@example.test" } });
    directoryMock.mockResolvedValue({ ...envelope(), rows: [], page: 2 });
    await GET(request(`page=2&snapshot=${VERSION}`));
    expect(authMock).toHaveBeenCalledTimes(2);
    expect(directoryMock.mock.calls[1][0]).toEqual({ role: "VIEWER", email: "two@example.test" });
  });

  it("fails closed when role or email is absent", async () => {
    authMock.mockResolvedValue({ user: {} });
    await GET(request());
    expect(directoryMock.mock.calls[0][0]).toEqual({ role: "VIEWER", email: null });
  });

  it.each(["q=one&q=two", "role=ADMIN", "page=2", "pageSize=9999999", "q=%00"])(
    "rejects invalid %s before the data call", async (query) => {
      const response = await GET(request(query));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_household_query" });
      expect(response.headers.get("X-AOA-Navigation-Scope")).toBe(SCOPE);
      expect(directoryMock).not.toHaveBeenCalled();
    },
  );

  it("discards all data when an ingest, permission or order change invalidates offsets", async () => {
    directoryMock.mockResolvedValue({ ...envelope(), page: 2, snapshot: "b".repeat(32) });
    const response = await GET(request(`page=2&snapshot=${VERSION}`));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "household_directory_changed" });
    expect(response.headers.get("X-AOA-Navigation-Scope")).toBe(SCOPE);
  });

  it("prevents appending the same last page when the data seam clamps an overrun", async () => {
    directoryMock.mockResolvedValue({ ...envelope(), page: 3 });
    const response = await GET(request(`page=4&snapshot=${VERSION}`));
    expect(response.status).toBe(416);
    expect(await response.json()).toEqual({ error: "household_page_out_of_range" });
    expect(response.headers.get("X-AOA-Navigation-Scope")).toBe(SCOPE);
  });

  it("uses generic retryable failures without leaking database errors or search text", async () => {
    directoryMock.mockRejectedValue(new Error("private synthetic SQL result one@example.test"));
    const response = await GET(request("q=private+household"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "household_directory_unavailable" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-AOA-Navigation-Scope")).toBe(SCOPE);
  });
});
