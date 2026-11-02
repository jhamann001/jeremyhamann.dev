"use client";

import { TRADE_TYPES, type TradeType } from "@/lib/trade-requests/new-request";
import { PRIORITIES, TRADE_TYPE_COPY, withTradeType, type Priority } from "@/lib/trade-requests/new-request-trade-types";
import { useNewRequestDraft } from "../NewRequestDraft";
import styles from "../NewRequestForm.module.css";
import { FieldLabel } from "./FieldLabel";

/** Trade Type and Priority, the second and third columns of section 1. */
export function TradeTypeFields() {
  const { draft, updateDraft } = useNewRequestDraft();
  return (
    <>
      <div className={styles.field}>
        <FieldLabel htmlFor="new-request-trade-type" text={TRADE_TYPE_COPY.tradeType} />
        <select
          id="new-request-trade-type" value={draft.tradeType}
          onChange={(event) => updateDraft((current) => withTradeType(current, event.target.value as TradeType))}
        >
          {TRADE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
      </div>
      <div className={styles.field}>
        <FieldLabel htmlFor="new-request-priority" text={TRADE_TYPE_COPY.priority} required />
        <select
          id="new-request-priority" value={draft.priority} aria-required="true"
          onChange={(event) => updateDraft({ priority: event.target.value as Priority })}
        >
          <option value="" disabled>{TRADE_TYPE_COPY.selectPriority}</option>
          {PRIORITIES.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
        </select>
      </div>
    </>
  );
}
