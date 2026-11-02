"use client";

import { useEffect, useId, useRef, useState } from "react";
import { changeTradeRequestStatus } from "@/app/(authenticated)/trade-requests/status-actions";
import { useSessionMessages } from "@/components/trade-requests/bell/session-messages";
import { useRequestChecklistSummary } from "@/components/trade-requests/checklist/RequestChecklistScope";
import { useTradeRequestsQueue } from "@/components/trade-requests/queue/QueueProvider";
import { Button } from "@/components/ui";
import { CHECKLIST_KEYS } from "@/lib/trade-requests/checklist-view";
import {
  STATUS_ACTIONS, STATUS_ACTION_COPY, STATUS_NOTE_MAX, canChangeStatus, statusUpdateFailedMessage, uncheckedWarningLead,
  type StatusActionDef, type StatusChangeResult,
} from "@/lib/trade-requests/status-view";
import { useRequestDetailFrame } from "./RequestDetailDialog";
import styles from "./StatusActions.module.css";

/**
 * The reviewer's status actions in the request frame's `actions` slot
 * (design pass P2-157 to P2-165). ADMIN and OPERATIONS act on a request until
 * it is decided; every other role, and a decided request, gets nothing here.
 * A success reloads the queue and closes the request, as in the standalone app.
 */
export function RequestStatusActions({ role }: { role: string }) {
  const frame = useRequestDetailFrame();
  const summary = useRequestChecklistSummary();
  const sessionMessages = useSessionMessages();
  const queue = useTradeRequestsQueue();
  const noteId = useId();
  const [action, setAction] = useState<StatusActionDef | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const { request } = frame;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (!canChangeStatus(role, request.status)) return null;

  const unchecked = summary?.uncheckedCount ?? CHECKLIST_KEYS.length;

  async function confirm() {
    if (!action || busy) return;
    setBusy(true);
    frame.setError(null);
    let result: StatusChangeResult;
    try {
      result = await changeTradeRequestStatus(request.id, { status: action.status, note, expectedUpdatedAt: request.updatedAt });
    } catch {
      result = { ok: false, message: STATUS_ACTION_COPY.actionFailed };
    }
    // The queue and the session messages live above the dialog, so the outcome
    // reaches them even when the request was closed while the change ran.
    if (result.ok) {
      queue.retry();
      if (mounted.current) frame.close();
      return;
    }
    sessionMessages.add(statusUpdateFailedMessage(result.message));
    if (!mounted.current) return;
    setBusy(false);
    frame.setError(result.message);
  }

  if (!action) {
    return (
      <div className={styles.buttons} data-testid="trade-request-status-actions">
        {STATUS_ACTIONS.map((item) => (
          <Button key={item.key} title={item.title} className={styles[item.tone]} onClick={() => setAction(item)}>
            {item.label}
          </Button>
        ))}
      </div>
    );
  }

  return (
    <div className={styles.form} data-testid="trade-request-status-form">
      {action.key === "approve" && unchecked > 0 ? (
        <div className={styles.warning} data-testid="trade-request-approve-warning">
          {uncheckedWarningLead(unchecked)}{STATUS_ACTION_COPY.warningRest}
          <button
            type="button"
            className={styles.warningLink}
            onClick={() => {
              setAction(null);
              frame.selectTab("checklist");
            }}
          >
            {STATUS_ACTION_COPY.warningLink}
          </button>
          {STATUS_ACTION_COPY.warningEnd}
        </div>
      ) : null}
      <label htmlFor={noteId} className={styles.label}>{STATUS_ACTION_COPY.noteLabel}</label>
      <input
        id={noteId}
        type="text"
        className={styles.input}
        autoFocus
        value={note}
        maxLength={STATUS_NOTE_MAX}
        onChange={(event) => setNote(event.target.value)}
        placeholder={STATUS_ACTION_COPY.notePlaceholder}
      />
      <div className={styles.formButtons}>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setAction(null);
            frame.setError(null);
          }}
        >
          {STATUS_ACTION_COPY.cancel}
        </Button>
        <Button onClick={confirm} disabled={busy} aria-busy={busy || undefined}>
          {busy ? STATUS_ACTION_COPY.processing : STATUS_ACTION_COPY.confirm}
        </Button>
      </div>
    </div>
  );
}
