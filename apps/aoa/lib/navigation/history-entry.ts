import { currentListDetailHref, safeListDetailHref, safeListHref, type ListNavigationReturnTarget } from "./list-memory";
import { browserNavigationStorage, LIST_HISTORY_STORAGE_KEY, type ScopedNavigationStorage } from "./session-storage";

/** Only this opaque token is put in history; hrefs/scopes remain in tab memory. */
export const LIST_HISTORY_STATE_KEY = "__aoaListNavigationEntryV1";
export const HOUSEHOLD_RETURN_HISTORY_STATE_KEY = "__aoaHouseholdReturnEntryV1";
const TOKEN = /^[a-f0-9]{32}$/;
const SCOPE = /^[A-Za-z0-9:_-]{1,256}$/;
const MAX_ENTRIES = 20;
const PENDING_TTL_MS = 30_000;

type HistoryEnvironment = {
  readState(): unknown;
  replaceState(state: Record<string, unknown>): void;
  pathname(): string;
  /** Includes the query for same-route Operations record details. */
  href?(): string;
  randomToken(): string;
};

export type ListHistoryEntries = {
  setScope(scope: string | null): void;
  getEntryId(scope: string, href: string, priorEntryId?: string): string | null;
  touchEntry(scope: string, href: string, entryId?: string): boolean;
  getDetailReturnTarget(scope: string, detailHref: string, candidate: ListNavigationReturnTarget | null): ListNavigationReturnTarget | null;
  prepareReturn(scope: string, target: ListNavigationReturnTarget): boolean;
  recordTraversal(state: unknown, pathname: string): void;
  cancelPendingReturn(): void;
  clear(scope?: string): void;
};

const validToken = (value: unknown): value is string =>
  typeof value === "string" && value.length === 32 && TOKEN.test(value);
const validScope = (value: unknown): value is string =>
  typeof value === "string" && !/[\u0000-\u001f\u007f]/.test(value) && SCOPE.test(value);
const objectState = (value: unknown): Record<string, unknown> | null =>
  value === null ? {} : typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Dependency-injected public browser APIs keep traversal and isolation testable. */
