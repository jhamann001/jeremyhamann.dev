import type { AssetMapPositionStatus, AssetMapTransferringValue } from "@/lib/data/asset-map";
import { Button } from "@/components/ui";
import { EDIT_COPY, POSITION_STATUSES, isPositionStatus } from "./edit-model";
import { positionStatusTone } from "../workspace-model";
import styles from "../AssetMappingWorkspace.module.css";

export function PositionStatusControl({
  value,
  pending,
  onSave,
}: {
  value: string | null;
  pending: boolean;
  onSave: (status: AssetMapPositionStatus) => void;
}) {
  if (pending) return <span className={styles.muted} aria-busy="true">{EDIT_COPY.statusPending}</span>;
  return (
    <select
      aria-label={EDIT_COPY.statusHeader}
      className={`${styles.editSelect} ${styles.statusSelect}`}
      data-tone={positionStatusTone(value)}
      value={value ?? ""}
      onChange={(e) => { if (isPositionStatus(e.target.value)) onSave(e.target.value); }}
    >
      {value == null ? <option value="" disabled>—</option> : null}
      {POSITION_STATUSES.map((s) => (
        <option key={s} value={s}>{s}</option>
      ))}
    </select>
  );
}

export function TransferringControl({
  value,
  pending,
  onSave,
}: {
  value: AssetMapTransferringValue;
  pending: boolean;
  onSave: (value: AssetMapTransferringValue) => void;
}) {
  if (pending) return <span className={styles.muted} aria-busy="true">{EDIT_COPY.transferringPending}</span>;
  return (
    <select
      aria-label={EDIT_COPY.transferringHeader}
      className={`${styles.editSelect} ${styles.transferSelect}`}
      value={value ?? ""}
      onChange={(e) => {
        const v = e.target.value;
        if (v === "YES" || v === "NO") onSave(v);
        else if (v === "CLEAR") onSave(null);
      }}
    >
      <option value="" disabled>{EDIT_COPY.transferringUnset}</option>
      <option value="YES">{EDIT_COPY.transferringYes}</option>
      <option value="NO">{EDIT_COPY.transferringNo}</option>
      {value !== null ? <option value="CLEAR">{EDIT_COPY.transferringClear}</option> : null}
    </select>
  );
}

export function DeletePositionButton({
  label,
  pending,
  onDelete,
}: {
  label: string;
  pending: boolean;
  onDelete: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      title={EDIT_COPY.deletePositionTitle}
      aria-label={`${EDIT_COPY.deletePositionTitle}: ${label}`}
      disabled={pending}
      onClick={onDelete}
    >
      {EDIT_COPY.deletePosition}
    </Button>
  );
}
