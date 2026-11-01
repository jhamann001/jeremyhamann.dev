import { describe, expect, it } from "vitest";
import type { AssigneeOption, TicketListQuery } from "@/types/domain";
import { buildTicketFilterChips } from "@/components/dashboard/ticket-filter-chips";
import {
  DEFAULT_DIR,
  DEFAULT_PAGE_SIZE,
  DEFAULT_SORT,
  DEFAULT_STATUS_FILTER,
  ticketQueryToParams,
} from "@/components/dashboard/ticket-query-params";

const BASE: TicketListQuery = {
  status: [...DEFAULT_STATUS_FILTER],
  sort: DEFAULT_SORT,
  dir: DEFAULT_DIR,
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
};

const ASSIGNEES: AssigneeOption[] = [
  { id: "u1", name: "Dana Fields", email: "dana@example.com", image: null, groups: ["client_services"] },
  { id: "u2", name: null, email: "sam@example.com", image: null, groups: ["ops_team"] },
];

const chips = (q: TicketListQuery, showQueue = true) =>
  buildTicketFilterChips(q, { showQueue, assignees: ASSIGNEES });

const keys = (q: TicketListQuery, showQueue = true) => chips(q, showQueue).map((c) => c.key);

/** The params a chip is NOT expected to cover: the search box is visible, pagination is not a filter. */
const NON_CHIP_PARAMS = new Set(["search", "page", "pageSize"]);

/** Which URL param each chip-key prefix answers for. The "sort" chip resets both halves, hence two. */
const PARAMS_BY_CHIP_PREFIX: Readonly<Record<string, readonly string[]>> = {
  status: ["status"],
  priority: ["priority"],
  sla: ["slaStatus"],
  assignee: ["assigneeId"],
  queue: ["queueKey"],
  category: ["category"],
  brand: ["brand"],
  source: ["source"],
  complaint: ["isComplaint"],
  followUp: ["followUp"],
  createdFrom: ["createdFrom"],
  createdTo: ["createdTo"],
  requesterEmail: ["requesterEmail"],
  sort: ["sort", "dir"],
};

describe("buildTicketFilterChips — coverage of every serialized predicate", () => {
  /**
   * The rule this module exists to hold. `brand` and `source` were serialized, parsed and turned into
   * SQL predicates while no chip, no Filters count and no "Clear all" acknowledged them, so a phone
   * user had no control anywhere that could remove them.
   */
  it("produces a chip for every key ticketQueryToParams writes", () => {
    const everything: TicketListQuery = {
      ...BASE,
      queueKey: "OPERATIONS",
      status: ["NEW"],
      priority: ["URGENT"],
      slaStatus: ["BREACHED"],
      category: ["COMPLAINT"],
      brand: ["CEDAR_RIDGE_DIRECT"],
      source: ["EMAIL"],
      isComplaint: true,
      followUp: "overdue",
      createdFrom: "2026-09-01T00:00:00.000Z",
      createdTo: "2026-09-20T00:00:00.000Z",
      requesterEmail: "jane@example.com",
      assigneeId: "u1",
      search: "wire",
      sort: "createdAt",
      dir: "desc",
    };
    const params = [...ticketQueryToParams(everything, { includeQueueKey: true }).keys()].filter(
      (k) => !NON_CHIP_PARAMS.has(k),
    );
    const covered = new Set<string>();
    for (const key of keys(everything)) {
      const prefix = key.split(":")[0];
      const mapped = PARAMS_BY_CHIP_PREFIX[prefix];
      expect(mapped, `chip key "${key}" is not mapped to a URL param`).toBeDefined();
      for (const param of mapped ?? []) covered.add(param);
    }
    for (const param of params) {
      expect(covered.has(param), `no chip covers "${param}"`).toBe(true);
    }
    expect(covered.has("brand")).toBe(true);
    expect(covered.has("source")).toBe(true);
  });

  it("is empty for the default query, so the Filters trigger shows no count", () => {
    expect(chips(BASE)).toEqual([]);
  });
});

