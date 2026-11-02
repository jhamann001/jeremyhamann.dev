"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { resubmitRequest, submitNewRequest } from "@/app/(authenticated)/trade-requests/new/submit-actions";
import { useTradeRequestsQueue } from "@/components/trade-requests/queue/QueueProvider";
import { NEW_REQUEST_COPY } from "@/lib/trade-requests/new-request";
import {
  buildNewRequestPayload,
  draftFromRequest,
  idempotencyStorageKey,
  newRequestFormTitle,
  submitFailureMessage,
  type SourceFormMode,
  type SubmitOutcome,
} from "@/lib/trade-requests/new-request-submit";
import type { TradeRequest } from "@/lib/trade-requests/request-types";
import { TRADE_REQUESTS_ROUTES } from "@/lib/trade-requests/routes";
import { NewRequestDraftProvider, useNewRequestDraft } from "../NewRequestDraft";
import { NewRequestForm } from "../NewRequestForm";

// The pending key survives a remount or reload, so a retry after a response
// that never arrived presents the same key and the service returns the
// request it already created. It is dropped only after a confirmed success.
function pendingKey(name: string | null, current: { current: string | null }): string {
  if (current.current) return current.current;
  let key: string | null = null;
  try {
    if (name) key = window.sessionStorage.getItem(name);
  } catch {
    key = null;
  }
  if (!key) {
    key = crypto.randomUUID();
    try {
      if (name) window.sessionStorage.setItem(name, key);
    } catch {
      // Without storage the key still covers retries from this form.
    }
  }
  current.current = key;
  return key;
}

function dropKey(name: string | null, current: { current: string | null }) {
  try {
    if (name) window.sessionStorage.removeItem(name);
  } catch {
    // Nothing stored.
  }
  current.current = null;
}

/**
 * The New Request form with its submit action: create for a new or cloned
 * request, resubmit for an edit. On success the queue reloads and opens; on
 * any failure the message is shown and the draft is left exactly as entered.
 */
export function NewRequestSubmitForm({ source = null }: { source?: TradeRequest | null }) {
  const router = useRouter();
  const queue = useTradeRequestsQueue();
  const { draft, context, households } = useNewRequestDraft();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [openedVersion] = useState(source?.updatedAt ?? "");
  const inFlight = useRef(false);
  const key = useRef<string | null>(null);
  const mode = draft.formMode;
  const keyName = idempotencyStorageKey(mode, source?.id ?? null);

  async function submit() {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setSubmitError(null);
    const payload = buildNewRequestPayload(context, { households, source });
    let outcome: SubmitOutcome;
    try {
      outcome = mode === "edit" && source
        ? await resubmitRequest(source.id, payload, openedVersion)
        : await submitNewRequest(payload, pendingKey(keyName, key));
    } catch {
      outcome = { ok: false, message: "" };
    }
    if (!outcome.ok) {
      inFlight.current = false;
      setSubmitting(false);
      setSubmitError(submitFailureMessage(outcome.message));
      return;
    }
    // Stays "Submitting..." until the queue opens, so a second click cannot start another submission.
    dropKey(keyName, key);
    queue.retry();
    router.push(TRADE_REQUESTS_ROUTES.tradingQueue);
  }

  return (
    <NewRequestForm
      onSubmit={() => void submit()}
      submitting={submitting}
      submitError={submitError}
      title={newRequestFormTitle(mode, source?.id ?? null, NEW_REQUEST_COPY.cardTitle)}
      onCancel={mode === "new" ? undefined : () => router.push(TRADE_REQUESTS_ROUTES.tradingQueue)}
    />
  );
}

/** Edit & Resubmit and Clone: a form of its own, seeded from the source request; the new-request draft is left alone. */
export function SourceRequestForm({ mode, source }: { mode: SourceFormMode; source: TradeRequest }) {
  return (
    <NewRequestDraftProvider initialDraft={draftFromRequest(source, mode)}>
      <NewRequestSubmitForm source={source} />
    </NewRequestDraftProvider>
  );
}
