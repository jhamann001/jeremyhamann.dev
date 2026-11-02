import { beforeEach, describe, expect, it, vi } from "vitest";
import { householdHistoryLocation, parseHouseholdHistoryQuery } from "@/lib/navigation/household-history-query";
import { safeListHref } from "@/lib/navigation/list-routes";
vi.mock("server-only", () => ({}));
const { auth, read } = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/data/household-history", () => ({ getHouseholdHistoryPage: read }));
import { GET as tasks } from "@/app/api/navigation/household-tasks/route";
import { GET as emails } from "@/app/api/navigation/household-email/route";
import { GET as activity } from "@/app/api/navigation/household-activity/route";

const scope = "a".repeat(64), snapshot = "b".repeat(64);
const request = (query = "household=001HKTNNUC69064") => new Request(`https://example.test/api/navigation/household-tasks?${query}`);
const fixture = { rows: [{ sf_id: "00TSYN000000001", subject: "Invented row" }], page: 1, pageSize: 100,
  total: 1, pageCount: 1, snapshot, meta: { openCount: 1, completedCount: 7 } };

describe("household history query boundaries", () => {
  it.each(["", "household=../other", "household=x&household=y", "household=x&sourceIds=other", "household=x&page=2",
    "household=x&page=0", "household=x&pageSize=99", "household=x&pageSize=201", "household=x&snapshot=bad",
    "household=x&tasksCompleted=true", "household=x&tasksCompleted=1&tasksCompleted=1", "household=x&tasksAssignee=",
    "household=x&tasksAssignee=all", "household=x&tasksAssignee=005SYN0000000001", `household=x&tasksAssignee=${"A".repeat(64)}`,
    "household=x&tasksAssignee=unassigned&tasksAssignee=unavailable"])("rejects %s", query => {
    expect(() => parseHouseholdHistoryQuery(new URLSearchParams(query), "tasks")).toThrow();
  });
  it.each(["unassigned", "unavailable", "f".repeat(64)])("accepts exact assignment filter %s only for tasks", assignee => {
    const query = new URLSearchParams(`household=hld_synthetic&tasksAssignee=${assignee}`);
    expect(parseHouseholdHistoryQuery(query, "tasks").assigneeFilter).toBe(assignee);
    expect(() => parseHouseholdHistoryQuery(query, "email")).toThrow();
    expect(() => parseHouseholdHistoryQuery(query, "activity")).toThrow();
    expect(safeListHref(`/households/hld_synthetic?tasksAssignee=${assignee}`))
      .toBe(`/households/hld_synthetic?tasksAssignee=${assignee}`);
  });
  it("accepts canonical IDs and bounded pages but never imports unrelated task filters", () => {
    expect(parseHouseholdHistoryQuery(new URLSearchParams(`household=hld_synthetic&page=2&snapshot=${snapshot}&tasksCompleted=1`), "tasks"))
      .toMatchObject({ householdId: "hld_synthetic", page: 2, pageSize: 100, includeCompleted: true });
    expect(() => parseHouseholdHistoryQuery(new URLSearchParams("household=x&tasksCompleted=1"), "email")).toThrow();
  });
  it("keeps a common history occurrence and separate card page windows", () => {
    const search = "accountStatus=closed&accountType=ira&showEmptyAccounts=1&tasksCompleted=1&tasksAssignee=unassigned&list=email&page=3";
    const email = householdHistoryLocation("/households/001SYN000000001", search, "email");
    const task = householdHistoryLocation("/households/001SYN000000001", search, "tasks");
    expect(email.historyHref).toBe(task.historyHref);
    expect(new URL(email.href, "https://example.test").searchParams.get("page")).toBe("3");
    expect(new URL(task.href, "https://example.test").searchParams.has("page")).toBe(false);
    expect(new URL(task.href, "https://example.test").searchParams.get("tasksCompleted")).toBe("1");
    expect(new URL(task.href, "https://example.test").searchParams.get("tasksAssignee")).toBe("unassigned");
    expect(new URL(email.historyHref, "https://example.test").searchParams.get("tasksAssignee")).toBe("unassigned");
    expect(new URL(task.href, "https://example.test").searchParams.get("list")).toBe("tasks");
    expect(new URL(task.href, "https://example.test").searchParams.get("showEmptyAccounts")).toBe("1");
    expect(new URL(email.historyHref, "https://example.test").searchParams.get("showEmptyAccounts")).toBe("1");
  });
  it("rejects malformed, duplicate and source-ID assignment filters in navigation memory", () => {
    for (const suffix of ["tasksAssignee=", "tasksAssignee=all", "tasksAssignee=005SYN0000000001", `tasksAssignee=${"A".repeat(64)}`,
      "tasksAssignee=unassigned&tasksAssignee=unassigned"]) {
      expect(safeListHref(`/households/001SYN000000001?${suffix}`)).toBeNull();
    }
  });
  it("retains only the explicit empty-account option in safe household navigation", () => {
    expect(safeListHref("/households/001SYN000000001?showEmptyAccounts=1"))
      .toBe("/households/001SYN000000001?showEmptyAccounts=1");
    for (const suffix of ["showEmptyAccounts=0", "showEmptyAccounts=true", "showEmptyAccounts=1&showEmptyAccounts=1"]) {
      expect(safeListHref(`/households/001SYN000000001?${suffix}`)).toBeNull();
    }
  });
});

