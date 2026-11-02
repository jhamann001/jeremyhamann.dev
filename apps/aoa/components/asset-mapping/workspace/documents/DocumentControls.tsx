import { Button, Pill, type StatusTone } from "@/components/ui";
import { DOC_COPY, reviewedLabel, type DocumentsState, type EffectiveReview, type ScanMessage } from "./documents-model";
import styles from "../AssetMappingWorkspace.module.css";

type Busy = DocumentsState["busy"];
type HouseholdActionProps = {
  view: "operations" | "client-service";
  canOperate: boolean;
  busy: Busy;
  review: EffectiveReview;
  onPdf: () => void;
  onMarkCompleted: () => void;
  onSaveToDrive: () => void;
};

export const COMPLETION_COPY = { completed: "Completed", notCompleted: "Not completed" } as const;

export function scanMessageTone(variant: ScanMessage["variant"]): StatusTone {
  return variant === "success" ? "ok" : variant === "warn" ? "caution" : "danger";
}

export function CompletionPill({ review }: { review: EffectiveReview }) {
  return review.current && review.reviewedAt != null
    ? <Pill tone="ok">{COMPLETION_COPY.completed}</Pill>
    : <Pill tone="neutral">{COMPLETION_COPY.notCompleted}</Pill>;
}

export function ExportPdfButton({ busy, onPdf }: { busy: Busy; onPdf: () => void }) {
  return (
    <Button size="sm" variant="ghost" disabled={busy.pdf} onClick={onPdf}>
      {busy.pdf ? DOC_COPY.generating : DOC_COPY.exportPdf}
    </Button>
  );
}

/** Household-header buttons: Export PDF, then the review action for the view. */
export function HouseholdDocumentActions(props: HouseholdActionProps) {
  return (
    <span className={styles.docActions}>
      <ExportPdfButton busy={props.busy} onPdf={props.onPdf} />
      <HouseholdReviewAction {...props} />
    </span>
  );
}

/** Mark as Completed on the operations view; Save to Drive takes its place on client service. */
export function HouseholdReviewAction({
  view, canOperate, busy, review, onMarkCompleted, onSaveToDrive,
}: HouseholdActionProps) {
  const reviewed = review.current && review.reviewedAt != null;
  return (
    <>
      {view === "operations" && canOperate ? (
        <Button
          size="sm"
          disabled={busy.markCompleted || review.current}
          title={reviewed ? `Reviewed by ${review.reviewer ?? "ops"}` : undefined}
          onClick={onMarkCompleted}
        >
          {busy.markCompleted ? DOC_COPY.saving : reviewed ? reviewedLabel(review.reviewer, review.reviewedAt!) : DOC_COPY.markCompleted}
        </Button>
      ) : null}
      {view === "client-service" && canOperate ? (
        <Button size="sm" disabled={busy.saveToDrive} onClick={onSaveToDrive}>
          {busy.saveToDrive ? DOC_COPY.saving : DOC_COPY.saveToDrive}
        </Button>
      ) : null}
    </>
  );
}

export function ExportAllClientsButton({ busy, onExport }: { busy: boolean; onExport: () => void }) {
  return (
    <Button size="sm" variant="ghost" disabled={busy} onClick={onExport}>
      {busy ? DOC_COPY.generatingAll : DOC_COPY.exportAll}
    </Button>
  );
}

export function RunScanControl({
  busy, message, onRun, onDismiss,
}: { busy: boolean; message: ScanMessage | null; onRun: () => void; onDismiss: () => void }) {
  return (
    <div className={styles.docToolbar}>
      {message ? (
        <span role="status" aria-live="polite" data-variant={message.variant} data-tone={scanMessageTone(message.variant)} className={styles.docNotice}>
          <span>{message.text}</span>
          <Button size="sm" variant="ghost" onClick={onDismiss}>{DOC_COPY.dismiss}</Button>
        </span>
      ) : null}
      <Button size="sm" variant="ghost" disabled={busy} aria-busy={busy} title={DOC_COPY.runScanTitle} onClick={onRun}>
        {busy ? <span className={styles.scanSpinner} aria-hidden="true" /> : null}
        {DOC_COPY.runScan}
      </Button>
    </div>
  );
}

export function DriveSavedNotice({ notice }: { notice: NonNullable<DocumentsState["notice"]> }) {
  return (
    <div role="status" aria-live="polite" data-tone="ok" className={styles.docNotice}>
      <strong>{DOC_COPY.savedToDrive}</strong>
      <span>{notice.filename}</span>
      <span>Reviewed by {notice.reviewer ?? "ops"}</span>
      {notice.webViewLink !== "" ? (
        <a href={notice.webViewLink} target="_blank" rel="noopener noreferrer">{DOC_COPY.openInDrive}</a>
      ) : null}
    </div>
  );
}

export function DocumentAlert({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div role="alert" className={styles.docAlert}>
      <span>{text}</span>
      <Button size="sm" variant="ghost" onClick={onDismiss}>{DOC_COPY.dismiss}</Button>
    </div>
  );
}
