"use server";

import { auth } from "@/auth";
import { fetchAcatList, AcatListError } from "@/lib/data/acat-status";
import { buildAcatTracking } from "@/lib/data/acat-tracking";
import { canSeeUnlinkedAcats } from "@/lib/data/acat-lane";

// Live (in-flight) ACAT count for the sidebar badge. Fetched AFTER the shell
// paints (owner decision 2026-07-21) — the tracker call can be slow or down, so
// it must never block the layout the way the local-DB nav counts do; the tab
// itself streams it for the same reason. Role-gated to the roles that can see
// the tab (canSeeUnlinkedAcats = ADMIN/OPERATIONS) and FAIL-SILENT → null (no
// badge) when the tracker degrades or the caller isn't permitted — never a crash.
export async function getLiveAcatCount(): Promise<number | null> {
  const session = await auth();
  if (!session?.user) return null;
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!canSeeUnlinkedAcats(role)) return null;
  try {
    const list = await fetchAcatList();
    // inFlight = the live phase (submitted/accepted/pending-settlement/-bookkeeping),
    // excluding terminal completed/rejected — the same summary the tab shows.
    return buildAcatTracking(list).summary.inFlight;
  } catch (err) {
    // AcatListError = the tracker is unreachable/degraded (expected) → no badge.
    // Anything else is unexpected — log server-side, still no badge (never break
    // the shell over a nav count).
    if (!(err instanceof AcatListError)) {
      console.error("[acat-count] live_count_failed", err);
    }
    return null;
  }
}