describe.each([["tasks", tasks], ["email", emails], ["activity", activity]] as const)("%s history API", (kind, get) => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.mockResolvedValue({ user: { role: "ADVISOR", email: "invented@example.invalid" }, navigationScope: scope });
    read.mockResolvedValue(fixture);
  });
  it("reauthenticates and passes only validated canonical route ID and current identity", async () => {
    const response = await get(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("x-aoa-navigation-scope")).toBe(scope);
    expect(await response.json()).toEqual(fixture);
    expect(read).toHaveBeenCalledWith({ role: "ADVISOR", email: "invented@example.invalid" }, "001HKTNNUC69064", kind,
      expect.objectContaining({ page: 1, pageSize: 100 }));
    await get(request()); expect(auth).toHaveBeenCalledTimes(2);
  });
  it("returns no records for absent auth, out-of-book identity or malformed input", async () => {
    auth.mockResolvedValue(null);
    expect((await get(request())).status).toBe(401); expect(read).not.toHaveBeenCalled();
    auth.mockResolvedValue({ user: { role: "ADVISOR" }, navigationScope: scope });
    expect((await get(request("household=x&sourceIds=evil"))).status).toBe(400); expect(read).not.toHaveBeenCalled();
    read.mockResolvedValue(null);
    const missing = await get(request()); expect(missing.status).toBe(404);
    expect(await missing.json()).not.toHaveProperty("rows");
  });
  it("rejects changed snapshots and clamped pages before exposing records", async () => {
    const changed = await get(request(`household=x&page=2&snapshot=${"c".repeat(64)}`));
    expect(changed.status).toBe(409); expect(await changed.json()).not.toHaveProperty("rows");
    const overrun = await get(request(`household=x&page=2&snapshot=${snapshot}`));
    expect(overrun.status).toBe(416); expect(await overrun.json()).not.toHaveProperty("rows");
  });
  it("does not echo auth or SQL details on failure", async () => {
    auth.mockRejectedValue(new Error("private auth details"));
    const authFailure = await get(request()); expect(authFailure.status).toBe(503);
    expect(JSON.stringify(await authFailure.json())).not.toContain("private");
    auth.mockResolvedValue({ user: { role: "ADVISOR" }, navigationScope: scope });
    read.mockRejectedValue(new Error("private SQL/body"));
    const failure = await get(request()); expect(failure.status).toBe(503);
    expect(JSON.stringify(await failure.json())).not.toContain("private SQL");
  });
});
