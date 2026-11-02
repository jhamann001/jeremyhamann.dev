"use client";

import { TRADE_TYPE_COPY } from "@/lib/trade-requests/new-request-trade-types";
import { FormSectionHeading, type NewRequestSectionProps } from "../FormSectionHeading";
import { useNewRequestDraft } from "../NewRequestDraft";
import styles from "../NewRequestForm.module.css";
import { FieldLabel } from "./FieldLabel";

export function NotesSection({ number, title }: NewRequestSectionProps) {
  const { draft, updateDraft } = useNewRequestDraft();
  return (
    <section className={styles.section} aria-labelledby={`new-request-section-${number}`}>
      <FormSectionHeading number={number} title={title} />
      <div className={styles.field}>
        <FieldLabel htmlFor="new-request-advisor-notes" text={TRADE_TYPE_COPY.advisorNotes} />
        <textarea
          id="new-request-advisor-notes" rows={3} placeholder={TRADE_TYPE_COPY.advisorNotesPlaceholder}
          value={draft.advisorNotes} onChange={(event) => updateDraft({ advisorNotes: event.target.value })}
        />
      </div>
    </section>
  );
}
