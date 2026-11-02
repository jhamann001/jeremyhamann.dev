"use client";

import { useMemo, useState, useTransition } from "react";
import { Button, Pill } from "@/components/ui";
import { Toast, useToast } from "@/components/prep/Toast";
import { confirmTradeProfileSource } from "@/app/(authenticated)/client-portrait/[id]/actions";
import type { AccountTradeRequestProfile } from "@/lib/data/trade-request-profile";
import type { TradeProfileSelectionRecord } from "@/lib/data/trade-profile-selection";
import { tradeProfileReviewStartsOpen } from "./trade-profile-review-state";
import styles from "./TradeProfileReviewControls.module.css";

type Choice = { accountId: string; requestId: string };

const datePart = (iso: string): string => iso.slice(0, 10);

export function TradeProfileReviewControls({
  clientSfId,
  accounts,
  selections,
}: {
  clientSfId: string;
  accounts: AccountTradeRequestProfile[];
  selections: TradeProfileSelectionRecord[];
}) {
  const { toast, showToast } = useToast();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const selectionByAccount = useMemo(
    () => new Map(selections.map((selection) => [selection.accountId, selection])),
    [selections],
  );
  const reviewable = accounts.filter(
    (account) =>
      account.candidates.length > 1 ||
      account.selection != null ||
      account.state === "scope_review",
  );
  if (reviewable.length === 0) return null;
  const startsOpen = tradeProfileReviewStartsOpen(reviewable);
  const householdCandidates = reviewable.some((account) =>
    account.candidates.some((candidate) => candidate.scope === "household"),
  );

  function confirm(form: FormData) {
    if (!choice) return;
    setError(null);
    startTransition(async () => {
      const result = await confirmTradeProfileSource(
        clientSfId,
        choice.accountId,
        choice.requestId,
        form.get("note"),
      );
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setChoice(null);
      showToast("Confirmed Trade Request source saved.");
    });
  }

  return (
    <details className={styles.review} open={startsOpen}>
      <summary className={styles.summary}>
        <div className={styles.intro}>
          <div>
            <span className={styles.eyebrow}>Human confirmation</span>
            <h3>Review instruction sources</h3>
          </div>
          <div className={styles.summaryMeta}>
            <Pill tone={startsOpen ? "amber" : "green"}>
              {startsOpen ? "Review needed" : "Confirmed"}
            </Pill>
            <span className={styles.toggleLabel}>
              {startsOpen ? "Open review" : "Review or change source"}
            </span>
            <span className={styles.chevron} aria-hidden="true">
              ▾
            </span>
          </div>
        </div>
      </summary>

      <div className={styles.reviewBody}>
        <p className={styles.help}>
          Choose the approved request that represents the complete current instructions
          for each account. A newer approved request will reopen review automatically.
          {householdCandidates
            ? " A household request also covers another client; confirming it here applies it to this client's account only."
            : ""}
        </p>

        <div className={styles.accounts}>
          {reviewable.map((account) => {
            const saved = selectionByAccount.get(account.accountId);
            return (
              <section className={styles.account} key={account.accountId}>
              <div className={styles.accountHeading}>
                <div>
                  <strong>{account.accountType ?? "Account"}</strong>
                  <span>{account.accountNumber}</span>
                </div>
                {account.selection?.state === "confirmed" ? (
                  <Pill tone="green">Confirmed source</Pill>
                ) : account.selection?.state === "stale" ? (
                  <Pill tone="gold">New review needed</Pill>
                ) : (
                  <Pill tone="amber">Review required</Pill>
                )}
              </div>

              {saved ? (
                <p className={styles.saved}>
                  Current confirmation: <code>{saved.requestId}</code>
                  {saved.selectedBy ? ` · ${saved.selectedBy}` : ""} · {datePart(saved.selectedAt)}
                  {saved.note ? ` · ${saved.note}` : ""}
                </p>
              ) : null}

              <div className={styles.candidates}>
                {account.candidates.map((candidate) => {
                  const selected = account.selection?.requestId === candidate.requestId;
                  const choosing =
                    choice?.accountId === account.accountId &&
                    choice.requestId === candidate.requestId;
                  return (
                    <article className={styles.candidate} key={candidate.requestId}>
                      <div className={styles.candidateHeading}>
                        <div>
                          <code>{candidate.requestId}</code>
                          <span>
                            {candidate.status} {candidate.tradeType} · {datePart(candidate.decidedAt)}
                            {candidate.scope === "household" ? " · household scope" : ""}
                          </span>
                        </div>
                        {selected ? <Pill tone="green">Selected</Pill> : null}
                      </div>
                      <dl>
                        <div>
                          <dt>Risk score</dt>
                          <dd>{candidate.riskScore ?? "Not supplied"}</dd>
                        </div>
                        {candidate.instructions.map((instruction) => (
                          <div key={instruction.key}>
                            <dt>{instruction.label}</dt>
                            <dd>{instruction.value}</dd>
                          </div>
                        ))}
                      </dl>

                      {choosing ? (
                        <form
                          className={styles.confirm}
                          onSubmit={(event) => {
                            event.preventDefault();
                            confirm(new FormData(event.currentTarget));
                          }}
                        >
                          <label htmlFor={`profile-note-${account.accountId}-${candidate.requestId}`}>
                            Review note (optional)
                          </label>
                          <textarea
                            id={`profile-note-${account.accountId}-${candidate.requestId}`}
                            name="note"
                            rows={2}
                            maxLength={500}
                            placeholder="Why this request is the current source"
                          />
                          <p>
                            This request will set the complete risk profile and investment
                            instructions for {account.accountNumber}.
                          </p>
                          <div className={styles.actions}>
                            <Button type="submit" size="sm" disabled={pending}>
                              {pending ? "Saving…" : "Confirm source"}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={pending}
                              onClick={() => setChoice(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        </form>
                      ) : (
                        <Button
                          size="sm"
                          variant={selected ? "ghost" : "primary"}
                          onClick={() => {
                            setError(null);
                            setChoice({
                              accountId: account.accountId,
                              requestId: candidate.requestId,
                            });
                          }}
                        >
                          {selected ? "Change confirmation" : "Use this request"}
                        </Button>
                      )}
                    </article>
                  );
                })}
              </div>
              </section>
            );
          })}
        </div>
        {error ? <p className={styles.error}>{error}</p> : null}
        <Toast message={toast} />
      </div>
    </details>
  );
}
