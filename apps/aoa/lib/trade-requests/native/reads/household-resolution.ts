import type { HouseholdConfig, SourceClient } from "./sources";

// Pure resolver, ported line for line from trade-request d41b6c9
// server/src/services/householdResolution.ts:35-154.

export type HouseholdResolutionAccount = {
  accountId: string; accountNumber: string | null; accountTitle: string; clientId: string | null;
  accountType: SourceClient["accounts"][number]["accountType"] | null; balance: number;
};
export type HouseholdResolution = {
  householdId: number; householdName: string; accounts: HouseholdResolutionAccount[]; selectedAccountIds: string[]; clientIds: string[];
};
export type HouseholdResolveResponse = { households: HouseholdResolution[]; unresolvedClientIds: string[]; unresolvedAccountIds: string[] };
export type ResolveInput = {
  clientIds: readonly string[]; accountIds: readonly string[]; clients: readonly SourceClient[]; householdConfig: HouseholdConfig;
};

export function resolveHouseholdsForClients(input: ResolveInput): HouseholdResolveResponse {
  const clientById = new Map<string, SourceClient>();
  const clientByAccountUlid = new Map<string, SourceClient>();
  const accountByUlid = new Map<string, SourceClient["accounts"][number]>();
  for (const client of input.clients) {
    clientById.set(client.id, client);
    for (const acct of client.accounts) {
      clientByAccountUlid.set(acct.id, client);
      accountByUlid.set(acct.id, acct);
    }
  }

  const bucketingUlids = new Set<string>();
  for (const cid of input.clientIds) {
    const client = clientById.get(cid);
    if (!client) continue;
    for (const acct of client.accounts) bucketingUlids.add(acct.id);
  }
  for (const ulid of input.accountIds) bucketingUlids.add(ulid);

  const selectionUlids =
    input.accountIds.length > 0
      ? new Set<string>(input.accountIds)
      : new Set<string>(
          input.clientIds
            .map((cid) => clientById.get(cid))
            .filter((c): c is SourceClient => c !== undefined)
            .flatMap((c) => c.accounts.map((a) => a.id)),
        );

  const buckets = new Map<number, { accountTitle: string }>();
  const unresolvedAccountIds = new Set<string>();
  for (const ulid of bucketingUlids) {
    const entry = input.householdConfig.byAccountNumber.get(ulid);
    if (entry === undefined || entry.householdId === undefined) {
      unresolvedAccountIds.add(ulid);
      continue;
    }
    if (!buckets.has(entry.householdId)) buckets.set(entry.householdId, { accountTitle: entry.householdName });
  }

  const unresolvedClientIds = new Set<string>();
  for (const cid of input.clientIds) {
    if (!clientById.has(cid)) unresolvedClientIds.add(cid);
  }

  const siblingsByHousehold = new Map<number, HouseholdResolutionAccount[]>();
  const householdNameById = new Map<number, string>();
  for (const entry of input.householdConfig.entries) {
    if (entry.householdId === undefined) continue;
    if (!buckets.has(entry.householdId)) continue;
    if (!householdNameById.has(entry.householdId)) householdNameById.set(entry.householdId, entry.householdName);
    const ulid = entry.accountNumber;
    const ownerClient = clientByAccountUlid.get(ulid) ?? null;
    const warehouseAccount = accountByUlid.get(ulid) ?? null;
    const sibling: HouseholdResolutionAccount = {
      accountId: ulid,
      accountNumber: warehouseAccount?.accountNumber ?? null,
      accountTitle: entry.accountTitle ?? "",
      clientId: ownerClient?.id ?? null,
      accountType: warehouseAccount?.accountType ?? null,
      balance: warehouseAccount?.balance ?? 0,
    };
    const list = siblingsByHousehold.get(entry.householdId) ?? [];
    list.push(sibling);
    siblingsByHousehold.set(entry.householdId, list);
  }

  const households: HouseholdResolution[] = [];
  for (const [householdId, siblings] of siblingsByHousehold) {
    siblings.sort((a, b) => a.accountTitle.localeCompare(b.accountTitle) || a.accountId.localeCompare(b.accountId));
    const selectedAccountIds = siblings.map((s) => s.accountId).filter((ulid) => selectionUlids.has(ulid));
    const clientIdSet = new Set<string>();
    for (const s of siblings) if (s.clientId) clientIdSet.add(s.clientId);
    const clientIds = Array.from(clientIdSet).sort((a, b) => {
      const an = clientById.get(a)?.name ?? a;
      const bn = clientById.get(b)?.name ?? b;
      return an.localeCompare(bn);
    });
    households.push({ householdId, householdName: householdNameById.get(householdId) ?? "", accounts: siblings, selectedAccountIds, clientIds });
  }

  households.sort((a, b) => a.householdName.localeCompare(b.householdName) || a.householdId - b.householdId);

  return {
    households,
    unresolvedClientIds: Array.from(unresolvedClientIds).sort((a, b) => a.localeCompare(b)),
    unresolvedAccountIds: Array.from(unresolvedAccountIds).sort((a, b) => a.localeCompare(b)),
  };
}
