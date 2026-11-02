/** Tab-session storage for navigation metadata only; never an authorization cache. */
export const LIST_MEMORY_STORAGE_KEY = "aoa.navigation.positions.v1";
export const LIST_HISTORY_STORAGE_KEY = "aoa.navigation.history.v1";
export const MAX_NAVIGATION_STORAGE_CHARS = 256_000;

export type ScopedNavigationStorage = {
  read(scope: string): unknown;
  write(scope: string, payload: unknown): void;
  clear(scope?: string): void;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const validScope = (scope: unknown): scope is string =>
  typeof scope === "string" && /^[A-Za-z0-9:_-]{1,256}$/.test(scope) && !/[\r\n]/.test(scope);

export function createScopedNavigationStorage(
  key: typeof LIST_MEMORY_STORAGE_KEY | typeof LIST_HISTORY_STORAGE_KEY,
  storage: () => StorageLike,
): ScopedNavigationStorage {
  function envelope(): { version: 1; scope: string; payload: unknown } | null {
    const raw = storage().getItem(key);
    if (raw === null) return null;
    if (raw.length > MAX_NAVIGATION_STORAGE_CHARS) throw new Error("navigation_metadata_oversized");
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("navigation_metadata_invalid");
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || !validScope(record.scope) ||
      Object.keys(record).some((name) => !["version", "scope", "payload"].includes(name))) {
      throw new Error("navigation_metadata_invalid");
    }
    return { version: 1, scope: record.scope, payload: record.payload };
  }
  function remove() { try { storage().removeItem(key); } catch { /* Storage can be disabled. */ } }
  return {
    read(scope) {
      if (!validScope(scope)) return null;
      try {
        const value = envelope();
        if (!value) return null;
        if (value.scope !== scope) { remove(); return null; }
        return value.payload;
      } catch { remove(); return null; }
    },
    write(scope, payload) {
      if (!validScope(scope)) return;
      try {
        const raw = JSON.stringify({ version: 1, scope, payload });
        if (raw.length > MAX_NAVIGATION_STORAGE_CHARS) { remove(); return; }
        storage().setItem(key, raw);
      } catch { remove(); /* Keep in-memory navigation functional. */ }
    },
    clear(scope) {
      try {
        if (scope !== undefined && envelope()?.scope !== scope) return;
      } catch { /* Corrupt state is never worth retaining. */ }
      remove();
    },
  };
}

export function browserNavigationStorage(key: typeof LIST_MEMORY_STORAGE_KEY | typeof LIST_HISTORY_STORAGE_KEY): ScopedNavigationStorage {
  // Delayed access permits browsers with blocked sessionStorage to fail soft.
  return createScopedNavigationStorage(key, () => window.sessionStorage);
}
