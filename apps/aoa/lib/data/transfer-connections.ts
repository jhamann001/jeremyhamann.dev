import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { withUserScope, type Identity } from "@/lib/rls";
import { getClientDirectory, getCedarRidgeUserIdForLinkedReads } from "./clients";
import { matchReceivingAccount, canonicalizeRegistrationType } from "./receiving-account-match";
import { readClientFeeRequests } from "./acat-reimbursement";
import { readTradeRequestsForUserCached } from "./trade-requests";
import { canReadCustodianLibrary } from "./custodian-library-contract";
import { canRecordOperationsOnlyTransferFact } from "./transfer-write";
import { resolveAssignableAssetMapAccount, type AssetMapClientScope, type AssignableAssetMapAccountKey } from "./transfer-asset-map";
import { readAcatStatusForTransferCached } from "./acat-status";
import type { DealRow } from "./deal-types";
import type { TransferAccountRow, TransferRow } from "./transfer-types";
import { STOPPED_OUTCOMES, type IntakeSourceFacts, type IntakeTransferRow } from "@/lib/transfers/new-transfer-intake";
import {
  accountTypeFromLabel,
  connectedIdentity,
  type TransferConnections,
  type ClientFeeRequests,
  type ClientTradeRequests,
  type ConnectedClient,
  type CustodianOption,
  type DealOption,
  type ReconciledReceivingAccount,
  type RosterPerson,
} from "@/lib/transfers/connections";

// Reads that connect an Asset Transfer to the AOA records it names. Every read
// that touches client, deal, fee or account data runs under the caller's
// row-level-security scope; a client is only ever found by id, never by name.
// Account numbers leave this module as their last four characters only.

export type { DealOption };

export type DirectoryClient = ConnectedClient & { firstName: string; lastName: string };

type DirectoryClientRow = {
  sf_id: string; first_name: string | null; last_name: string | null;
  household_sf_id: string | null; household_name: string | null;
};

function clientMatch(column: Prisma.Sql, clientSfId: string): Prisma.Sql {
  return Prisma.sql`(${column} = ${clientSfId} OR (length(${clientSfId}) = 15 AND left(${column}, 15) = ${clientSfId}))`;
}

/** The directory client for an id (a real person row of mirror.client, never a household placeholder). */
export async function readDirectoryClient(tx: Prisma.TransactionClient, clientSfId: string): Promise<DirectoryClient | null> {
  if (!clientSfId.trim()) return null;
  const rows = await tx.$queryRaw<DirectoryClientRow[]>(Prisma.sql`
    SELECT c.sf_id, c.first_name, c.last_name, h.sf_id AS household_sf_id, h.name AS household_name
      FROM mirror.client c
      LEFT JOIN mirror.household h ON h.sf_id = c.household_id
     WHERE ${clientMatch(Prisma.sql`c.sf_id`, clientSfId.trim())}
       AND (c.household_id IS NULL OR c.sf_id <> c.household_id)
     ORDER BY c.sf_id
     LIMIT 2`);
  if (rows.length !== 1) return null;
  const row = rows[0];
  const firstName = row.first_name?.trim() ?? "";
  const lastName = row.last_name?.trim() ?? "";
  return {
    sfId: row.sf_id,
    firstName,
    lastName,
    name: `${firstName} ${lastName}`.trim(),
    householdSfId: row.household_sf_id,
    householdName: row.household_name,
  };
}

export async function getDirectoryClient(identity: Identity, clientSfId: string): Promise<DirectoryClient | null> {
  return withUserScope(identity, (tx) => readDirectoryClient(tx, clientSfId));
}

export const CLIENT_SEARCH_LIMIT = 25;

/** The client directory's own search (CRM identity overlay included), limited to one page of matches. */
export async function searchDirectoryClients(identity: Identity, query: string): Promise<ConnectedClient[]> {
  const text = query.trim();
  if (text.length < 2) return [];
  const page = await getClientDirectory(identity, { query: text, stage: "all", sortKey: "name", sortDir: "asc" }, 1, CLIENT_SEARCH_LIMIT);
  return page.rows.map((row) => ({
    sfId: row.sf_id,
    name: row.name,
    householdSfId: row.household_id,
    householdName: row.household_name,
  }));
}

type DealOptionRow = Omit<DealOption, "sfDealId" | "amount" | "clientSfId" | "accountLast4" | "transferringFirm" | "linkedTransferId"> & {
  sf_deal_id: string | null; amount: Prisma.Decimal | number; client_sf_id: string | null; account_last4: string | null;
  transferring_firm: string | null; linked_transfer_id: string | null;
};

