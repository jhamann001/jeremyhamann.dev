"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Pill } from "@/components/ui";
import { createTransferExceptionDecision } from "@/app/(authenticated)/(workflow)/decision-center/actions";
import { ResolveTransferException } from "@/components/asset-transfer/resolve/ResolveTransferException";
import {
  DECISION_OWNER_LABEL,
  DECISION_OWNER_TEAMS,
  type DecisionOwnerTeamValue,
} from "@/lib/data/decision-case-shared";
import type { DecisionCaseRow } from "@/lib/data/decision-cases";
import styles from "./LinkedDecisionCases.module.css";

export function LinkedDecisionCases({
  cases,
  transferId,
  canWrite,
}: {
  cases: DecisionCaseRow[];
  transferId: string;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [question, setQuestion] = useState("");
  const [ownerTeam, setOwnerTeam] = useState<DecisionOwnerTeamValue>("OPERATIONS");
  const [blocksTransfer, setBlocksTransfer] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await createTransferExceptionDecision({
        transferId,
        question,
        ownerTeam,
        blocksTransfer,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setQuestion("");
      setShowForm(false);
      router.refresh();
    });
  };

  return (
    <div className={styles.wrap}>
      {cases.length === 0 ? (
        <p className={styles.empty}>
          No unresolved judgment is attached to this transfer. Known route rules stay in the approved funding plan and flow directly to Tasks.
        </p>
      ) : (
        <ul className={styles.list}>
          {cases.map((item) => {
            const open = item.status !== "RESOLVED";
            return (
              <li key={item.id} className={open ? styles.open : styles.resolved}>
                <div className={styles.marker} aria-hidden="true">{open ? "!" : "✓"}</div>
                <div className={styles.body}>
                  <div className={styles.topline}>
                    <strong>{item.question}</strong>
                    <Pill tone={open ? "amber" : "green"} dot>
                      {open ? (item.blocksTransfer ? "Blocking" : "Open") : "Resolved"}
                    </Pill>
                  </div>
                  <span>
                    {open
                      ? `${DECISION_OWNER_LABEL[item.ownerTeam]} owns the exception.`
                      : item.resolutionSummary}
                  </span>
                </div>
                {open && item.blocksTransfer && canWrite ? (
                  <div className={styles.resolve}>
                    <ResolveTransferException decisionId={item.id} baseVersion={item.version} appearance="record" />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {showForm ? (
        <form
          className={styles.exceptionForm}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className={styles.formHead}>
            <div>
              <strong>Escalate a real exception</strong>
              <span>Use this only when judgment or clarification is still required.</span>
            </div>
            <Button type="button" size="sm" variant="ghost" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
          </div>
          <label>
            What needs to be decided?
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              maxLength={500}
              rows={2}
              required
              placeholder="Example: Confirm whether the restricted position should be donated or retained."
            />
          </label>
          <label>
            Decision owner
            <select
              value={ownerTeam}
              onChange={(event) => setOwnerTeam(event.target.value as DecisionOwnerTeamValue)}
            >
              {DECISION_OWNER_TEAMS.map((owner) => (
                <option key={owner} value={owner}>{DECISION_OWNER_LABEL[owner]}</option>
              ))}
            </select>
          </label>
          <label className={styles.blockingChoice}>
            <input
              type="checkbox"
              checked={blocksTransfer}
              onChange={(event) => setBlocksTransfer(event.target.checked)}
            />
            Stop transfer progress until this exception is resolved
          </label>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          <div className={styles.formActions}>
            <Button type="submit" size="sm" disabled={pending || question.trim().length === 0}>
              {pending ? "Creating…" : "Create decision"}
            </Button>
          </div>
        </form>
      ) : canWrite ? (
        <div className={styles.escalateAction}>
          <span>Standard partial-ACAT exclusions do not need a decision.</span>
          <Button size="sm" variant="ghost" onClick={() => setShowForm(true)}>
            + Escalate exception
          </Button>
        </div>
      ) : null}
    </div>
  );
}
