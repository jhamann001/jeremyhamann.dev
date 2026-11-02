// Linked holdings on an asset transfer (ticket). Read-only: holdings are
// shown at click time through the Client Portrait's holdings preview and are
// never stored in AoA or written into a transfer's asset map. Pure: no Prisma,
// no server-only and no Node built-ins, so the dialog can import it.

export type TransferabilityLabel = "likely_transferable" | "likely_not" | "unknown";

/** One holding as the Client Portrait preview returns it. */
export type LinkedHoldingRow = {
  symbol: string | null;
  name: string | null;
  quantity: number | null;
  value: number | null;
  label?: TransferabilityLabel;
  reason?: string;
};

export type LinkedAccountOption = {
  externalAccountId: string;
  clientSfId: string;
  clientName: string;
  institution: string;
  accountType: string;
  mask: string | null;
  /** A transfer in this context draws from this account. */
  hasTransfer: boolean;
};

export const LINKED_HOLDINGS_SOURCE_LABEL = "Plaid via Warehouse bridge";
export const LINKED_HOLDINGS_CARD_LABEL = "Saved Warehouse query · 6899";

export const INCOMPLETE_PREVIEW_MESSAGE =
  "Some returned holdings are missing an identifier, quantity or value. Check the statement before mapping them.";
export const EMPTY_PREVIEW_MESSAGE =
  "This query has no holdings to map. Keep the existing evidence and use a statement or investigate.";
export const MISSING_AS_OF_MESSAGE =
  "A reported holdings-as-of date is needed; query time is separate.";
export const QUERY_FAILED_MESSAGE =
  "The query failed. Your transfer evidence is unchanged; use a statement or retry.";
export const UNAVAILABLE_MESSAGE =
  "Your role cannot load linked holdings for this client, or the linked account is no longer active.";

const REASON_PHRASES: Record<string, string> = {
  omni: "Omni mutual fund",
  mutual_fund_non_omni: "Mutual fund is not Omni",
  mutual_fund_unlisted: "Mutual fund is not on the restriction list",
  missing_symbol: "No ticker",
  missing_security_type: "Security type unavailable",
  unrecognized_security_type: "Security type not classified",
  rules_unavailable: "Transfer rules unavailable",
  fixed_income: "Fixed income is liquidated",
  apex_asset_unsupported: "Asset type is not supported",
  standard_security: "Standard security",
  cash: "Cash transfers with the account",
  needs_review: "Needs review",
};

export function reasonPhrase(reason: string | null | undefined): string {
  return (reason && REASON_PHRASES[reason]) || "Needs review";
}

export function isCashHolding(holding: Pick<LinkedHoldingRow, "symbol" | "reason">): boolean {
  if (holding.reason === "cash") return true;
  const symbol = (holding.symbol ?? "").trim().toUpperCase();
  return symbol === "CASH" || symbol.startsWith("CUR:");
}

/** Advisory only: the classifier's transferable label (or cash). Unknown never establishes eligibility. */
export function holdingEligible(holding: Pick<LinkedHoldingRow, "symbol" | "reason" | "label">): boolean {
  return isCashHolding(holding) || holding.label === "likely_transferable";
}

export function mappingFinding(holding: Pick<LinkedHoldingRow, "symbol" | "reason" | "label">): string {
  if (isCashHolding(holding)) return "Cash balance";
  return holding.label === "likely_transferable" ? "Eligible for in-kind ACAT" : "Needs a separate route / review";
}

/** Why a preview needs a second look before Ops maps it by hand, or null. */
export function previewIssue(rows: readonly LinkedHoldingRow[], asOf: string | null): string | null {
  if (!rows.length) return EMPTY_PREVIEW_MESSAGE;
  if (rows.some(row => row.symbol == null || row.symbol.trim() === "" || row.quantity == null || row.value == null)) {
    return INCOMPLETE_PREVIEW_MESSAGE;
  }
  if (!asOf || !Number.isFinite(Date.parse(asOf))) return MISSING_AS_OF_MESSAGE;
  return null;
}

export function accountLabel(account: Pick<LinkedAccountOption, "clientName" | "institution" | "accountType" | "mask">): string {
  return `${account.clientName} · ${account.institution} · ${account.accountType}${account.mask ? ` •••• ${account.mask}` : ""}`;
}

function suffix(value: string | null | undefined): string | null {
  const cleaned = (value ?? "").replace(/[^A-Za-z0-9]/g, "");
  return cleaned.length >= 4 ? cleaned.slice(-4).toUpperCase() : null;
}

/** A linked account is this transfer's source only when its mask equals the recorded delivering-account last 4. */
export function accountMatchesTransfer(mask: string | null | undefined, transferLast4: string | null | undefined): boolean {
  const left = suffix(mask);
  const right = suffix(transferLast4);
  return left != null && left === right;
}
