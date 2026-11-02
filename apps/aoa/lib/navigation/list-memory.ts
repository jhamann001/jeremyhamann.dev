/**
 * Bounded navigation metadata, not a data cache or an authorization decision.
 *
 * Browser metadata persists only in the current tab's sessionStorage, never
 * row payloads, localStorage, or shared server state. A
 * restoration must fetch every retained page again under current server RLS.
 */
import { browserNavigationStorage, LIST_MEMORY_STORAGE_KEY, type ScopedNavigationStorage } from "./session-storage";
import { safeListHref, safeListDetailHref } from "./list-routes";
export { safeListHref, safeListDetailHref, currentListDetailHref } from "./list-routes";

export type ListNavigationPosition = {
  firstPage: number;
  lastPage: number;
  anchorId: string | null;
  anchorOffset: number;
  scrollTop: number;
  expandedIds?: string[];
};

export type ListNavigationEntry = ListNavigationPosition & {
  href: string;
  savedAt: number;
  entryId?: string;
};

export type ListNavigationReturnTarget = { href: string; entryId: string | null };

export type ListNavigationMemoryOptions = {
  ttlMs?: number;
  maxEntries?: number;
  maxLoadedPages?: number;
  now?: () => number;
  storage?: ScopedNavigationStorage;
};

export type ListNavigationMemory = {
  /** Opaque server-authenticated login/identity/role partition; not an access token. */
  setScope(scope: string | null): void;
  save(scope: string, href: string, position: ListNavigationPosition, entryId?: string): boolean;
  read(scope: string, href: string, entryId?: string): ListNavigationEntry | null;
  latest(scope: string, pathname: string, match?: Readonly<Record<string, string>>): ListNavigationEntry | null;
  rememberReturn(scope: string, detailHref: string, listHref: string, entryId?: string): boolean;
  returnHref(scope: string, detailHref: string): string | null;
  returnTarget(scope: string, detailHref: string): ListNavigationReturnTarget | null;
  forget(scope: string, href: string, entryId?: string): void;
  /** A stale scope cannot clear a newer user's metadata. Omit only for logout. */
  clear(scope?: string): void;
};

const DEFAULT_MAX_ENTRIES = 20;
export const MAX_REMEMBERED_LIST_PAGES = 50;
const MAX_PAGE = 1_000_000;
const MAX_SCROLL = 10_000_000;
// Leave room for percent-encoded Unicode within the bounded decoded filters.
const MAX_HREF_LENGTH = 8_192;
const MAX_EXPANDED_IDS = 20;
const HOUSEHOLD_PATH = "/households";
const PARSE_ORIGIN = "https://navigation.invalid";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const SCOPE = /^[A-Za-z0-9:_-]{1,256}$/;
const RECORD_ID = /^[A-Za-z0-9_.:-]{1,192}$/;
const QUERY_LIMITS: Readonly<Record<string, number>> = {
  q: 256,
  stage: 32,
  advisor: 254,
  status: 100,
  sort: 32,
  dir: 8,
  page: 7,
};

/** Exact local list route only; never accept a URL that could redirect elsewhere. */
export function safeHouseholdListHref(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > MAX_HREF_LENGTH ||
    CONTROL_CHARACTERS.test(value) ||
    value.includes("#") ||
    value.includes("\\") ||
    !(value === HOUSEHOLD_PATH || value.startsWith(`${HOUSEHOLD_PATH}?`))
  ) return null;

  const url = new URL(value, PARSE_ORIGIN);
  if (url.origin !== PARSE_ORIGIN || url.pathname !== HOUSEHOLD_PATH || url.hash) return null;
  const seen = new Set<string>();
  for (const [key, parameter] of url.searchParams) {
    const limit = Object.hasOwn(QUERY_LIMITS, key) ? QUERY_LIMITS[key] : 0;
    if (!limit || seen.has(key) || parameter.length > limit || CONTROL_CHARACTERS.test(parameter)) {
      return null;
    }
    seen.add(key);
    if (key === "stage" && !["all", "client", "lost_client"].includes(parameter)) return null;
    if (key === "sort" && !["name", "stage", "aum"].includes(parameter)) return null;
    if (key === "dir" && !["asc", "desc"].includes(parameter)) return null;
    if (key === "page" && (!/^[1-9]\d{0,6}$/.test(parameter) || Number(parameter) > MAX_PAGE)) {
      return null;
    }
  }
  // Equivalent ordering has one identity. Business-level filter normalization
  // stays with the list's server/client query contract, not this memory store.
  url.searchParams.sort();
  const query = url.searchParams.toString();
  const canonical = query ? `${HOUSEHOLD_PATH}?${query}` : HOUSEHOLD_PATH;
  return canonical.length <= MAX_HREF_LENGTH ? canonical : null;
}

/** An exact household detail entry; a different record never inherits an origin. */
export function safeHouseholdDetailHref(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 256 || CONTROL_CHARACTERS.test(value)) return null;
  const match = /^\/households\/([A-Za-z0-9_-]{1,128})$/.exec(value);
  return match && RECORD_ID.test(match[1]) ? value : null;
}