/** The client's open deals, and the household's, with the transfer each is already linked to. */
export async function readDealOptions(
  tx: Prisma.TransactionClient,
  clientSfId: string,
  householdSfId: string | null,
): Promise<DealOption[]> {
  const household = householdSfId?.trim() ? householdSfId.trim().slice(0, 15) : null;
  const rows = await tx.$queryRaw<DealOptionRow[]>(Prisma.sql`
    SELECT d.id, d.sf_deal_id, d.name, d.amount, d.stage::text AS stage, d.client_sf_id, d.account_last4, d.transferring_firm,
           t.id AS linked_transfer_id
      FROM app.deal d
      LEFT JOIN app.transfer t ON t.deal_id = d.id
     WHERE d.archived_at IS NULL
       AND (${clientMatch(Prisma.sql`d.client_sf_id`, clientSfId)}
            OR (${household}::text IS NOT NULL AND left(d.household_sf_id, 15) = ${household}))
     ORDER BY (d.stage IN ('WON', 'LOST')), d.close_date NULLS LAST, d.id
     LIMIT 50`);
  return rows.map((row) => ({
    id: row.id,
    sfDealId: row.sf_deal_id,
    name: row.name,
    amount: Number(row.amount),
    stage: row.stage,
    clientSfId: row.client_sf_id,
    accountLast4: row.account_last4,
    transferringFirm: row.transferring_firm,
    linkedTransferId: row.linked_transfer_id,
  }));
}

export async function getDealOptions(identity: Identity, clientSfId: string, householdSfId: string | null): Promise<DealOption[]> {
  if (!clientSfId.trim()) return [];
  return withUserScope(identity, (tx) => readDealOptions(tx, clientSfId.trim(), householdSfId));
}

/** Active (not retired, not merged) custodian profiles; null when the role cannot read the library. */
export async function listCustodianOptions(identity: Identity): Promise<CustodianOption[] | null> {
  if (!canReadCustodianLibrary(identity.role)) return null;
  return withUserScope(identity, (tx) => tx.custodianProfile.findMany({
    where: { retired_at: null, merged_into_id: null },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  }));
}

export async function readCustodianOption(tx: Prisma.TransactionClient, custodianId: string): Promise<CustodianOption | null> {
  if (!custodianId.trim()) return null;
  return tx.custodianProfile.findFirst({
    where: { id: custodianId.trim(), retired_at: null, merged_into_id: null },
    select: { id: true, name: true },
  });
}

const firmKey = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

/** The profile whose name exactly matches a recorded firm name, as a suggestion only. */
export function suggestedCustodian(options: readonly CustodianOption[], firm: string | null | undefined): CustodianOption | null {
  if (!firm?.trim()) return null;
  const wanted = firmKey(firm);
  const matches = options.filter((option) => firmKey(option.name) === wanted);
  return matches.length === 1 ? matches[0] : null;
}

const ROSTER_ROLES = ["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE"] as const;

/** AOA users who can own transfer work. A repeated name is told apart by its email. */
export async function readTaskOwnerRoster(): Promise<RosterPerson[]> {
  const users = await prisma.user.findMany({
    where: { role: { in: [...ROSTER_ROLES] }, email: { not: null } },
    select: { name: true, email: true },
  });
  const people = users.flatMap((user) => user.email?.trim() ? [{ name: user.name?.trim() || user.email.trim(), email: user.email.trim() }] : []);
  const counts = new Map<string, number>();
  for (const person of people) counts.set(person.name.toLowerCase(), (counts.get(person.name.toLowerCase()) ?? 0) + 1);
  return people
    .map((person) => (counts.get(person.name.toLowerCase()) ?? 0) > 1 ? { ...person, name: `${person.name} · ${person.email}` } : person)
    .sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
}

/** Operations fee requests on file for the linked client; only Operations roles read them. */
export async function getClientFeeRequests(identity: Identity, clientSfId: string | null): Promise<ClientFeeRequests> {
  if (!clientSfId?.trim()) return { state: "unlinked" };
  if (!canRecordOperationsOnlyTransferFact(identity.role)) return { state: "unavailable" };
  try {
    const read = await withUserScope(identity, (tx) => readClientFeeRequests(tx, clientSfId.trim()));
    return read.client ? { state: "ready", requests: read.requests, truncated: read.truncated } : { state: "unlinked" };
  } catch {
    console.error("[transfer-connections] fee_requests_unavailable");
    return { state: "unavailable" };
  }
}

