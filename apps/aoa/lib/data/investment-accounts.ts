import { Prisma } from "@prisma/client";
import { withUserScope, type Identity } from "@/lib/rls";
import { previousTradingDay, toDateStr } from "@/lib/market-calendar";
import { crmCanonicalHouseholdSourceKeys } from "@/lib/crm/resolve";
import { FIRM_ACCOUNT_IDS, FIRM_HOUSEHOLD_ID } from "./firm-household";
import type { InvestmentAccount } from "./types";

/** Display only. Never use this seam to authorize Apex reports, forms or trades.
 * UNION ALL is safe: the custodians have separate account identities. No join
 * to clients/households here can multiply balances. Both tables enforce RLS.
 * Full Schwab numbers and source fingerprints are deliberately NOT selected.
 * Unconfirmed rows remain in this base so firmwide coverage can fail closed;
 * attributed account lists below select only confirmed rows. */
export function investmentAccountBaseSql(now: Date = new Date()): Prisma.Sql {
  const today = toDateStr(now);
  const minimum = previousTradingDay(today);
  return Prisma.sql`
    SELECT custodian_account_id AS account_id, 'Apex'::text AS custodian,
           COALESCE(apex_account_number, custodian_account_id) AS display_number,
           account_type, account_status, client_sf_id,
           CASE WHEN custodian_account_id IN (${Prisma.join([...FIRM_ACCOUNT_IDS])})
             THEN ${FIRM_HOUSEHOLD_ID} ELSE household_sf_id END AS household_sf_id,
           account_aum, account_cash, account_securities, balance_as_of,
           balance_current AND account_aum IS NOT NULL
             AND account_status IS DISTINCT FROM 'CLOSED' AS balance_current,
           close_date, close_date_source, true AS confirmed,
           (custodian_account_id IN (${Prisma.join([...FIRM_ACCOUNT_IDS])})
            OR COALESCE(household_sf_id = ${FIRM_HOUSEHOLD_ID}, false)) AS is_firm
      FROM mirror.client_account_aum WHERE source_present
    UNION ALL
    SELECT account_id, 'Schwab'::text, '••••' || account_number_last4,
           COALESCE(account_type, registration_type), account_status, client_sf_id,
           CASE WHEN account_scope = 'FIRM_OPERATING' THEN ${FIRM_HOUSEHOLD_ID}
                ELSE household_sf_id END,
           account_aum, account_cash, account_securities, balance_as_of,
           balance_current AND account_status <> 'CLOSED' AND resolution_state = 'CONFIRMED'
             AND account_scope IN ('CLIENT', 'FIRM_OPERATING')
             AND balance_as_of BETWEEN ${minimum}::date AND ${today}::date,
           NULL::date, NULL::text,
           resolution_state = 'CONFIRMED' AND account_scope IN ('CLIENT', 'FIRM_OPERATING'),
           account_scope = 'FIRM_OPERATING'
      FROM mirror.schwab_account_balance WHERE source_present`;
}

type RawInvestmentAccount = {
  account_id: string; custodian: "Apex" | "Schwab"; display_number: string;
  account_type: string | null; account_status: string | null;
  client_sf_id: string | null; household_sf_id: string | null;
  account_aum: unknown; account_cash: unknown; account_securities: unknown;
  balance_as_of: Date | null; balance_current: boolean;
  close_date: Date | null; close_date_source: "APEX" | "PROVISIONAL_OVERRIDE" | null;
  is_firm: boolean;
};

function mapAccount(row: RawInvestmentAccount): InvestmentAccount {
  return {
    id: `${row.custodian}:${row.account_id}`,
    sourceAccountId: row.account_id,
    custodian: row.custodian, num: row.display_number,
    type: row.account_type ?? "Account", status: row.account_status ?? "",
    value: row.account_aum == null ? null : Number(row.account_aum),
    cash: row.account_cash == null ? null : Number(row.account_cash),
    securities: row.account_securities == null ? null : Number(row.account_securities),
    balanceAsOf: row.balance_as_of?.toISOString().slice(0, 10) ?? null,
    balanceCurrent: row.balance_current,
    closeDate: row.close_date?.toISOString().slice(0, 10) ?? null,
    closeDateSource: row.close_date_source,
    clientSfId: row.client_sf_id, householdSfId: row.household_sf_id,
    firmOperating: row.is_firm,
  };
}

async function accountsWhere(id: Identity, predicate: Prisma.Sql): Promise<InvestmentAccount[]> {
  const rows = await withUserScope(id, (tx) => tx.$queryRaw<RawInvestmentAccount[]>(Prisma.sql`
    WITH accounts AS (${investmentAccountBaseSql()})
    SELECT account_id, custodian, display_number, account_type, account_status,
           client_sf_id, household_sf_id, account_aum, account_cash, account_securities,
           balance_as_of, balance_current, close_date, close_date_source, is_firm
      FROM accounts WHERE confirmed AND ${predicate}
     ORDER BY account_aum DESC NULLS LAST, custodian, account_id`));
  return rows.map(mapAccount);
}

export async function investmentAccountsForClient(id: Identity, clientSfId: string): Promise<InvestmentAccount[]> {
  if (!clientSfId) return [];
  return accountsWhere(id, Prisma.sql`left(client_sf_id, 15) = ${clientSfId.slice(0, 15)} AND NOT is_firm`);
}

export async function investmentAccountsForHouseholdSources(id: Identity, householdSfIds: string[]): Promise<InvestmentAccount[]> {
  const keys = [...new Set(householdSfIds.filter(Boolean).map((key) => key.slice(0, 15)))];
  if (!keys.length) return [];
  // Same canonical source bound as the existing Apex read. Fail, never truncate
  // and quietly understate a household if the identity contract ever expands.
  if (keys.length > 16) throw new Error("investment_accounts_household_scope_limit");
  return accountsWhere(id, Prisma.sql`left(household_sf_id, 15) IN (${Prisma.join(keys)})`);
}

export type InvestmentAumState = {
  value: number | null;
  availability: "AVAILABLE" | "PENDING" | "ABSENT";
  source: "apex" | "custodians" | null;
};

export function investmentAumState(accounts: readonly InvestmentAccount[]): InvestmentAumState {
  const source = accounts.some((a) => a.custodian === "Schwab") ? "custodians" : "apex";
  if (!accounts.length) return { value: null, availability: "ABSENT", source: null };
  if (accounts.some((a) => a.status.toUpperCase() !== "CLOSED" && (!a.balanceCurrent || a.value == null))) {
    return { value: null, availability: "PENDING", source };
  }
  const cents = accounts.reduce((sum, a) => sum +
    (a.balanceCurrent && a.status.toUpperCase() !== "CLOSED" ? Math.round((a.value ?? 0) * 100) : 0), 0);
  return { value: cents / 100, availability: "AVAILABLE", source };
}

export async function householdInvestmentAumStateForSources(id: Identity, keys: string[]): Promise<InvestmentAumState> {
  return investmentAumState(await investmentAccountsForHouseholdSources(id, keys));
}

export async function householdInvestmentAumState(id: Identity, key: string): Promise<InvestmentAumState> {
  const sources = key === FIRM_HOUSEHOLD_ID ? [key] : await crmCanonicalHouseholdSourceKeys(id, key);
  return householdInvestmentAumStateForSources(id, sources);
}
