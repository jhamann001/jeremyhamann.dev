import { describe, expect, it, vi } from "vitest";
import { createListNavigationMemory } from "@/lib/navigation/list-memory";
import { createListHistoryEntries, HOUSEHOLD_RETURN_HISTORY_STATE_KEY, LIST_HISTORY_STATE_KEY } from "@/lib/navigation/history-entry";
import {
  createScopedNavigationStorage, LIST_HISTORY_STORAGE_KEY, LIST_MEMORY_STORAGE_KEY, MAX_NAVIGATION_STORAGE_CHARS,
} from "@/lib/navigation/session-storage";

const scope = "opaque-synthetic-login-scope";
const href = "/households?q=Synthetic&stage=all";
const detail = "/households/synthetic-215";
const entryId = "a".repeat(32);
const position = { firstPage: 1, lastPage: 3, anchorId: "synthetic-215", anchorOffset: -12, scrollTop: 7500 };

function tab() {
  const values = new Map<string, string>();
  const native = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  return {
    values, native,
    storage: createScopedNavigationStorage(LIST_MEMORY_STORAGE_KEY, () => native),
    historyStorage: createScopedNavigationStorage(LIST_HISTORY_STORAGE_KEY, () => native),
  };
}

describe("signed-in tab-session navigation retention", () => {
  it("restores validated metadata after refresh and more than 15 minutes without retaining row payloads", () => {
    const { values, storage } = tab();
    const first = createListNavigationMemory({ storage, now: () => 1000 });
    first.setScope(scope);
    first.save(scope, href, { ...position, rows: [{ name: "DO_NOT_SAVE_CLIENT" }] } as typeof position, entryId);
    first.rememberReturn(scope, detail, href, entryId);
    const refreshed = createListNavigationMemory({ storage, now: () => 1000 + 2 * 60 * 60_000 });
    refreshed.setScope(scope);
    expect(refreshed.read(scope, href, entryId)).toMatchObject(position);
    expect(refreshed.returnTarget(scope, detail)).toEqual({ href, entryId });
    expect(values.get(LIST_MEMORY_STORAGE_KEY)).not.toContain("DO_NOT_SAVE_CLIENT");
    expect(values.get(LIST_MEMORY_STORAGE_KEY)).not.toContain('"rows"');
  });

  it("clears across logout, new login and account/role scope change, including same-user login", () => {
    const { storage, values } = tab();
    const first = createListNavigationMemory({ storage });
    first.setScope(scope); first.save(scope, href, position, entryId);
    const next = createListNavigationMemory({ storage });
    next.setScope("new-login-even-for-same-person");
    expect(next.read("new-login-even-for-same-person", href, entryId)).toBeNull();
    expect(values.has(LIST_MEMORY_STORAGE_KEY)).toBe(false);
    next.save("new-login-even-for-same-person", href, position, entryId);
    next.clear(scope); // stale cleanup cannot erase current session state
    expect(values.has(LIST_MEMORY_STORAGE_KEY)).toBe(true);
    next.clear();
    expect(values.has(LIST_MEMORY_STORAGE_KEY)).toBe(false);
    const signedBackIn = createListNavigationMemory({ storage }); signedBackIn.setScope(scope);
    expect(signedBackIn.read(scope, href, entryId)).toBeNull();
  });

  it("an unavailable authenticated scope clears prior persisted state even on first initialization", () => {
    const { storage, historyStorage, values } = tab();
    storage.write(scope, { entries: [], returns: [] });
    historyStorage.write(scope, { lists: [], details: [] });
    const memory = createListNavigationMemory({ storage }); memory.setScope(null);
    const history = createListHistoryEntries({
      readState: () => ({}), replaceState: vi.fn(), pathname: () => "/households", randomToken: () => entryId,
    }, { storage: historyStorage }); history.setScope(null);
    expect(values.size).toBe(0);
  });

  it("keeps browser tabs independent and preserves bounded LRU after refresh", () => {
    const firstTab = tab(); const secondTab = tab();
    const first = createListNavigationMemory({ storage: firstTab.storage, maxEntries: 2 });
    const second = createListNavigationMemory({ storage: secondTab.storage });
    first.setScope(scope); second.setScope(scope);
    first.save(scope, href, position, entryId);
    first.save(scope, "/households?q=Second", position, entryId);
    first.read(scope, href, entryId);
    const refreshed = createListNavigationMemory({ storage: firstTab.storage, maxEntries: 2 });
    refreshed.setScope(scope);
    refreshed.save(scope, "/households?q=Third", position, entryId);
    expect(refreshed.read(scope, href, entryId)).not.toBeNull();
    expect(refreshed.read(scope, "/households?q=Second", entryId)).toBeNull();
    expect(second.read(scope, href, entryId)).toBeNull();
  });

  it.each([
    "{invalid", "null", '[]', "x".repeat(MAX_NAVIGATION_STORAGE_CHARS + 1),
    JSON.stringify({ version: 2, scope, payload: {} }),
    JSON.stringify({ version: 1, scope, payload: {}, rows: ["unexpected"] }),
  ])("rejects corrupt/oversized/version-mismatched envelopes without displaying or throwing: %s", (raw) => {
    const { storage, values } = tab(); values.set(LIST_MEMORY_STORAGE_KEY, raw);
    const memory = createListNavigationMemory({ storage });
    expect(() => memory.setScope(scope)).not.toThrow();
    expect(memory.read(scope, href, entryId)).toBeNull();
    expect(values.has(LIST_MEMORY_STORAGE_KEY)).toBe(false);
  });

  it.each([
    { entries: Array(21).fill({}), returns: [] },
    { entries: [], returns: Array(21).fill({}) },
    { entries: [{ ...position, href: "https://evil.invalid", savedAt: 1000 }], returns: [] },
    { entries: [{ ...position, href, savedAt: 1000, rows: ["forged"] }], returns: [] },
    { entries: [{ ...position, lastPage: 51, href, savedAt: 1000 }], returns: [] },
    { entries: [], returns: [{ detailHref: "/unrelated", href, savedAt: 1000 }] },
  ])("rejects untrusted payloads at hydration bounds: %j", (payload) => {
    const { storage, values } = tab(); storage.write(scope, payload);
    const memory = createListNavigationMemory({ storage, now: () => 2000 }); memory.setScope(scope);
    expect(memory.read(scope, href, entryId)).toBeNull();
    expect(values.has(LIST_MEMORY_STORAGE_KEY)).toBe(false);
  });

  it("blocked/quota-exceeded storage falls back to in-memory navigation", () => {
    const blocked = createScopedNavigationStorage(LIST_MEMORY_STORAGE_KEY, () => { throw new Error("blocked"); });
    const memory = createListNavigationMemory({ storage: blocked });
    memory.setScope(scope);
    expect(memory.save(scope, href, position, entryId)).toBe(true);
    expect(memory.read(scope, href, entryId)).toMatchObject(position);
    expect(() => memory.clear()).not.toThrow();
    const { native } = tab(); native.setItem = vi.fn(() => { throw new Error("quota"); });
    const quota = createListNavigationMemory({ storage: createScopedNavigationStorage(LIST_MEMORY_STORAGE_KEY, () => native) });
    quota.setScope(scope);
    expect(quota.save(scope, href, position, entryId)).toBe(true);
    expect(quota.read(scope, href, entryId)).toMatchObject(position);
  });

  it("restores per-list and repeated per-detail history bindings on page refresh", () => {
    const { historyStorage, values } = tab();
    let state: Record<string, unknown> = {}; let pathname = "/households"; let sequence = 0;
    const environment = {
      readState: () => state, replaceState: (next: Record<string, unknown>) => { state = next; },
      pathname: () => pathname, randomToken: () => (++sequence).toString(16).padStart(32, "0"),
    };
    const first = createListHistoryEntries(environment, { storage: historyStorage, now: () => 1000 }); first.setScope(scope);
    const firstId = first.getEntryId(scope, href)!;
    const listState = state;
    pathname = detail; state = {};
    const firstTarget = { href, entryId: firstId };
    first.getDetailReturnTarget(scope, detail, firstTarget);
    const firstDetailState = state;
    state = {}; pathname = "/households";
    const secondHref = "/households?q=Other";
    const secondId = first.getEntryId(scope, secondHref)!;
    pathname = detail; state = {};
    const secondTarget = { href: secondHref, entryId: secondId };
    first.getDetailReturnTarget(scope, detail, secondTarget);
    const refreshed = createListHistoryEntries(environment, { storage: historyStorage, now: () => 1000 + 2 * 60 * 60_000 });
    refreshed.setScope(scope);
    expect(refreshed.getDetailReturnTarget(scope, detail, secondTarget)).toEqual(secondTarget);
    state = firstDetailState;
    expect(refreshed.getDetailReturnTarget(scope, detail, secondTarget)).toEqual(firstTarget);
    expect(state[HOUSEHOLD_RETURN_HISTORY_STATE_KEY]).toBe(firstDetailState[HOUSEHOLD_RETURN_HISTORY_STATE_KEY]);
    pathname = "/households"; state = listState;
    expect(refreshed.getEntryId(scope, href)).toBe(firstId);
    expect(state[LIST_HISTORY_STATE_KEY]).toBe(firstId);
    expect(JSON.parse(values.get(LIST_HISTORY_STORAGE_KEY)!).payload.lists).toHaveLength(2);
  });

  it.each([
    { lists: Array(21).fill({}), details: [] },
    { lists: [{ token: entryId, href: "https://evil.invalid", savedAt: 1000 }], details: [] },
    { lists: [], details: [{ token: entryId, detailHref: detail, target: { href, entryId, rows: [] }, savedAt: 1000 }] },
  ])("rejects unbounded or invalid persisted history registries: %j", (payload) => {
    const { historyStorage, values } = tab(); historyStorage.write(scope, payload);
    const history = createListHistoryEntries({
      readState: () => ({ [HOUSEHOLD_RETURN_HISTORY_STATE_KEY]: entryId }), replaceState: vi.fn(),
      pathname: () => detail, randomToken: () => "b".repeat(32),
    }, { storage: historyStorage, now: () => 2000 });
    history.setScope(scope);
    expect(history.getDetailReturnTarget(scope, detail, { href, entryId })).toBeNull();
    expect(values.has(LIST_HISTORY_STORAGE_KEY)).toBe(false);
  });
});
