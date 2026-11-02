import type { LinkTargetsResult } from "@/app/(authenticated)/acat-tracking/actions";
import { splitProspectName, type LinkTarget } from "@/lib/data/acat-link";

type Loaded = Extract<LinkTargetsResult, { ok: true }>;
type Match = { key: string; label: string; sub: string; target: LinkTarget };

// Salesforce aliases share 15 characters; imported opaque IDs stay complete.
const sourceKey = (value: string) => /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/.test(value)
  ? value.slice(0, 15) : value;

/** Search only the RLS-visible picker data already loaded for the operator. */
export function acatLinkTargetMatches(targets: Loaded, query: string): Match[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const clients = targets.clients.filter((client) => client.name.toLowerCase().includes(q));
  const memberHouseholds = new Set(
    clients.flatMap((client) => client.householdId ? [sourceKey(client.householdId)] : []),
  );
  const households = targets.households.filter((household) =>
    household.name.toLowerCase().includes(q)
    || household.sourceNames?.some((name) => name.toLowerCase().includes(q))
    || memberHouseholds.has(sourceKey(household.sfId)),
  );

  // Offer the household even when a common name matches many individual
  // members. The existing eight-option bound still applies to the whole list.
  return [
    ...households.map((household): Match => {
      const { first, last } = splitProspectName(household.name);
      return {
        key: `h:${household.sfId}`,
        label: household.name,
        sub: "Household",
        target: {
          kind: "household",
          householdSfId: household.sfId,
          householdName: household.name,
          firstName: first,
          lastName: last,
        },
      };
    }),
    ...clients.map((client): Match => {
      const { first, last } = splitProspectName(client.name);
      return {
        key: `c:${client.sfId}`,
        label: client.name,
        sub: client.householdName ?? "Client",
        target: {
          kind: "client",
          clientSfId: client.sfId,
          firstName: first,
          lastName: last,
          householdSfId: client.householdId,
          householdName: client.householdName,
        },
      };
    }),
  ].slice(0, 8);
}
