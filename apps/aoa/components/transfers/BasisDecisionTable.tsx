"use client";

import type {
  TransferDecisionChoice,
  TransferDecisionRow,
} from "@/lib/data/transfer-types";
import { recommendPosition } from "@/lib/data/transfer-basis";
import { usd } from "@/lib/format";
import { Pill, PreviewBadge } from "@/components/ui";
import { useTransferPlanDraft } from "./TransferPlanDraftProvider";
import styles from "./BasisDecisionTable.module.css";

// "What to transfer — basis-aware decision" card body (WO ticket, TDD ADR-3).
// The recommendation column is DERIVED per row by the frozen
// `recommendPosition` (never stored); the decision select edits the shared
// browser-local funding-plan draft. Approval persists every decision together.
// Position rows are Phase D's data — a record without rows shows the empty
// state WITH PreviewBadge (locked decision 6), never a broken table.
// VIEWER (canWrite=false): the decision renders as a pill, no select.

const DECISION_LABEL: Record<TransferDecisionChoice, string> = {
  BRING_IN: "Bring in",
  LEAVE_GIFT: "Leave / gift",
  UNDECIDED: "Undecided",
};

const DECISION_TONE: Record<TransferDecisionChoice, "green" | "amber" | "gray"> =
  {
    BRING_IN: "green",
    LEAVE_GIFT: "amber",
    UNDECIDED: "gray",
  };

const gainPct = (value: number, basis: number): string => {
  if (basis <= 0) return "∞";
  const pct = ((value - basis) / basis) * 100;
  return `${pct >= 0 ? "+" : ""}${Math.round(pct)}%`;
};

export function BasisDecisionTable({
  decisions,
}: {
  decisions: TransferDecisionRow[];
}) {
  const draft = useTransferPlanDraft();

  if (decisions.length === 0) {
    return (
      <div className={styles.empty}>
        <PreviewBadge label="Positions arrive with Phase D ingest" />
        <p className={styles.emptyText}>
          No position rows on this record yet — statement/custodian ingest
          hydrates the basis-aware table. The decision writes are real once
          rows exist.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.banner} role="note">
        <strong>⚠ Avoid ossification.</strong> Don&apos;t transfer in
        highly-appreciated lots — bring low basis in for TLH; leave or gift the
        winners.
      </div>

      {decisions.some(
        (decision) =>
          draft.basisDecision(decision.id, decision.decision) === "UNDECIDED",
      ) ? (
        <div className={styles.decisionLink}>
          <div>
            <strong>Decision required</strong>
            <span>Unresolved position instructions are blocking transfer preparation.</span>
          </div>
        </div>
      ) : null}

      {draft.errors.find((error) => error.field === "positions") && (
        <p className={styles.error} role="alert">
          {draft.errors.find((error) => error.field === "positions")?.message}
        </p>
      )}

      <div className={styles.scroller}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Position</th>
              <th className={styles.num}>Value</th>
              <th className={styles.num}>Cost basis</th>
              <th className={styles.num}>Unrealized gain</th>
              <th>Recommendation</th>
              <th>Decision</th>
            </tr>
          </thead>
          <tbody>
            {decisions.map((d) => {
              const rec = recommendPosition(d.value, d.cost_basis);
              const selected = draft.basisDecision(d.id, d.decision);
              return (
                <tr key={d.id}>
                  <td>
                    <span className={styles.symbol}>{d.symbol}</span>
                    <span className={styles.desc}>{d.description}</span>
                  </td>
                  <td className={styles.num}>{usd(d.value)}</td>
                  <td className={styles.num}>
                    {d.cost_basis == null ? "—" : usd(d.cost_basis)}
                  </td>
                  <td className={styles.num}>
                    {d.cost_basis == null ? "—" : gainPct(d.value, d.cost_basis)}
                  </td>
                  <td>
                    <Pill
                      tone={
                        rec.kind === "LEAVE_GIFT"
                          ? "amber"
                          : rec.kind === "BRING_IN"
                            ? "green"
                            : "gray"
                      }
                    >
                      {rec.label}
                    </Pill>
                  </td>
                  <td>
                    {draft.canEdit ? (
                      <select
                        className={styles.select}
                        value={selected}
                        disabled={draft.pending}
                        onChange={(e) =>
                          draft.setBasisDecision(
                            d.id,
                            e.target.value as TransferDecisionChoice,
                          )
                        }
                        aria-label={`Decision for ${d.symbol}`}
                      >
                        {(
                          Object.keys(DECISION_LABEL) as TransferDecisionChoice[]
                        ).map((c) => (
                          <option key={c} value={c}>
                            {DECISION_LABEL[c]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Pill tone={DECISION_TONE[selected]}>
                        {DECISION_LABEL[selected]}
                      </Pill>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
