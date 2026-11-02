"use client";

import { Button } from "@/components/ui";
import {
  ALLOCATION_COPY,
  MAX_EQUITY_STRATEGIES,
  MAX_RATIONALE_CHARS,
  allocationRationaleRequired,
  baseAllocationFor,
  equityTotal,
  moneyMarketMismatch,
  moneyMarketRequiredTitle,
  moneyMarketTarget,
  rationaleCount,
  rationaleCountTone,
  rationalePlaceholder,
  selectedAccountTypes,
  withStrategyAdded,
  withStrategyRemoved,
  withStrategyUpdated,
  type EquityStrategyInput,
} from "@/lib/trade-requests/new-request-allocation";
import { FormSectionHeading, type NewRequestSectionProps } from "../FormSectionHeading";
import { useNewRequestDraft } from "../NewRequestDraft";
import formStyles from "../NewRequestForm.module.css";
import { BenchmarkCombobox } from "./BenchmarkCombobox";
import styles from "./Allocation.module.css";

/** Strategies with benchmark, percentage, the money-market warning and the Reg BI rationale (AC-38, AC-71 to AC-74, AC-135 to AC-147). */
export function EquityStrategySection({ number, title }: NewRequestSectionProps) {
  const { draft, updateDraft, context } = useNewRequestDraft();
  const total = equityTotal(draft);
  const base = baseAllocationFor(draft);
  const allRequired = allocationRationaleRequired(draft);
  const accountTypes = selectedAccountTypes(context);
  const update = (id: number, patch: Partial<Omit<EquityStrategyInput, "id">>) =>
    updateDraft((current) => withStrategyUpdated(current, id, patch));

  return (
    <section className={formStyles.section} aria-labelledby={`new-request-section-${number}`}>
      <FormSectionHeading
        number={number} title={title}
        actions={(
          <span aria-live="polite" data-testid="equity-total" className={`${styles.total} ${total === 100 ? styles.totalOk : styles.totalOff}`}>
            {total}% / 100%{total !== 100 && <span className={styles.srOnly}>{ALLOCATION_COPY.mustEqual}</span>}
          </span>
        )}
      />
      <p className={formStyles.sectionLead}>
        Distribute the <strong>{base === null ? ALLOCATION_COPY.unset : `${base.equity}%`}</strong> equity allocation across strategies.
      </p>
      <div className={styles.strategies}>
        {draft.equityStrategies.map((strategy) => {
          const mismatch = moneyMarketMismatch(context, strategy);
          const required = allRequired || mismatch !== null;
          const rationaleId = `new-request-rationale-${strategy.id}`;
          const counterId = `${rationaleId}-count`;
          const tone = rationaleCountTone(strategy.rationale);
          return (
            <div key={strategy.id} className={styles.strategy} data-testid="equity-strategy">
              <div className={styles.strategyRow}>
                <div className={`${formStyles.field} ${styles.benchmarkField}`}>
                  <label htmlFor={`new-request-benchmark-${strategy.id}`} className={formStyles.label}>{ALLOCATION_COPY.benchmark}</label>
                  <BenchmarkCombobox
                    id={`new-request-benchmark-${strategy.id}`} value={strategy.benchmark}
                    onChange={(benchmark) => update(strategy.id, { benchmark })}
                  />
                  {mismatch && (
                    <p role="alert" className={styles.warning}>
                      <strong>{mismatch.entered}</strong> doesn’t match {moneyMarketTarget(mismatch, draft.residence, accountTypes)}.
                      {" "}Expected: <strong>{mismatch.expected.join(" or ")}</strong>. {ALLOCATION_COPY.overrideTail}
                    </p>
                  )}
                </div>
                <div className={`${formStyles.field} ${styles.percentField}`}>
                  <label htmlFor={`new-request-percent-${strategy.id}`} className={formStyles.label}>{ALLOCATION_COPY.percentOfEquity}</label>
                  <div className={styles.percentWrap}>
                    <input
                      id={`new-request-percent-${strategy.id}`} type="number" className={formStyles.input} value={strategy.allocation}
                      onChange={(event) => update(strategy.id, { allocation: event.target.value })}
                    />
                    <span className={styles.percentSuffix} aria-hidden="true">%</span>
                  </div>
                </div>
                {draft.equityStrategies.length > 1 && (
                  <button
                    type="button" className={styles.remove} aria-label={ALLOCATION_COPY.removeStrategy}
                    onClick={() => updateDraft((current) => withStrategyRemoved(current, strategy.id))}
                  >
                    ×
                  </button>
                )}
              </div>
              <div className={formStyles.field}>
                <label
                  htmlFor={rationaleId} className={formStyles.label}
                  title={mismatch ? moneyMarketRequiredTitle(mismatch)
                    : allRequired ? ALLOCATION_COPY.rationaleRequiredTitle : ALLOCATION_COPY.rationaleOptionalTitle}
                >
                  {ALLOCATION_COPY.rationale}{" "}
                  {required
                    ? <span className={formStyles.required} aria-hidden="true">*</span>
                    : <span className={styles.optional}>{ALLOCATION_COPY.optional}</span>}
                </label>
                <textarea
                  id={rationaleId} rows={2} maxLength={MAX_RATIONALE_CHARS} aria-required={required} aria-describedby={counterId}
                  placeholder={rationalePlaceholder(strategy)} value={strategy.rationale}
                  onChange={(event) => update(strategy.id, { rationale: event.target.value })}
                />
                <p id={counterId} className={`${styles.counter} ${styles[`counter_${tone}`]}`} aria-live="polite">
                  {rationaleCount(strategy.rationale)}
                </p>
              </div>
            </div>
          );
        })}
      </div>
      {draft.equityStrategies.length < MAX_EQUITY_STRATEGIES && (
        <Button variant="ghost" className={styles.add} onClick={() => updateDraft(withStrategyAdded)}>
          + Add Another Equity Strategy ({draft.equityStrategies.length}/{MAX_EQUITY_STRATEGIES})
        </Button>
      )}
    </section>
  );
}
