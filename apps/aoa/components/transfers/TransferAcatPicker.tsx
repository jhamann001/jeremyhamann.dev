"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { usdFromCents } from "@/lib/format";
import { resolveAcatStatus } from "@/lib/data/acat-status-catalog";
import type {
  TransferAcatCandidate,
  TransferAcatCandidatesResult,
} from "@/lib/data/transfer-acat-picker-types";
import {
  loadTransferAcatCandidates,
  linkAcatRecordToTransfer,
} from "@/app/(authenticated)/asset-transfer/acat-picker-actions";
import styles from "./TransferAcatPicker.module.css";

type Loaded = Extract<TransferAcatCandidatesResult, { ok: true }>;

function day(value: string | null): string {
  if (!value) return "Not provided";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Not provided"
    : date.toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
      });
}

function statusLabel(value: string | null): string {
  return value ? resolveAcatStatus(value).label : "Status not provided";
}

/** Shared, transfer-scoped entry point. Its caller gates the affordance; both
 * server actions independently enforce the firm-wide role and target rules. */
export function TransferAcatPicker({
  transferId,
  variant = "primary",
}: {
  transferId: string;
  variant?: "primary" | "inline";
}) {
  const router = useRouter();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [linked, setLinked] = useState(false);

  return (
    <>
      {linked ? (
        <span className={styles.note} role="status">ACAT linked. Refreshing transfer…</span>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          className={variant === "inline" ? styles.inlineTrigger : styles.primaryTrigger}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          Find and link ACAT
        </button>
      )}
      {open && (
        <TransferAcatDialog
          transferId={transferId}
          onClose={() => setOpen(false)}
          restoreFocus={() => triggerRef.current?.focus()}
          onLinked={() => {
            setLinked(true);
            setOpen(false);
            router.refresh();
          }}
        />
      )}
    </>
  );
}