export function createListHistoryEntries(
  environment: HistoryEnvironment,
  options: { now?: () => number; maxEntries?: number; ttlMs?: number; storage?: ScopedNavigationStorage } = {},
): ListHistoryEntries {
  const now = options.now ?? Date.now;
  const currentLocation = () => environment.href?.() ?? environment.pathname();
  const routePath = (href: string) => href.split("?")[0];
  const maxEntries = Number.isSafeInteger(options.maxEntries) && options.maxEntries! > 0 && options.maxEntries! <= 100
    ? options.maxEntries! : MAX_ENTRIES;
  const ttlMs = Number.isSafeInteger(options.ttlMs) && options.ttlMs! > 0 && options.ttlMs! <= 24 * 60 * 60_000
    ? options.ttlMs! : Infinity;
  let scope: string | null = null;
  const registry = new Map<string, { href: string; savedAt: number }>();
  const detailRegistry = new Map<string, { detailHref: string; target: ListNavigationReturnTarget; savedAt: number }>();
  let pending: { href: string; entryId: string; savedAt: number } | null = null;
  let traversal: { pathname: string; listEntryId?: string; detailEntryId?: string; savedAt: number } | null = null;

  function eligible(value: string): boolean { return scope !== null && value === scope; }
  function fresh(savedAt: number, limit = ttlMs): boolean {
    const current = now();
    return Number.isFinite(current) && current >= savedAt && current - savedAt < limit;
  }
  function prune() {
    for (const [token, entry] of registry) if (!fresh(entry.savedAt)) registry.delete(token);
    for (const [token, entry] of detailRegistry) if (!fresh(entry.savedAt)) detailRegistry.delete(token);
    if (pending && !fresh(pending.savedAt, PENDING_TTL_MS)) pending = null;
    if (traversal && !fresh(traversal.savedAt, PENDING_TTL_MS)) traversal = null;
  }
  function persist() {
    if (scope) options.storage?.write(scope, {
      lists: Array.from(registry, ([token, value]) => ({ token, href: value.href, savedAt: value.savedAt })),
      details: Array.from(detailRegistry, ([token, value]) => ({
        token, detailHref: value.detailHref, target: { ...value.target }, savedAt: value.savedAt,
      })),
    });
  }
  function hydrate() {
    if (!scope || !options.storage) return;
    const stored = options.storage.read(scope);
    if (stored === null || stored === undefined) return;
    try {
      if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new Error("invalid");
      const data = stored as Record<string, unknown>;
      if (Object.keys(data).some((key) => !["lists", "details"].includes(key)) ||
        !Array.isArray(data.lists) || data.lists.length > maxEntries ||
        !Array.isArray(data.details) || data.details.length > maxEntries) throw new Error("invalid");
      for (const raw of data.lists) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid");
        const value = raw as { token: string; href: string; savedAt: number };
        if (Object.keys(raw).some((key) => !["token", "href", "savedAt"].includes(key)) ||
          !validToken(value.token) || safeListHref(value.href) !== value.href ||
          !Number.isFinite(value.savedAt) || value.savedAt < 0) throw new Error("invalid");
        if (fresh(value.savedAt)) registry.set(value.token, { href: value.href, savedAt: value.savedAt });
      }
      for (const raw of data.details) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid");
        const value = raw as { token: string; detailHref: string; target: ListNavigationReturnTarget; savedAt: number };
        const target = value.target;
        if (Object.keys(raw).some((key) => !["token", "detailHref", "target", "savedAt"].includes(key)) ||
          !validToken(value.token) || safeListDetailHref(value.detailHref) !== value.detailHref ||
          !target || typeof target !== "object" || Array.isArray(target) ||
          Object.keys(target).some((key) => !["href", "entryId"].includes(key)) ||
          safeListHref(target.href) !== target.href || !validToken(target.entryId) ||
          !Number.isFinite(value.savedAt) || value.savedAt < 0) throw new Error("invalid");
        if (fresh(value.savedAt)) detailRegistry.set(value.token, {
          detailHref: value.detailHref, target: { href: target.href, entryId: target.entryId }, savedAt: value.savedAt,
        });
      }
    } catch {
      registry.clear(); detailRegistry.clear(); options.storage.clear(scope);
    }
  }
  function remember(token: string, href: string) {
    registry.delete(token);
    registry.set(token, { href, savedAt: now() });
    while (registry.size > maxEntries) registry.delete(registry.keys().next().value!);
    persist();
  }
  function rememberDetail(token: string, detailHref: string, target: ListNavigationReturnTarget) {
    detailRegistry.delete(token);
    detailRegistry.set(token, { detailHref, target: { ...target }, savedAt: now() });
    while (detailRegistry.size > maxEntries) detailRegistry.delete(detailRegistry.keys().next().value!);
    persist();
  }
  // A household detail can also own independently scrolling child lists. On
  // traversal restore BOTH opaque bindings before either consumer uses up the
  // traversal record; child/parent effect ordering must not rebind an old visit.
  function restoreTraversalState(state: Record<string, unknown>, location: string, forList: boolean) {
    prune();
    const pathname = routePath(location);
    const detail = currentListDetailHref(location);
    if (!traversal || routePath(traversal.pathname) !== pathname) return state;
    const next = { ...state };
    const listToken = traversal.listEntryId;
    if (listToken && registry.get(listToken)?.href.split("?")[0] === pathname) next[LIST_HISTORY_STATE_KEY] = listToken;
    else if (safeListHref(pathname)) delete next[LIST_HISTORY_STATE_KEY];
    const detailToken = traversal.detailEntryId;
    if (detailToken && detailRegistry.get(detailToken)?.detailHref === detail) next[HOUSEHOLD_RETURN_HISTORY_STATE_KEY] = detailToken;
    else if (forList && detail) {
      // A direct historical detail with no origin must never inherit a newer
      // same-record return mapping just because its child list mounted first.
      for (let attempt = 0; attempt < 3; attempt++) {
        const marker = environment.randomToken();
        if (validToken(marker) && !registry.has(marker) && !detailRegistry.has(marker)) { next[HOUSEHOLD_RETURN_HISTORY_STATE_KEY] = marker; break; }
      }
    }
    if (next[LIST_HISTORY_STATE_KEY] !== state[LIST_HISTORY_STATE_KEY] || next[HOUSEHOLD_RETURN_HISTORY_STATE_KEY] !== state[HOUSEHOLD_RETURN_HISTORY_STATE_KEY]) environment.replaceState(next);
    return next;
  }
  function removeOwnState() {
    try {
      const state = objectState(environment.readState());
      if (!state || (!Object.hasOwn(state, LIST_HISTORY_STATE_KEY) && !Object.hasOwn(state, HOUSEHOLD_RETURN_HISTORY_STATE_KEY))) return;
      const next = { ...state };
      delete next[LIST_HISTORY_STATE_KEY];
      delete next[HOUSEHOLD_RETURN_HISTORY_STATE_KEY];
      environment.replaceState(next);
    } catch { /* Navigation memory is optional; browser restrictions fail soft. */ }
  }
  function clear(requestedScope?: string) {
    if (requestedScope !== undefined && !eligible(requestedScope)) return;
    options.storage?.clear(requestedScope);
    registry.clear();
    detailRegistry.clear();
    pending = null;
    traversal = null;
    scope = null;
    removeOwnState();
  }

  return {
    setScope(nextScope) {
      const next = validScope(nextScope) ? nextScope : null;
      if (next === null) options.storage?.clear();
      if (next === scope) return;
      // First mount after refresh hydrates before interpreting the surviving
      // opaque history token. A real scope change clears the previous login.
      if (scope !== null || next === null) clear();
      scope = next;
      hydrate();
    },
    getEntryId(requestedScope, href, priorEntryId) {
      if (!eligible(requestedScope)) return null;
      const safeHref = safeListHref(href);
      if (!safeHref || !Number.isFinite(now())) return null;
      try {
        if (environment.pathname() !== routePath(safeHref)) return null;
        const rawState = objectState(environment.readState());
        if (!rawState) return null; // Never overwrite an unexpected foreign state shape.
        const state = restoreTraversalState(rawState, currentLocation(), true);
        prune();
        let token: string | null = null;
        if (traversal && routePath(traversal.pathname) === routePath(safeHref)) {
          if (traversal.listEntryId && registry.get(traversal.listEntryId)?.href === safeHref) {
            token = traversal.listEntryId;
          }
          // A recognized traversal with no surviving binding is a tombstone:
          // mint a fresh entry rather than reusing framework-copied state.
          pending = null;
          traversal = null;
        } else if (pending?.href === safeHref) {
          token = pending.entryId;
          pending = null;
          traversal = null;
        } else {
          // A stale prepared return cannot attach itself to a later navigation.
          pending = null;
          traversal = null;
          const candidate = state[LIST_HISTORY_STATE_KEY];
          if (validToken(candidate) && registry.get(candidate)?.href === safeHref) token = candidate;
          // Streaming RSC can copy the outgoing query's token into history
          // after this still-mounted list has already accepted the new one.
          // Retain only its validated same-query binding, never across a native
          // traversal/tombstone or over another valid current occurrence.
          else if (validToken(priorEntryId) && registry.get(priorEntryId)?.href === safeHref) token = priorEntryId;
        }
        if (!token) {
          // A collision must not bind a different existing entry to this query.
          for (let attempt = 0; attempt < 3 && !token; attempt++) {
            const generated = environment.randomToken();
            if (validToken(generated) && !registry.has(generated)) token = generated;
          }
        }
        if (!token) return null;
        if (state[LIST_HISTORY_STATE_KEY] !== token) {
          environment.replaceState({ ...state, [LIST_HISTORY_STATE_KEY]: token });
        }
        remember(token, safeHref);
        return token;
      } catch { return null; }
    },
    touchEntry(requestedScope, href, entryId) {
      if (!eligible(requestedScope) || !validToken(entryId) || !Number.isFinite(now())) return false;
      const safeHref = safeListHref(href);
      // Renew a still-bound active entry when the caller captures fresh list
      // position. Do not mint identities, reactivate scopes, write history, or
      // resurrect evicted entries. Check the binding before TTL pruning: users
      // may stay on one list longer than TTL before their next scroll/click.
      if (!safeHref || registry.get(entryId)?.href !== safeHref) return false;
      remember(entryId, safeHref);
      prune();
      return true;
    },
    getDetailReturnTarget(requestedScope, detailHref, candidate) {
      if (!eligible(requestedScope) || !Number.isFinite(now())) return null;
      const detail = safeListDetailHref(detailHref);
      if (!detail) return null;
      try {
        if (currentListDetailHref(currentLocation()) !== detail) return null;
        const rawState = objectState(environment.readState());
        if (!rawState) return null;
        const state = restoreTraversalState(rawState, currentLocation(), false);
        prune();
        // The framework may replace custom history state between popstate and
        // component mount. Use the validated occurrence captured from the native
        // event, not a newer same-household candidate, then reattach only our key.
        const restored = traversal?.pathname === detail ? traversal : null;
        if (restored && (!restored.detailEntryId || !detailRegistry.has(restored.detailEntryId))) {
          // Preserve a fail-safe marker in this history occurrence after the
          // pending traversal is consumed. It has no registry binding, so a
          // later click cannot silently bind this old visit to the latest list.
          // A fresh forward entry can still establish its own valid origin.
          let marker: string | null = null;
          for (let attempt = 0; attempt < 3 && !marker; attempt++) {
            const generated = environment.randomToken();
            if (validToken(generated) && !registry.has(generated) && !detailRegistry.has(generated)) marker = generated;
          }
          if (marker) {
            environment.replaceState({ ...state, [HOUSEHOLD_RETURN_HISTORY_STATE_KEY]: marker });
            traversal = null;
          }
          return null;
        }
        const restoredToken = restored?.detailEntryId;
        traversal = null;
        const currentToken = restoredToken ?? state[HOUSEHOLD_RETURN_HISTORY_STATE_KEY];
        if (currentToken !== undefined) {
          // Evicted, expired or foreign historical entries must not inherit the
          // latest visit to the same household from a different list occurrence.
          if (!validToken(currentToken)) return null;
          const existing = detailRegistry.get(currentToken);
          if (!existing) return null;
          if (existing.detailHref === detail) {
            if (state[HOUSEHOLD_RETURN_HISTORY_STATE_KEY] !== currentToken) {
              environment.replaceState({ ...state, [HOUSEHOLD_RETURN_HISTORY_STATE_KEY]: currentToken });
            }
            rememberDetail(currentToken, detail, existing.target);
            return { ...existing.target };
          }
          // A framework may copy custom state into a different household's new
          // entry. Its previous household binding must not control this one.
        }
        const href = safeListHref(candidate?.href);
        if (!href || !validToken(candidate?.entryId)) return null;
        let token: string | null = null;
        for (let attempt = 0; attempt < 3 && !token; attempt++) {
          const generated = environment.randomToken();
          if (validToken(generated) && !registry.has(generated) && !detailRegistry.has(generated)) token = generated;
        }
        if (!token) return null;
        const target = { href, entryId: candidate.entryId };
        environment.replaceState({ ...state, [HOUSEHOLD_RETURN_HISTORY_STATE_KEY]: token });
        rememberDetail(token, detail, target);
        return { ...target };
      } catch { return null; }
    },
    prepareReturn(requestedScope, target) {
      if (!eligible(requestedScope)) return false;
      const href = safeListHref(target?.href);
      if (!href || !validToken(target?.entryId) || !Number.isFinite(now())) return false;
      prune();
      // The caller obtained this target from freshly scoped list metadata.
      // Never accept a token already bound to a different query in this scope.
      const existing = registry.get(target.entryId);
      if (existing && existing.href !== href) return false;
      remember(target.entryId, href);
      pending = { href, entryId: target.entryId, savedAt: now() };
      return true;
    },
    recordTraversal(rawState, pathname) {
      pending = null;
      traversal = null;
      if (scope === null || !Number.isFinite(now())) return;
      const listHref = safeListHref(pathname);
      const detailHref = currentListDetailHref(pathname);
      if (!listHref && !detailHref) return;
      const state = objectState(rawState);
      prune();
      const listToken = state?.[LIST_HISTORY_STATE_KEY];
      const detailToken = state?.[HOUSEHOLD_RETURN_HISTORY_STATE_KEY];
      const listEntryId = listHref && validToken(listToken) && registry.has(listToken)
        ? listToken : undefined;
      const detailEntryId = validToken(detailToken) && detailRegistry.get(detailToken)?.detailHref === detailHref
        ? detailToken : undefined;
      // Keep one bounded tombstone even when the native entry has no usable
      // token. A framework state rewrite must not turn an old visit into a new
      // visit with the latest same-household return target.
      traversal = { pathname: detailHref ?? pathname, listEntryId, detailEntryId, savedAt: now() };
    },
    cancelPendingReturn() { pending = null; },
    clear,
  };
}

