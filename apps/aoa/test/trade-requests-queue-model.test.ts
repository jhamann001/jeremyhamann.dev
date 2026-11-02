import { describe, expect, it } from "vitest";
import {
  COUNT_TILES, DEFAULT_QUEUE_SORT, QUEUE_COPY, QUEUE_POLL_INTERVAL_MS, QUEUE_SEARCH_DELAY_MS,
  emptyQueueMessage, homeFirstName, householdLabel, nextQueueSort, parseCounts, parseRequestPage,
  queueColumns, sortQueueEntries, submitterLabel, type TradeRequestListEntry,
} from "@/lib/trade-requests/queue-model";
import { queueRequestRoute, requestIdFromPath, tradeRequestDetailRoute } from "@/lib/trade-requests/routes";

const entry = (id: string, over: Partial<TradeRequestListEntry> = {}): TradeRequestListEntry => ({
  id, clientName: `Client ${id}`, clientNames: [`Client ${id}`], advisor: "Rachel Moss", submittedBy: "Avery Stone",
  tradeType: "Raise Cash", status: "Pending Review", date: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z", ...over,
});
const ids = (entries: TradeRequestListEntry[]) => entries.map((e) => e.id);

describe("Trading Queue columns (AC-69)", () => {
  it("reviewers get Advisor and Submitted by between Date and Status", () => {
    expect(queueColumns(true).map((c) => c.label)).toEqual(["Request ID", "Household", "Trade Type", "Date", "Advisor", "Submitted by", "Status"]);
  });
  it("advisors get the five shared columns", () => {
    expect(queueColumns(false).map((c) => c.label)).toEqual(["Request ID", "Household", "Trade Type", "Date", "Status"]);
  });
  it("household joins every client name with ' & '; submitter falls back to the advisor", () => {
    expect(householdLabel(entry("a", { clientNames: ["Alexie Neil", "Bo Neil"] }))).toBe("Alexie Neil & Bo Neil");
    expect(householdLabel(entry("a", { clientName: "Solo", clientNames: ["Solo"] }))).toBe("Solo");
    expect(submitterLabel(entry("a", { submittedBy: "" }))).toBe("Rachel Moss");
    expect(submitterLabel(entry("a"))).toBe("Avery Stone");
  });
});

describe("Trading Queue sorting (AC-70, AC-75, AC-76)", () => {
  const listed = [
    entry("REQ-B", { date: "2026-10-02T00:00:00Z", tradeType: "Liquidate" }),
    entry("REQ-C", { date: "2026-10-03T00:00:00Z", tradeType: "Initial Funding" }),
    entry("REQ-A", { date: "2026-10-01T00:00:00Z", tradeType: "Raise Cash" }),
  ];

  it("defaults to Date, newest first", () => {
    expect(DEFAULT_QUEUE_SORT).toEqual({ key: "date", dir: "desc" });
    expect(ids(sortQueueEntries(listed, DEFAULT_QUEUE_SORT))).toEqual(["REQ-C", "REQ-B", "REQ-A"]);
  });

  it("a header that is not the current sort column sorts ascending", () => {
    expect(nextQueueSort({ key: "date", dir: "desc" }, "id")).toEqual({ key: "id", dir: "asc" });
    expect(nextQueueSort({ key: "id", dir: "desc" }, "tradeType")).toEqual({ key: "tradeType", dir: "asc" });
    expect(ids(sortQueueEntries(listed, { key: "id", dir: "asc" }))).toEqual(["REQ-A", "REQ-B", "REQ-C"]);
    expect(ids(sortQueueEntries(listed, { key: "tradeType", dir: "asc" }))).toEqual(["REQ-C", "REQ-B", "REQ-A"]);
  });

  it("the current sort column reverses", () => {
    expect(nextQueueSort({ key: "id", dir: "asc" }, "id")).toEqual({ key: "id", dir: "desc" });
    expect(nextQueueSort({ key: "id", dir: "desc" }, "id")).toEqual({ key: "id", dir: "asc" });
    expect(ids(sortQueueEntries(listed, { key: "id", dir: "desc" }))).toEqual(["REQ-C", "REQ-B", "REQ-A"]);
  });

  it("reorders only what is listed and leaves the input untouched", () => {
    const before = ids(listed);
    expect(sortQueueEntries(listed, { key: "id", dir: "asc" })).toHaveLength(3);
    expect(ids(listed)).toEqual(before);
  });

  it("Status ascending follows the workflow sequence with any other status last; descending reverses it", () => {
    const statuses = ["Completed", "On Hold", "Rejected", "Approved", "", "Pending Current Asset Liquidation", "Needs Info", "Pending Review", "constructor"];
    const byStatus = statuses.map((status, i) => entry(`R${i}`, { status }));
    const asc = sortQueueEntries(byStatus, { key: "status", dir: "asc" }).map((e) => e.status);
    expect(asc.slice(0, 6)).toEqual(["Pending Review", "Needs Info", "Pending Current Asset Liquidation", "Approved", "Rejected", "Completed"]);
    expect(new Set(asc.slice(6))).toEqual(new Set(["On Hold", "", "constructor"]));
    const desc = sortQueueEntries(byStatus, { key: "status", dir: "desc" }).map((e) => e.status);
    expect(new Set(desc.slice(0, 3))).toEqual(new Set(["On Hold", "", "constructor"]));
    expect(desc.slice(3)).toEqual(["Completed", "Rejected", "Approved", "Pending Current Asset Liquidation", "Needs Info", "Pending Review"]);
  });

  it("sorts Household, Advisor and Submitted by on their displayed text", () => {
    const people = [
      entry("1", { clientNames: ["Zed", "Amy"], clientName: "Zed", advisor: "B", submittedBy: "" }),
      entry("2", { clientNames: ["Bea"], clientName: "Bea", advisor: "A", submittedBy: "Cy" }),
    ];
    expect(ids(sortQueueEntries(people, { key: "household", dir: "asc" }))).toEqual(["2", "1"]);
    expect(ids(sortQueueEntries(people, { key: "advisor", dir: "asc" }))).toEqual(["2", "1"]);
    expect(ids(sortQueueEntries(people, { key: "submittedBy", dir: "asc" }))).toEqual(["1", "2"]);
  });
});

