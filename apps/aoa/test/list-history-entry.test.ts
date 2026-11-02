import { describe, expect, it, vi } from "vitest";
import {
  createListHistoryEntries, getListHistoryEntryId, LIST_HISTORY_STATE_KEY,
  HOUSEHOLD_RETURN_HISTORY_STATE_KEY,
} from "@/lib/navigation/history-entry";
import { createListNavigationMemory } from "@/lib/navigation/list-memory";

const scope = "synthetic-user-scope";
const a = "/households?q=Query+A";
const b = "/households?q=Query+B";

function setup(options: { maxEntries?: number; ttlMs?: number } = {}) {
  let sequence = 0;
  let time = 10_000;
  let pathname = "/households";
  let index = 0;
  const states: unknown[] = [{ frameworkField: { tree: ["preserve", "exactly"] }, other: true }];
  const replaceState = vi.fn((state: Record<string, unknown>) => { states[index] = state; });
  const history = createListHistoryEntries({
    readState: () => states[index], replaceState, pathname: () => pathname,
    randomToken: () => (++sequence).toString(16).padStart(32, "0"),
  }, { now: () => time, ...options });
  history.setScope(scope);
  return {
    history, states, replaceState,
    current: () => states[index] as Record<string, unknown>,
    setState: (state: unknown) => { states[index] = state; },
    setPath: (value: string) => { pathname = value; },
    setTime: (value: number) => { time = value; },
    push: (state: unknown = {}) => { states.splice(index + 1); states.push(state); index++; },
    back: () => { index--; history.cancelPendingReturn(); },
    forward: () => { index++; history.cancelPendingReturn(); },
  };
}

