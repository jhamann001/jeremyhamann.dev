/**
 * The object-store seam for the jobs runtime.
 *
 * S4 owns `src/lib/storage.ts` and S5 consumes it — "must not reimplement it". This module is the one
 * place the jobs runtime touches it, so the duplicate-copy job reads as business logic rather than as a
 * storage backend, and so a test can hand it a fake store.
 *
 * The types are RE-EXPORTED, never redeclared: a second copy of `ObjectStore` in this slice would be
 * exactly the drift the contract forbids. When S4 changes the interface, this file fails to compile — which
 * is the intended outcome.
 */
export type { ObjectHead, ObjectStore, SignedUrl } from "@/lib/storage";

/**
 * S4's document-key predicate, re-exported for the same reason as the types: the jobs runtime must not
 * carry its own idea of what a writable key looks like. `src/jobs/duplicate-copy.ts` checks the key it
 * built against this before handing it to the store, so a malformed name fails with a message naming the
 * file rather than with the store's generic refusal.
 */
export { isValidDocumentKey } from "@/lib/storage";

import { objectStore } from "@/lib/storage";
import type { ObjectStore } from "@/lib/storage";

/**
 * S4's store for the given bucket. `bucket` unset falls back to S4's filesystem backend, which is what a
 * local run gets; production passes `env.DUPLICATE_COPY_BUCKET`, and the job does not call this at all when
 * that key is unset (it logs "disabled" and exits 0 instead).
 *
 * `{ keys: "document" }` is NOT optional here. Job output is keyed by UTC date —
 * `2026/09/19/audit-chain.csv` — and the attachment key grammar (`<id>/<id>`, no dots) refuses that on
 * the very first `put`, in every backend. A store built without it cannot write a single file.
 *
 * Async because the duplicate-copy job awaits it and because a future backend may need to resolve an
 * identity before it can be used; keeping the seam async now avoids a signature change later.
 */
export async function loadObjectStore(bucket: string | undefined): Promise<ObjectStore> {
  return objectStore(bucket, { keys: "document" });
}
