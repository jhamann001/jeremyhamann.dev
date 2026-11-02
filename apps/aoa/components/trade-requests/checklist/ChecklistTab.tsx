"use client";

import { useId } from "react";
import { CHECKLIST_COPY, CHECKLIST_ITEMS, CHECKLIST_VALUE_MAX, checklistStamp } from "@/lib/trade-requests/checklist-view";
import type { RequestChecklist } from "./use-request-checklist";
import styles from "./Checklist.module.css";

const localDate = (iso: string) => new Date(iso).toLocaleDateString();

/** The Pre-approval Checklist tab of request detail (design pass P2-138 to P2-156). */
export function ChecklistTab({ checklist }: { checklist: RequestChecklist }) {
  const baseId = useId();
  const editable = checklist.access === "edit";
  return (
    <div className={styles.checklist} data-testid="trade-request-checklist">
      <div className={styles.head}>
        <p className={styles.intro}>
          <strong>{CHECKLIST_COPY.introLead}</strong>{CHECKLIST_COPY.introRest}
        </p>
        <span className={styles.count}>{checklist.checkedCount} of {checklist.total} complete</span>
      </div>
      <progress
        className={styles.progress}
        value={checklist.checkedCount}
        max={checklist.total}
        aria-label={CHECKLIST_COPY.progressLabel}
      />
      <ul className={styles.items}>
        {CHECKLIST_ITEMS.map((item) => {
          const state = checklist.checklist[item.key];
          const checked = state?.checked === true;
          const value = state?.value ?? "";
          const stamp = checklistStamp(state, localDate);
          const fieldId = `${baseId}-${item.key}`;
          const itemEditable = checklist.isEditable(item.key);
          return (
            <li key={item.key} className={styles.item} data-key={item.key}>
              <button
                type="button"
                className={`${styles.box} ${checked ? styles.boxOn : ""}`}
                aria-pressed={checked}
                aria-label={item.label}
                disabled={!itemEditable}
                onClick={() => checklist.toggle(item.key)}
              >
                {checked && <span aria-hidden="true">✓</span>}
              </button>
              <div className={styles.text}>
                <p className={styles.label}>{item.label}</p>
                {item.help && <p className={styles.help}>{item.help}</p>}
                {item.field && (checked || value) && (
                  <div className={styles.field}>
                    <label className={styles.fieldLabel} htmlFor={fieldId}>{item.field.label}</label>
                    <textarea
                      id={fieldId}
                      className={styles.textarea}
                      value={value}
                      rows={2}
                      maxLength={CHECKLIST_VALUE_MAX}
                      placeholder={item.field.placeholder}
                      disabled={!itemEditable}
                      onChange={(event) => checklist.changeText(item.key, event.target.value)}
                      onBlur={() => checklist.commitText(item.key)}
                    />
                  </div>
                )}
                {stamp && <p className={styles.stamp}>{stamp}</p>}
              </div>
            </li>
          );
        })}
      </ul>
      {!editable && (
        <p className={styles.note}>{checklist.access === "read_only" ? CHECKLIST_COPY.readOnly : CHECKLIST_COPY.locked}</p>
      )}
    </div>
  );
}
