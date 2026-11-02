import { cache } from "react";
import { fetchAcatList, AcatListError } from "@/lib/data/acat-status";
import { buildAcatTracking } from "@/lib/data/acat-tracking";
import { listTransfers } from "@/lib/data/transfers";
import type { Identity } from "@/lib/data/types";
import { AcatTrackingView } from "./AcatTrackingView";
import styles from "./AcatTrackingData.module.css";

// Async SERVER component behind the ACAT Tracking page's <Suspense> boundary. It
// does the two reads, builds the pure grouping/summary (buildAcatTracking), and
// renders the summary KPIs + the grouped list. Rendered inside <Suspense> so its
// awaits NEVER block the page shell — the shell streams instantly and this
// streams in when the tracker resolves (the PR #133 perf lesson).
//
// TWO reads:
//   • listTransfers(identity) — RLS-scoped; used ONLY to learn which ACATs are
//     linked to a transfer the caller can see, via TWO maps: the tracker record
//     `id` → transferId (the PRIMARY link key — covers record-id links, incl.
//     UUID-less "N/A" records) and acatTransferId → transferId (the legacy UUID
//     leg), so linked rows can offer a "View transfer →" link. For ADMIN/OPS
//     this is the firm's transfers.
//   • fetchAcatList() — the firm-wide tracker list (dev-fixture short-circuit via
//     ACAT_FIXTURE=1). This is the external call; a failure degrades gracefully.
//
// GRACEFUL DEGRADE: an AcatListError (tracker 401/5xx/transport) renders a quiet
// "live ACAT data unavailable" note — no crash, no fabricated rows. Any other
// error is re-thrown (a real bug should surface). The transfers read is a
// first-party DB call and is intentionally NOT wrapped — its failure is a real
// error, not a degrade case.

// Request-level dedup only (ACAT status is live — no time-based cache).
const readAcatList = cache(() => fetchAcatList());

export async function AcatTrackingData({ identity }: { identity: Identity }) {
  // Learn the visible linkage first (first-party, RLS-scoped). Two maps, one
  // loop: record id (primary) + legacy UUID (fallback). includeArchived: an
  // ACAT linked to an ARCHIVED transfer must still read "linked" (and keep its
  // "View transfer →" deep link — getTransfer serves archived rows; the detail
  // shows the archived banner). Excluding archived here would wrongly flip a
  // linked ACAT to un-linked — the same regression class the completed-FUNDED
  // opt-in guards against.
  const transfers = await listTransfers(identity, { includeArchived: true });
  const linked = new Map<string, string>();
  const linkedByRecord = new Map<string, string>();
  for (const t of transfers) {
    if (t.acat_transfer_id) linked.set(t.acat_transfer_id, t.id);
    if (t.acat_record_id) linkedByRecord.set(t.acat_record_id, t.id);
  }

  let list;
  try {
    list = await readAcatList();
  } catch (err) {
    if (!(err instanceof AcatListError)) throw err; // unexpected → surface
    return (
      <div className={styles.unavailable} role="status">
        Live ACAT data is unavailable right now. It will appear here once the
        tracker is reachable again.
      </div>
    );
  }

  return <AcatTrackingView {...buildAcatTracking(list, linked, linkedByRecord)} />;
}