describe("Home and queue copy", () => {
  it("matches the design pass byte for byte", () => {
    expect(QUEUE_COPY.homeTitle("Dana")).toBe("Welcome back, Dana");
    expect(QUEUE_COPY.homeDescription).toBe("Here\u0027s a snapshot of your trade activity.");
    expect(QUEUE_COPY.statsError).toBe("Unable to load stats.");
    expect(QUEUE_COPY.queueReviewerDescription).toBe("Review and manage all pending trade requests.");
    expect(QUEUE_COPY.queueAdvisorDescription).toBe("View all trade requests and their status.");
    expect(QUEUE_COPY.loading).toBe("Loading requests...");
    expect(QUEUE_COPY.searchPlaceholder).toBe("Search all requests (ID, client, type, advisor, submitter, status)\u2026");
    expect(QUEUE_COPY.refreshFailed).toBe("Unable to refresh \u2014 showing last loaded data.");
    expect(QUEUE_COPY.noMatches).toBe("No requests match your search.");
    expect(QUEUE_COPY.noRequests).toBe("No active trade requests found.");
    expect(QUEUE_COPY.loadFailed).toBe("Failed to load requests");
    expect(QUEUE_COPY.loadingMore).toBe("Loading...");
    expect(COUNT_TILES.map((t) => t.label)).toEqual(["Total Requests", "Pending Review", "Needs Info", "Approved / Done"]);
    expect(COUNT_TILES.map((t) => t.hint)).toEqual([
      "All submitted trade requests", "Awaiting trader review", "Returned to advisor for clarification", "Approved or completed requests",
    ]);
  });

  it("empty line depends on the typed search term (AC-116, AC-117)", () => {
    expect(emptyQueueMessage("aufderhar")).toBe("No requests match your search.");
    expect(emptyQueueMessage("   ")).toBe("No active trade requests found.");
    expect(emptyQueueMessage("")).toBe("No active trade requests found.");
  });

  it("schedule constants match the standalone app (AC-113, AC-114)", () => {
    expect(QUEUE_POLL_INTERVAL_MS).toBe(30_000);
    expect(QUEUE_SEARCH_DELAY_MS).toBe(300);
  });

  it("first name comes from the session name, else the email", () => {
    expect(homeFirstName("Dana Admin", "admin@x.invalid")).toBe("Dana");
    expect(homeFirstName("  ", "admin@x.invalid")).toBe("admin");
    expect(homeFirstName(null, null)).toBe("");
  });

  it("detail route encodes the request id", () => {
    expect(tradeRequestDetailRoute("REQ-3Z7G")).toBe("/trade-requests/REQ-3Z7G");
    expect(tradeRequestDetailRoute("a/b?c")).toBe("/trade-requests/a%2Fb%3Fc");
    expect(queueRequestRoute("a/b?c")).toBe("/trade-requests/queue/a%2Fb%3Fc");
    expect(requestIdFromPath("/trade-requests/queue/a%2Fb%3Fc")).toBe("a/b?c");
    expect(requestIdFromPath("/trade-requests/REQ-3Z7G")).toBe("REQ-3Z7G");
    expect(requestIdFromPath("/trade-requests/queue/queue")).toBe("queue");
    for (const path of ["/trade-requests", "/trade-requests/queue", "/trade-requests/new", "/trade-requests/new/x", "/trade-requests/queue/a/b", "/trade-requests/%E0%A4%A", null]) {
      expect(requestIdFromPath(path)).toBeNull();
    }
  });
});

describe("response parsing", () => {
  it("counts need four non-negative integers (AC-31)", () => {
    expect(parseCounts({ total: 112, pendingReview: 20, needsInfo: 19, approved: 37 })).toEqual({ total: 112, pendingReview: 20, needsInfo: 19, approved: 37 });
    expect(parseCounts({ total: 1, pendingReview: 0, needsInfo: 0 })).toBeNull();
    expect(parseCounts({ total: -1, pendingReview: 0, needsInfo: 0, approved: 0 })).toBeNull();
    expect(parseCounts(null)).toBeNull();
  });

  it("a page keeps whole entries and normalizes the fields the queue reads", () => {
    const page = parseRequestPage({ data: [{ id: "REQ-1", clientNames: ["A", 3], extra: { keep: true } }], nextCursor: "c1" });
    expect(page?.nextCursor).toBe("c1");
    expect(page?.data[0]).toMatchObject({ id: "REQ-1", clientName: "A", clientNames: ["A"], status: "", extra: { keep: true } });
    expect(parseRequestPage({ data: [], nextCursor: "" })).toEqual({ data: [], nextCursor: null });
    expect(parseRequestPage({ data: [{ nope: 1 }], nextCursor: null })).toBeNull();
    expect(parseRequestPage({ data: "x" })).toBeNull();
    expect(parseRequestPage({ data: [], nextCursor: 5 })).toBeNull();
  });
});
