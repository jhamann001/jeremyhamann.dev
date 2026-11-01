/** Operational identity projection. Never expose the trigger's private cache. */
export const acatClientLinksSelection = {
  select: { cedarRidgeUserId: true, client: { select: { canonicalName: true } } },
  orderBy: { cedarRidgeUserId: "asc" },
} as const;

type IdentityRecord = {
  cedarRidgeUserId?: string | null;
  clientLinks?: { cedarRidgeUserId: string; client: { canonicalName: string } }[];
  identitySetIds?: string[];
};

export function toOperationalAcat<T extends IdentityRecord>(record: T) {
  const { clientLinks, identitySetIds, ...fields } = record;
  void identitySetIds;
  const linkedClients = (clientLinks ?? []).map((link) => ({
    cedarRidgeUserId: link.cedarRidgeUserId, displayName: link.client.canonicalName,
  })).sort((a, b) => a.cedarRidgeUserId.localeCompare(b.cedarRidgeUserId));
  const cedarRidgeUserIds = linkedClients.map((client) => client.cedarRidgeUserId);
  return { ...fields, cedarRidgeUserId: cedarRidgeUserIds.length === 1 ? cedarRidgeUserIds[0] : null,
    cedarRidgeUserIds, linkedClients };
}
