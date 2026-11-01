/**
 * B1's single integration point with B10's web-push sender.
 *
 * It holds NO implementation, no fallback and no placeholder body: it calls
 * `sendWebPush(sub, payload)` in `src/lib/web-push/send.ts`, which is B10's file and B10's contract
 * signature, and returns exactly what that returns. The brief is explicit that a sibling slice's
 * absence is REPORTED rather than stubbed, so there is no local "disabled" shim here pretending push
 * works — while B10 is unlanded, `tsc` reports one unresolved module, on the line below, and this is
 * the only place in B1 that it can come from.
 *
 * WHY THE IMPORT IS LAZY. B4's `src/jobs/run.ts` registers `runDigestJob`, so `@/jobs/digest` is in
 * that module's graph; a STATIC import of an unlanded module here would fail at module-load time and
 * take B4's own suites down with it — a slice breaking a sibling's green tests over a dependency
 * that is merely not merged yet. Deferring it to the call means the graph loads, B4 stays green, the
 * typecheck still reports the gap, and the import is evaluated only when push is actually
 * configured. That is also the right shape on its own terms: with the three `VAPID_*` keys unset —
 * every environment on this branch — the RFC 8291 crypto is never pulled in at all, and nothing
 * transmits (CONTRACT §0 rule 4).
 */
import type { PushOutcome } from "@/lib/web-push/send";

export type { PushOutcome };

/** The subscription fields B10's sender takes, exactly as they are stored on `PushSubscription`. */
export type PushTarget = { endpoint: string; p256dh: string; auth: string };

/** `sendWebPush` per CONTRACT §10 B10, loaded at the call. Returns "disabled" when push is off. */
export async function sendWebPush(sub: PushTarget, payload: unknown): Promise<PushOutcome> {
  const mod = await import("@/lib/web-push/send");
  return mod.sendWebPush(sub, payload);
}
