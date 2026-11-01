// The client directory as the warehouse would export it: the universe's people and their Apex
// accounts, in the saved question's tagged-row format (src/lib/client-directory/source.ts). The
// warehouse stand-in serves these rows, and the seed writes the same snapshot, so a sync after a
// reset changes nothing.

import { createHash } from "node:crypto";
import { accountOwners, clientUserId, type Universe } from "./universe";

// The saved question's fingerprint, as the warehouse reports it. Set CLIENT_DIRECTORY_QUERY_FINGERPRINT
// to this value; the sync refuses rows from any other query.
export const DIRECTORY_QUERY_FINGERPRINT = createHash("sha256").update("cedar-ridge demo client directory, version 1").digest("hex");

export const investmentAccountId = (accountId: string): string =>
  `inv-${createHash("sha256").update(`account:${accountId}`).digest("hex").slice(0, 24)}`;

/** The directory rows, stamped as current at `now`. */
export function directoryRows(universe: Universe, now: Date): Record<string, unknown>[] {
  const updated = new Date(now.getTime() - 86_400_000).toISOString();
  const clients = universe.people.map((p) => ({
    row_kind: "client",
    cedar_ridge_user_id: clientUserId(p.id),
    canonical_name: `${p.first} ${p.last}`,
    crm_stage: "Client",
    eligibility: "ACTIVE",
    source: "warehouse",
    source_updated_at: updated,
  }));
  const accounts = universe.accounts.map((a) => ({
    row_kind: "account",
    investment_account_id: investmentAccountId(a.id),
    custodian: "APEX",
    custodian_account_id: investmentAccountId(a.id).replace("inv-", "blu-"),
    account_number: a.number,
    account_status: "OPEN",
    source_updated_at: updated,
  }));
  const memberships = universe.accounts.flatMap((a) => accountOwners(universe, a).map((p, index) => ({
    row_kind: "membership",
    investment_account_id: investmentAccountId(a.id),
    cedar_ridge_user_id: clientUserId(p.id),
    relationship_type: index === 0 ? "PRIMARY" : "JOINT",
  })));
  return [
    {
      row_kind: "manifest",
      contract_version: 1,
      complete: true,
      source: "warehouse",
      source_as_of: now.toISOString(),
      source_health: "FRESH",
      query_fingerprint: DIRECTORY_QUERY_FINGERPRINT,
      expected_clients: clients.length,
      expected_accounts: accounts.length,
      expected_memberships: memberships.length,
    },
    ...clients,
    ...accounts,
    ...memberships,
  ];
}
