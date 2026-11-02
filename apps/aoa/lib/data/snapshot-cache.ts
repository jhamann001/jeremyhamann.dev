import "server-only";

export type Snapshot<T> = { data: T; checkedAt: number; expiresAt: number };

/** One successful source snapshot per process, never a response/identity cache.
 * No stale fallback, sliding TTL, disk persistence or unbounded key collection.
 * Auth MUST be checked by callers before every read, including cache hits. */
export function createSnapshotCache<T>(ttlMs: number) {
  let key: string | undefined;
  let entry: Snapshot<T> | undefined;
  let pending: Promise<Snapshot<T>> | undefined;
  let generation = 0;
  let eviction: ReturnType<typeof setTimeout> | undefined;
  function clearEntry() {
    entry = undefined;
    clearTimeout(eviction);
  }
  return {
    async read(sourceKey: string, load: () => Promise<T>, refresh = false): Promise<Snapshot<T>> {
      if (key !== sourceKey) {
        key = sourceKey;
        generation++;
        clearEntry();
        pending = undefined;
      }
      // A manual refresh joins an already-running source read, never a saved
      // result. All callers during a refresh join that same read.
      if (refresh) clearEntry();
      const now = Date.now();
      if (entry && now >= entry.checkedAt && now < entry.expiresAt) return structuredClone(entry);
      clearEntry();
      if (!pending) {
        const version = generation;
        const operation = Promise.resolve().then(load).then((data) => {
          const value = { data, checkedAt: now, expiresAt: now + ttlMs };
          if (generation === version && Date.now() >= now && Date.now() < value.expiresAt) {
            entry = structuredClone(value);
            eviction = setTimeout(clearEntry, value.expiresAt - Date.now());
            eviction.unref?.();
          }
          return value;
        });
        pending = operation;
        // Never cache an error or let a superseded read erase a newer one.
        void operation.finally(() => { if (pending === operation) pending = undefined; }).catch(() => {});
      }
      return structuredClone(await pending);
    },
  };
}
