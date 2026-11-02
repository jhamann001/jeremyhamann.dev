import "server-only";
import { listRecords, readRecord } from "./store";
import type { StandInCall, StandInReply, StandInRoute } from "./fetch";

// The warehouse (saved queries over the custodian's data), answered in the demo. AoA runs only saved cards, by id, plus
// the trade reconciliation's two fixed queries; each is answered from the warehouse's rows here:
//   6472  account resolver: the custodian account behind an account number (kind "account", id = account number)
//   6634  new funding: ACH, check and wire deposits into an account (kind "funding", one row per activity)
//   6700  the activity feed's source date (the last business day)
//   6898  the Plaid-linked (held-away) accounts' summaries (kind "linked_summary", one row per account)
//   6899  a Plaid-linked account's holdings (kind "linked_holdings", id = external account id, `rows`)
//   trade reconciliation: the custodian's trade executions and the rebalancer's orders for a business date
//         (kinds "apex_trade" and "rebalancer_order")
// The performance report's cards (6469-6471, 6502) are not here: those pages are off in production too.

export interface AccountRow {
  account_id: string;
  apex_acct: string;
  account_type: string | null;
  account_nickname: string | null;
  client_name: string | null;
}

export interface FundingRow {
  account_id: string;
  activity_id: string;
  activity_date: string;
  settle_date: string | null;
  net_amount: number;
  funding_method: "ACH" | "Check" | "Wire";
  activity_description: string | null;
  source_application_id: string | null;
  generation: number;
}

export interface LinkedHoldings {
  rows: Record<string, unknown>[];
}

export interface ApexTrade {
  activity_id: string;
  process_date: string;
  account_id: string;
  asset_type: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  net_amount: number;
  gross_amount: number;
  client_order_id: string | null;
  activity_time: string;
}

export interface RebalancerOrder {
  rebalancer_order_id: string;
  apex_account_id: string;
  asset_type: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  notional_amount: number;
  initiated_timestamp: string;
  client_basket_id: string | null;
  apex_basket_id: string | null;
}

const rows = (json: unknown[]): StandInReply => ({ status: 200, json });

/** A card's template-tag value: `{ target: ["variable", ["template-tag", name]], value }`. */
export function tagValue(parameters: unknown, name: string): unknown {
  if (!Array.isArray(parameters)) return undefined;
  for (const p of parameters) {
    const target = (p as { target?: unknown })?.target;
    if (Array.isArray(target) && Array.isArray(target[1]) && target[1][0] === "template-tag" && target[1][1] === name) {
      return (p as { value?: unknown }).value;
    }
  }
  return undefined;
}

/** The last weekday before `day` (the feed lands overnight). */
export function lastBusinessDay(day = new Date()): string {
  const d = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  do d.setUTCDate(d.getUTCDate() - 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

async function card({ params, body }: StandInCall): Promise<StandInReply> {
  const parameters = (body as { parameters?: unknown } | null)?.parameters;
  switch (params.card) {
    case "6472": {
      const record = await readRecord<AccountRow>("warehouse", "account", String(tagValue(parameters, "account_number") ?? ""));
      return rows(record ? [record.doc] : []);
    }
    case "6634": {
      const account = String(tagValue(parameters, "account_id") ?? "");
      const since = String(tagValue(parameters, "start_date") ?? "");
      const all = await listRecords<FundingRow>("warehouse", "funding");
      return rows(all.map((r) => r.doc).filter((f) => f.account_id === account && f.activity_date >= since)
        .sort((a, b) => b.activity_date.localeCompare(a.activity_date)));
    }
    case "6700":
      return rows([{ as_of: lastBusinessDay() }]);
    case "6898":
      return rows((await listRecords<Record<string, unknown>>("warehouse", "linked_summary")).map((r) => r.doc));
    case "6899": {
      const record = await readRecord<LinkedHoldings>("warehouse", "linked_holdings", String(tagValue(parameters, "external_account_id") ?? ""));
      return rows(record?.doc.rows ?? []);
    }
    default:
      return { status: 501, json: { error: "not_in_demo" } };
  }
}

/** The native queries AoA sends are fixed; the trade reconciliation's two are told apart by the table they read. */
async function dataset({ body }: StandInCall): Promise<StandInReply> {
  let query: { native?: { query?: unknown }; parameters?: unknown };
  try {
    query = JSON.parse(String((body as { query?: unknown } | null)?.query ?? ""));
  } catch {
    return { status: 400, json: { error: "invalid_query" } };
  }
  const sql = String(query.native?.query ?? "");
  const day = String(tagValue(query.parameters, "business_date") ?? "");
  const counted = <T extends object>(list: T[]) => rows(list.map((r) => ({ ...r, source_row_count: list.length })));
  if (sql.includes("FROM apex.apex_daily_activities")) {
    const trades = (await listRecords<ApexTrade>("warehouse", "apex_trade")).map((r) => r.doc).filter((t) => t.process_date === day);
    return counted(trades);
  }
  if (sql.includes("FROM investment.rebalancer_order")) {
    const orders = (await listRecords<RebalancerOrder>("warehouse", "rebalancer_order")).map((r) => r.doc)
      .filter((o) => o.initiated_timestamp.slice(0, 10) === day);
    return counted(orders);
  }
  return { status: 501, json: { error: "not_in_demo" } };
}

export const WAREHOUSE_ROUTES: readonly StandInRoute[] = [
  ["POST", "/api/card/:card/query/json", card],
  ["POST", "/api/dataset/json", dataset],
];
