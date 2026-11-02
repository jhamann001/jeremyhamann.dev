import { withUserScope } from "@/lib/rls";
import type { Identity } from "@/lib/rls";
import { Prisma } from "@prisma/client";
import { FIRM_HOUSEHOLD_ID } from "./firm-household";

// tkt account-AUM read seam. REAL, RLS-scoped reads from mirror.client_account_aum
// (written by the daily cron pull, app/api/cron/account-aum). Every function runs
// inside withUserScope, so Postgres RLS scopes rows to the caller's book (Ops/
// Admin/HoA see the firm; an advisor/CS sees only accounts whose household is in
// their book — the client_account_aum_own_book policy rides through mirror.household).
//
// DECIMAL/BIGINT TRAP (carried, see lib/data/households.ts): account_aum is a
// Postgres numeric → a Prisma Decimal at runtime; sum(...) is numeric and count(*)
// is bigint. None serialize across the RSC boundary, so ALL Number()-coercion
// lives HERE, at the seam — a raw Decimal never leaves this file.

export type ApexAccountAum = {
  // ticket: the ULID key (mirror.client_account_aum PK). ALWAYS present.
  custodianAccountId: string;
  // null for the firm's corporate accounts (they have no Apex account number);
  // always present for client accounts.
  apexAccountNumber: string | null;
  accountType: string | null;
  isManaged: boolean;
  accountStatus: string | null;
  // null when the feed has no valuation for the account (unknown), distinct from
  // a genuine $0 balance which stays 0. NULLs sort last (query ORDER BY ... NULLS LAST).
  accountAum: number | null;
  accountCash: number | null;
  accountSecurities: number | null;
  balanceAsOf: Date | null;
  sourceSnapshotAsOf: Date | null;
  balanceCurrent: boolean;
  sourcePresent: boolean;
  closeDate: Date | null;
  closeDateSource: "APEX" | "PROVISIONAL_OVERRIDE" | null;
  asOf: Date | null;
  // SF Contact (003) id of the account's owner; null for a firm/unlinked account.
  clientSfId: string | null;
};

type RawApexRow = {
  custodian_account_id: string;
  apex_account_number: string | null;
  account_type: string | null;
  is_managed: boolean;
  account_status: string | null;
  account_aum: unknown; // Decimal at runtime
  account_cash: unknown;
  account_securities: unknown;
  balance_as_of: Date | null;
  source_snapshot_as_of: Date | null;
  balance_current: boolean;
  source_present: boolean;
  close_date: Date | null;
  close_date_source: "APEX" | "PROVISIONAL_OVERRIDE" | null;
  as_of: Date | null;
  client_sf_id: string | null;
};

type RawAumStateRow = {
  total: unknown;
  n: bigint;
  open_n: bigint;
  current_open_n: bigint;
};

export type ApexAumState = {
  value: number | null;
  availability: "AVAILABLE" | "PENDING" | "ABSENT";
};

function mapAumState(row: RawAumStateRow | undefined): ApexAumState {
  if (!row || Number(row.n) === 0) return { value: null, availability: "ABSENT" };
  if (Number(row.open_n) !== Number(row.current_open_n)) {
    return { value: null, availability: "PENDING" };
  }
  // A lifecycle containing only closed accounts has current AUM of exactly $0.
  return { value: row.total == null ? 0 : Number(row.total), availability: "AVAILABLE" };
}

function mapAccount(r: RawApexRow): ApexAccountAum {
  return {
    custodianAccountId: r.custodian_account_id,
    apexAccountNumber: r.apex_account_number,
    accountType: r.account_type,
    isManaged: r.is_managed,
    accountStatus: r.account_status,
    clientSfId: r.client_sf_id,
    accountAum: r.account_aum == null ? null : Number(r.account_aum),
    accountCash: r.account_cash == null ? null : Number(r.account_cash),
    accountSecurities: r.account_securities == null ? null : Number(r.account_securities),
    balanceAsOf: r.balance_as_of,
    sourceSnapshotAsOf: r.source_snapshot_as_of,
    balanceCurrent: r.balance_current,
    sourcePresent: r.source_present,
    closeDate: r.close_date,
    closeDateSource: r.close_date_source,
    // Compatibility alias for report callers. It now means the exact balance
    // date, never merely the date of the surrounding source snapshot.
    asOf: r.balance_as_of,
  };
}

/** All of a client's Apex accounts (managed AND unmanaged, INCLUDING $0), most
 *  valuable first. Empty for an unknown/out-of-book client or an empty id. */
