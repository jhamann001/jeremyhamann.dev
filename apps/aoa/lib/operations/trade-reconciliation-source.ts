import "server-only";

import {
  WAREHOUSE_REQUEST_TIMEOUT_MS,
  readWarehouseEnv,
} from "@/lib/warehouse/client";
import type {
  MeridianTradeSourceRow,
  ApexTradeSourceRow,
  ReconciliationAssetType,
} from "@/lib/operations/trade-reconciliation";
import { serviceFetch } from "@/lib/demo/stand-ins/fetch";

const DATABASE_ID = 4;
const MAX_SOURCE_ROWS = 10_000;
// Bound the export in SQL, not preview constraints (Warehouse discards those).
// The extra row detects overflow; COUNT(*) OVER () independently proves that
// the export returned the complete filtered source before anything is saved.
const SOURCE_FETCH_LIMIT = MAX_SOURCE_ROWS + 1;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const APEX_QUERY = `SELECT
  activity_id,
  CAST(process_date AS date) AS process_date,
  account_id,
  asset_type,
  symbol,
  side,
  ABS(quantity) AS quantity,
  ABS(net_amount) AS net_amount,
  ABS(gross_amount) AS gross_amount,
  client_order_id,
  activity_time,
  COUNT(*) OVER () AS source_row_count
FROM apex.apex_daily_activities
WHERE type = 'TRADE'
  AND account_id <> '01SYNTH85BR7BT1ZPYKBDZAC9C'
  AND CAST(process_date AS date) = {{business_date}}
ORDER BY account_id, client_order_id, activity_id
LIMIT ${SOURCE_FETCH_LIMIT}`;

const MERIDIAN_QUERY = `SELECT
  rebalancer_order_id,
  apex_account_id,
  asset_type,
  symbol,
  ABS(quantity) AS quantity,
  ABS(notional_amount) AS notional_amount,
  side,
  initiated_timestamp,
  client_basket_id,
  apex_basket_id,
  COUNT(*) OVER () AS source_row_count
FROM investment.rebalancer_order
WHERE CAST(initiated_timestamp AS date) = {{business_date}}
ORDER BY apex_account_id, rebalancer_order_id
LIMIT ${SOURCE_FETCH_LIMIT}`;

type FixedSource = "apex" | "meridian";
const QUERIES: Record<FixedSource, string> = {
  apex: APEX_QUERY,
  meridian: MERIDIAN_QUERY,
};

export class TradeReconciliationSourceError extends Error {
  constructor(readonly reason:
    | "invalid_date" | "config_error" | "warehouse_error" | "invalid_source"
    | "source_truncated" | "source_limit_exceeded"
  ) {
    super(reason === "source_limit_exceeded"
      ? "A source exceeds the supported 10,000 rows. Complete retrieval requires source paging; no reconciliation was completed."
      : reason === "source_truncated"
        ? "A source returned incomplete results. No reconciliation was completed."
        : reason);
  }
}

function dateParameter(value: string) {
  return [{
    type: "date/single",
    target: ["variable", ["template-tag", "business_date"]],
    value,
  }];
}

function requestBody(source: FixedSource, businessDate: string) {
  return {
    // JSON-encoded query is supported by the native export API across versions.
    // Disable locale formatting so quantities, dollars and dates remain raw.
    format_rows: false,
    query: JSON.stringify({
      database: DATABASE_ID,
      type: "native",
      native: {
        query: QUERIES[source],
        "template-tags": {
          business_date: {
            id: "trade-reconciliation-business-date",
            name: "business_date",
            "display-name": "Business date",
            type: "date",
          },
        },
      },
      parameters: dateParameter(businessDate),
    }),
  };
}

async function querySource(source: FixedSource, businessDate: string): Promise<unknown> {
  const { baseUrl, apiKey } = readWarehouseEnv(
    "trade-reconciliation",
    (reason) => new TradeReconciliationSourceError(reason),
  );
  let response: Response;
  try {
    response = await serviceFetch(new URL("/api/dataset/json", baseUrl), {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody(source, businessDate)),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(WAREHOUSE_REQUEST_TIMEOUT_MS),
    });
  } catch {
    console.error(`[trade-reconciliation] ${source}_fetch_failed`);
    throw new TradeReconciliationSourceError("warehouse_error");
  }
  if (!response.ok) {
    console.error(`[trade-reconciliation] ${source}_status=${response.status}`);
    throw new TradeReconciliationSourceError("warehouse_error");
  }
  try {
    return await response.json();
  } catch {
    console.error(`[trade-reconciliation] ${source}_invalid_json`);
    throw new TradeReconciliationSourceError("invalid_source");
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new TradeReconciliationSourceError("invalid_source");
  }
  return value.trim();
}

