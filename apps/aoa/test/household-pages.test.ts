import { describe, expect, it, vi } from "vitest";
import type { HouseholdDirectoryPage } from "@/lib/data/households";
import type { HouseholdListRow } from "@/lib/data/types";
import { appendHouseholdRows, fetchHouseholdPage, HouseholdPageError } from "@/lib/navigation/household-pages";
import { DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS as FILTERS } from "@/lib/navigation/household-query";

const SNAPSHOT = "a".repeat(32);
const SCOPE = "b".repeat(64);
const SCOPE_HEADER = "X-AOA-Navigation-Scope";
const row = (n: number): HouseholdListRow => ({
  sf_id: `synthetic-${n}`, name: `Synthetic ${n}`, stage: "Client", status: "Active",
  lead_advisor_email: "synthetic@example.test", household_kind: "CLIENT", advisor_name: null,
  member_count: 1, aum: 100, aum_source: "mirror", employeeStatus: null,
});
function envelope(page = 1, total = 205): HouseholdDirectoryPage & { queryKey: string } {
  return {
    snapshot: SNAPSHOT, queryKey: "", total, page, pageSize: 100,
    pageCount: Math.max(1, Math.ceil(total / 100)),
    rows: Array.from({ length: Math.max(0, Math.min(100, total - ((page - 1) * 100))) }, (_, i) => row((page - 1) * 100 + i)),
    counts: { all: total, client: total, lost_client: 0 },
    summaryCounts: { clients: total, prospects: 0, lost: 0 }, advisorOptions: [], statusOptions: [],
    aumSplit: { total: null, firm: null, employee: null, available: false },
  };
}
const fetcher = (response: Response) => vi.fn<typeof fetch>().mockResolvedValue(response);
const pageResponse = (body: unknown, scope = SCOPE) => Response.json(body, { headers: { [SCOPE_HEADER]: scope } });

describe("Household progressive append validation", () => {
  it("accepts mixed-custodian row provenance and scoped source metadata", async () => {
    const mixed = { ...row(1), aum_source: "custodians" as const };
    expect(appendHouseholdRows([], [mixed])).toEqual([mixed]);
    const body = envelope(1, 1);
    body.rows = [mixed];
    body.aumSplit.sources = [{ custodian: "Schwab", oldest: "2026-09-17", newest: "2026-09-17", pending: 0 }];
    body.aumSplit.employeeScopeComplete = false;
    expect(await fetchHouseholdPage(FILTERS, 1, null, 100, new AbortController().signal, SCOPE,
      fetcher(pageResponse(body)))).toEqual(body);
  });

  it.each([
    { employeeScopeComplete: "yes" }, { sources: [null] },
    { sources: [{ custodian: "Other", oldest: null, newest: null, pending: 0 }] },
    { sources: [{ custodian: "Schwab", oldest: null, newest: null, pending: -1 }] },
  ])("rejects malformed source/ownership metadata", async (extra) => {
    const body = envelope(1, 1);
    Object.assign(body.aumSplit, extra);
    await expect(fetchHouseholdPage(FILTERS, 1, null, 100, new AbortController().signal, SCOPE,
      fetcher(pageResponse(body)))).rejects.toThrow(HouseholdPageError);
  });
  it("appends in order without mutating either original page", () => {
    const a = [row(1)], b = [row(2)];
    expect(appendHouseholdRows(a, b)).toEqual([row(1), row(2)]);
    expect(a).toEqual([row(1)]);
    expect(b).toEqual([row(2)]);
  });

  it.each([
    [[row(1)], [row(1)]], [[], [row(1), row(1)]], [[row(1), row(1)], []],
  ])("rejects overlapping or already-corrupt rows instead of concealing missing records", (current, next) => {
    expect(() => appendHouseholdRows(current, next)).toThrow(new HouseholdPageError("changed"));
  });

  it.each([
    null, {}, { ...row(1), sf_id: "" }, { ...row(1), sf_id: "a/b" }, { ...row(1), name: {} },
    { ...row(1), member_count: -1 }, { ...row(1), member_count: 0.5 }, { ...row(1), aum: NaN },
    { ...row(1), aum: "100" }, { ...row(1), employeeStatus: "UNKNOWN" }, { ...row(1), aum_source: "unknown" },
  ])("rejects a malformed row with a controlled changed-data error", (badRow) => {
    expect(() => appendHouseholdRows([], [badRow] as HouseholdListRow[])).toThrow(new HouseholdPageError("changed"));
  });
});

