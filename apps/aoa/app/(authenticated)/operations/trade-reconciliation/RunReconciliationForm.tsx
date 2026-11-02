"use client";

import { useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { tradeDateForRunDate } from "@/lib/operations/trade-reconciliation-run-date";
import { runTradeReconciliation } from "./actions";
import styles from "./page.module.css";

function RunReconciliationButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  const label = pending ? "Running reconciliation…" : "Run reconciliation";

  return (
    <>
      <button type="submit" disabled={disabled || pending} aria-busy={pending} aria-label={label}>
        {pending && <span className={styles.runSpinner} aria-hidden="true" />}
        <span>{label}</span>
      </button>
      <span className={styles.runStatus} role="status" aria-live="polite" aria-atomic="true">
        {pending ? "Reconciliation is running." : ""}
      </span>
    </>
  );
}

export function RunReconciliationForm({
  initialRunDate = "",
  maximumRunDate,
}: {
  initialRunDate?: string;
  maximumRunDate: string;
}) {
  const [runDate, setRunDate] = useState(initialRunDate);
  const tradeDate = useMemo(
    () => tradeDateForRunDate(runDate, maximumRunDate),
    [maximumRunDate, runDate],
  );
  const unavailableMessage = runDate === maximumRunDate
    ? "No reconciliation is due today because NYSE is closed."
    : "Choose a valid NYSE trading day";

  return (
    <form className={styles.runForm} action={runTradeReconciliation}>
      <label>
        Run date
        <input
          type="date"
          name="runDate"
          required
          value={runDate}
          max={maximumRunDate}
          onChange={(event) => setRunDate(event.target.value)}
        />
      </label>
      <div className={styles.tradeDatePreview} aria-live="polite">
        <b>Trade date</b>
        <span>{tradeDate ?? (runDate ? unavailableMessage : "Select a run date")}</span>
      </div>
      <RunReconciliationButton disabled={!tradeDate} />
      <span>Both Apex trades and Meridian orders use the displayed prior NYSE trading day. Nothing is queried until you run the reconciliation.</span>
    </form>
  );
}