describe("buildTicketFilterChips — brand and source", () => {
  it("labels each selected brand and removes only that one", () => {
    const q: TicketListQuery = { ...BASE, brand: ["CEDAR_RIDGE_WEALTH", "CEDAR_RIDGE_DIRECT"] };
    const built = chips(q);
    const brandChips = built.filter((c) => c.key.startsWith("brand:"));
    expect(brandChips.map((c) => c.label)).toEqual(["Cedar Ridge Wealth", "Cedar Ridge Direct"]);
    expect(brandChips[1].next.brand).toEqual(["CEDAR_RIDGE_WEALTH"]);
  });

  it("drops the brand key entirely when the last brand is removed", () => {
    const q: TicketListQuery = { ...BASE, brand: ["CEDAR_RIDGE_DIRECT"] };
    const only = chips(q).find((c) => c.key === "brand:CEDAR_RIDGE_DIRECT");
    expect(only).toBeDefined();
    expect(only?.next.brand).toBeUndefined();
    expect("brand" in (only?.next ?? {})).toBe(false);
  });

  it("prefixes source labels so \"Email\" reads as a channel, not a category", () => {
    const built = chips({ ...BASE, source: ["EMAIL", "VOICEMAIL"] });
    expect(built.map((c) => c.label)).toEqual(["Source: Email", "Source: Voicemail"]);
    expect(built[0].next.source).toEqual(["VOICEMAIL"]);
  });

  it("counts brand and source toward the active count like every other predicate", () => {
    expect(chips({ ...BASE, brand: ["CEDAR_RIDGE_DIRECT"], source: ["EMAIL", "PHONE"] })).toHaveLength(3);
  });
});

describe("buildTicketFilterChips — the pre-existing predicates are unchanged", () => {
  it("says nothing about the default status set but chips any other set", () => {
    expect(keys(BASE)).toEqual([]);
    expect(keys({ ...BASE, status: ["NEW", "OPEN"] })).toEqual(["status:NEW", "status:OPEN"]);
  });

  it("names a known assignee, the two literals, and an unknown id", () => {
    const label = (assigneeId: string) => chips({ ...BASE, assigneeId })[0].label;
    expect(label("u1")).toBe("Dana Fields");
    expect(label("u2")).toBe("sam@example.com");
    expect(label("me")).toBe("Assigned to me");
    expect(label("unassigned")).toBe("Unassigned");
    expect(label("ghost")).toBe("Selected user");
  });

  it("chips the queue only when the route does not pin it", () => {
    const q: TicketListQuery = { ...BASE, queueKey: "OPERATIONS" };
    expect(keys(q, true)).toEqual(["queue"]);
    expect(keys(q, false)).toEqual([]);
  });

  it("renders the created bounds as the local calendar days the operator picked", () => {
    const from = new Date(2026, 8, 1, 0, 0, 0, 0).toISOString();
    const toExclusive = new Date(2026, 8, 20, 0, 0, 0, 0).toISOString();
    const built = chips({ ...BASE, createdFrom: from, createdTo: toExclusive });
    expect(built.map((c) => c.label)).toEqual(["Created from 2026-09-01", "Created to 2026-09-19"]);
    expect(built[0].next.createdFrom).toBeUndefined();
    expect(built[1].next.createdTo).toBeUndefined();
  });

  it("chips a non-default sort and resets both halves on removal", () => {
    const built = chips({ ...BASE, sort: "createdAt", dir: "desc" });
    expect(built).toHaveLength(1);
    expect(built[0].label).toBe("Sort: Created ↓");
    expect(built[0].next.sort).toBe(DEFAULT_SORT);
    expect(built[0].next.dir).toBe(DEFAULT_DIR);
  });

  it("chips the complaint and follow-up filters in both of their states", () => {
    expect(chips({ ...BASE, isComplaint: true })[0].label).toBe("Complaints");
    expect(chips({ ...BASE, isComplaint: false })[0].label).toBe("Not complaints");
    expect(chips({ ...BASE, followUp: "overdue" })[0].label).toBe("Follow-up overdue");
  });

  it("never carries a removed predicate into the next query", () => {
    const q: TicketListQuery = { ...BASE, isComplaint: true, requesterEmail: "jane@example.com" };
    const complaint = chips(q).find((c) => c.key === "complaint");
    expect(complaint?.next.isComplaint).toBeUndefined();
    expect(complaint?.next.requesterEmail).toBe("jane@example.com");
  });
});
