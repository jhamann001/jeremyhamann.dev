"use client";

import { useEffect, useRef } from "react";
import { loadNewRequestClients, lookupNewRequestHouseholds } from "@/app/(authenticated)/trade-requests/new/actions";
import { Button, Card, CardBody, CardHeader, Pill } from "@/components/ui";
import { TradeRequestsNotSetUp } from "@/components/trade-requests/WorkspaceNotices";
import {
  NEW_REQUEST_COPY,
  householdLookupInput,
  newRequestCapWarning,
  newRequestSubmitEnabled,
  newRequestSubmitLabel,
  type NewRequestDraft,
} from "@/lib/trade-requests/new-request";
import { SUBMIT_COPY } from "@/lib/trade-requests/new-request-submit";
import { usePriorAllocationLoader } from "./allocation/PriorAllocationPrompt";
import { useStandingExclusionsFill } from "./exclusions/ExclusionFields";
import { useNewRequestDraft } from "./NewRequestDraft";
import { useNoPlanCopy } from "./NoPlanCopy";
import { visibleSections } from "./sections";
import styles from "./NewRequestForm.module.css";

const CAP_WARNING_ID = "new-request-cap-warning";
const SUBMIT_ERROR_ID = "new-request-submit-error";
const HOUSEHOLD_DEBOUNCE_MS = 150;

export type NewRequestFormProps = {
  onSubmit?: (draft: NewRequestDraft) => void;
  /** While true Submit is disabled and reads "Submitting...". */
  submitting?: boolean;
  /** Shown in a banner at the top of the form. */
  submitError?: string | null;
  /** Card title; defaults to "New Trade Request". */
  title?: string;
  /** Edit and clone forms: the Cancel control. */
  onCancel?: () => void;
};

/**
 * Form shell. Submit is enabled only when every registered gate holds
 * (NEW_REQUEST_SUBMIT_GATES); the submit action itself is supplied by onSubmit.
 */
export function NewRequestForm({ onSubmit, submitting = false, submitError = null, title, onCancel }: NewRequestFormProps) {
  const { draft, clients, ensureClients, context, setHouseholds } = useNewRequestDraft();
  const noPlanCopy = useNoPlanCopy();
  const lookupSequence = useRef(0);
  const errorBanner = useRef<HTMLDivElement>(null);
  const loaded = clients.status === "loaded";
  // A request being edited keeps its household; nothing is resolved for it.
  const lookup = loaded && draft.formMode !== "edit" ? householdLookupInput(context) : null;
  const lookupKey = lookup ? JSON.stringify(lookup) : null;
  usePriorAllocationLoader();
  useStandingExclusionsFill();

  useEffect(() => {
    ensureClients(loadNewRequestClients);
  }, [ensureClients]);

  // The banner sits above the form while Submit is at its foot.
  useEffect(() => {
    if (submitError) errorBanner.current?.scrollIntoView?.({ block: "nearest" });
  }, [submitError]);

  useEffect(() => {
    if (!loaded) return;
    const sequence = ++lookupSequence.current;
    if (!lookupKey) {
      setHouseholds(null);
      return;
    }
    const { clientIds, accountIds } = JSON.parse(lookupKey) as { clientIds: string[]; accountIds: string[] };
    const handle = window.setTimeout(() => {
      lookupNewRequestHouseholds(clientIds, accountIds)
        .then((result) => {
          if (result && lookupSequence.current === sequence) setHouseholds(result);
        })
        .catch(() => undefined);
    }, HOUSEHOLD_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [loaded, lookupKey, setHouseholds]);

  if (clients.status === "idle" || clients.status === "loading") {
    return (
      <Card className={styles.form}>
        <p className={styles.state} role="status" aria-live="polite" aria-busy="true">{NEW_REQUEST_COPY.loading}</p>
      </Card>
    );
  }
  if (clients.status === "not_set_up") return <TradeRequestsNotSetUp />;
  if (clients.status === "failed") {
    return (
      <Card className={styles.form} data-testid="new-request-load-failed">
        <div className={styles.state} role="alert">
          <p className={styles.stateTitle}>{NEW_REQUEST_COPY.loadFailed}</p>
          <p className={styles.stateMessage}>{clients.message}</p>
        </div>
      </Card>
    );
  }

  const listed = clients.status === "loaded" ? clients.clients : [];
  const capWarning = newRequestCapWarning(context);
  const enabled = newRequestSubmitEnabled(context) && !submitting;
  const describedBy = [submitError ? SUBMIT_ERROR_ID : null, capWarning ? CAP_WARNING_ID : null].filter(Boolean).join(" ") || undefined;

  return (
    <form
      className={styles.form} noValidate aria-labelledby="new-request-title"
      onSubmit={(event) => event.preventDefault()}
    >
      <Card className={styles.card}>
        <CardHeader className={styles.header}>
          <h2 id="new-request-title" className={styles.title}>{title ?? NEW_REQUEST_COPY.cardTitle}</h2>
          {listed.length > 0 && (
            <span title={NEW_REQUEST_COPY.connectedTitle}><Pill tone="green">{NEW_REQUEST_COPY.connected}</Pill></span>
          )}
        </CardHeader>
        {submitError && <div ref={errorBanner} id={SUBMIT_ERROR_ID} role="alert" className={`${styles.banner} ${styles.danger}`}>{submitError}</div>}
        {capWarning && <div id={CAP_WARNING_ID} role="alert" className={`${styles.banner} ${styles.caution}`}>{capWarning}</div>}
        <CardBody className={styles.body}>
          {visibleSections(draft).map(({ section, number }) => (
            <section.Component key={section.id} number={number} title={section.title} />
          ))}
          <div className={styles.footer}>
            {onCancel && <Button variant="ghost" onClick={onCancel}>{SUBMIT_COPY.cancel}</Button>}
            <Button
              variant="primary" className={styles.submit} disabled={!enabled}
              onClick={() => {
                if (enabled) onSubmit?.(draft);
              }}
              aria-describedby={describedBy}
              aria-busy={submitting || undefined}
            >
              {newRequestSubmitLabel(draft, submitting, noPlanCopy)}
            </Button>
          </div>
        </CardBody>
      </Card>
    </form>
  );
}
