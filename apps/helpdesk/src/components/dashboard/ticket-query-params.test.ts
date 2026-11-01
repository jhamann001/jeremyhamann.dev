import { describe, expect, it } from "vitest";
import type { TicketListQuery } from "@/types/domain";
import {
  DEFAULT_DIR,
  DEFAULT_PAGE_SIZE,
  DEFAULT_SORT,
  DEFAULT_STATUS_FILTER,
  dateInputToIsoEndExclusive,
  dateInputToIsoStart,
  hasActiveFilters,
  isoEndExclusiveToDateInput,
  isoToDateInput,
  sameSet,
  ticketExportHref,
  ticketQueryHref,
  ticketQueryToParams,
} from "@/components/dashboard/ticket-query-params";

const BASE: TicketListQuery = {
  status: [...DEFAULT_STATUS_FILTER],
  sort: DEFAULT_SORT,
  dir: DEFAULT_DIR,
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
};

const params = (q: TicketListQuery, includeQueueKey = true): URLSearchParams =>
  ticketQueryToParams(q, { includeQueueKey });

describe("sameSet", () => {
  it("ignores order and rejects different lengths", () => {
    expect(sameSet(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameSet(["a"], ["a", "b"])).toBe(false);
  });
});

describe("ticketQueryToParams — defaults", () => {
  it("writes nothing for the default query", () => {
    expect(params(BASE).toString()).toBe("");
  });

  it("omits the default status set but writes any other set", () => {
    expect(params({ ...BASE, status: ["NEW"] }).getAll("status")).toEqual(["NEW"]);
  });

  it("drops queueKey when the route pins it", () => {
    expect(params({ ...BASE, queueKey: "OPERATIONS" }, false).has("queueKey")).toBe(false);
    expect(params({ ...BASE, queueKey: "OPERATIONS" }, true).get("queueKey")).toBe("OPERATIONS");
  });
});

describe("ticketQueryToParams — Wave A filters", () => {
  it("repeats bare keys for category, brand and source (convention 12)", () => {
    const p = params({
      ...BASE,
      category: ["COMPLAINT", "COST_BASIS"],
      brand: ["CEDAR_RIDGE_DIRECT"],
      source: ["EMAIL", "VOICEMAIL"],
    });
    expect(p.getAll("category")).toEqual(["COMPLAINT", "COST_BASIS"]);
    expect(p.getAll("brand")).toEqual(["CEDAR_RIDGE_DIRECT"]);
    expect(p.getAll("source")).toEqual(["EMAIL", "VOICEMAIL"]);
    expect(p.toString()).not.toContain("category[]");
  });

  it("writes isComplaint in both directions and omits it when undefined", () => {
    expect(params({ ...BASE, isComplaint: true }).get("isComplaint")).toBe("true");
    expect(params({ ...BASE, isComplaint: false }).get("isComplaint")).toBe("false");
    expect(params(BASE).has("isComplaint")).toBe(false);
  });

  it("writes the follow-up filter verbatim", () => {
    expect(params({ ...BASE, followUp: "overdue" }).get("followUp")).toBe("overdue");
  });

  it("lower-cases and trims requesterEmail, and drops it when blank", () => {
    expect(params({ ...BASE, requesterEmail: "  Jane.Doe@Example.COM " }).get("requesterEmail")).toBe(
      "jane.doe@example.com",
    );
    expect(params({ ...BASE, requesterEmail: "   " }).has("requesterEmail")).toBe(false);
  });

  it("carries the created-date bounds through unchanged", () => {
    const p = params({ ...BASE, createdFrom: "2026-09-01T00:00:00.000Z", createdTo: "2026-09-20T00:00:00.000Z" });
    expect(p.get("createdFrom")).toBe("2026-09-01T00:00:00.000Z");
    expect(p.get("createdTo")).toBe("2026-09-20T00:00:00.000Z");
  });
});

describe("hasActiveFilters", () => {
  it("is false for the default query and for pagination or sort alone", () => {
    expect(hasActiveFilters(BASE, { includeQueueKey: true })).toBe(false);
    expect(hasActiveFilters({ ...BASE, page: 4, sort: "createdAt", dir: "desc" }, { includeQueueKey: true })).toBe(false);
  });

  it("is true for each Wave A filter on its own", () => {
    const cases: TicketListQuery[] = [
      { ...BASE, category: ["COMPLAINT"] },
      { ...BASE, brand: ["CEDAR_RIDGE_DIRECT"] },
      { ...BASE, source: ["EMAIL"] },
      { ...BASE, isComplaint: false },
      { ...BASE, followUp: "due" },
      { ...BASE, createdFrom: "2026-09-01T00:00:00.000Z" },
      { ...BASE, createdTo: "2026-09-20T00:00:00.000Z" },
      { ...BASE, requesterEmail: "jane@example.com" },
    ];
    for (const q of cases) expect(hasActiveFilters(q, { includeQueueKey: true })).toBe(true);
  });
});

describe("ticketQueryHref", () => {
  it("returns the bare pathname when nothing is set", () => {
    expect(ticketQueryHref("/dashboard", BASE, { includeQueueKey: true })).toBe("/dashboard");
  });

  it("appends the query string otherwise", () => {
    expect(ticketQueryHref("/dashboard", { ...BASE, isComplaint: true }, { includeQueueKey: true })).toBe(
      "/dashboard?isComplaint=true",
    );
  });
});

describe("ticketExportHref", () => {
  it("drops pagination so the file covers the whole filtered set", () => {
    const href = ticketExportHref({ ...BASE, page: 3, pageSize: 200, isComplaint: true });
    expect(href).toContain("isComplaint=true");
    expect(href).not.toContain("page=");
    expect(href).not.toContain("pageSize=");
  });

  it("always carries the queue key — the route has no pinned-queue context", () => {
    expect(ticketExportHref({ ...BASE, queueKey: "CLIENT_SERVICE" })).toContain("queueKey=CLIENT_SERVICE");
  });

  it("writes scope only for the full (compliance) scope", () => {
    expect(ticketExportHref(BASE, "standard")).toBe("/api/tickets/export");
    expect(ticketExportHref(BASE, "full")).toBe("/api/tickets/export?scope=full");
  });

  it("keeps sort and dir so the CSV row order matches the screen", () => {
    const href = ticketExportHref({ ...BASE, sort: "createdAt", dir: "desc" });
    expect(href).toContain("sort=createdAt");
    expect(href).toContain("dir=desc");
  });
});

describe("created-date range helpers", () => {
  it("turns a date input into local midnight and back", () => {
    const iso = dateInputToIsoStart("2026-09-19");
    expect(iso).toBeDefined();
    const at = new Date(iso as string);
    expect(at.getHours()).toBe(0);
    expect(at.getMinutes()).toBe(0);
    expect(isoToDateInput(iso)).toBe("2026-09-19");
  });

  it("makes the `to` bound exclusive — the day after the one the operator picked", () => {
    const iso = dateInputToIsoEndExclusive("2026-09-19");
    expect(iso).toBeDefined();
    expect(new Date(iso as string).getDate()).toBe(20);
    expect(isoEndExclusiveToDateInput(iso)).toBe("2026-09-19");
  });

  it("round-trips across a month and a year boundary", () => {
    expect(isoEndExclusiveToDateInput(dateInputToIsoEndExclusive("2026-09-30"))).toBe("2026-09-30");
    expect(isoEndExclusiveToDateInput(dateInputToIsoEndExclusive("2026-12-31"))).toBe("2026-12-31");
    expect(isoToDateInput(dateInputToIsoStart("2027-01-01"))).toBe("2027-01-01");
  });

  it("rejects blanks and impossible dates instead of rolling them over", () => {
    expect(dateInputToIsoStart("")).toBeUndefined();
    expect(dateInputToIsoStart("not-a-date")).toBeUndefined();
    expect(dateInputToIsoStart("2026-02-31")).toBeUndefined();
    expect(dateInputToIsoEndExclusive("2026-13-01")).toBeUndefined();
  });

  it("returns an empty input value for missing or unparseable ISO", () => {
    expect(isoToDateInput(undefined)).toBe("");
    expect(isoToDateInput("nonsense")).toBe("");
    expect(isoEndExclusiveToDateInput(undefined)).toBe("");
    expect(isoEndExclusiveToDateInput("nonsense")).toBe("");
  });
});
