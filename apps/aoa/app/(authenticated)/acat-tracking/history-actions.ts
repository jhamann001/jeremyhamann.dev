"use server";

import { auth } from "@/auth";
import { canSeeUnlinkedAcats } from "@/lib/data/acat-lane";
import { canReadCustodianLibrary } from "@/lib/data/custodian-library-contract";
import { readAcatMachine } from "@/lib/data/acat-status";
import { parseHistoryResponse, type HistoryResult } from "@/lib/data/acat-history-view";
import { acatFieldHistoryEnabled, acatOpsBookEnabled } from "@/lib/flags";

// Same shape the drawer actions accept for a tracker record id; no dots or
// slashes, so the id can never change which tracker route is called.
const RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/;

// Read-only. The tracker owns history (ticket); this action only reads it for
// the open transfer, keyed on the tracker record id like every other book read.
export async function loadTransferHistory(recordId: string): Promise<HistoryResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, reason: "forbidden" };
  if (!(acatOpsBookEnabled() && acatFieldHistoryEnabled())) return { ok: false, reason: "off" };
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!canSeeUnlinkedAcats(role) || !canReadCustodianLibrary(role)) return { ok: false, reason: "forbidden" };
  if (typeof recordId !== "string" || !RECORD_ID.test(recordId)) {
    return { ok: false, reason: "invalid" };
  }
  const res = await readAcatMachine(`/api/machine/acats/by-record/${encodeURIComponent(recordId)}/history`);
  const result = parseHistoryResponse(res.status, res.data);
  // Status only: never the record id, the entries, or the response body.
  if (!result.ok && result.reason === "unavailable") {
    console.error("[acat-history] history_read_failed", { status: res.status });
  }
  return result;
}
