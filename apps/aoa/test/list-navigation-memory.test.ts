import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createListNavigationMemory, getBrowserListNavigationMemory,
  safeHouseholdDetailHref, safeHouseholdListHref,
  type ListNavigationMemoryOptions, type ListNavigationPosition,
} from "@/lib/navigation/list-memory";

const scope = "opaque-user-session-permission-v1";
const otherScope = "opaque-user-session-permission-v2";
const position: ListNavigationPosition = {
  firstPage: 1, lastPage: 3, anchorId: "household-synthetic-215",
  anchorOffset: -12.5, scrollTop: 7520.25, expandedIds: ["synthetic-account-1"],
};

function setup(options: ListNavigationMemoryOptions = {}) {
  let time = 10_000;
  const memory = createListNavigationMemory({ now: () => time, ...options });
  memory.setScope(scope);
  return { memory, setTime: (value: number) => { time = value; } };
}

afterEach(() => vi.unstubAllGlobals());

describe("safe household navigation URLs", () => {
  it.each([
    ["/households", "/households"], ["/households?", "/households"],
    ["/households?stage=all&q=Demo+Household&page=4", "/households?page=4&q=Demo+Household&stage=all"],
    ["/households?status=active&advisor=synthetic-1&dir=desc&sort=aum", "/households?advisor=synthetic-1&dir=desc&sort=aum&status=active"],
    ["/households?q=a%26b%3Dc", "/households?q=a%26b%3Dc"],
    ["/households?page=1000000", "/households?page=1000000"],
  ])("canonicalizes the exact allowed list path: %s", (input, expected) => {
    expect(safeHouseholdListHref(input)).toBe(expected);
  });

  it.each([
    "https://example.com/households", "https://navigation.invalid/households",
    "//example.com/households", "javascript:alert(1)", "/households/",
    "/households/fake", "/households/../login", "/households%2f..%2flogin",
    "/households\\evil", "/households#section", "/households?q=x#section", "/households?#",
    " /households", "/households\n", "/households?returnTo=https://example.com",
    "/households?q=one&q=two", "/households?%71=one&q=two", "/households?constructor=x",
    "/households?__proto__=x", "/households?toString=x", "/households?q=%0a",
    "/households?q=%00", "/households?q=%7f", "/households?sort=unknown",
    "/households?stage=prospect", "/households?dir=UP", "/households?page=0",
    "/households?page=-1", "/households?page=01", "/households?page=1.5",
    "/households?page=1000001", "/households?page=1e2", "/households?page=NaN",
    "/households?q=" + "x".repeat(257), "/households?status=" + "x".repeat(101),
    "/households?advisor=" + "x".repeat(255), "/households?" + "x".repeat(8192),
    null, undefined, 42, {},
  ])("rejects unsafe, ambiguous or unbounded list navigation: %s", (input) => {
    expect(safeHouseholdListHref(input)).toBeNull();
  });

  it("accepts only an exact record path for a return origin", () => {
    expect(safeHouseholdDetailHref("/households/001SYNTHETIC_123-ab"))
      .toBe("/households/001SYNTHETIC_123-ab");
  });

  it("keeps maximum-length percent-encoded Unicode queries round-trip safe", () => {
    const href = "/households?q=" + encodeURIComponent("☃".repeat(256));
    expect(safeHouseholdListHref(href)).toBe(href);
    expect(safeHouseholdListHref(safeHouseholdListHref(href))).toBe(href);
  });

  it.each([
    "/households", "/households/", "/households/one/two", "/households/a?tab=tasks",
    "/households/a#tasks", "/households/a\n", "/households/%61", "/households/..",
    "//example.com/households/a", "https://navigation.invalid/households/a",
    "/households/" + "a".repeat(129), null, 2, {},
  ])("rejects unrelated or ambiguous detail paths: %s", (input) => {
    expect(safeHouseholdDetailHref(input)).toBeNull();
  });
});

