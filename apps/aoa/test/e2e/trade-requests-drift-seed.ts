// Synthetic drift rows for the ticket browser check and the standalone parity capture. Every SQL literal comes
// from test/fixtures/trade-request-drift-view-seed.json (synthetic, committed); nothing is user input.

export type DriftSeedAccount = {
  dayOffset: number;
  accountId: string;
  accountTitle: string;
  householdName: string;
  coverage: string;
  status: string;
  totalValueUsd: number;
  position: [number, number, number];
  template: [number, number, number];
  maxBucketDeltaPct: number | null;
  worstBucket: string | null;
  symbolBreachCount: number;
  details: Record<string, unknown>;
};
export type DriftSeed = {
  accounts: DriftSeedAccount[];
  overrides: Array<{ accountId: string; reason: string; note: string; expiresOn: string | null; setByName: string; updatedAt: string }>;
  shadowAccounts: DriftSeedAccount[];
  exclusions: {
    client: Array<{ clientId: string; ticker: string; kind: string; reason: string; noBuy: boolean; noSell: boolean; createdByName: string; createdAt: string }>;
    account: Array<{ accountId: string; ticker: string; kind: string; reason: string; noBuy: boolean; noSell: boolean; createdByName: string; createdAt: string }>;
  };
  roster: Array<{ email: string; name: string }>;
  /** Rows the synthetic Warehouse answers per card id (contacts 6043, investments 6040, balances 6042). */
  warehouse: Record<string, unknown[]>;
  inputs: { exclusions: unknown[] };
};

const RUN_STARTED_AT = "2026-10-18T13:15:00Z";
const IDENT = /^[a-z_]+$/;

function lit(value: string | number | boolean | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

function accountInsert(schema: string, table: string, a: DriftSeedAccount): string {
  return `INSERT INTO ${schema}.${table} (run_date_local, run_started_at, account_id, account_title, household_name, coverage, status, `
    + "total_value_usd, position_cash_pct, position_fixed_pct, position_equity_pct, template_cash_pct, template_fixed_pct, template_equity_pct, "
    + "max_bucket_delta_pct, worst_bucket, symbol_breach_count, tolerance_pct, uninvested_cash_threshold_pct, schema_version, snapshot_source, "
    + `snapshot_as_of, details) VALUES (CURRENT_DATE - ${a.dayOffset}, ${lit(RUN_STARTED_AT)}::timestamptz - interval '${a.dayOffset} day', `
    + `${lit(a.accountId)}, ${lit(a.accountTitle)}, ${lit(a.householdName)}, ${lit(a.coverage)}, ${lit(a.status)}, ${a.totalValueUsd}, `
    + `${a.position.join(", ")}, ${a.template.join(", ")}, ${lit(a.maxBucketDeltaPct)}, ${lit(a.worstBucket)}, ${a.symbolBreachCount}, 5, 99, 1, `
    + `'gcs', '2026-10-17T00:00:00Z', ${lit(JSON.stringify(a.details))}::jsonb)`;
}

/** The live run, the override, the standing exclusions and (AOA only) the shadow-only run, for `schema` (standalone: public). */
export function driftSeedStatements(seed: DriftSeed, schema: string, opts: { shadow: boolean }): string[] {
  if (!IDENT.test(schema)) throw new Error("invalid schema");
  return [
    ...seed.accounts.map((a) => accountInsert(schema, "position_drift_accounts", a)),
    ...seed.overrides.map((o) =>
      `INSERT INTO ${schema}.drift_status_overrides (account_id, reason, note, expires_on, set_by, set_by_name, created_at, updated_at) `
      + `VALUES (${lit(o.accountId)}, ${lit(o.reason)}, ${lit(o.note)}, ${lit(o.expiresOn)}, NULL, ${lit(o.setByName)}, ${lit(o.updatedAt)}, ${lit(o.updatedAt)})`),
    ...seed.exclusions.client.map((e) =>
      `INSERT INTO ${schema}.client_exclusions (client_id, ticker, kind, reason, no_buy, no_sell, created_by, created_by_name, created_at) `
      + `VALUES (${lit(e.clientId)}, ${lit(e.ticker)}, ${lit(e.kind)}, ${lit(e.reason)}, ${lit(e.noBuy)}, ${lit(e.noSell)}, NULL, ${lit(e.createdByName)}, ${lit(e.createdAt)})`),
    ...seed.exclusions.account.map((e) =>
      `INSERT INTO ${schema}.account_exclusions (account_id, ticker, kind, reason, no_buy, no_sell, created_by, created_by_name, created_at) `
      + `VALUES (${lit(e.accountId)}, ${lit(e.ticker)}, ${lit(e.kind)}, ${lit(e.reason)}, ${lit(e.noBuy)}, ${lit(e.noSell)}, NULL, ${lit(e.createdByName)}, ${lit(e.createdAt)})`),
    ...(opts.shadow ? seed.shadowAccounts.map((a) => accountInsert(schema, "shadow_position_drift_accounts", a)) : []),
  ];
}
