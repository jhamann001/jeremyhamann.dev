// Deterministic synthetic clients, accounts and firm households for the New
// Request browser check. Every value is invented; nothing is real client data.

export type SyntheticAccount = { ulid: string; number: string; type: string; balance: number; title: string; household?: { id: number; name: string } };
export type SyntheticClient = { id: string; name: string; accounts: SyntheticAccount[] };

const ulid = (n: number) => `01TRW11SYN${String(n).padStart(16, "0")}`;
let next = 1;
const account = (title: string, type: string, balance: number, household?: SyntheticAccount["household"]): SyntheticAccount => {
  const n = next++;
  return { ulid: ulid(n), number: `SYN${String(n).padStart(5, "0")}`, type, balance, title, household };
};

export const BRENNAN = { id: 7101, name: "Brennan Family Household (synthetic)" };
export const CARVER = { id: 7102, name: "Carver Household (synthetic)" };

export const SYNTHETIC_CLIENTS: SyntheticClient[] = [
  { id: "trw11-alex", name: "Maeve Brennan (synthetic)", accounts: [
    account("Maeve Brennan Individual", "BROKERAGE", 150_000, BRENNAN), account("Maeve Brennan Roth IRA", "ROTH_IRA", 42_000, BRENNAN)] },
  { id: "trw11-blair", name: "Lucille Howell (synthetic)", accounts: [account("Lucille Howell Traditional IRA", "TRADITIONAL_IRA", 88_000, BRENNAN)] },
  { id: "trw11-morgan", name: "Esta Barrows (synthetic)", accounts: [account("Esta Barrows Individual", "BROKERAGE", 61_000, CARVER)] },
  { id: "trw11-abdullah", name: "Abdullah Beatty (synthetic)", accounts: [
    account("Abdullah Beatty Roth IRA", "ROTH_IRA", 23_000, CARVER), account("Abdullah Beatty Joint", "JOINT_BROKERAGE_TENANTS_WITH_RIGHT_OF_SURVIVORSHIP", 310_000, CARVER)] },
  { id: "trw11-wide", name: "Wide Portfolio Trust (synthetic)", accounts: Array.from({ length: 55 }, (_, i) => account(`Wide Sleeve ${i + 1}`, "BROKERAGE", 10_000 + i)) },
  ...Array.from({ length: 52 }, (_, i) => ({
    id: `trw11-filler-${String(i + 1).padStart(2, "0")}`,
    name: `Synthetic Filler ${String(i + 1).padStart(2, "0")}`,
    accounts: [account(`Filler ${i + 1} Individual`, "BROKERAGE", 5_000 + i)],
  })),
];

export const TRW11_PORTS = { on: 3151, off: 3152, service: 8151, warehouse: 9151 } as const;
export const QUESTIONS = { contacts: "9101", investments: "9102", balances: "9103" } as const;

export function warehouseRows(question: string): unknown[] {
  if (question === QUESTIONS.contacts) {
    return SYNTHETIC_CLIENTS.map((client) => ({ cedar_ridge_user_id__c: client.id, name: client.name, crm__primary_entity_stage__c: "Client" }));
  }
  if (question === QUESTIONS.investments) {
    return SYNTHETIC_CLIENTS.flatMap((client) => client.accounts.map((a) => ({
      user_id: client.id, custodian_account_number: a.number, custodian_account_id: a.ulid, account_type: a.type,
    })));
  }
  if (question === QUESTIONS.balances) {
    return SYNTHETIC_CLIENTS.flatMap((client) => client.accounts.map((a) => ({
      account_id: a.ulid, total_equity: a.balance, cash_equity: a.balance, snapshot_timestamp: "2026-10-16T00:00:00Z",
    })));
  }
  return [];
}

/** Meridian active_accounts shape for MERIDIAN_SNAPSHOT_SOURCE=file. */
export function activeAccountsSnapshot() {
  const accounts = SYNTHETIC_CLIENTS.flatMap((client) => client.accounts).map((a) => ({
    trading_account_no: a.ulid, account_title: a.title, account_type: "NA",
    household_id: a.household?.id ?? null, household_name: a.household?.name ?? null,
  }));
  return { generated_at: "2026-10-16T00:00:00Z", firm_id: "synthetic", account_count: accounts.length, accounts };
}

export const byName = (name: string) => SYNTHETIC_CLIENTS.find((client) => client.name === name)!;
