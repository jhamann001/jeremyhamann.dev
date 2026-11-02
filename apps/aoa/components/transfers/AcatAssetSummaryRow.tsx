import Link from "next/link";
import { readAcatStatusForTransferCached } from "@/lib/data/acat-status";
import { assetMapSummary } from "./funding-picture";
import styles from "./FundingPictureCard.module.css";

// Async SERVER component: the funding-picture hub's tracker-count fragment for
// an id-linked transfer. Rendered INSIDE the card's own <Suspense> boundary,
// so the tracker call never blocks the shell (PR #133). It consumes the SHARED
// request-memoized reader (readAcatStatusForTransferCached) — the same memo
// the ACAT-row expansion's AcatStatusSection uses — so the two fragments cost
// ONE tracker call per request. Two render variants (the #189 merged section):
//   • "row" — flag OFF: the standalone "Asset mapping" row (pre-#189 strings:
//     count line / "Linked — no positions yet" / the unavailable row).
//   • "inFlight" — flag ON: the secondary "In flight: …" line rendered beneath
//     the AssetMapLinkControl inside the merged Asset-mapping section.
// Degrade contract (unchanged): 404/null → empty assets; thrown
// AcatStatusError (401/5xx/transport) → the explicit "unavailable" state,
// never an affirmative "no positions yet".

export async function AcatAssetSummaryRow({
  acatRecordId,
  acatTransferId,
  variant,
}: {
  acatRecordId: string | null;
  acatTransferId: string | null;
  variant: "row" | "inFlight";
}) {
  let summary: ReturnType<typeof assetMapSummary>;
  try {
    const status = await readAcatStatusForTransferCached(
      acatRecordId,
      acatTransferId,
    );
    summary = assetMapSummary(status?.assets ?? []);
  } catch {
    // Tracker failure — the data layer already logged a static marker/status.
    return variant === "inFlight" ? (
      <span className={styles.rowEmpty}>
        In-flight positions unavailable — tracker didn’t respond
      </span>
    ) : (
      <div className={styles.row}>
        <span className={styles.rowLabel}>Asset mapping</span>
        <span className={styles.rowEmpty}>
          Asset map unavailable — tracker didn’t respond
        </span>
      </div>
    );
  }

  // Shared label for the tracker's redacted in-flight positions (#189's
  // `positionsText`, reproduced verbatim for both variants).
  const positionsText =
    summary.total === 0
      ? "no positions yet"
      : `${summary.total} ${summary.total === 1 ? "position" : "positions"} · ${
          summary.classified
        } classified${
          summary.issues > 0
            ? ` · ${summary.issues} ${summary.issues === 1 ? "issue" : "issues"}`
            : ""
        }`;

  if (variant === "inFlight") {
    return (
      <Link href="/acat-tracking" className={styles.acatLink}>
        In flight: {positionsText} →
      </Link>
    );
  }
  return (
    <Link href="/acat-tracking" className={styles.row}>
      <span className={styles.rowLabel}>Asset mapping</span>
      <span className={styles.rowValue}>
        {summary.total === 0 ? "Linked — no positions yet" : positionsText}
      </span>
      <span className={styles.rowGo} aria-hidden>
        →
      </span>
    </Link>
  );
}
