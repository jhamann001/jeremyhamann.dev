"use client";

import { useState, useTransition } from "react";
import type { TaxBudget, TaxBudgetYear } from "@/lib/data/types";
import { Card, CardHeader, CardBody, Button, Pill } from "@/components/ui";
import { usdCompact } from "@/lib/format";
import { taxBudgetView } from "./tax-budget";
import { Toast, useToast } from "@/components/prep/Toast";
import { saveTaxBudget } from "@/app/(authenticated)/client-portrait/[id]/actions";
import styles from "./TaxBudgetCard.module.css";

// Tax Budget card (P1, ticket — mockup `#n2tax` renderTaxBudget): the annual
// realized-gains headroom for tax-aware trading. Three states — set (figures +
// tone-colored progress bar + status pill), stale ("needs update" — prior year
// only), never set. Values are app-owned and entered manually by an authorized
// user; the server action persists one historical row per client/year.

export function TaxBudgetCard({
  taxBudget,
  clientSfId,
  canEdit,
}: {
  taxBudget: TaxBudget;
  clientSfId: string;
  canEdit: boolean;
}) {
  const { toast, showToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<string[]>([]);
  // Immediate post-save display while the revalidated server payload refreshes.
  const [draft, setDraft] = useState<TaxBudgetYear | null>(null);

  const effective: TaxBudget = draft ? { ...taxBudget, current: draft } : taxBudget;
  const view = taxBudgetView(effective);
  const { year } = taxBudget;

  function startEdit() {
    setErrors([]);
    setEditing(true);
  }

  function saveEdit(form: FormData) {
    // Keep the raw strings so the shared validator can accept familiar
    // currency entry such as "33,333" without losing precision in the form.
    const budget = form.get("budget");
    const realized = form.get("realized");
    const note = String(form.get("note") ?? "").trim();
    setErrors([]);
    startTransition(async () => {
      const result = await saveTaxBudget(clientSfId, { budget, realized, note });
      if (!result.ok) {
        setErrors(result.errors.map((error) => error.message));
        return;
      }
      setDraft(result.budget);
      setEditing(false);
      showToast(`${year} tax budget saved.`);
    });
  }

  if (editing) {
    const cur = effective.current;
    return (
      <Card>
        <CardHeader>
          <h2>Tax Budget · {year}</h2>
          <Pill tone="gray">editing</Pill>
        </CardHeader>
        <CardBody>
          {view.kind === "stale" ? (
            <p className={styles.hint}>
              Last set for {view.priorYear}: {usdCompact(view.priorBudget)}. Enter{" "}
              {`${year}’s`} figures.
            </p>
          ) : null}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveEdit(new FormData(e.currentTarget));
            }}
          >
            <div className={styles.fields}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="tb-budget">
                  Realized-gains budget ($)
                </label>
                <input
                  id="tb-budget"
                  name="budget"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  defaultValue={cur?.budget ?? ""}
                  placeholder="e.g. 150,000"
                  className={styles.input}
                  required
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="tb-realized">
                  Realized YTD ($)
                </label>
                <input
                  id="tb-realized"
                  name="realized"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  defaultValue={cur?.realized ?? 0}
                  className={styles.input}
                  required
                />
              </div>
            </div>
            <label className={styles.label} htmlFor="tb-note">
              Planning note
            </label>
            <textarea
              id="tb-note"
              name="note"
              rows={2}
              defaultValue={cur?.note ?? ""}
              className={styles.input}
              maxLength={2000}
            />
            {errors.length > 0 ? (
              <div className={styles.error} role="alert">
                {errors.map((error) => (
                  <div key={error}>{error}</div>
                ))}
              </div>
            ) : null}
            <div className={styles.actions}>
              <Button size="sm" type="submit" disabled={pending}>
                {pending ? "Saving…" : "Save budget"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditing(false)}
                disabled={pending}
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardBody>
        <Toast message={toast} />
      </Card>
    );
  }

  if (view.kind === "set") {
    return (
      <Card>
        <CardHeader>
          <h2>Tax Budget · {year}</h2>
          <Pill tone={view.tone} dot>
            {view.label}
          </Pill>
          {canEdit ? (
            <Button size="sm" variant="ghost" onClick={startEdit}>
              Edit
            </Button>
          ) : null}
        </CardHeader>
        <CardBody>
          <div className={styles.figures}>
            <div>
              <div className={styles.figureLabel}>Realized-gains budget</div>
              <div className={styles.figure}>{usdCompact(view.budget)}</div>
            </div>
            <div>
              <div className={styles.figureLabel}>Realized YTD</div>
              <div className={styles.figure}>{usdCompact(view.realized)}</div>
            </div>
            <div>
              <div className={styles.figureLabel}>Remaining headroom</div>
              <div
                className={`${styles.figure} ${view.over ? styles.overFigure : styles.okFigure}`}
              >
                {view.over ? `−${usdCompact(Math.abs(view.remaining))}` : usdCompact(view.remaining)}
              </div>
            </div>
          </div>
          <div
            className={styles.bar}
            role="progressbar"
            aria-valuenow={view.pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Realized ${view.pct}% of the ${year} gains budget`}
          >
            <div
              className={`${styles.barFill} ${styles[view.tone]}`}
              style={{ width: `${view.pct}%` }}
            />
          </div>
          {view.note ? <p className={styles.note}>{view.note}</p> : null}
        </CardBody>
        <Toast message={toast} />
      </Card>
    );
  }

  if (view.kind === "stale") {
    return (
      <Card className={styles.staleCard}>
        <CardHeader>
          <h2>Tax Budget · {year}</h2>
          <Pill tone="amber" dot>
            needs update
          </Pill>
        </CardHeader>
        <CardBody>
          <div className={styles.staleBox}>
            <div className={styles.staleMain}>
              <h4 className={styles.staleTitle}>No {year} tax budget on file</h4>
              <p className={styles.staleCopy}>
                Last set for <b>{view.priorYear}</b>: {usdCompact(view.priorBudget)}{" "}
                realized-gains budget. We need an updated figure before any tax-aware
                rebalancing or harvesting this year.
              </p>
              <p className={styles.hint}>
                Set the updated amount here before tax-aware trading.
              </p>
            </div>
            <div className={styles.staleActions}>
              {canEdit ? (
                <Button size="sm" onClick={startEdit}>
                  Set {year} budget
                </Button>
              ) : null}
            </div>
          </div>
        </CardBody>
        <Toast message={toast} />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <h2>Tax Budget · {year}</h2>
        <Pill tone="gray">not set</Pill>
        {canEdit ? (
          <Button size="sm" onClick={startEdit}>
            Set budget
          </Button>
        ) : null}
      </CardHeader>
      <CardBody>
        <p className={styles.emptyCopy}>
          No tax budget on file yet.
          {canEdit ? ` Set the ${year} realized-gains budget here.` : ""}
        </p>
      </CardBody>
      <Toast message={toast} />
    </Card>
  );
}
