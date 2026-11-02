"use client";

import { useState } from "react";
import { Button, Card, CardBody, CardHeader } from "@/components/ui";
import { useTransferPlanDraft } from "./TransferPlanDraftProvider";
import styles from "./TransferPlanApprovalFooter.module.css";

// Keep the single approval action after every choice it saves. The provider
// owns the complete draft and clears dirty state only after a successful save.
export function TransferPlanApprovalFooter() {
  const draft = useTransferPlanDraft();
  const [note, setNote] = useState("");

  if (!draft.canApprove) return null;

  const legacyReview = draft.approvalMode === "LEGACY_IN_TRANSFER_REVIEW";

  const approvalLabel = draft.approvedVersion > 0
    ? "Approve revised plan"
    : "Approve funding plan";
  const approvalRequired = !draft.planComplete || draft.approvedVersion === 0;

  return (
    <Card>
      <CardHeader>Review and approve plan</CardHeader>
      <CardBody>
        <div className={styles.wrap}>
          <p className={styles.help}>
            {legacyReview
              ? "This transfer is already in progress. Review the saved funding type and securities before approving. To change the plan, return this transfer to Preparation. Existing task progress is preserved."
              : "Review the funding type and securities choices above. Changes are saved together when you approve the plan."}
          </p>

          <div role="status" aria-live="polite">
            {(draft.dirty || approvalRequired) && (
              <div className={styles.unsaved}>
                <strong>
                  {draft.pending ? "Approving plan…" : draft.dirty ? "Unsaved plan changes" : "Approval required"}
                </strong>
                <span>
                  {draft.pending
                    ? "Wait for approval to finish."
                    : draft.dirty
                      ? `Click ${approvalLabel} to save your funding type and securities choices. Changes are not saved automatically.`
                      : draft.fundingType == null
                        ? legacyReview
                          ? "This saved plan has no funding type. Return this transfer to Preparation to complete the plan."
                          : `Choose a funding type and review the securities choices, then click ${approvalLabel}.`
                        : `${draft.planComplete ? "This saved plan has no versioned approval." : "This saved plan needs approval."} Review the funding type and securities choices, then click ${approvalLabel}. You do not need to change them to approve.`}
                </span>
              </div>
            )}
          </div>

          <label className={styles.noteLabel} htmlFor="funding_plan_note">
            Approval note <span>optional</span>
          </label>
          <textarea
            id="funding_plan_note"
            className={styles.note}
            value={note}
            maxLength={500}
            rows={2}
            disabled={draft.pending}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Add context that should travel with this approved version."
          />

          {draft.errors.length > 0 && (
            <p className={styles.error} role="alert">
              {draft.errors[0]?.message}
            </p>
          )}

          <div className={styles.actions}>
            <Button
              size="sm"
              disabled={
                draft.pending ||
                draft.fundingType == null ||
                (!draft.dirty && !approvalRequired)
              }
              onClick={() => draft.approve(note)}
            >
              {draft.pending ? "Approving…" : approvalLabel}
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