/** The linked client's Trade Requests, through the existing per-client read. */
export async function getClientTradeRequests(identity: Identity, clientSfId: string | null): Promise<ClientTradeRequests> {
  if (!clientSfId?.trim()) return { state: "unlinked" };
  let cedarRidgeUserId: string | null;
  try {
    cedarRidgeUserId = await getCedarRidgeUserIdForLinkedReads(identity, clientSfId.trim());
  } catch {
    return { state: "unavailable" };
  }
  if (!cedarRidgeUserId) return { state: "unlinked" };
  try {
    const rows = await readTradeRequestsForUserCached(cedarRidgeUserId);
    return {
      state: "ready",
      requests: rows.map((row) => ({ id: row.id, status: row.status, tradeType: row.tradeType, createdAt: row.createdAt })),
    };
  } catch {
    return { state: "unavailable" };
  }
}

type ApexRow = { account_type: string | null; account_status: string | null; apex_account_number: string | null };

export async function readApexAccountRows(tx: Prisma.TransactionClient, clientSfId: string | null): Promise<ApexRow[]> {
  if (!clientSfId?.trim()) return [];
  return tx.$queryRaw<ApexRow[]>(Prisma.sql`
    SELECT account_type, account_status, apex_account_number
      FROM mirror.client_account_aum
     WHERE ${clientMatch(Prisma.sql`client_sf_id`, clientSfId.trim())}
       AND source_present
     ORDER BY (apex_account_number IS NULL), custodian_account_id`);
}

/**
 * Each recorded receiving account against the client's Apex accounts. A
 * same-type Apex account decides the status; the recorded status stands only
 * when Apex has no account of that type.
 */
export function reconcileReceivingAccounts(
  accounts: readonly { id: string; label: string; status: string }[],
  apex: readonly ApexRow[],
  fallbackType: string | null,
): ReconciledReceivingAccount[] {
  return accounts.map((account) => {
    const stored = account.status === "OPEN" ? "OPEN" : "TO_OPEN";
    const type = accountTypeFromLabel(account.label) || fallbackType || "";
    const want = canonicalizeRegistrationType(type);
    const sameType = want ? apex.filter((row) => canonicalizeRegistrationType(row.account_type) === want) : [];
    if (sameType.length === 0) {
      return { id: account.id, label: account.label, status: stored, source: "manual" as const, apexMasked: null };
    }
    const { status, match } = matchReceivingAccount(type, sameType);
    const number = match?.apex_account_number?.replace(/\W/g, "") ?? "";
    return { id: account.id, label: account.label, status, source: "apex" as const, apexMasked: number ? `••••${number.slice(-4)}` : null };
  });
}

export async function getReconciledReceivingAccounts(
  identity: Identity,
  clientSfId: string | null,
  accounts: readonly { id: string; label: string; status: string }[],
  fallbackType: string | null,
): Promise<ReconciledReceivingAccount[]> {
  if (!accounts.length) return [];
  const apex = await withUserScope(identity, (tx) => readApexAccountRows(tx, clientSfId));
  return reconcileReceivingAccounts(accounts, apex, fallbackType);
}

/** The client's other transfers, as the intake sees them (sources already moving, open receiving accounts). */
export async function clientIntakeRows(
  tx: Prisma.TransactionClient, clientSfId: string | null, firstName: string, lastName: string,
): Promise<IntakeTransferRow[]> {
  const rows = await tx.transfer.findMany({
    where: {
      archived_at: null,
      ...(clientSfId ? { client_sf_id: clientSfId } : {
        client_first_name: { equals: firstName, mode: "insensitive" as const },
        client_last_name: { equals: lastName, mode: "insensitive" as const },
      }),
    },
    select: {
      id: true, stage: true, transferring_firm: true, asset_map_account_type: true, asset_map_account_number: true,
      source_account_type: true, source_account_last4: true, source_account_title: true,
      receiving_account_type: true, receiving_account_title: true,
      accounts: { where: { status: "OPEN" }, select: { label: true }, orderBy: { created_at: "asc" } },
      outcomes: { select: { outcome: true, resumed: true }, orderBy: { created_at: "desc" }, take: 1 },
    },
    orderBy: { created_at: "asc" },
  });
  return rows.map((row) => {
    const outcome = row.outcomes[0];
    const stopped = outcome && !outcome.resumed && (STOPPED_OUTCOMES as readonly string[]).includes(outcome.outcome);
    const compact = (row.asset_map_account_number ?? "").replace(/[^A-Za-z0-9]/g, "");
    return {
      transferId: row.id,
      institution: row.transferring_firm,
      type: row.asset_map_account_type ?? row.source_account_type,
      last4: compact ? compact.slice(-4) : row.source_account_last4,
      title: row.source_account_title,
      receivingType: row.receiving_account_type,
      receivingTitle: row.receiving_account_title,
      openAccounts: row.accounts.map((account) => account.label),
      active: row.stage !== "FUNDED" && !stopped,
    };
  });
}