describe("bounded scoped navigation metadata", () => {
  it("requires an active authenticated scope", () => {
    const memory = createListNavigationMemory();
    expect(memory.save(scope, "/households", position)).toBe(false);
    expect(memory.read(scope, "/households")).toBeNull();
    expect(memory.rememberReturn(scope, "/households/a", "/households")).toBe(false);
    memory.setScope(scope);
    expect(memory.save(scope, "/households", position)).toBe(true);
  });

  it("projects only metadata and returns defensive copies", () => {
    const { memory } = setup();
    const source = { ...position, expandedIds: ["synthetic-1", "synthetic-1"], rows: [{ secret: "no" }] };
    memory.save(scope, "/households", source);
    source.expandedIds.push("later");
    const result = memory.read(scope, "/households")!;
    expect(result).toEqual({ ...position, href: "/households", savedAt: 10_000, expandedIds: ["synthetic-1"] });
    expect(result).not.toHaveProperty("rows");
    result.expandedIds!.push("changed");
    result.scrollTop = 0;
    expect(memory.read(scope, "/households")?.scrollTop).toBe(position.scrollTop);
    expect(memory.read(scope, "/households")?.expandedIds).toEqual(["synthetic-1"]);
  });

  it("canonicalizes query ordering but isolates different queries and deep-entry pages", () => {
    const { memory } = setup();
    memory.save(scope, "/households?stage=all&q=Demo", position);
    expect(memory.read(scope, "/households?q=Demo&stage=all")?.lastPage).toBe(3);
    expect(memory.read(scope, "/households?stage=all&q=Other")).toBeNull();
    expect(memory.read(scope, "/households?stage=all&q=Demo&page=2")).toBeNull();
  });

  it("clears all metadata and rejects stale writes after identity or permission changes", () => {
    const { memory } = setup();
    memory.save(scope, "/households", position);
    memory.rememberReturn(scope, "/households/a", "/households");
    memory.setScope(otherScope);
    expect(memory.read(otherScope, "/households")).toBeNull();
    expect(memory.returnHref(otherScope, "/households/a")).toBeNull();
    expect(memory.read(scope, "/households")).toBeNull();
    expect(memory.save(scope, "/households", position)).toBe(false);
    expect(memory.rememberReturn(scope, "/households/b", "/households")).toBe(false);
    memory.setScope(scope);
    expect(memory.read(scope, "/households")).toBeNull();
  });

  it("same-scope activation is idempotent and stale cleanup cannot erase a new scope", () => {
    const { memory } = setup();
    memory.save(scope, "/households", position);
    memory.setScope(scope);
    expect(memory.read(scope, "/households")).not.toBeNull();
    memory.setScope(otherScope);
    memory.save(otherScope, "/households", position);
    memory.clear(scope);
    expect(memory.read(otherScope, "/households")).not.toBeNull();
    memory.clear(otherScope);
    expect(memory.read(otherScope, "/households")).toBeNull();
    expect(memory.save(otherScope, "/households", position)).toBe(false);
  });

  it.each([null, "", "scope\n", "raw.email@example.com", "x".repeat(257)])(
    "invalid or logged-out scope clears prior metadata: %s", (invalidScope) => {
      const { memory } = setup();
      memory.save(scope, "/households", position);
      memory.setScope(invalidScope);
      expect(memory.read(scope, "/households")).toBeNull();
      expect(memory.save(scope, "/households", position)).toBe(false);
    },
  );

  it("explicit logout clears and deactivates the store", () => {
    const { memory } = setup();
    memory.save(scope, "/households", position);
    memory.clear();
    expect(memory.read(scope, "/households")).toBeNull();
    expect(memory.save(scope, "/households", position)).toBe(false);
  });

  it("independent browser-tab instances retain different positions and origins", () => {
    const first = setup().memory;
    const second = setup().memory;
    first.save(scope, "/households", position);
    first.rememberReturn(scope, "/households/a", "/households");
    expect(second.read(scope, "/households")).toBeNull();
    expect(second.returnHref(scope, "/households/a")).toBeNull();
    second.save(scope, "/households", { ...position, scrollTop: 12 });
    expect(first.read(scope, "/households")?.scrollTop).toBe(position.scrollTop);
    expect(second.read(scope, "/households")?.scrollTop).toBe(12);
  });

  it("expires exactly at TTL without extending retention on reads", () => {
    const { memory, setTime } = setup({ ttlMs: 100 });
    memory.save(scope, "/households", position);
    memory.rememberReturn(scope, "/households/a", "/households");
    setTime(10_099);
    expect(memory.read(scope, "/households")).not.toBeNull();
    expect(memory.returnHref(scope, "/households/a")).toBe("/households");
    setTime(10_100);
    expect(memory.read(scope, "/households")).toBeNull();
    expect(memory.returnHref(scope, "/households/a")).toBeNull();
  });

  it("new captures refresh TTL; a clock rewind discards obsolete state", () => {
    const { memory, setTime } = setup({ ttlMs: 100 });
    memory.save(scope, "/households", position);
    setTime(10_090);
    memory.save(scope, "/households", position);
    setTime(10_100);
    expect(memory.read(scope, "/households")).not.toBeNull();
    setTime(10_000);
    expect(memory.read(scope, "/households")).toBeNull();
  });

  it("evicts least-recently-used queries and dependent return links", () => {
    const { memory } = setup({ maxEntries: 2 });
    memory.save(scope, "/households?q=First", position);
    memory.save(scope, "/households?q=Second", position);
    memory.rememberReturn(scope, "/households/first", "/households?q=First");
    memory.rememberReturn(scope, "/households/second", "/households?q=Second");
    memory.read(scope, "/households?q=First");
    memory.save(scope, "/households?q=Third", position);
    expect(memory.read(scope, "/households?q=First")).not.toBeNull();
    expect(memory.read(scope, "/households?q=Second")).toBeNull();
    expect(memory.returnHref(scope, "/households/second")).toBeNull();
    expect(memory.returnHref(scope, "/households/first")).toBe("/households?q=First");
  });

  it("separately bounds return origins and never sends direct entry to an unrelated list", () => {
    const { memory } = setup({ maxEntries: 2 });
    memory.save(scope, "/households", position);
    memory.rememberReturn(scope, "/households/a", "/households");
    memory.rememberReturn(scope, "/households/b", "/households");
    memory.returnHref(scope, "/households/a");
    memory.rememberReturn(scope, "/households/c", "/households");
    expect(memory.returnHref(scope, "/households/a")).toBe("/households");
    expect(memory.returnHref(scope, "/households/b")).toBeNull();
    expect(memory.returnHref(scope, "/households/c")).toBe("/households");
    expect(memory.returnHref(scope, "/households/direct-entry")).toBeNull();
  });

  it("refuses unvisited, unrelated and cross-scope origins", () => {
    const { memory } = setup();
    expect(memory.rememberReturn(scope, "/households/a", "/households")).toBe(false);
    memory.save(scope, "/households", position);
    expect(memory.rememberReturn(scope, "/unrelated/a", "/households")).toBe(false);
    expect(memory.rememberReturn(scope, "/households/a", "/crm")).toBe(false);
    expect(memory.rememberReturn(otherScope, "/households/a", "/households")).toBe(false);
    expect(memory.returnHref(scope, "/households/a")).toBeNull();
  });

  it("a second visit changes only the exact detail's origin", () => {
    const { memory } = setup();
    memory.save(scope, "/households?q=First", position);
    memory.save(scope, "/households?q=Second", position);
    memory.rememberReturn(scope, "/households/a", "/households?q=First");
    memory.rememberReturn(scope, "/households/b", "/households?q=First");
    memory.rememberReturn(scope, "/households/a", "/households?q=Second");
    expect(memory.returnHref(scope, "/households/a")).toBe("/households?q=Second");
    expect(memory.returnHref(scope, "/households/b")).toBe("/households?q=First");
  });

  it("forget clears only the requested query and its dependent origins", () => {
    const { memory } = setup();
    memory.save(scope, "/households?q=First&stage=all", position);
    memory.save(scope, "/households?q=Second", position);
    memory.rememberReturn(scope, "/households/a", "/households?q=First&stage=all");
    memory.rememberReturn(scope, "/households/b", "/households?q=Second");
    memory.forget(otherScope, "/households?q=Second");
    memory.forget(scope, "/households?stage=all&q=First");
    expect(memory.read(scope, "/households?q=First&stage=all")).toBeNull();
    expect(memory.returnHref(scope, "/households/a")).toBeNull();
    expect(memory.read(scope, "/households?q=Second")).not.toBeNull();
    expect(memory.returnHref(scope, "/households/b")).toBe("/households?q=Second");
  });

  it.each([
    { firstPage: 0 }, { firstPage: 1.1 }, { lastPage: 0 }, { lastPage: 51 },
    { lastPage: 1000001 }, { firstPage: 10, lastPage: 9 }, { scrollTop: -1 },
    { scrollTop: Infinity }, { scrollTop: NaN }, { scrollTop: 10_000_001 },
    { anchorOffset: Infinity }, { anchorOffset: NaN }, { anchorOffset: -10_000_001 },
    { anchorId: "unsafe id" }, { anchorId: "id\n" }, { anchorId: "x".repeat(193) },
    { anchorId: "[onclick]" }, { expandedIds: ["id\n"] },
    { expandedIds: ["private@example.com"] }, { expandedIds: Array(21).fill("id") },
  ])("rejects malformed or unbounded metadata: %s", (patch) => {
    const { memory } = setup();
    expect(memory.save(scope, "/households", { ...position, ...patch })).toBe(false);
    expect(memory.read(scope, "/households")).toBeNull();
  });

  it("accepts bounded contiguous ranges with a missing anchor; invalid saves preserve prior state", () => {
    const { memory } = setup({ maxLoadedPages: 2 });
    expect(memory.save(scope, "/households?page=7", {
      ...position, firstPage: 7, lastPage: 8, anchorId: null, expandedIds: undefined,
    })).toBe(true);
    expect(memory.save(scope, "/households?page=7", { ...position, firstPage: 7, lastPage: 9 })).toBe(false);
    expect(memory.read(scope, "/households?page=7")?.lastPage).toBe(8);
  });

  it("does not save without a finite clock value", () => {
    const { memory, setTime } = setup();
    setTime(NaN);
    expect(memory.save(scope, "/households", position)).toBe(false);
  });

  it("invalid or excessive options use bounded defaults", () => {
    const { memory, setTime } = setup({ maxEntries: Infinity, ttlMs: -1, maxLoadedPages: 0 });
    for (let i = 0; i < 21; i++) memory.save(scope, "/households?q=" + i, position);
    expect(memory.read(scope, "/households?q=0")).toBeNull();
    expect(memory.read(scope, "/households?q=20")).not.toBeNull();
    setTime(10_000 + 15 * 60_000);
    expect(memory.read(scope, "/households?q=20")).not.toBeNull();
  });

  it("never creates a singleton while server rendering", () => {
    expect(getBrowserListNavigationMemory()).toBeNull();
  });

  it("blocked browser storage keeps in-memory navigation working without history access", () => {
    const forbidden = () => { throw new Error("storage and history are blocked"); };
    vi.stubGlobal("window", Object.defineProperties({}, {
      localStorage: { get: forbidden }, sessionStorage: { get: forbidden }, history: { get: forbidden },
    }));
    const memory = getBrowserListNavigationMemory()!;
    expect(getBrowserListNavigationMemory()).toBe(memory);
    memory.setScope(scope);
    memory.save(scope, "/households", position);
    memory.rememberReturn(scope, "/households/a", "/households");
    expect(memory.returnHref(scope, "/households/a")).toBe("/households");
    memory.clear();
  });
});
