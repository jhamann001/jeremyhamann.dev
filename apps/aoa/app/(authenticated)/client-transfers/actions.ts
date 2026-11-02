"use server";

import { auth } from "@/auth";
import { readAdvisorTransfers } from "@/lib/data/advisor-transfers";
import { acatAdvisorListEnabled } from "@/lib/flags";
import type { AdvisorTransferRow } from "@/lib/transfers/advisor-transfer-status";

export type AdvisorTransfersLoad =
  | { ok: true; rows: AdvisorTransferRow[] }
  | { ok: false; reason: "not_allowed" | "unavailable" };

/**
 * Refresh and Retry for the Client Transfers list. The person is always the
 * signed-in session's work email, never a client-supplied value. A tracker
 * failure is returned as `unavailable`, not thrown.
 */
export async function loadAdvisorTransfers(): Promise<AdvisorTransfersLoad> {
  if (!acatAdvisorListEnabled()) return { ok: false, reason: "not_allowed" };
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return { ok: false, reason: "not_allowed" };
  const result = await readAdvisorTransfers(email);
  if (result.ok) return result;
  return { ok: false, reason: result.reason === "unavailable" ? "unavailable" : "not_allowed" };
}
