import { readAcatStatusForTransferCached } from "@/lib/data/acat-status";
import { acatSectionOutcome } from "@/lib/data/acat-lane";
import { AcatStatusCard } from "./AcatStatusCard";

// Async SERVER component (no "use client") that reads the LIVE ACAT status for
// a transfer's linked ACAT — RECORD-ID-FIRST (the tracker record PK, primary
// since record-id linking) with the legacy by-UUID fallback for rows linked
// before it (getAcatStatusForTransfer) — and renders <AcatStatusCard>. It is
// rendered INSIDE a <Suspense> boundary on the transfer detail page, so its
// await NEVER blocks the transfer shell — the shell streams instantly and this
// section streams in when the tracker call resolves (the PR #133 perf lesson:
// don't block the page on an external call).
//
// GRACEFUL DEGRADE (three outcomes, same shape as the Suspense-deferred funding
// section pattern under components/funding/):
//   • 200 → the card.
//   • 404 with a stored link id → a quiet but VISIBLE "no tracker record
//     matches" note (acatSectionOutcome): the page only renders this section
//     when a link id IS stored, so a 404 means the stored id is stale/mistyped
//     — rendering nothing here made a bad link read as "the ACAT disappeared".
//     Null-render survives ONLY for the defensive both-ids-null arm (which the
//     page gate makes unreachable).
//   • AcatStatusError (401 / 5xx / transport) → a quiet inline note; the data
//     layer already logged a STATIC marker / status. The page never breaks.
//
// SECURITY / RLS: this only ever receives the ids already stored on a transfer
// the caller can see (the RLS-scoped getTransfer on the detail page gates it).
// It never resolves scope itself and never widens beyond the ids it is handed.

// Request-level dedup: the SHARED cached reader (lib/data/acat-status.ts,
// readAcatStatusForTransferCached) memoizes the tracker call for a single
// request, so this section and the funding-picture hub's asset-mapping count
// line (AcatAssetSummaryRow) cost ONE tracker call between them.

export async function AcatStatusSection({
  acatRecordId,
  acatTransferId,
  summaryOnly = false,
}: {
  acatRecordId: string | null;
  acatTransferId: string | null;
  summaryOnly?: boolean;
}) {
  try {
    const status = await readAcatStatusForTransferCached(
      acatRecordId,
      acatTransferId,
    );
    const outcome = acatSectionOutcome(
      status != null,
      acatRecordId,
      acatTransferId,
    );
    if (outcome === "none") return null; // defensive: no link ids at all
    if (outcome === "missing_link") {
      // 404 with a stored link id: the id matches no tracker record. Visible,
      // muted — same tone as the "unavailable" error note below.
      return (
        <p style={{ color: "var(--muted)", fontSize: 13 }}>
          No tracker record matches the linked ACAT id — edit the record to fix
          the link.
        </p>
      );
    }
    return <AcatStatusCard status={status!} summaryOnly={summaryOnly} />;
  } catch {
    // AcatStatusError — the data layer already logged a static marker / status.
    return (
      <p style={{ color: "var(--muted)", fontSize: 13 }}>
        ACAT status unavailable.
      </p>
    );
  }
}
