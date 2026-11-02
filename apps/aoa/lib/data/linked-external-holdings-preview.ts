import "server-only";
import { queryWarehouseCard } from "@/lib/warehouse/client";

// On-demand holdings preview for one Plaid-linked account (ticket). Reads
// saved Warehouse card 6899 through the allowlisted runtime transport and returns
// a display DTO. Nothing here writes to the database, the mirror, asset mapping
// or AUM, and nothing logs the payload: the transport logs status only.
//
// The DTO is an explicit allowlist of display fields. Anything else the card
// returns (access_token, isin, cusip, cost_basis, ...) is dropped here and never
// crosses the server-action boundary to the browser.

export const HOLDINGS_PREVIEW_CARD_ID = 6899;
/** dataset_query.native.template-tags.external_account_id.id on card 6899.
 *  Warehouse rejects the call with HTTP 400 when the parameter omits this id. */
export const HOLDINGS_PREVIEW_EXTERNAL_ACCOUNT_ID_PARAM_ID =
  "fe1f5565-cc0f-4338-865c-bd1a66475f5c";

export type HoldingsPreviewRow = {
  symbol: string | null;
  name: string | null;
  quantity: number | null;
  value: number | null;
  /** Advisory transferability. Omitted by the card normalizer; the preview action adds it. */
  label?: "likely_transferable" | "likely_not" | "unknown";
  /** Stable reason code. Never a ticker, CUSIP, or ISIN. */
  reason?: string;
};

export type HoldingsClassificationInput = {
  symbol: string | null;
  name: string | null;
  security_type: string | null;
};

export type HoldingsPreviewResult = {
  asOf: string | null;
  /** Null when any row value is unknown; an unknown amount is never summed as $0. */
  holdingsTotal: number | null;
  institutionBalance: number | null;
  difference: number | null;
  rows: HoldingsPreviewRow[];
};

export class HoldingsPreviewError extends Error {
  constructor(
    readonly reason: "config_error" | "warehouse_error",
    message: string,
  ) {
    super(message);
    this.name = "HoldingsPreviewError";
  }
}

function num(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function text(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === "" ? null : s;
}

function cardRecords(payload: unknown): Record<string, unknown>[] {
  if (!Array.isArray(payload)) {
    throw new HoldingsPreviewError("warehouse_error", "bad_shape");
  }
  return payload.filter(
    (raw): raw is Record<string, unknown> => raw != null && typeof raw === "object",
  );
}

function isHolding(record: Record<string, unknown>): boolean {
  return text(record.security_id) != null || text(record.ticker) != null;
}

export function classificationInputsFromCard(payload: unknown): HoldingsClassificationInput[] {
  return cardRecords(payload).filter(isHolding).map((record) => ({
    symbol: text(record.ticker) ?? text(record.security_id),
    name: text(record.security_name),
    security_type: text(record.security_type),
  }));
}

export function normalizeHoldingsPreview(payload: unknown): HoldingsPreviewResult {
  const records = cardRecords(payload);
  // Card 6899 aliases the security name as security_name and the holding value
  // as market_value. It LEFT JOINs holdings ON TRUE, so an account with no
  // current holdings returns one row with no security; that row carries only
  // account-level totals and is not a holding.
  const rows: HoldingsPreviewRow[] = records
    .filter(isHolding)
    .map((r) => ({
      // Symbol is external_investment_securities.ticker, else security_id.
      symbol: text(r.ticker) ?? text(r.security_id),
      name: text(r.security_name),
      quantity: num(r.quantity),
      value: num(r.market_value),
    }));
  const holdingsTotal = rows.some((row) => row.value == null)
    ? null
    : rows.reduce((sum, row) => sum + (row.value ?? 0), 0);
  const first = records[0];
  const institutionBalance = num(first?.institution_balance ?? first?.current);
  return {
    asOf: text(
      first?.as_of
        ?? first?.institution_price_datetime
        ?? first?.institution_price_as_of
        ?? first?.last_updated,
    ),
    holdingsTotal,
    institutionBalance,
    difference:
      holdingsTotal == null || institutionBalance == null
        ? null
        : holdingsTotal - institutionBalance,
    rows,
  };
}

async function queryHoldingsCard(externalAccountId: string): Promise<unknown> {
  return queryWarehouseCard(
    HOLDINGS_PREVIEW_CARD_ID,
    [
      {
        id: HOLDINGS_PREVIEW_EXTERNAL_ACCOUNT_ID_PARAM_ID,
        type: "string/=",
        target: ["variable", ["template-tag", "external_account_id"]],
        value: externalAccountId,
      },
    ],
    "plaid-holdings-preview",
    (reason, message) => new HoldingsPreviewError(reason, message),
  );
}

export async function loadLinkedHoldingsCard(
  externalAccountId: string,
): Promise<{ preview: HoldingsPreviewResult; inputs: HoldingsClassificationInput[] }> {
  const payload = await queryHoldingsCard(externalAccountId);
  return {
    preview: normalizeHoldingsPreview(payload),
    inputs: classificationInputsFromCard(payload),
  };
}

export async function fetchLinkedHoldingsPreview(
  externalAccountId: string,
): Promise<HoldingsPreviewResult> {
  const { preview } = await loadLinkedHoldingsCard(externalAccountId);
  return preview;
}