function optionalText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 256) {
    throw new TradeReconciliationSourceError("invalid_source");
  }
  return value.trim();
}

function numberValue(row: Record<string, unknown>, key: string, optional = false): number | null {
  const raw = row[key];
  if (optional && (raw === null || raw === undefined || raw === "")) return null;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(value)) throw new TradeReconciliationSourceError("invalid_source");
  return Math.abs(value);
}

function side(row: Record<string, unknown>): "Buy" | "Sell" {
  const value = requiredText(row, "side").toUpperCase();
  if (value === "BUY") return "Buy";
  if (value === "SELL") return "Sell";
  throw new TradeReconciliationSourceError("invalid_source");
}

function assetType(row: Record<string, unknown>): ReconciliationAssetType {
  const value = optionalText(row, "asset_type")?.toUpperCase().replaceAll(" ", "_") ?? "UNKNOWN";
  return value === "EQUITY" || value === "ETF" || value === "MUTUAL_FUND" || value === "FIXED_INCOME"
    ? value
    : "UNKNOWN";
}

function payloadRows(payload: unknown): Record<string, unknown>[] {
  // JSON exports are object arrays, not the preview's status/data envelope.
  // Exports omit rows_truncated, so require the full count from this same SQL
  // statement on every row rather than trusting HTTP success or array length.
  if (!Array.isArray(payload)) {
    throw new TradeReconciliationSourceError("invalid_source");
  }
  if (payload.length > MAX_SOURCE_ROWS) {
    throw new TradeReconciliationSourceError("source_limit_exceeded");
  }
  return payload.map((value) => {
    const row = object(value);
    if (!row) throw new TradeReconciliationSourceError("invalid_source");
    const rawCount = row.source_row_count;
    const count = typeof rawCount === "number" ? rawCount
      : typeof rawCount === "string" && /^[1-9]\d{0,15}$/.test(rawCount) ? Number(rawCount)
        : NaN;
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new TradeReconciliationSourceError("invalid_source");
    }
    if (count > MAX_SOURCE_ROWS) {
      throw new TradeReconciliationSourceError("source_limit_exceeded");
    }
    if (count !== payload.length) {
      throw new TradeReconciliationSourceError("source_truncated");
    }
    return row;
  });
}

function apexRows(payload: unknown, businessDate: string): ApexTradeSourceRow[] {
  return payloadRows(payload).map((row) => {
    const processDate = requiredText(row, "process_date").slice(0, 10);
    if (processDate !== businessDate) throw new TradeReconciliationSourceError("invalid_source");
    return {
      activityId: requiredText(row, "activity_id"),
      processDate,
      accountId: requiredText(row, "account_id"),
      assetType: assetType(row),
      symbol: requiredText(row, "symbol").toUpperCase(),
      side: side(row),
      quantity: numberValue(row, "quantity", true),
      netAmount: numberValue(row, "net_amount", true),
      grossAmount: numberValue(row, "gross_amount", true),
      clientOrderId: optionalText(row, "client_order_id"),
      activityTimestamp: optionalText(row, "activity_time"),
    };
  });
}

function meridianRows(payload: unknown): MeridianTradeSourceRow[] {
  return payloadRows(payload).map((row) => ({
    rebalancerOrderId: requiredText(row, "rebalancer_order_id"),
    accountId: requiredText(row, "apex_account_id"),
    assetType: assetType(row),
    symbol: requiredText(row, "symbol").toUpperCase(),
    side: side(row),
    quantity: numberValue(row, "quantity", true),
    notionalAmount: numberValue(row, "notional_amount", true),
    initiatedTimestamp: optionalText(row, "initiated_timestamp"),
    clientBasketId: optionalText(row, "client_basket_id"),
    apexBasketId: optionalText(row, "apex_basket_id"),
  }));
}

export async function fetchTradeReconciliationSources(businessDate: string): Promise<{
  apex: ApexTradeSourceRow[];
  meridian: MeridianTradeSourceRow[];
}> {
  if (!DATE_RE.test(businessDate)) throw new TradeReconciliationSourceError("invalid_date");
  const [apexPayload, meridianPayload] = await Promise.all([
    querySource("apex", businessDate),
    querySource("meridian", businessDate),
  ]);
  return {
    apex: apexRows(apexPayload, businessDate),
    meridian: meridianRows(meridianPayload),
  };
}
