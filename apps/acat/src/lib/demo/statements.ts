// The statement pipeline's view of the demo: one parsed statement per delivering account the demo's
// transfers use, in the pipeline's response shapes (/api/v1/positions and /api/v1/position-accounts).
// It comes from the same plan the seed writes, so a sync returns the positions the seed recorded. It
// also holds the outside account of each household with no transfer yet, for a visitor to open one.

import { createHash } from "node:crypto";
import { assetsFromHoldings, planDemoTransfers, previousMonthEnd, type DemoFirm, type PlannedTransfer } from "./seed";
import { ACCOUNT_TYPE, accountOwners, addBusinessDays, calendarDaysBetween, ownerNames, pastBusinessInstant, seededInt, type Universe } from "./universe";

export interface PipelinePosition {
  symbol: string;
  description: string;
  quantity: number;
  market_value: number;
  asset_type: string | null;
  transfer_eligible: string;
  transferring: "YES" | "NO";
}

export interface PipelineStatement {
  id: string;
  account_number: string;
  client_name: string;
  account_holder: string;
  custodian: string;
  account_type: string;
  account_registration: string;
  statement_date: string;
  statement_age_days: number;
  is_stale: boolean;
  processed_at: string;
  is_historical: boolean;
  positions: PipelinePosition[];
}

/** A stable RFC 4122-shaped id for a statement account. */
function uuidFrom(text: string): string {
  const hex = createHash("sha256").update(text).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function pipelineStatements(universe: Universe, now: Date): PipelineStatement[] {
  const { today, transfers, firms } = planDemoTransfers(universe, now);
  const statements = new Map<string, PipelineStatement>();
  for (const t of transfers) {
    const number = t.statementAccountNumber;
    if (!number || !t.statement || t.assets.length === 0 || statements.has(number)) continue;
    const owners = ownerNames(accountOwners(universe, t.account));
    const registration = ACCOUNT_TYPE[t.account.type];
    statements.set(number, {
      id: uuidFrom(`statement:${number}`),
      account_number: number,
      client_name: owners,
      account_holder: owners,
      custodian: t.firm.name,
      account_type: registration,
      account_registration: registration,
      statement_date: t.statement.periodEnd,
      statement_age_days: calendarDaysBetween(t.statement.periodEnd, today),
      is_stale: t.statement.stale,
      processed_at: pastBusinessInstant(t.requestDay, `${t.id}:statement`, now).toISOString(),
      is_historical: false,
      positions: t.assets.map((a) => ({
        symbol: a.symbol,
        description: a.description,
        quantity: a.expectedQty,
        market_value: a.amount,
        asset_type: a.assetClass,
        transfer_eligible: a.liquidate ? "Liquidate" : "Transfer in kind",
        transferring: "YES",
      })),
    });
  }
  for (const statement of walkInStatements(universe, today, now, transfers, firms)) {
    if (!statements.has(statement.account_number)) statements.set(statement.account_number, statement);
  }
  return [...statements.values()];
}

/** The firm holding the outside account of a household that starts the day with no transfer. */
const WALK_IN_FIRM = "BNY Investments";

/**
 * A household with no seeded transfer is where a visitor opens one. The pipeline already holds the
 * statement for its outside account, so the new transfer can sync positions and be reconciled.
 */
function walkInStatements(universe: Universe, today: string, now: Date, transfers: PlannedTransfer[], firms: DemoFirm[]): PipelineStatement[] {
  const busy = new Set(transfers.map((t) => t.household));
  const firm = firms.find((f) => f.name === WALK_IN_FIRM);
  if (!firm) return [];
  const periodEnd = previousMonthEnd(today);
  return universe.households
    .filter((h) => !busy.has(h.id))
    .flatMap((household) => {
      const account = universe.accounts.find((a) => a.household === household.id);
      if (!account) return [];
      const number = `${firm.prefix}-${seededInt(`${household.id}:walk-in:acct`, 10000000, 99999999)}`;
      const owners = ownerNames(accountOwners(universe, account));
      const registration = ACCOUNT_TYPE[account.type];
      const positions = assetsFromHoldings(universe, account, Math.round(account.value * 0.7), "Pending", `${household.id}:walk-in`);
      return [{
        id: uuidFrom(`statement:${number}`),
        account_number: number,
        client_name: owners,
        account_holder: owners,
        custodian: firm.name,
        account_type: registration,
        account_registration: registration,
        statement_date: periodEnd,
        statement_age_days: calendarDaysBetween(periodEnd, today),
        is_stale: false,
        processed_at: pastBusinessInstant(addBusinessDays(today, -1), `${household.id}:walk-in:statement`, now).toISOString(),
        is_historical: false,
        positions: positions.map((a) => ({
          symbol: a.symbol,
          description: a.description,
          quantity: a.expectedQty,
          market_value: a.amount,
          asset_type: a.assetClass,
          transfer_eligible: "Transfer in kind",
          transferring: "YES" as const,
        })),
      }];
    });
}