export async function apexAccountsForClient(
  id: Identity,
  clientSfId: string,
): Promise<ApexAccountAum[]> {
  if (!clientSfId) return [];
  const rows = await withUserScope(id, (tx) =>
    tx.$queryRaw<RawApexRow[]>`
      SELECT custodian_account_id, apex_account_number, account_type, is_managed,
             account_status, account_aum, account_cash, account_securities,
             balance_as_of, source_snapshot_as_of, balance_current, source_present,
             close_date, close_date_source, as_of, client_sf_id
      FROM mirror.client_account_aum
      WHERE client_sf_id = ${clientSfId}
        AND source_present
      ORDER BY account_aum DESC NULLS LAST`,
  );
  return rows.map(mapAccount);
}

/** One Apex account row by its account number, RLS-scoped to the caller's book.
 *  This is the per-account authorization gate for the Performance report page:
 *  the client_account_aum_own_book policy returns the row ONLY when the account's
 *  household is in the caller's book (Ops/Admin/HoA see the firm), so an advisor
 *  requesting an out-of-book account gets null → the page 404s. null for an
 *  unknown account or an empty id. */
export async function apexAccountByNumber(
  id: Identity,
  apexAccountNumber: string,
): Promise<ApexAccountAum | null> {
  if (!apexAccountNumber) return null;
  const rows = await withUserScope(id, (tx) =>
    tx.$queryRaw<RawApexRow[]>`
      SELECT custodian_account_id, apex_account_number, account_type, is_managed,
             account_status, account_aum, account_cash, account_securities,
             balance_as_of, source_snapshot_as_of, balance_current, source_present,
             close_date, close_date_source, as_of, client_sf_id
      FROM mirror.client_account_aum
      WHERE apex_account_number = ${apexAccountNumber}
        AND source_present
      LIMIT 1`,
  );
  const r = rows[0];
  if (!r) return null;
  return mapAccount(r);
}

/** Resolve the selected form account under the caller's RLS scope. A display
 * number supplied by the browser never controls the generated document. */
export async function apexAccountByCustodianId(
  id: Identity,
  custodianAccountId: string,
): Promise<ApexAccountAum | null> {
  if (!custodianAccountId) return null;
  const rows = await withUserScope(id, (tx) =>
    tx.$queryRaw<RawApexRow[]>`
      SELECT custodian_account_id, apex_account_number, account_type, is_managed,
             account_status, account_aum, account_cash, account_securities,
             balance_as_of, source_snapshot_as_of, balance_current, source_present,
             close_date, close_date_source, as_of, client_sf_id
      FROM mirror.client_account_aum
      WHERE custodian_account_id = ${custodianAccountId}
        AND source_present
      LIMIT 1`,
  );
  return rows[0] ? mapAccount(rows[0]) : null;
}

/** All of a HOUSEHOLD's Apex accounts (managed AND unmanaged, INCLUDING $0),
 *  most valuable first, using the SAME left(...,15) width normalization
 *  householdApexAumTotal uses (mirror stores 15- or 18-char household ids; the
 *  feed carries 18-char). This is the member list for the household-level TWR
 *  Performance report: it runs inside withUserScope, so the
 *  client_account_aum_own_book RLS policy scopes rows to the caller's book —
 *  an out-of-book household yields [] and the page treats that like "no
 *  reportable accounts" (the household read itself already 404s out-of-book). */
export async function apexAccountsForHousehold(
  id: Identity,
  householdSfId: string,
): Promise<ApexAccountAum[]> {
  return apexAccountsForHouseholdSources(id, [householdSfId]);
}

/** All Apex accounts represented by a confirmed canonical household group. */
export async function apexAccountsForHouseholdSources(
  id: Identity,
  householdSfIds: string[],
): Promise<ApexAccountAum[]> {
  const keys = [
    ...new Set(householdSfIds.filter(Boolean).map((value) => value.slice(0, 15))),
  ].slice(0, 16);
  if (keys.length === 0) return [];
  const rows = await withUserScope(id, (tx) =>
    tx.$queryRaw<RawApexRow[]>(Prisma.sql`
      SELECT custodian_account_id, apex_account_number, account_type, is_managed,
             account_status, account_aum, account_cash, account_securities,
             balance_as_of, source_snapshot_as_of, balance_current, source_present,
             close_date, close_date_source, as_of, client_sf_id
      FROM mirror.client_account_aum
      WHERE left(household_sf_id, 15) IN (${Prisma.join(keys)})
        AND source_present
      ORDER BY account_aum DESC NULLS LAST`),
  );
  return rows.map(mapAccount);
}

/** A client's headline Apex AUM: SUM over ALL their accounts (managed +
 *  unmanaged — the locked "total of all accounts" definition). null when the
 *  client has NO account rows (so the caller can fall back), never 0-for-empty. */
export async function clientApexAumTotal(
  id: Identity,
  clientSfId: string,
): Promise<number | null> {
  return (await clientApexAumState(id, clientSfId)).value;
}

/** Distinguish no Apex relationship from the migration window where account
 * rows exist but the first governed current snapshot has not committed. */
