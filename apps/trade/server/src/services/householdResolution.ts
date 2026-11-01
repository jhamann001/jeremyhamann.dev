import type {
  Client,
  HouseholdResolution,
  HouseholdResolutionAccount,
  HouseholdResolveResponse,
} from '@trade-request/shared';
import type { HouseholdConfig } from './householdConfig.js';

/**
 * Pure resolver — given the advisor's current selection (a mix of
 * Warehouse client IDs and explicit Apex ULIDs) plus the cached Warehouse
 * client list and Meridian household config, return the firm households
 * those selections belong to with sibling accounts enumerated.
 *
 * No I/O, no module-level state — the route is responsible for fetching
 * `clients` and `householdConfig` and threading them in.
 *
 * See `docs/plans/2026-q2-trade-request-householding.md` §6 Step 2 for
 * the full pseudocode + Decision logs #4 / #5 / #6.
 */

export interface ResolveInput {
  /** Warehouse Client.id values. */
  clientIds: readonly string[];
  /** Apex ULIDs — the route is responsible for validating the format. */
  accountIds: readonly string[];
  clients: readonly Client[];
  householdConfig: HouseholdConfig;
}

interface BucketEntry {
  /** The HouseholdConfig entry's accountTitle, used to sort siblings. */
  accountTitle: string;
}

export function resolveHouseholdsForClients(input: ResolveInput): HouseholdResolveResponse {
  const clientById = new Map<string, Client>();
  const clientByAccountUlid = new Map<string, Client>();
  const accountByUlid = new Map<string, Client['accounts'][number]>();
  for (const client of input.clients) {
    clientById.set(client.id, client);
    for (const acct of client.accounts) {
      clientByAccountUlid.set(acct.id, client);
      accountByUlid.set(acct.id, acct);
    }
  }

  // Step 2 — bucketingUlids vs selectionUlids (Decision log #4 / N-new-1).
  //
  // bucketingUlids is the broadest reach: every ULID we should resolve into
  // a household so sibling discovery is complete.
  const bucketingUlids = new Set<string>();
  for (const cid of input.clientIds) {
    const client = clientById.get(cid);
    if (!client) continue;
    for (const acct of client.accounts) bucketingUlids.add(acct.id);
  }
  for (const ulid of input.accountIds) bucketingUlids.add(ulid);

  // selectionUlids is the authoritative selected set used for
  // "is this sibling already selected?" — when accountIds is non-empty,
  // the form has told us which accounts within the picked clients are
  // actually in the trade. Treat that as canonical; do NOT re-expand
  // clientIds.
  const selectionUlids =
    input.accountIds.length > 0
      ? new Set<string>(input.accountIds)
      : new Set<string>(
          input.clientIds
            .map((cid) => clientById.get(cid))
            .filter((c): c is Client => c !== undefined)
            .flatMap((c) => c.accounts.map((a) => a.id)),
        );

  // Step 3 — drop ULIDs into household buckets or onto unresolvedAccountIds.
  const buckets = new Map<number, BucketEntry>();
  const unresolvedAccountIds = new Set<string>();
  for (const ulid of bucketingUlids) {
    const entry = input.householdConfig.byAccountNumber.get(ulid);
    if (entry === undefined || entry.householdId === undefined) {
      // Decision log #6 — synthetic fixtures may omit householdId; treat
      // as unmapped rather than coercing to a sentinel value.
      unresolvedAccountIds.add(ulid);
      continue;
    }
    if (!buckets.has(entry.householdId)) {
      buckets.set(entry.householdId, { accountTitle: entry.householdName });
    }
  }

  // Step 4 — clientIds the Warehouse list does not know about. (Accounts
  // belonging to known clients have already been folded into bucketingUlids
  // in Step 2; nothing to do here for them.)
  const unresolvedClientIds = new Set<string>();
  for (const cid of input.clientIds) {
    if (!clientById.has(cid)) unresolvedClientIds.add(cid);
  }

  // Step 5 — for each household bucket, enumerate ALL sibling entries.
  // The HouseholdConfig already has every account in the firm export;
  // walk it once and group by householdId.
  const siblingsByHousehold = new Map<number, HouseholdResolution['accounts'][number][]>();
  const householdNameById = new Map<number, string>();
  for (const entry of input.householdConfig.entries) {
    if (entry.householdId === undefined) continue;
    if (!buckets.has(entry.householdId)) continue;
    if (!householdNameById.has(entry.householdId)) {
      householdNameById.set(entry.householdId, entry.householdName);
    }
    const ulid = entry.accountNumber;
    const ownerClient = clientByAccountUlid.get(ulid) ?? null;
    const warehouseAccount = accountByUlid.get(ulid) ?? null;
    const sibling: HouseholdResolutionAccount = {
      accountId: ulid,
      accountNumber: warehouseAccount?.accountNumber ?? null,
      accountTitle: entry.accountTitle ?? '',
      clientId: ownerClient?.id ?? null,
      accountType: warehouseAccount?.accountType ?? null,
      balance: warehouseAccount?.balance ?? 0,
    };
    const list = siblingsByHousehold.get(entry.householdId) ?? [];
    list.push(sibling);
    siblingsByHousehold.set(entry.householdId, list);
  }

  // Step 6–8 — build HouseholdResolution rows.
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
    households.push({
      householdId,
      householdName: householdNameById.get(householdId) ?? '',
      accounts: siblings,
      selectedAccountIds,
      clientIds,
    });
  }

  households.sort((a, b) => a.householdName.localeCompare(b.householdName) || a.householdId - b.householdId);

  return {
    households,
    unresolvedClientIds: Array.from(unresolvedClientIds).sort((a, b) => a.localeCompare(b)),
    unresolvedAccountIds: Array.from(unresolvedAccountIds).sort((a, b) => a.localeCompare(b)),
  };
}