/** Source facts for a picked asset-map account: custodian, type, last four and holder. Never the full number. */
/** One of the client's asset-map accounts: display facts plus the server-only link key. */
export async function readAssetMapSourceFacts(
  tx: Prisma.TransactionClient, accountId: string, client: AssetMapClientScope,
): Promise<{ facts: IntakeSourceFacts; key: AssignableAssetMapAccountKey } | null> {
  const account = await resolveAssignableAssetMapAccount(tx, accountId, client);
  if (!account) return null;
  const holder = await tx.$queryRaw<{ account_holder: string | null }[]>(Prisma.sql`
    SELECT account_holder FROM mirror.acat_asset_map_account WHERE id = ${accountId} LIMIT 1`);
  const number = account.accountNumber?.replace(/[^A-Za-z0-9]/g, "") ?? "";
  return {
    facts: {
      institution: account.custodian,
      type: account.accountType,
      last4: number.length >= 4 ? number.slice(-4) : null,
      title: holder[0]?.account_holder?.trim() || null,
    },
    key: account,
  };
}

export type IntakeReceivingOption = { key: string; type: string; masked: string | null; label: string };

/** The client's open Apex accounts, offered as existing receiving accounts at intake. */
export function openApexReceivingOptions(apex: readonly ApexRow[]): IntakeReceivingOption[] {
  const seen = new Set<string>();
  return apex.flatMap((row) => {
    const type = row.account_type?.trim();
    if (!type || matchReceivingAccount(type, [row]).status !== "OPEN") return [];
    const number = row.apex_account_number?.replace(/\W/g, "") ?? "";
    const masked = number ? `••••${number.slice(-4)}` : null;
    const key = `${canonicalizeRegistrationType(type)}|${masked ?? ""}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ key, type, masked, label: masked ? `${type} ${masked}` : type }];
  });
}

/** The workspace detail's connected records for one transfer. Each read degrades on its own. */
export async function getTransferConnections(
  identity: Identity,
  transfer: TransferRow,
  accounts: readonly TransferAccountRow[],
  deal: DealRow | null,
): Promise<TransferConnections> {
  const operations = canRecordOperationsOnlyTransferFact(identity.role);
  const found = transfer.client_sf_id ? await getDirectoryClient(identity, transfer.client_sf_id).catch(() => null) : null;
  const directoryClient = found
    ? { sfId: found.sfId, name: found.name, householdSfId: found.householdSfId, householdName: found.householdName }
    : null;
  const { name, householdName, source } = connectedIdentity(transfer, directoryClient, deal ? {
    clientFirstName: deal.client_first_name,
    clientLastName: deal.client_last_name,
    householdName: deal.household_name,
    householdSfId: deal.household_sf_id,
  } : null);
  const custodianId = transfer.delivering_custodian_id ?? null;
  const custodian = custodianId && canReadCustodianLibrary(identity.role)
    ? await withUserScope(identity, (tx) => readCustodianOption(tx, custodianId)).catch(() => null)
    : null;
  const roster = await readTaskOwnerRoster().catch(() => []);
  const feeRequests = await getClientFeeRequests(identity, transfer.client_sf_id);
  const tradeRequests: ClientTradeRequests = operations ? await getClientTradeRequests(identity, transfer.client_sf_id) : { state: "unavailable" };
  const receiving = await getReconciledReceivingAccounts(
    identity, transfer.client_sf_id, accounts, transfer.receiving_account_type ?? transfer.asset_map_account_type,
  ).catch(() => accounts.map((account) => ({
    id: account.id, label: account.label, status: account.status === "OPEN" ? "OPEN" as const : "TO_OPEN" as const,
    source: "manual" as const, apexMasked: null,
  })));
  let trackerControlNumber: string | null = null;
  if (transfer.acat_record_id || transfer.acat_transfer_id) {
    try {
      trackerControlNumber = (await readAcatStatusForTransferCached(transfer.acat_record_id, transfer.acat_transfer_id))?.controlNumber ?? null;
    } catch {
      trackerControlNumber = null;
    }
  }
  return {
    client: { name, householdName, source },
    directoryClient,
    custodian,
    roster,
    feeRequests,
    tradeRequests,
    receiving,
    trackerControlNumber,
  };
}