function positiveOption(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum
    ? value
    : fallback;
}

function validRecordId(value: unknown): value is string {
  return typeof value === "string" && !CONTROL_CHARACTERS.test(value) && RECORD_ID.test(value);
}

function validEntryId(value: unknown): value is string {
  return typeof value === "string" && !CONTROL_CHARACTERS.test(value) && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validPosition(value: ListNavigationPosition, maxLoadedPages: number): boolean {
  return !!value &&
    Number.isSafeInteger(value.firstPage) && value.firstPage >= 1 &&
    Number.isSafeInteger(value.lastPage) && value.lastPage >= value.firstPage &&
    value.lastPage <= MAX_PAGE && value.lastPage - value.firstPage < maxLoadedPages &&
    (value.anchorId === null || validRecordId(value.anchorId)) &&
    Number.isFinite(value.anchorOffset) && Math.abs(value.anchorOffset) <= MAX_SCROLL &&
    Number.isFinite(value.scrollTop) && value.scrollTop >= 0 && value.scrollTop <= MAX_SCROLL &&
    (value.expandedIds === undefined || (Array.isArray(value.expandedIds) &&
      value.expandedIds.length <= MAX_EXPANDED_IDS &&
      value.expandedIds.every(validRecordId)));
}

function copyEntry(value: ListNavigationEntry): ListNavigationEntry {
  // Explicit projection deliberately discards unknown object fields/row data.
  return {
    href: value.href,
    firstPage: value.firstPage,
    lastPage: value.lastPage,
    anchorId: value.anchorId,
    anchorOffset: value.anchorOffset,
    scrollTop: value.scrollTop,
    savedAt: value.savedAt,
    ...(value.entryId ? { entryId: value.entryId } : {}),
    ...(value.expandedIds ? { expandedIds: [...new Set(value.expandedIds)] } : {}),
  };
}

export function createListNavigationMemory(options: ListNavigationMemoryOptions = {}): ListNavigationMemory {
  // Production retention is the signed-in tab session. A finite TTL remains
  // injectable for deterministic expiry tests, never the browser default.
  const ttlMs = positiveOption(options.ttlMs, Infinity, 24 * 60 * 60_000);
  const maxEntries = positiveOption(options.maxEntries, DEFAULT_MAX_ENTRIES, 100);
  const maxLoadedPages = positiveOption(options.maxLoadedPages, MAX_REMEMBERED_LIST_PAGES, 100);
  const now = options.now ?? Date.now;
  let activeScope: string | null = null;
  // Map insertion order is LRU order. Return origins have their own equal bound.
  const entries = new Map<string, ListNavigationEntry>();
  const returns = new Map<string, { href: string; entryId?: string; key: string; savedAt: number }>();

  const entryKey = (href: string, entryId?: string) => JSON.stringify([href, entryId ?? null]);

  function eligible(scope: string): boolean {
    return activeScope !== null && scope === activeScope;
  }

  function fresh(savedAt: number, currentTime: number): boolean {
    return Number.isFinite(currentTime) && currentTime >= savedAt && currentTime - savedAt < ttlMs;
  }

  function persist() {
    if (activeScope) options.storage?.write(activeScope, {
      entries: Array.from(entries.values(), copyEntry),
      returns: Array.from(returns, ([detailHref, origin]) => ({
        detailHref, href: origin.href, entryId: origin.entryId, savedAt: origin.savedAt,
      })),
    });
  }

  function hydrate() {
    if (!activeScope || !options.storage) return;
    const stored = options.storage.read(activeScope);
    if (stored === null || stored === undefined) return;
    try {
      if (typeof stored !== "object" || Array.isArray(stored)) throw new Error("invalid");
      const data = stored as Record<string, unknown>;
      if (Object.keys(data).some((key) => !["entries", "returns"].includes(key)) ||
        !Array.isArray(data.entries) || data.entries.length > maxEntries ||
        !Array.isArray(data.returns) || data.returns.length > maxEntries) throw new Error("invalid");
      for (const raw of data.entries) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid");
        const value = raw as ListNavigationEntry;
        if (Object.keys(raw).some((key) => !["href", "firstPage", "lastPage", "anchorId", "anchorOffset", "scrollTop", "savedAt", "entryId", "expandedIds"].includes(key)) ||
          safeListHref(value.href) !== value.href || !validPosition(value, maxLoadedPages) ||
          (value.entryId !== undefined && !validEntryId(value.entryId)) ||
          !Number.isFinite(value.savedAt) || value.savedAt < 0) throw new Error("invalid");
        if (fresh(value.savedAt, now())) entries.set(entryKey(value.href, value.entryId), copyEntry(value));
      }
      for (const raw of data.returns) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid");
        const value = raw as { detailHref: string; href: string; entryId?: string; savedAt: number };
        if (Object.keys(raw).some((key) => !["detailHref", "href", "entryId", "savedAt"].includes(key)) ||
          safeListDetailHref(value.detailHref) !== value.detailHref || safeListHref(value.href) !== value.href ||
          (value.entryId !== undefined && !validEntryId(value.entryId)) ||
          !Number.isFinite(value.savedAt) || value.savedAt < 0) throw new Error("invalid");
        const key = entryKey(value.href, value.entryId);
        if (fresh(value.savedAt, now()) && entries.has(key)) returns.set(value.detailHref, {
          href: value.href, entryId: value.entryId, key, savedAt: value.savedAt,
        });
      }
    } catch {
      entries.clear(); returns.clear(); options.storage.clear(activeScope);
    }
  }

  function prune(): void {
    const currentTime = now();
    for (const [href, entry] of entries) {
      if (!fresh(entry.savedAt, currentTime)) entries.delete(href);
    }
    for (const [detail, origin] of returns) {
      if (!fresh(origin.savedAt, currentTime) || !entries.has(origin.key)) returns.delete(detail);
    }
  }

  function read(scope: string, href: string, entryId?: string): ListNavigationEntry | null {
    if (!eligible(scope) || (entryId !== undefined && !validEntryId(entryId))) return null;
    const safeHref = safeListHref(href);
    if (!safeHref) return null;
    prune();
    const key = entryKey(safeHref, entryId);
    const value = entries.get(key);
    if (!value) return null;
    entries.delete(key);
    entries.set(key, value);
    persist();
    return copyEntry(value);
  }

  function returnTarget(scope: string, detailHref: string): ListNavigationReturnTarget | null {
    if (!eligible(scope)) return null;
    const detail = safeListDetailHref(detailHref);
    if (!detail) return null;
    prune();
    const origin = returns.get(detail);
    if (!origin || !read(scope, origin.href, origin.entryId)) return null;
    returns.delete(detail);
    returns.set(detail, origin);
    persist();
    return { href: origin.href, entryId: origin.entryId ?? null };
  }

  return {
    setScope(scope) {
      const nextScope = typeof scope === "string" && !CONTROL_CHARACTERS.test(scope) && SCOPE.test(scope) ? scope : null;
      if (nextScope === null) options.storage?.clear();
      if (nextScope === activeScope) return;
      if (activeScope !== null || nextScope === null) options.storage?.clear();
      entries.clear();
      returns.clear();
      activeScope = nextScope;
      hydrate();
    },
    save(scope, href, position, entryId) {
      if (!eligible(scope) || (entryId !== undefined && !validEntryId(entryId))) return false;
      const safeHref = safeListHref(href);
      const savedAt = now();
      if (!safeHref || !validPosition(position, maxLoadedPages) || !Number.isFinite(savedAt)) return false;
      prune();
      const key = entryKey(safeHref, entryId);
      entries.delete(key);
      entries.set(key, copyEntry({ ...position, href: safeHref, savedAt, entryId }));
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
      prune();
      persist();
      return true;
    },
    read,
    latest(scope, pathname, match = {}) {
      if (!eligible(scope) || safeListHref(pathname) !== pathname || pathname.includes("?")) return null;
      prune();
      for (const entry of [...entries.values()].reverse()) {
        const url = new URL(entry.href, "https://navigation.invalid");
        if (url.pathname === pathname && Object.entries(match).every(([key, value]) => (url.searchParams.get(key) ?? "") === value)) {
          return copyEntry(entry);
        }
      }
      return null;
    },
    rememberReturn(scope, detailHref, listHref, entryId) {
      if (!eligible(scope)) return false;
      const detail = safeListDetailHref(detailHref);
      const entry = read(scope, listHref, entryId);
      if (!detail || !entry) return false;
      returns.delete(detail);
      returns.set(detail, { href: entry.href, entryId: entry.entryId, key: entryKey(entry.href, entry.entryId), savedAt: now() });
      while (returns.size > maxEntries) returns.delete(returns.keys().next().value!);
      persist();
      return true;
    },
    returnHref(scope, detailHref) {
      return returnTarget(scope, detailHref)?.href ?? null;
    },
    returnTarget,
    forget(scope, href, entryId) {
      if (!eligible(scope) || (entryId !== undefined && !validEntryId(entryId))) return;
      const safeHref = safeListHref(href);
      if (!safeHref) return;
      const key = entryKey(safeHref, entryId);
      entries.delete(key);
      for (const [detail, origin] of returns) {
        if (origin.key === key) returns.delete(detail);
      }
      persist();
    },
    clear(scope) {
      if (scope !== undefined && !eligible(scope)) return;
      options.storage?.clear(scope);
      entries.clear();
      returns.clear();
      activeScope = null;
    },
  };
}

let browserMemory: ListNavigationMemory | undefined;

/** No server singleton: server rendering must not retain one user's metadata. */
export function getBrowserListNavigationMemory(): ListNavigationMemory | null {
  if (typeof window === "undefined") return null;
  browserMemory ??= createListNavigationMemory({ storage: browserNavigationStorage(LIST_MEMORY_STORAGE_KEY) });
  return browserMemory;
}
