import type { AcatRecord } from "@/lib/types";
import type { ClientSearchItem } from "@/lib/client-identity-contract";

/** Plural server data is authoritative, including an explicitly empty set.
 * The scalar fallback supports older single-person fixtures only. */
export function getLinkedClients(record: AcatRecord): ClientSearchItem[] {
  const ids = record.cedarRidgeUserIds ?? record.linkedClients?.map((client) => client.cedarRidgeUserId)
    ?? (record.cedarRidgeUserId ? [record.cedarRidgeUserId] : []);
  const names = new Map(record.linkedClients?.map((client) => [client.cedarRidgeUserId, client.displayName]));
  return ids.map((cedarRidgeUserId) => ({ cedarRidgeUserId,
    displayName: names.get(cedarRidgeUserId) ?? (ids.length === 1 ? record.clientName : "Linked client"),
    accountHints: [],
  }));
}
