import { readAcatBook, type AcatBookSnapshot } from "@/lib/data/acat-workspace";
import { ACAT_BOOK_LOAD_FAILURE } from "@/lib/data/acat-book";
import { EXTERNAL_APPS } from "@/lib/external-apps";
import { AcatSectionNav } from "@/components/custodians/AcatSectionNav";
import { acatFieldHistoryEnabled, acatPaperworkEnabled, acatSecurityReconEnabled, acatTransferDrawerEnabled } from "@/lib/flags";
import type { Identity } from "@/lib/data/types";
import { acatFeeRequestsHref, acatFeeRequestsReadEnabled, acatReimbursementCreateEnabled } from "@/lib/operations/fee-request-link";
import { AcatBookView, BookRefreshButton } from "./AcatBookView";
import styles from "./AcatBookView.module.css";

export async function AcatBookData({ identity, userName, prefsScope, editsEnabled = false, dayToDayEnabled = false, columnsEnabled = false, showRemoved = false, initialRecordId = null, feeEnabled = false }: {
  identity: Identity; userName: string | null; prefsScope: string; editsEnabled?: boolean; dayToDayEnabled?: boolean; columnsEnabled?: boolean; showRemoved?: boolean; initialRecordId?: string | null; feeEnabled?: boolean;
}) {
  let snapshot: AcatBookSnapshot | null = null;
  try {
    snapshot = await readAcatBook(identity, { removed: showRemoved });
  } catch { /* The failure region below replaces the book; it is never shown as empty. */ }
  if (!snapshot) {
    return <>
      <AcatSectionNav current="tracking" />
      <section role="status" className={styles.failure}>
        <p>{ACAT_BOOK_LOAD_FAILURE}</p>
        <div className={styles.failureActions}>
          <BookRefreshButton>Retry</BookRefreshButton>
          <a href={EXTERNAL_APPS.acatTracking} target="_blank" rel="noopener noreferrer" className={styles.trackerLink}>Open full tracker ↗</a>
        </div>
      </section>
    </>;
  }
  return <>
    <AcatSectionNav current="tracking" />
    <AcatBookView rows={snapshot.rows} linkedTransferIds={snapshot.linkedTransferIds}
      linkedByRecordId={snapshot.linkedByRecordId} userName={userName} prefsScope={prefsScope}
      paperwork={acatPaperworkEnabled()}
      editsEnabled={editsEnabled} dayToDayEnabled={dayToDayEnabled} columnsEnabled={columnsEnabled} removedRows={snapshot.removedRows} initialRecordId={initialRecordId}
      securityRecon={acatSecurityReconEnabled()}
      transferDrawer={acatTransferDrawerEnabled() ? { admin: identity.role === "ADMIN" } : null} feeEnabled={feeEnabled}
      feeRequestsHref={feeEnabled ? acatFeeRequestsHref(identity.role) : null}
      feeReimbursement={feeEnabled && acatReimbursementCreateEnabled(identity.role)}
      feeRequestsRead={feeEnabled && acatFeeRequestsReadEnabled(identity.role)}
      historyEnabled={acatFieldHistoryEnabled()} />
  </>;
}
