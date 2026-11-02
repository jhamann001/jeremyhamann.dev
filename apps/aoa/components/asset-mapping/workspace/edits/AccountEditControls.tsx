import { useState } from "react";
import { Button } from "@/components/ui";
import { ACCOUNT_TYPE_OPTIONS, EDIT_COPY, accountTypeConfirmTitle, deleteAccountConfirm } from "./edit-model";
import styles from "../AssetMappingWorkspace.module.css";

export function AccountTypeControl({
  currentType,
  currentOther,
  pending,
  onRequest,
}: {
  currentType: string | null;
  currentOther: string | null;
  pending: boolean;
  onRequest: (accountType: string, accountTypeOther: string | null) => void;
}) {
  const [otherMode, setOtherMode] = useState(false);
  const [otherDraft, setOtherDraft] = useState("");

  if (pending) return <span className={styles.muted} aria-busy="true">{EDIT_COPY.accountTypePending}</span>;
  if (otherMode) {
    return (
      <span className={styles.badges}>
        <label>
          {EDIT_COPY.otherPrompt}
          <input
            placeholder={EDIT_COPY.otherPlaceholder}
            value={otherDraft}
            onChange={(e) => setOtherDraft(e.target.value)}
          />
        </label>
        <Button
          size="sm"
          onClick={() => {
            onRequest("Other", otherDraft.trim() || null);
            setOtherMode(false);
          }}
        >
          {EDIT_COPY.otherSave}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOtherMode(false)}>
          {EDIT_COPY.otherBack}
        </Button>
      </span>
    );
  }
  return (
    <span className={styles.badges}>
      <select
        aria-label={EDIT_COPY.accountTypeHeader}
        value={currentType ?? ""}
        onChange={(e) => {
          const next = e.target.value;
          if (next === "Other") {
            setOtherDraft(currentOther ?? "");
            setOtherMode(true);
          } else if (next !== "") {
            onRequest(next, null);
          }
        }}
      >
        {currentType == null ? <option value="" disabled>Unknown</option> : null}
        {ACCOUNT_TYPE_OPTIONS.map((t) => (
          <option key={t} value={t}>{t === "Other" ? EDIT_COPY.otherOption : t}</option>
        ))}
      </select>
      {currentType === "Other" && currentOther ? <span className={styles.muted}>· {currentOther}</span> : null}
    </span>
  );
}

export function DeleteAccountButton({ pending, onDelete }: { pending: boolean; onDelete: () => void }) {
  return (
    <Button variant="ghost" size="sm" title={EDIT_COPY.deleteAccountTitle} disabled={pending} onClick={onDelete}>
      {EDIT_COPY.deleteAccount}
    </Button>
  );
}

export const ACCOUNT_MENU_LABEL = "More account actions";

export function AccountOverflowMenu({ pending, onDelete }: { pending: boolean; onDelete: () => void }) {
  return (
    <details className={styles.menu} data-menu="account">
      <summary className={styles.menuToggle} aria-label={ACCOUNT_MENU_LABEL} title={ACCOUNT_MENU_LABEL}>⋯</summary>
      <div className={styles.menuList}>
        <DeleteAccountButton pending={pending} onDelete={onDelete} />
      </div>
    </details>
  );
}

export function AccountTypeConfirm({
  from,
  accountType,
  accountTypeOther,
  onConfirm,
  onCancel,
}: {
  from: string | null;
  accountType: string;
  accountTypeOther: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div role="alertdialog" aria-label={EDIT_COPY.accountTypeHeader} className={styles.confirm}>
      <p>{accountTypeConfirmTitle(from, accountType, accountTypeOther)}</p>
      <p>{EDIT_COPY.accountTypeConfirmBody}</p>
      <span className={styles.badges}>
        <Button size="sm" onClick={onConfirm}>{EDIT_COPY.changeType}</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>{EDIT_COPY.cancel}</Button>
      </span>
    </div>
  );
}

export function DeleteAccountConfirm({
  label,
  onConfirm,
  onCancel,
}: {
  label: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div role="alertdialog" aria-label={EDIT_COPY.deleteAccountTitle} className={styles.confirm}>
      <p>{deleteAccountConfirm(label)}</p>
      <span className={styles.badges}>
        <Button size="sm" onClick={onConfirm}>{EDIT_COPY.deleteAccount}</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>{EDIT_COPY.cancel}</Button>
      </span>
    </div>
  );
}
