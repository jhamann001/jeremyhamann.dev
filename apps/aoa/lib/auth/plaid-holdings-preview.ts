import { allowPlaidHoldingsPreviewEnabled } from "@/lib/flags";

/** Admin / Operations only. Fail closed for every other role (incl. VIEWER). */
export function canPreviewPlaidHoldings(role: string | null | undefined): boolean {
  return role === "ADMIN" || role === "OPERATIONS";
}

/** The single server-side gate for the holdings preview: the page uses it to
 *  decide whether the control renders and the server action re-checks it on
 *  every call, so a browser cannot reach card 6899 with the switch off. */
export function plaidHoldingsPreviewAllowed(role: string | null | undefined): boolean {
  return allowPlaidHoldingsPreviewEnabled() && canPreviewPlaidHoldings(role);
}