describe("Household page fetch protocol", () => {
  it("requests bounded same-origin/no-store JSON without following login redirects", async () => {
    const controller = new AbortController();
    const mockFetch = fetcher(pageResponse(envelope(2)));
    expect(await fetchHouseholdPage(FILTERS, 2, SNAPSHOT, 100, controller.signal, SCOPE, mockFetch)).toEqual(envelope(2));
    expect(mockFetch).toHaveBeenCalledWith(`/api/households?page=2&snapshot=${SNAPSHOT}`, {
      signal: controller.signal, cache: "no-store", credentials: "same-origin", redirect: "error",
    });
  });

  it.each([401, 403])("categorizes authentication status%i without reading sensitive response content", async (status) => {
    await expect(fetchHouseholdPage(FILTERS, 1, null, 100, new AbortController().signal, SCOPE,
      fetcher(new Response("private auth error", { status })))).rejects.toEqual(new HouseholdPageError("unauthorized"));
  });

  it.each([409, 416])("requires a new dataset after status%i", async (status) => {
    await expect(fetchHouseholdPage(FILTERS, 1, null, 100, new AbortController().signal, SCOPE,
      fetcher(new Response(null, { status })))).rejects.toEqual(new HouseholdPageError("changed"));
  });

  it.each([400, 404, 429, 500, 503])("keeps status%i retryable and generic", async (status) => {
    await expect(fetchHouseholdPage(FILTERS, 1, null, 100, new AbortController().signal, SCOPE,
      fetcher(new Response("private error", { status })))).rejects.toEqual(new HouseholdPageError("unavailable"));
  });

  it("classifies malformed JSON as unavailable", async () => {
    await expect(fetchHouseholdPage(FILTERS, 1, null, 100, new AbortController().signal, SCOPE,
      fetcher(new Response("<html>login</html>", { headers: { [SCOPE_HEADER]: SCOPE } })))).rejects.toEqual(new HouseholdPageError("unavailable"));
  });

  it.each([1, 2])("rejects a different login before reading page %i, even with identical content", async (page) => {
    const response = pageResponse(envelope(page), "c".repeat(64));
    const readBody = vi.spyOn(response, "json");
    await expect(fetchHouseholdPage(FILTERS, page, page > 1 ? SNAPSHOT : null, 100,
      new AbortController().signal, SCOPE, fetcher(response))).rejects.toEqual(new HouseholdPageError("unauthorized"));
    expect(readBody).not.toHaveBeenCalled();
  });

  it.each([409, 416, 503])("clears the previous login instead of treating status%i as an ordinary paging error", async (status) => {
    const response = new Response("private error", { status, headers: { [SCOPE_HEADER]: "c".repeat(64) } });
    await expect(fetchHouseholdPage(FILTERS, 2, SNAPSHOT, 100, new AbortController().signal, SCOPE,
      fetcher(response))).rejects.toEqual(new HouseholdPageError("unauthorized"));
  });

  it.each([null, "", "not-an-opaque-scope", "b".repeat(65)])("fails closed for a missing or invalid current scope %s", async (scope) => {
    const response = scope === null ? Response.json(envelope()) : pageResponse(envelope(), scope);
    await expect(fetchHouseholdPage(FILTERS, 1, null, 100, new AbortController().signal, SCOPE,
      fetcher(response))).rejects.toEqual(new HouseholdPageError("unauthorized"));
  });

  it("keeps legacy JWT paging usable only while both sides have the empty no-memory scope", async () => {
    await expect(fetchHouseholdPage(FILTERS, 1, null, 100, new AbortController().signal, "",
      fetcher(pageResponse(envelope(), "")))).resolves.toEqual(envelope());
    await expect(fetchHouseholdPage(FILTERS, 1, null, 100, new AbortController().signal, "",
      fetcher(pageResponse(envelope(), SCOPE)))).rejects.toEqual(new HouseholdPageError("unauthorized"));
    await expect(fetchHouseholdPage(FILTERS, 1, null, 100, new AbortController().signal, "",
      fetcher(Response.json(envelope())))).rejects.toEqual(new HouseholdPageError("unauthorized"));
  });

  it.each([
    { total: -1 }, { total: 1.2 }, { page: 2 }, { pageCount: 99 }, { pageSize: 200 },
    { queryKey: "q=other" }, { snapshot: "not-a-version" }, { snapshot: "b".repeat(32) },
    { counts: null }, { summaryCounts: { clients: -1 } }, { advisorOptions: [null] },
    { statusOptions: [{}] }, { aumSplit: { available: false, total: 100, firm: null } },
    { aumSplit: { available: true, total: 100, firm: 10 } },
    { aumSplit: { available: true, total: 100, firm: 10, employee: "20" } },
    { rows: Array.from({ length: 99 }, (_, i) => row(i)) },
    { rows: Array.from({ length: 101 }, (_, i) => row(i)) },
  ])("rejects inconsistent server envelopes %j", async (overrides) => {
    await expect(fetchHouseholdPage(FILTERS, 1, SNAPSHOT, 100, new AbortController().signal, SCOPE,
      fetcher(pageResponse({ ...envelope(), ...overrides })))).rejects.toEqual(new HouseholdPageError("changed"));
  });

  it.each([envelope(3), envelope(1, 0), envelope(1, 100)])("accepts exact final and empty pages", async (page) => {
    await expect(fetchHouseholdPage(FILTERS, page.page, page.page > 1 ? SNAPSHOT : null, 100,
      new AbortController().signal, SCOPE, fetcher(pageResponse(page)))).resolves.toEqual(page);
  });

  it("does not fetch an invalid or unbounded requested page", async () => {
    const mockFetch = fetcher(pageResponse(envelope()));
    for (const [page, size, snapshot] of [[0, 100, null], [2, 100, null], [1, 201, null]] as const) {
      await expect(fetchHouseholdPage(FILTERS, page, snapshot, size, new AbortController().signal, SCOPE, mockFetch))
        .rejects.toEqual(new HouseholdPageError("changed"));
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("ignores work aborted before the fetch or during JSON decoding", async () => {
    const early = new AbortController();
    early.abort();
    const mockFetch = fetcher(pageResponse(envelope()));
    await expect(fetchHouseholdPage(FILTERS, 1, null, 100, early.signal, SCOPE, mockFetch)).rejects.toMatchObject({ name: "AbortError" });
    expect(mockFetch).not.toHaveBeenCalled();

    const delayed = new AbortController();
    const response = { ok: true, status: 200, headers: new Headers({ [SCOPE_HEADER]: SCOPE }),
      json: async () => { delayed.abort(); return envelope(); } } as Response;
    await expect(fetchHouseholdPage(FILTERS, 1, null, 100, delayed.signal, SCOPE, fetcher(response))).rejects.toMatchObject({ name: "AbortError" });
  });
});