export async function clientApexAumState(
  id: Identity,
  clientSfId: string,
): Promise<ApexAumState> {
  if (!clientSfId) return { value: null, availability: "ABSENT" };
  const rows = await withUserScope(id, (tx) =>
    tx.$queryRaw<RawAumStateRow[]>`
      SELECT sum(account_aum) FILTER (WHERE balance_current) AS total,
             count(*) AS n,
             count(*) FILTER (WHERE account_status IS DISTINCT FROM 'CLOSED') AS open_n,
             count(*) FILTER (
               WHERE account_status IS DISTINCT FROM 'CLOSED' AND balance_current
             ) AS current_open_n
      FROM mirror.client_account_aum
      WHERE client_sf_id = ${clientSfId}
        AND source_present`,
  );
  return mapAumState(rows[0]);
}

/** A household's headline Apex AUM: SUM over ALL accounts whose household_sf_id
 *  matches, using the SAME left(...,15) width normalization households.ts uses
 *  for deals (mirror stores 15- or 18-char ids; the feed carries 18-char).
 *  null when no matching account rows. */
export async function householdApexAumTotal(
  id: Identity,
  householdSfId: string,
): Promise<number | null> {
  return (await householdApexAumState(id, householdSfId)).value;
}

export async function householdApexAumState(
  id: Identity,
  householdSfId: string,
): Promise<ApexAumState> {
  return householdApexAumStateForSources(id, [householdSfId]);
}

/** Headline Apex state across every source in a canonical household group. */
export async function householdApexAumStateForSources(
  id: Identity,
  householdSfIds: string[],
): Promise<ApexAumState> {
  const keys = [
    ...new Set(householdSfIds.filter(Boolean).map((value) => value.slice(0, 15))),
  ].slice(0, 16);
  if (keys.length === 0) return { value: null, availability: "ABSENT" };
  const rows = await withUserScope(id, (tx) =>
    tx.$queryRaw<RawAumStateRow[]>(Prisma.sql`
      SELECT sum(account_aum) FILTER (WHERE balance_current) AS total,
             count(*) AS n,
             count(*) FILTER (WHERE account_status IS DISTINCT FROM 'CLOSED') AS open_n,
             count(*) FILTER (
               WHERE account_status IS DISTINCT FROM 'CLOSED' AND balance_current
             ) AS current_open_n
      FROM mirror.client_account_aum
      WHERE left(household_sf_id, 15) IN (${Prisma.join(keys)})
        AND source_present`),
  );
  return mapAumState(rows[0]);
}

/** ticket — firm-wide AUM roll-up for the Households KPI, split so the page
 *  can show BOTH a Client figure (excludes the firm household) and a Total that
 *  ties to Apex's report. Summed DIRECTLY over account_aum (not the per-household
 *  effective-AUM chain) so the numbers tie to the custodian to the penny:
 *    • total : SUM over every source-present, current row (= Apex's report total).
 *    • firm  : SUM over the firm household's accounts (household_sf_id =
 *              FIRM_HOUSEHOLD_ID). 0 for a caller who cannot see the firm.
 *  client = total − firm is derived by the pure `splitAum` helper at the page.
 *
 *  RLS-scoped like the rest of the seam: Ops/Admin/HoA see the whole firm (the
 *  target parity numbers); an advisor sees only their book (firm sum is 0 — the
 *  own_book policy's household join can't reach the synthetic firm household), so
 *  their Total and Client coincide. No visible/current aggregate remains
 *  unavailable; it is never coerced into a plausible $0 KPI. */
export async function firmWideAumSplit(
  id: Identity,
): Promise<{ total: number | null; firm: number | null; available: boolean }> {
  const rows = await withUserScope(id, (tx) =>
    tx.$queryRaw<{
      total: unknown; firm: unknown; n: bigint; open_n: bigint; current_open_n: bigint;
    }[]>`
      SELECT sum(account_aum) FILTER (WHERE balance_current) AS total,
             sum(account_aum) FILTER (
               WHERE balance_current AND household_sf_id = ${FIRM_HOUSEHOLD_ID}
             ) AS firm,
             count(*) AS n,
             count(*) FILTER (WHERE account_status IS DISTINCT FROM 'CLOSED') AS open_n,
             count(*) FILTER (
               WHERE account_status IS DISTINCT FROM 'CLOSED' AND balance_current
             ) AS current_open_n
      FROM mirror.client_account_aum
      WHERE source_present`,
  );
  const row = rows[0];
  const available = !!row && Number(row.n) > 0 &&
    Number(row.open_n) === Number(row.current_open_n);
  if (!available) return { total: null, firm: null, available: false };
  return {
    total: row?.total == null ? 0 : Number(row.total),
    firm: row?.firm == null ? 0 : Number(row.firm),
    available: true,
  };
}
