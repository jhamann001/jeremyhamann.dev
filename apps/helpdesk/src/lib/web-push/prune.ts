/**
 * Pruning a dead push subscription (`pwa-push`).
 *
 * `PushSubscription` is one of the two Wave B tables that may be hard-deleted, and this is the reason
 * CONTRACT §1.4 gives: the push service answers **410 Gone** when a subscription dies, and a row we
 * may never use again and must not keep retrying is a liability rather than evidence. What remains in
 * the record is the pair of audit rows — `PUSH_SUBSCRIBED` when the device registered and
 * `PUSH_UNSUBSCRIBED` when it went — each carrying a hash of the endpoint, never the endpoint.
 *
 * It is written by the SYSTEM actor because nobody asked for it: the 410 arrives during a dispatch
 * run, hours after the browser was uninstalled or the permission revoked.
 */
import type { AuditEntry } from "@/types/domain";
import { SYSTEM_ACTOR, systemRequestContext, writeAudit } from "@/lib/audit";
import { withTx } from "@/lib/db";
import { logError } from "@/lib/logger";
import { hashEndpoint, pushServiceHost } from "./endpoint";

/**
 * Deletes the subscription for `endpoint` and records it, in ONE transaction.
 *
 * Returns whether a row was there to remove. It never throws: a failed prune must not turn a
 * delivery outcome into an exception inside a dispatcher that is iterating other people's
 * notifications — the row simply survives to the next run, where the next 410 tries again.
 */
export async function pruneGoneSubscription(endpoint: string): Promise<boolean> {
  try {
    return await withTx(async (tx) => {
      const existing = await tx.pushSubscription.findUnique({
        where: { endpoint },
        select: { id: true, userId: true },
      });
      if (existing === null) return false;

      await tx.pushSubscription.delete({ where: { id: existing.id } });

      const entry: AuditEntry = {
        action: "PUSH_UNSUBSCRIBED",
        entityType: "PUSH_SUBSCRIPTION",
        entityId: existing.id,
        fieldChanged: "endpoint",
        oldValue: null,
        newValue: hashEndpoint(endpoint),
        metadata: { reason: "GONE", service: pushServiceHost(endpoint), userId: existing.userId },
      };
      await writeAudit(tx, SYSTEM_ACTOR, systemRequestContext("web-push:prune"), entry);
      return true;
    });
  } catch (e) {
    logError("web-push:prune", e, { service: pushServiceHost(endpoint) });
    return false;
  }
}