describe("per-history-entry opaque navigation tokens", () => {
  it("keeps a mounted query's validated binding through a later streamed framework rewrite", () => {
    const { history, setPath, current, setState, push } = setup();
    const detail = "/households/nested";
    setPath(detail);
    const first = history.getEntryId(scope, detail)!;
    push();
    const second = history.getEntryId(scope, `${detail}?tasksCompleted=1`)!;
    history.recordTraversal({ [LIST_HISTORY_STATE_KEY]: first }, detail);
    setState({ framework: "first rewrite", [LIST_HISTORY_STATE_KEY]: second });
    expect(history.getEntryId(scope, detail)).toBe(first);
    setState({ framework: "later streamed rewrite", [LIST_HISTORY_STATE_KEY]: second });
    expect(history.getEntryId(scope, detail, first)).toBe(first);
    expect(current()).toEqual({ framework: "later streamed rewrite", [LIST_HISTORY_STATE_KEY]: first });
  });
  it("a mounted fallback cannot override a native traversal tombstone or valid other occurrence", () => {
    const { history, setState, push } = setup();
    const first = history.getEntryId(scope, a)!;
    push();
    const second = history.getEntryId(scope, a)!;
    expect(history.getEntryId(scope, a, first)).toBe(second);
    history.recordTraversal({}, "/households");
    setState({ framework: "rebuilt" });
    const third = history.getEntryId(scope, a, first);
    expect(third).not.toBe(first);
    expect(third).not.toBe(second);
  });
  it.each(["child-first", "return-first"])("restores both nested-list and parent-return bindings regardless of effect order: %s", order => {
    const { history, push, setPath, current, setState } = setup();
    const entryId = history.getEntryId(scope, a)!;
    const target = { href: a, entryId };
    const detail = "/households/nested";
    push(); setPath(detail);
    expect(history.getDetailReturnTarget(scope, detail, target)).toEqual(target);
    const childToken = history.getEntryId(scope, detail)!;
    const saved = { ...current() };
    history.recordTraversal(saved, detail);
    setState({ framework: "rebuilt" });
    if (order === "child-first") {
      expect(history.getEntryId(scope, detail)).toBe(childToken);
      expect(history.getDetailReturnTarget(scope, detail, null)).toEqual(target);
    } else {
      expect(history.getDetailReturnTarget(scope, detail, null)).toEqual(target);
      expect(history.getEntryId(scope, detail)).toBe(childToken);
    }
    expect(current()).toEqual({ framework: "rebuilt", [LIST_HISTORY_STATE_KEY]: childToken,
      [HOUSEHOLD_RETURN_HISTORY_STATE_KEY]: saved[HOUSEHOLD_RETURN_HISTORY_STATE_KEY] });
  });

  it("a historical direct detail cannot inherit a later origin when its child list mounts first", () => {
    const { history, setPath, current, setState } = setup();
    const entryId = history.getEntryId(scope, a)!;
    setPath("/households/direct"); setState({});
    history.getEntryId(scope, "/households/direct");
    const saved = { ...current() };
    history.recordTraversal(saved, "/households/direct");
    setState({ framework: "rebuilt" });
    history.getEntryId(scope, "/households/direct");
    expect(history.getDetailReturnTarget(scope, "/households/direct", { href: a, entryId })).toBeNull();
  });

  it("adds only its opaque token and preserves all foreign/framework state", () => {
    const { history, current, replaceState, states } = setup();
    const original = current();
    const token = history.getEntryId(scope, a)!;
    expect(token).toMatch(/^[a-f0-9]{32}$/);
    expect(current()).toEqual({ ...original, [LIST_HISTORY_STATE_KEY]: token });
    expect(current().frameworkField).toBe(original.frameworkField);
    expect(JSON.stringify(current())).not.toContain("Query");
    expect(JSON.stringify(current())).not.toContain(scope);
    expect(states).toHaveLength(1);
    expect(replaceState).toHaveBeenCalledOnce();
    expect(history.getEntryId(scope, a)).toBe(token);
    expect(replaceState).toHaveBeenCalledOnce();
  });

  it("preserves independent A→B→A occurrences across browser Back and Forward", () => {
    const { history, push, back, forward } = setup();
    const firstA = history.getEntryId(scope, a)!;
    push();
    const firstB = history.getEntryId(scope, b)!;
    push();
    const secondA = history.getEntryId(scope, a)!;
    expect(new Set([firstA, firstB, secondA]).size).toBe(3);
    back();
    expect(history.getEntryId(scope, b)).toBe(firstB);
    back();
    expect(history.getEntryId(scope, a)).toBe(firstA);
    forward();
    expect(history.getEntryId(scope, b)).toBe(firstB);
    forward();
    expect(history.getEntryId(scope, a)).toBe(secondA);
  });

  it("does not reuse copied state when the new list query differs", () => {
    const { history, push, current } = setup();
    const first = history.getEntryId(scope, a);
    push({ ...current() });
    expect(history.getEntryId(scope, b)).not.toBe(first);
  });

  it("app Back replaces its entry with the prepared original token, without navigation", () => {
    const { history, push, current, states } = setup();
    const original = history.getEntryId(scope, a)!;
    push({ detailFrameworkState: "untouched" });
    expect(history.prepareReturn(scope, { href: a, entryId: original })).toBe(true);
    // Simulate router.replace completing before the list mounts.
    expect(history.getEntryId(scope, a)).toBe(original);
    expect(current()).toEqual({ detailFrameworkState: "untouched", [LIST_HISTORY_STATE_KEY]: original });
    expect(states).toHaveLength(2);
  });

  it("same household opened from A and B retains both in-app Back origins", () => {
    const { history, push, back, forward, setPath, current } = setup();
    const detail = "/households/synthetic-1";
    const aId = history.getEntryId(scope, a)!;
    const aTarget = { href: a, entryId: aId };
    push(); setPath(detail);
    expect(history.getDetailReturnTarget(scope, detail, aTarget)).toEqual(aTarget);
    const firstDetailToken = current()[HOUSEHOLD_RETURN_HISTORY_STATE_KEY];
    push(); setPath("/households");
    const bId = history.getEntryId(scope, b)!;
    const bTarget = { href: b, entryId: bId };
    push(); setPath(detail);
    expect(history.getDetailReturnTarget(scope, detail, bTarget)).toEqual(bTarget);
    expect(current()[HOUSEHOLD_RETURN_HISTORY_STATE_KEY]).not.toBe(firstDetailToken);
    back(); setPath("/households");
    expect(history.getEntryId(scope, b)).toBe(bId);
    back(); setPath(detail);
    // The latest household→list map now points at B, but this occurrence is A.
    expect(history.getDetailReturnTarget(scope, detail, bTarget)).toEqual(aTarget);
    forward(); setPath("/households");
    forward(); setPath(detail);
    expect(history.getDetailReturnTarget(scope, detail, aTarget)).toEqual(bTarget);
  });

  it("restores a list occurrence if framework rendering replaces native popstate data", () => {
    const { history, push, back, current, setState } = setup();
    const first = history.getEntryId(scope, a)!;
    push(); const second = history.getEntryId(scope, a)!;
    expect(second).not.toBe(first);
    back();
    history.recordTraversal(current(), "/households");
    setState({ framework: "new restore state without custom fields" });
    expect(history.getEntryId(scope, a)).toBe(first);
    expect(current()).toEqual({ framework: "new restore state without custom fields", [LIST_HISTORY_STATE_KEY]: first });
  });

  it("restores the old household origin when framework rendering drops its occurrence token", () => {
    const { history, push, back, setPath, current, setState } = setup();
    const detail = "/households/synthetic-1";
    const firstTarget = { href: a, entryId: "a".repeat(32) };
    const secondTarget = { href: b, entryId: "b".repeat(32) };
    setPath(detail);
    history.getDetailReturnTarget(scope, detail, firstTarget);
    const originalToken = current()[HOUSEHOLD_RETURN_HISTORY_STATE_KEY];
    push();
    history.getDetailReturnTarget(scope, detail, secondTarget);
    // App Back replaces the second detail with its list, then browser Back
    // restores the older detail. Next may reconstruct state before layout.
    history.prepareReturn(scope, secondTarget);
    setPath("/households"); history.getEntryId(scope, b);
    back(); setPath(detail);
    history.recordTraversal(current(), detail);
    setState({ framework: "restored without own fields" });
    expect(history.getDetailReturnTarget(scope, detail, secondTarget)).toEqual(firstTarget);
    expect(current()[HOUSEHOLD_RETURN_HISTORY_STATE_KEY]).toBe(originalToken);
    expect(current().framework).toBe("restored without own fields");
  });

  it("does not use pending traversal across scopes, routes, or after expiry", () => {
    const { history, push, current, setState, setTime } = setup();
    const first = history.getEntryId(scope, a)!;
    history.recordTraversal(current(), "/households");
    history.setScope("other-scope");
    setState({});
    expect(history.getEntryId("other-scope", a)).not.toBe(first);
    history.setScope(scope);
    const newer = history.getEntryId(scope, a)!;
    history.recordTraversal(current(), "/unrelated");
    push();
    expect(history.getEntryId(scope, a)).not.toBe(newer);
    const currentId = history.getEntryId(scope, a)!;
    history.recordTraversal(current(), "/households");
    setState({}); setTime(40_000);
    expect(history.getEntryId(scope, a)).not.toBe(currentId);
  });

  it.each(["evicted", "expired"])("keeps a %s detail traversal fail-safe after framework state replacement and repeated resolution", (reason) => {
    const { history, push, back, setPath, current, setState, setTime } = setup({
      maxEntries: reason === "evicted" ? 1 : 20, ttlMs: 100,
    });
    const detail = "/households/synthetic-1";
    const firstTarget = { href: a, entryId: "a".repeat(32) };
    const latestTarget = { href: b, entryId: "b".repeat(32) };
    setPath(detail);
    history.getDetailReturnTarget(scope, detail, firstTarget);
    if (reason === "expired") setTime(10_100);
    push(); history.getDetailReturnTarget(scope, detail, latestTarget);
    back(); history.recordTraversal(current(), detail);
    setState({ framework: "restored without own fields" });
    expect(history.getDetailReturnTarget(scope, detail, latestTarget)).toBeNull();
    expect(history.getDetailReturnTarget(scope, detail, latestTarget)).toBeNull();
    expect(current()).toEqual({
      framework: "restored without own fields",
      [HOUSEHOLD_RETURN_HISTORY_STATE_KEY]: expect.stringMatching(/^[a-f0-9]{32}$/),
    });
    // A genuinely new forward visit is not quarantined with the old occurrence.
    push();
    expect(history.getDetailReturnTarget(scope, detail, latestTarget)).toEqual(latestTarget);
  });

  it.each([
    null, {}, ["foreign-state"],
    { [HOUSEHOLD_RETURN_HISTORY_STATE_KEY]: "invalid" },
    { [HOUSEHOLD_RETURN_HISTORY_STATE_KEY]: "f".repeat(32) },
  ])("does not rebind an unrecognized detail traversal after framework replacement: %j", (nativeState) => {
    const { history, push, setPath, setState } = setup();
    const detail = "/households/synthetic-1";
    const latestTarget = { href: b, entryId: "b".repeat(32) };
    setPath(detail);
    history.getDetailReturnTarget(scope, detail, latestTarget);
    push();
    history.recordTraversal(nativeState, detail);
    setState({ framework: "replacement" });
    expect(history.getDetailReturnTarget(scope, detail, latestTarget)).toBeNull();
    expect(history.getDetailReturnTarget(scope, detail, latestTarget)).toBeNull();
  });

  it("does not use a copied list token after traversing an unrecognized list occurrence", () => {
    const { history, current, setState } = setup();
    const first = history.getEntryId(scope, a)!;
    const copiedState = current();
    history.recordTraversal({}, "/households");
    setState(copiedState);
    expect(history.getEntryId(scope, a)).not.toBe(first);
  });

  it("detail tokens contain no query, identity or target payload and preserve framework state", () => {
    const { history, push, setPath, current } = setup();
    const entryId = history.getEntryId(scope, a)!;
    push({ framework: { opaque: "unchanged" } }); setPath("/households/synthetic-1");
    const previous = current();
    const target = { href: a, entryId };
    expect(history.getDetailReturnTarget(scope, "/households/synthetic-1", target)).toEqual(target);
    expect(current()).toEqual({ ...previous, [HOUSEHOLD_RETURN_HISTORY_STATE_KEY]: expect.stringMatching(/^[a-f0-9]{32}$/) });
    expect(JSON.stringify(current())).not.toContain("Query");
    expect(JSON.stringify(current())).not.toContain(scope);
    const returned = history.getDetailReturnTarget(scope, "/households/synthetic-1", null)!;
    returned.href = "https://example.com";
    expect(history.getDetailReturnTarget(scope, "/households/synthetic-1", null)).toEqual(target);
  });

  it("evicted or expired detail entries never inherit a newer visit's origin", () => {
    const { history, push, back, setPath, setTime } = setup({ maxEntries: 1, ttlMs: 100 });
    const firstTarget = { href: a, entryId: "a".repeat(32) };
    const secondTarget = { href: b, entryId: "b".repeat(32) };
    const detail = "/households/synthetic-1";
    setPath(detail);
    history.getDetailReturnTarget(scope, detail, firstTarget);
    push(); history.getDetailReturnTarget(scope, detail, secondTarget);
    back();
    expect(history.getDetailReturnTarget(scope, detail, secondTarget)).toBeNull();
    push(); history.getDetailReturnTarget(scope, detail, firstTarget);
    setTime(10_100);
    expect(history.getDetailReturnTarget(scope, detail, secondTarget)).toBeNull();
  });

  it("cannot bind a return for another scope, route or unsafe candidate", () => {
    const { history, setPath } = setup();
    const target = { href: a, entryId: "a".repeat(32) };
    expect(history.getDetailReturnTarget(scope, "/households/synthetic-1", target)).toBeNull();
    setPath("/households/synthetic-1");
    expect(history.getDetailReturnTarget("other", "/households/synthetic-1", target)).toBeNull();
    expect(history.getDetailReturnTarget(scope, "/households/synthetic-2", target)).toBeNull();
    expect(history.getDetailReturnTarget(scope, "/households/synthetic-1", { ...target, href: "https://example.com" })).toBeNull();
    expect(history.getDetailReturnTarget(scope, "/households/synthetic-1", { ...target, entryId: "malformed" })).toBeNull();
    expect(history.getDetailReturnTarget(scope, "/households/synthetic-1", null)).toBeNull();
  });

  it("scope cleanup removes both opaque fields but preserves unrelated state", () => {
    const { history, setPath, current } = setup();
    const entryId = history.getEntryId(scope, a)!;
    setPath("/households/synthetic-1");
    history.getDetailReturnTarget(scope, "/households/synthetic-1", { href: a, entryId });
    expect(current()).toHaveProperty(LIST_HISTORY_STATE_KEY);
    expect(current()).toHaveProperty(HOUSEHOLD_RETURN_HISTORY_STATE_KEY);
    history.clear("not-current");
    expect(current()).toHaveProperty(HOUSEHOLD_RETURN_HISTORY_STATE_KEY);
    history.clear(scope);
    expect(current()).not.toHaveProperty(LIST_HISTORY_STATE_KEY);
    expect(current()).not.toHaveProperty(HOUSEHOLD_RETURN_HISTORY_STATE_KEY);
    expect(current().frameworkField).toEqual({ tree: ["preserve", "exactly"] });
  });

  it("preserves actual per-entry positions when the same query is visited again", () => {
    const { history, push, back } = setup();
    const memory = createListNavigationMemory();
    memory.setScope(scope);
    const first = history.getEntryId(scope, a)!;
    const position = { firstPage: 1, lastPage: 5, anchorId: "synthetic-450", anchorOffset: -5, scrollTop: 20_000 };
    memory.save(scope, a, position, first);
    push();
    history.getEntryId(scope, b);
    push();
    const second = history.getEntryId(scope, a)!;
    memory.save(scope, a, { ...position, lastPage: 1, anchorId: "synthetic-1", scrollTop: 0 }, second);
    expect(memory.read(scope, a, second)?.lastPage).toBe(1);
    back();
    history.getEntryId(scope, b);
    back();
    expect(memory.read(scope, a, history.getEntryId(scope, a)!)?.lastPage).toBe(5);
    expect(memory.read(scope, a, first)?.anchorId).toBe("synthetic-450");
  });

  it("forgets only one history occurrence and its dependent return origin", () => {
    const memory = createListNavigationMemory();
    memory.setScope(scope);
    const position = { firstPage: 1, lastPage: 2, anchorId: null, anchorOffset: 0, scrollTop: 200 };
    memory.save(scope, a, position, "first-entry");
    memory.save(scope, a, { ...position, lastPage: 3 }, "second-entry");
    memory.rememberReturn(scope, "/households/first", a, "first-entry");
    memory.rememberReturn(scope, "/households/second", a, "second-entry");
    memory.forget(scope, a, "second-entry");
    expect(memory.read(scope, a, "first-entry")?.lastPage).toBe(2);
    expect(memory.read(scope, a, "second-entry")).toBeNull();
    expect(memory.returnTarget(scope, "/households/first")).toEqual({ href: a, entryId: "first-entry" });
    expect(memory.returnTarget(scope, "/households/second")).toBeNull();
    expect(memory.read(scope, a)).toBeNull();
  });

  it("keeps legacy URL-only callers isolated from entry-specific metadata", () => {
    const memory = createListNavigationMemory();
    memory.setScope(scope);
    const position = { firstPage: 1, lastPage: 2, anchorId: null, anchorOffset: 0, scrollTop: 200 };
    memory.save(scope, a, position);
    memory.save(scope, a, { ...position, lastPage: 4 }, "entry");
    memory.rememberReturn(scope, "/households/legacy", a);
    expect(memory.returnTarget(scope, "/households/legacy")).toEqual({ href: a, entryId: null });
    memory.forget(scope, a);
    expect(memory.read(scope, a, "entry")?.lastPage).toBe(4);
    expect(memory.read(scope, a)).toBeNull();
  });

  it.each(["bad id", "id\n", "x".repeat(129)])("rejects malformed memory entry IDs: %s", (entryId) => {
    const memory = createListNavigationMemory();
    memory.setScope(scope);
    const position = { firstPage: 1, lastPage: 2, anchorId: null, anchorOffset: 0, scrollTop: 200 };
    expect(memory.save(scope, a, position, entryId)).toBe(false);
    expect(memory.read(scope, a, entryId)).toBeNull();
    expect(memory.rememberReturn(scope, "/households/first", a, entryId)).toBe(false);
  });

  it("scope changes quarantine existing history tokens and stale cleanup", () => {
    const { history, current } = setup();
    const first = history.getEntryId(scope, a)!;
    history.setScope("different-scope");
    const second = history.getEntryId("different-scope", a)!;
    expect(second).not.toBe(first);
    history.clear(scope);
    expect(current()[LIST_HISTORY_STATE_KEY]).toBe(second);
    expect(history.getEntryId(scope, a)).toBeNull();
    expect(history.prepareReturn(scope, { href: a, entryId: first })).toBe(false);
    history.clear("different-scope");
    expect(current()).not.toHaveProperty(LIST_HISTORY_STATE_KEY);
  });

  it("bounded registry evicts old entry identities instead of misrestoring them", () => {
    const { history, push, back } = setup({ maxEntries: 2 });
    const first = history.getEntryId(scope, a)!;
    push(); history.getEntryId(scope, b);
    push(); history.getEntryId(scope, "/households?q=Third");
    back(); back();
    expect(history.getEntryId(scope, a)).not.toBe(first);
  });

  it("expires token bindings at TTL and renews active entries", () => {
    const { history, setTime } = setup({ ttlMs: 100 });
    const first = history.getEntryId(scope, a)!;
    setTime(10_090);
    expect(history.getEntryId(scope, a)).toBe(first);
    setTime(10_190);
    expect(history.getEntryId(scope, a)).not.toBe(first);
  });

  it("fresh scroll/click captures renew the bound entry without rewriting history", () => {
    const { history, setTime, replaceState, push, back } = setup({ ttlMs: 100 });
    const first = history.getEntryId(scope, a)!;
    replaceState.mockClear();
    // User stays on the list beyond TTL; the next position capture is fresh.
    setTime(10_200);
    expect(history.touchEntry(scope, a, first)).toBe(true);
    expect(replaceState).not.toHaveBeenCalled();
    push(); history.getEntryId(scope, b);
    back();
    expect(history.getEntryId(scope, a)).toBe(first);
  });

  it("stale or mismatched touch cannot reactivate another scope or alter a binding", () => {
    const { history, replaceState } = setup();
    const first = history.getEntryId(scope, a)!;
    replaceState.mockClear();
    expect(history.touchEntry(scope, b, first)).toBe(false);
    expect(history.touchEntry("other-scope", a, first)).toBe(false);
    expect(history.touchEntry(scope, a, "invalid")).toBe(false);
    expect(history.touchEntry(scope, a)).toBe(false);
    history.setScope("new-scope");
    replaceState.mockClear();
    expect(history.touchEntry(scope, a, first)).toBe(false);
    expect(replaceState).not.toHaveBeenCalled();
    expect(history.getEntryId(scope, a)).toBeNull();
  });

  it("touch does not resurrect an entry evicted by the bounded registry", () => {
    const { history, push } = setup({ maxEntries: 1 });
    const first = history.getEntryId(scope, a)!;
    push(); history.getEntryId(scope, b);
    expect(history.touchEntry(scope, a, first)).toBe(false);
  });

  it("browser traversal cancels an unfinished app Back target", () => {
    const { history, push, back, current } = setup();
    const first = history.getEntryId(scope, a)!;
    push(); const second = history.getEntryId(scope, a)!;
    history.prepareReturn(scope, { href: a, entryId: second });
    back();
    expect(history.getEntryId(scope, a)).toBe(first);
    expect(current()[LIST_HISTORY_STATE_KEY]).toBe(first);
  });

  it("prepared app Back targets are short-lived and exact-query-only", () => {
    const { history, push, setTime } = setup();
    const first = history.getEntryId(scope, a)!;
    push();
    history.prepareReturn(scope, { href: a, entryId: first });
    setTime(40_000);
    expect(history.getEntryId(scope, a)).not.toBe(first);
    push();
    history.prepareReturn(scope, { href: a, entryId: first });
    const other = history.getEntryId(scope, b)!;
    expect(other).not.toBe(first);
    push();
    expect(history.getEntryId(scope, a)).not.toBe(first);
  });

  it("rejects unsafe targets and tokens bound to a different list query", () => {
    const { history } = setup();
    const token = history.getEntryId(scope, a)!;
    expect(history.prepareReturn(scope, { href: b, entryId: token })).toBe(false);
    expect(history.prepareReturn(scope, { href: "https://example.com", entryId: token })).toBe(false);
    expect(history.prepareReturn(scope, { href: a, entryId: "invalid" })).toBe(false);
    expect(history.prepareReturn(scope, { href: a, entryId: null })).toBe(false);
  });

  it("does not tag an unrelated current route or invalid state shape", () => {
    const { history, setPath, replaceState, setState } = setup();
    setPath("/households/detail");
    expect(history.getEntryId(scope, a)).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
    setPath("/households");
    setState(["do-not-overwrite"]);
    expect(history.getEntryId(scope, a)).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("fails soft when browser history or crypto are unavailable", () => {
    const history = createListHistoryEntries({
      readState: () => { throw new Error("blocked"); }, replaceState: vi.fn(),
      pathname: () => "/households", randomToken: () => { throw new Error("unavailable"); },
    });
    history.setScope(scope);
    expect(history.getEntryId(scope, a)).toBeNull();
    expect(() => history.clear()).not.toThrow();
  });

  it("does not create any browser state during server rendering", () => {
    expect(getListHistoryEntryId(scope, a)).toBeNull();
  });
});
