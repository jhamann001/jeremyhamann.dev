import { Button, Pill } from "@/components/ui";
import type { DocForm, DocStatus } from "@/lib/data/workflow-types";
import { DOC_STATUS_LABEL, docTone } from "./status-tone";
import { Select } from "./Select";
import styles from "./DocCard.module.css";

const DOC_OPTIONS = (Object.keys(DOC_STATUS_LABEL) as DocStatus[]).map((v) => ({
  value: v,
  label: DOC_STATUS_LABEL[v],
}));

// Apex-form card (shared by Decision Center's task panels and the Tasks table
// sub-rows). `onStatus` present → renders the doc-status control; the DocuSign
// action is a disabled stub (real send is a later phase, ADR-6).
export function DocCard({
  doc,
  status,
  onStatus,
}: {
  doc: DocForm;
  status: DocStatus;
  onStatus?: (status: DocStatus) => void;
}) {
  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <div>
          <div className={styles.name}>{doc.name}</div>
          <div className={styles.code}>{doc.code}</div>
        </div>
        <Pill tone={docTone(status)} dot>
          {DOC_STATUS_LABEL[status]}
        </Pill>
      </div>
      <div className={styles.meta}>
        <span className={styles.label}>Fields</span>
        {doc.fields.join(" · ")}
      </div>
      <div className={styles.meta}>
        <span className={styles.label}>Signers</span>
        {doc.signers.join(", ")}
      </div>
      {doc.supporting ? (
        <div className={styles.supporting}>Supporting docs: {doc.supporting}</div>
      ) : null}
      <div className={styles.controls}>
        {onStatus ? (
          <Select value={status} options={DOC_OPTIONS} onChange={onStatus} ariaLabel={`${doc.name} status`} />
        ) : null}
        <Button variant="ghost" size="sm" disabled title="DocuSign integration — later phase">
          DocuSign ↗
        </Button>
      </div>
    </div>
  );
}
