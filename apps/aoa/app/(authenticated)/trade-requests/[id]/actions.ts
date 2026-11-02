"use server";

import { tradeRequestsWorkspaceEnabled } from "@/lib/flags";
import { loadAccountExclusions, type AccountExclusionsLoad } from "@/lib/trade-requests/detail";
import { REQUEST_DETAIL_COPY } from "@/lib/trade-requests/detail-view";

/**
 * Download PDF's exclusion lookup. The delegated client confirms the signed-in
 * person and their workspace role on every call; the flag is checked first.
 */
export async function loadRequestPdfExclusions(accountIds: unknown): Promise<AccountExclusionsLoad> {
  if (!tradeRequestsWorkspaceEnabled()) return { ok: false, message: REQUEST_DETAIL_COPY.pdfFailed };
  if (
    !Array.isArray(accountIds) || accountIds.length > 1000
    || !accountIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 100)
  ) return { ok: false, message: REQUEST_DETAIL_COPY.pdfFailed };
  return loadAccountExclusions(accountIds as string[]);
}
