import "server-only";
import { serviceFetch } from "@/lib/demo/stand-ins/fetch";

// Shared server-only Warehouse transport. Runtime access is intentionally
// READ-ONLY IN EFFECT: callers may execute only the saved cards enumerated
// below, through Warehouse's fixed card-query endpoint, with template-tag
// parameters. This module exposes no arbitrary path, native SQL, metadata,
// collection, dashboard, or mutation primitive. Do not weaken this boundary.
// The one reviewed exception is the Trade Request drift port (ticket):
// lib/trade-requests/sources/warehouse.ts runs its own allowlisted cards and a
// fixed set of cost-basis and account-master queries against warehouse
// databases 4 and 101, with the standalone service's 45 s timeout and retry.
//
// Warehouse executes a saved question with HTTP POST even though it is a read.
// The method therefore cannot establish read-only semantics by itself; the
// card allowlist + fixed request shape do that at the application boundary.
// The Warehouse API key should still be replaced with a genuinely read-only
// service-account key when that administrative control is available.
//
// Reads WAREHOUSE_URL / WAREHOUSE_API_KEY from env (the SAME secrets the TWR
// report + account-aum cron use). NEVER logs the url, key, request body, or
// response body — only STATIC markers / status codes. The caller supplies its
// own `logTag` (so each feature keeps its own log prefix) and an error factory
// (so each feature throws its OWN error type with its OWN "reason"), which keeps
// the TWR module's behavior byte-identical after the extraction.

export type WarehouseErrorReason = "config_error" | "warehouse_error";

// Bound every external warehouse request. Without an abort signal a stalled
// Warehouse connection can hold a report render open until the platform's own
// deadline. All Warehouse callers share this transport and therefore this limit.
export const WAREHOUSE_REQUEST_TIMEOUT_MS = 15_000;

/** Every saved Warehouse card the deployed application may execute. Adding a
 * card is a security-sensitive change: review its SQL, parameters and result
 * schema before extending this list. Repository maintenance scripts are not
 * runtime application code and use their own GET-only transport. */
export const RUNTIME_WAREHOUSE_CARD_IDS = [
  6469, // AOA Daily Balances (TWR)
  6470, // AOA Activities (TWR)
  6471, // AOA Cost Basis (TWR)
  6472, // AOA Account Number UULID Resolver
  6502, // AOA Realized G/L YTD
  6634, // New Funding (ACH/Check/Wire) - AOA v2 (Rebook-safe)
  6601, // Account AUM ingest
  6700, // AOA Activity Feed Source Date (PII-free)
  6898, // AOA Plaid Linked Account Summary Ingest
  6899, // AOA Plaid Linked Holdings Preview
  6043, // Trade Request contacts (ticket, drift and client list)
  6040, // Trade Request investments (ticket)
  6042, // Trade Request balances (ticket)
  6139, // Trade Request stock record (ticket, drift positions)
] as const;

export type RuntimeWarehouseCardId = (typeof RUNTIME_WAREHOUSE_CARD_IDS)[number];
const RUNTIME_CARD_ID_SET = new Set<number>(RUNTIME_WAREHOUSE_CARD_IDS);

/** Factory the caller passes so the shared transport throws the caller's own
 *  error type (e.g. TwrDataError / FundingDataError) with a matching reason. */
export type WarehouseErrorFactory = (
  reason: WarehouseErrorReason,
  message: string,
) => Error;

export function readWarehouseEnv(
  logTag: string,
  makeError: WarehouseErrorFactory,
): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.WAREHOUSE_URL;
  const apiKey = process.env.WAREHOUSE_API_KEY;
  if (!baseUrl || !apiKey) {
    // STATIC marker only — never the url/key.
    console.error(`[${logTag}] warehouse_env_missing`);
    throw makeError("config_error", "Warehouse env missing");
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    console.error(`[${logTag}] warehouse_url_invalid`);
    throw makeError("config_error", "Warehouse URL invalid");
  }
  if (parsed.protocol !== "https:") {
    console.error(`[${logTag}] warehouse_url_insecure`);
    throw makeError("config_error", "Warehouse URL must use HTTPS");
  }
  return { baseUrl: parsed.origin, apiKey };
}

export async function queryWarehouseCard(
  cardId: RuntimeWarehouseCardId,
  parameters: readonly unknown[],
  logTag: string,
  makeError: WarehouseErrorFactory,
): Promise<unknown> {
  // Keep a runtime guard as well as the TypeScript union: JavaScript callers,
  // unsafe casts and compromised inputs must not turn this into an arbitrary
  // card executor.
  if (!RUNTIME_CARD_ID_SET.has(cardId)) {
    console.error(`[${logTag}] card_not_allowed`);
    throw makeError("warehouse_error", "Warehouse card not allowed");
  }
  const { baseUrl, apiKey } = readWarehouseEnv(logTag, makeError);
  let res: Response;
  try {
    const url = new URL(`/api/card/${cardId}/query/json`, baseUrl);
    res = await serviceFetch(url.toString(), {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ parameters }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(WAREHOUSE_REQUEST_TIMEOUT_MS),
    });
  } catch {
    console.error(`[${logTag}] fetch_failed`);
    throw makeError("warehouse_error", "Warehouse fetch failed");
  }
  if (!res.ok) {
    // STATUS ONLY — never the body (may echo the query).
    console.error(`[${logTag}] status=${res.status}`);
    throw makeError("warehouse_error", `Warehouse ${res.status}`);
  }
  return res.json();
}