let browserEntries: ListHistoryEntries | undefined;

function browserHistoryEntries(): ListHistoryEntries | null {
  if (typeof window === "undefined") return null;
  if (!browserEntries) {
    browserEntries = createListHistoryEntries({
      readState: () => window.history.state,
      // No URL argument: this never navigates or adds a history entry.
      replaceState: (state) => window.history.replaceState(state, ""),
      pathname: () => window.location.pathname,
      href: () => `${window.location.pathname}${window.location.search}`,
      randomToken: () => Array.from(window.crypto.getRandomValues(new Uint8Array(16)))
        .map((value) => value.toString(16).padStart(2, "0")).join(""),
    }, { storage: browserNavigationStorage(LIST_HISTORY_STORAGE_KEY) });
    // Observe the native event before framework restoration can replace custom
    // state. Retain only validated opaque occurrence tokens, never the event's
    // framework payload. Do not cancel, override or initiate browser traversal.
    window.addEventListener("popstate", (event: PopStateEvent) => {
      browserEntries?.recordTraversal(event.state, `${window.location.pathname}${window.location.search}`);
    }, { capture: true });
  }
  return browserEntries;
}

/** Call only while mounting a list with a server-authenticated scope. */
export function getListHistoryEntryId(scope: string, href: string, priorEntryId?: string): string | null {
  const entries = browserHistoryEntries();
  entries?.setScope(scope);
  return entries?.getEntryId(scope, href, priorEntryId) ?? null;
}

/** Apply login/identity/role changes even when another app page is open. */
export function setListHistoryScope(scope: string | null): void {
  browserHistoryEntries()?.setScope(scope);
}

export function prepareListHistoryReturn(scope: string, target: ListNavigationReturnTarget): boolean {
  return browserHistoryEntries()?.prepareReturn(scope, target) ?? false;
}

/** Pair with a successful position save; never creates or changes current scope. */
export function touchListHistoryEntry(scope: string, href: string, entryId?: string): boolean {
  return browserEntries?.touchEntry(scope, href, entryId) ?? false;
}

/** Binds the origin to this household's current history occurrence, not its name. */
export function getHouseholdHistoryReturnTarget(
  scope: string,
  detailHref: string,
  candidate: ListNavigationReturnTarget | null,
): ListNavigationReturnTarget | null {
  const entries = browserHistoryEntries();
  entries?.setScope(scope);
  return entries?.getDetailReturnTarget(scope, detailHref, candidate) ?? null;
}

export function clearListHistoryState(scope?: string): void {
  if (browserEntries) browserEntries.clear(scope);
  else if (typeof window !== "undefined") browserNavigationStorage(LIST_HISTORY_STORAGE_KEY).clear(scope);
}