function TransferAcatDialog({
  transferId,
  onClose,
  restoreFocus,
  onLinked,
}: {
  transferId: string;
  onClose: () => void;
  restoreFocus: () => void;
  onLinked: () => void;
}) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const submittingRef = useRef(false);
  const focusReturnRef = useRef(restoreFocus);
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);

  const reload = useCallback(async () => {
    if (submittingRef.current) return;
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setData(null);
    setLoadError(null);
    setSaveError(null);
    // Fresh reads always require a new choice and review. Never retain a
    // checkbox or confirmation fingerprint from the previous source snapshot.
    setSelectedId(null);
    setConfirmed(false);
    try {
      const result = await loadTransferAcatCandidates(transferId);
      if (!mountedRef.current || generation !== loadGenerationRef.current) return;
      if (result.ok) setData(result);
      else setLoadError(result.message);
    } catch {
      if (mountedRef.current && generation === loadGenerationRef.current) {
        setLoadError("ACAT records could not be loaded. Try again.");
      }
    } finally {
      if (mountedRef.current && generation === loadGenerationRef.current) setLoading(false);
    }
  }, [transferId]);

  useEffect(() => {
    mountedRef.current = true;
    const dialog = dialogRef.current;
    const returnFocus = focusReturnRef.current;
    dialog?.showModal();
    searchRef.current?.focus();
    void reload();
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      dialog?.close();
      returnFocus();
    };
  }, [reload]);

  const results = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return (data?.candidates ?? []).filter((candidate) => {
      const searchable = [
        candidate.clientName,
        candidate.transferringCustodian,
        candidate.statementAccountMasked,
        candidate.receivingAccountMasked,
      ].filter(Boolean).join(" ").toLocaleLowerCase();
      return terms.every((term) => searchable.includes(term));
    });
  }, [data, query]);
  const selected = data?.candidates.find((candidate) => candidate.recordId === selectedId) ?? null;

  const submit = async () => {
    if (submittingRef.current || !data || !selected || selected.unavailableReason || !confirmed) return;
    submittingRef.current = true;
    setPending(true);
    setSaveError(null);
    let succeeded = false;
    try {
      const result = await linkAcatRecordToTransfer(transferId, {
        recordId: selected.recordId,
        confirmationKey: selected.confirmationKey,
        destinationConfirmationKey: data.destination.confirmationKey,
        confirmed: true,
      });
      if (!mountedRef.current) return;
      if (result.ok) succeeded = true;
      else {
        setSaveError(result.message);
        setConfirmed(false);
      }
    } catch {
      if (mountedRef.current) {
        setSaveError("The link could not be confirmed. Refresh the records before trying again.");
        setConfirmed(false);
      }
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setPending(false);
    }
    if (succeeded && mountedRef.current) onLinked();
  };

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        // Native modal inertness handles the page behind us. Explicit wrapping
        // also keeps Tab from moving into browser chrome at either boundary.
        const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          "button, [href], input, select, textarea, [tabindex]",
        )).filter((element) =>
          !element.matches(":disabled") && element.tabIndex >= 0 && element.getClientRects().length > 0,
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = event.currentTarget.ownerDocument.activeElement;
        if (!first) {
          event.preventDefault();
          event.currentTarget.focus();
        } else if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || !event.currentTarget.contains(active))) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!submittingRef.current) onClose();
      }}
    >
      <div className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Existing tracker records</p>
          <h2 id={`${id}-title`} className={styles.title}>Find and link ACAT</h2>
          <p id={`${id}-description`} className={styles.note}>
            Choose an in-flight ACAT, then review who it belongs to before linking.
            Historical records may require the advanced ID option below.
          </p>
        </div>
        <button
          type="button"
          className={styles.close}
          aria-label="Close ACAT picker"
          disabled={pending}
          onClick={() => { if (!submittingRef.current) onClose(); }}
        >×</button>
      </div>

      <div className={styles.body} aria-busy={loading || pending}>
        <div className={styles.searchRow}>
          <div className={styles.searchField}>
            <label htmlFor={`${id}-search`} className={styles.fieldLabel}>Search ACAT records</label>
            <input
              ref={searchRef}
              id={`${id}-search`}
              className={styles.search}
              type="search"
              autoComplete="off"
              placeholder="Client, custodian, or account last 4"
              value={query}
              disabled={pending}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelectedId(null);
                setConfirmed(false);
                setSaveError(null);
              }}
            />
          </div>
          <Button variant="ghost" size="sm" disabled={loading || pending} onClick={() => void reload()}>
            Refresh records
          </Button>
        </div>

        {loading ? (
          <p className={styles.empty} role="status">Loading ACAT records…</p>
        ) : loadError ? (
          <div className={styles.errorState}>
            <p role="alert">{loadError}</p>
            <Button variant="ghost" size="sm" onClick={() => void reload()}>Try again</Button>
          </div>
        ) : data ? (
          <>
            <p className={styles.resultCount} role="status">
              {results.length} {results.length === 1 ? "record" : "records"}
              {query.trim() ? " matching your search" : " from ACAT Tracking"}
            </p>
            {results.length === 0 ? (
              <p className={styles.empty}>
                {data.candidates.length === 0
                  ? "No in-flight ACAT records are available to link."
                  : "No records match this search. Try another client, custodian, or account last 4."}
              </p>
            ) : (
              <fieldset className={styles.candidates} disabled={pending}>
                <legend className={styles.srOnly}>Choose an ACAT to review</legend>
                {results.map((candidate) => (
                  <label
                    key={candidate.recordId}
                    className={`${styles.candidate} ${selectedId === candidate.recordId ? styles.selected : ""} ${candidate.unavailableReason ? styles.unavailable : ""}`}
                  >
                    <input
                      type="radio"
                      name={`${id}-record`}
                      checked={selectedId === candidate.recordId}
                      disabled={Boolean(candidate.unavailableReason)}
                      aria-label={`Select ${candidate.clientName ?? "unnamed client"}, ${candidate.transferringCustodian ?? "custodian not provided"}, statement account ${candidate.statementAccountMasked ?? "not provided"}, ${day(candidate.acatDate)}`}
                      onChange={() => {
                        if (submittingRef.current) return;
                        setSelectedId(candidate.recordId);
                        setConfirmed(false);
                        setSaveError(null);
                      }}
                    />
                    <span className={styles.candidateContent}>
                      <span className={styles.candidateHeader}>
                        <strong>{candidate.clientName ?? "Client not provided"}</strong>
                        <span className={styles.status}>{statusLabel(candidate.status)}</span>
                      </span>
                      <span className={styles.candidateSub}>
                        {candidate.transferringCustodian ?? "Custodian not provided"} · {day(candidate.acatDate)} · {usdFromCents(candidate.amountCents)}
                      </span>
                      <span className={styles.accounts}>
                        <span>Statement account <strong>{candidate.statementAccountMasked ?? "Not provided"}</strong></span>
                        <span>Receiving account <strong>{candidate.receivingAccountMasked ?? "Not provided"}</strong></span>
                      </span>
                      <span className={styles.candidateSub}>
                        Account type: {candidate.accountType ?? "Not provided"} · Transfer: {candidate.transferType ?? "Not provided"} · Direction: {candidate.direction ?? "Not provided"}
                      </span>
                      {candidate.unavailableReason && <span className={styles.unavailableNote}>{candidate.unavailableReason}</span>}
                    </span>
                  </label>
                ))}
              </fieldset>
            )}

            {selected && (
              <section className={styles.review} aria-labelledby={`${id}-review`}>
                <h3 id={`${id}-review`} className={styles.reviewTitle}>Review this link</h3>
                <div className={styles.comparison}>
                  <div className={styles.identity}>
                    <p className={styles.eyebrow}>This asset transfer</p>
                    <strong>{data.destination.clientName}</strong>
                    <dl className={styles.facts}>
                      <div><dt>Household</dt><dd>{data.destination.householdName ?? "No household on file"}</dd></div>
                    </dl>
                  </div>
                  <div className={styles.identity}>
                    <p className={styles.eyebrow}>Selected tracker ACAT</p>
                    <strong>{selected.clientName ?? "Client not provided"}</strong>
                    <SelectedAcatFacts candidate={selected} />
                  </div>
                </div>
                <label className={styles.confirmation}>
                  <input type="checkbox" checked={confirmed} disabled={pending} onChange={(event) => setConfirmed(event.target.checked)} />
                  <span>I confirmed this ACAT belongs to this transfer</span>
                </label>
              </section>
            )}
          </>
        ) : null}
        {saveError && <p className={styles.error} role="alert">{saveError}</p>}
      </div>

      <div className={styles.footer}>
        <div className={styles.advanced}>
          {pending ? (
            <span className={styles.note} role="status">Linking ACAT. Please wait…</span>
          ) : (
            <>
              <Link href={`/asset-transfer/${transferId}/edit?focus=acat#acat`}>Enter an ID manually (advanced)</Link>
              <span>Use the tracker&apos;s ACAT ID, not a receiving account number.</span>
            </>
          )}
        </div>
        <Button
          className={styles.submit}
          disabled={pending || loading || !selected || Boolean(selected.unavailableReason) || !confirmed}
          onClick={() => void submit()}
        >
          {pending ? "Linking…" : "Link ACAT to this transfer"}
        </Button>
      </div>
    </dialog>
  );
}

function SelectedAcatFacts({ candidate }: { candidate: TransferAcatCandidate }) {
  return (
    <dl className={styles.facts}>
      <div><dt>Custodian</dt><dd>{candidate.transferringCustodian ?? "Not provided"}</dd></div>
      <div><dt>Statement account</dt><dd>{candidate.statementAccountMasked ?? "Not provided"}</dd></div>
      <div><dt>Receiving account</dt><dd>{candidate.receivingAccountMasked ?? "Not provided"}</dd></div>
      <div><dt>Date / status</dt><dd>{day(candidate.acatDate)} · {statusLabel(candidate.status)}</dd></div>
      <div><dt>Amount</dt><dd>{usdFromCents(candidate.amountCents)}</dd></div>
      <div><dt>Type / direction</dt><dd>{candidate.accountType ?? "Not provided"} · {candidate.transferType ?? "Not provided"} · {candidate.direction ?? "Not provided"}</dd></div>
    </dl>
  );
}
