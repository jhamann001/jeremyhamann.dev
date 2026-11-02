"use server";

import { auth } from "@/auth";
import { getAcatOpsStatusByRecordId, type AcatStatus } from "@/lib/data/acat-status";
import { canSeeUnlinkedAcats } from "@/lib/data/acat-lane";

// Server action backing the ACAT Tracking drawer (ticket). An unlinked ACAT
// has NO transfer, hence no RLS scoping key — so the by-record read is gated
// here by the SAME firm-wide role check the lane uses to decide who sees
// unlinked cards at all (ADMIN / OPERATIONS). A caller who can't see the card
// can't load its positions either. The read is the operations projection
// (full Apex and statement numbers). The advisor status card does not use
// this action. Returns a serializable, typed result so the
// client drawer degrades quietly on any failure.
//
// KEYED ON THE RECORD `id` (not acatTransferId): acatTransferId is a nullable,
// NON-UNIQUE placeholder — many records share "N/A" or null, so a
// by-acatTransferId read returns the single newest match for ALL of them (the
// wrong-ACAT-in-every-modal bug). The record `id` is unique and always present,
// so every row resolves to ITS OWN record.

export type AcatDetailResult =
  | { ok: true; status: AcatStatus | null } // null = 404 (no such record)
  | { ok: false; reason: "forbidden" | "error" };

export async function loadUnlinkedAcatDetail(
  recordId: string,
): Promise<AcatDetailResult> {
  const session = await auth();
  const role = (session?.user as { role?: string } | undefined)?.role ?? null;
  if (!session?.user || !canSeeUnlinkedAcats(role)) {
    return { ok: false, reason: "forbidden" };
  }
  try {
    const status = await getAcatOpsStatusByRecordId(recordId);
    return { ok: true, status };
  } catch {
    // AcatStatusError — the data layer already logged a static marker / status.
    return { ok: false, reason: "error" };
  }
}
