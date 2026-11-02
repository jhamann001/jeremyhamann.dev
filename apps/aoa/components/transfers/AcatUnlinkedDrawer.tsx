"use client";

import { useCallback, useEffect, useId, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { Pill, type PillTone } from "@/components/ui";
import { usdFromCents } from "@/lib/format";
import type { AcatToneKind } from "@/lib/data/acat-lane";
import { resolveAcatStatus } from "@/lib/data/acat-status-catalog";
import type { AcatListRow, AcatStatus } from "@/lib/data/acat-status";
import {
  loadUnlinkedAcatDetail,
  type AcatDetailResult,
} from "@/app/(authenticated)/asset-transfer/acat-lane-actions";
import { AcatStatusCard } from "./AcatStatusCard";
import { AcatLinkPicker } from "./AcatLinkPicker";
import { TransferPreparationPanel } from "./TransferPreparationPanel";
import { unlinkAcatFromExistingTransfer } from "@/app/(authenticated)/acat-tracking/actions";
import styles from "./AcatUnlinkedDrawer.module.css";

// Shared ACAT-detail drawer. Opens OVER a list and streams in the full position
// table from the role-gated `loadUnlinkedAcatDetail` action, keyed on the row's
// tracker RECORD `id` (via getAcatStatusByRecordId + <AcatStatusCard>) — the
// drawer never fetches directly. Keying on the unique record `id` (not the
// nullable, non-unique acatTransferId) is what makes each row show ITS OWN
// record. Only firm-wide roles reach it; the action re-checks (ADMIN /
// OPERATIONS).
//
// It serves BOTH kinds of row:
//   • LINKED (a `transferId` is provided) — the ACAT belongs to a transfer the
//     caller can see; the footer offers a "View transfer →" link to that
//     transfer's detail route.
//   • UN-LINKED (no `transferId`) — a residual tracker ACAT with no
//     app.transfer; the footer mounts the AcatLinkPicker for EVERY such row.
//     The record `id` (always present) is the PRIMARY link key, so even a
//     UUID-less row ("N/A"/blank acatTransferId) is linkable — the picker
//     hands the seam the record id plus the raw UUID for normalization.
//
// Backs the standalone ACAT Tracking page (transfer-centric step 2). On the
// transfer-centric board itself an ACAT is a status chip, so the board does not
// open this drawer today.

const TONE: Record<AcatToneKind, PillTone> = {
  accepted: "green",
  submitted: "amber",
  rejected: "red",
  neutral: "gray",
};

function MetaTile({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value}</span>
    </div>
  );
}

export function AcatUnlinkedDrawer({
  row,
  transferId = null,
  onClose,
  onTypeChanged,
  onUnlinked,
  onUnlinkError,
  readOnly = false,
  editor,
  onLinked,
  dayToDayText = null,
  trackerShell = null,
  feeSection,
  historySection = null,
}: {
  row: AcatListRow;
  /** When set, the row is LINKED to this transfer — the footer shows a
   *  "View transfer →" link instead of the un-linked hint. */
  transferId?: string | null;
  onClose: () => void;
  onTypeChanged?: (recordId: string, type: string | null) => void;
  onUnlinked: () => void;
  onUnlinkError?: (message: string) => void;
  /** Detail and link state only: no preparation panel, unlink, or link picker. */
  readOnly?: boolean;
  /** Edit controls mounted under the tiles when not read-only. */
  editor?: ReactNode;
  /** Forwarded to the link picker: stay in place after a link. */
  onLinked?: (transferId: string) => void;
  /** Current notes and trade instructions, or the reason they could not be loaded. */
  dayToDayText?: { notes: string; tradeInstructions: string; loadError: string | null } | null;
  /** The tracker-style header, actions, and details. When set it replaces the back button, header, tiles, and day-to-day text; every other region is unchanged. */
  trackerShell?: ReactNode;
  /** Optional fee workspace mounted under the editor while the fee release is on. */
  feeSection?: ReactNode;
  /** Collapsed field-history section (ticket), shown under the positions. */
  historySection?: ReactNode;
}) {
  const typeChangedCallback = useRef(onTypeChanged);
  useEffect(() => { typeChangedCallback.current = onTypeChanged; }, [onTypeChanged]);
  const request = useRef(0);
  const [currentType, setCurrentType] = useState<string | null | undefined>(undefined);
  const [result, setResult] = useState<AcatDetailResult | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [unlinkError, setUnlinkError] = useState("");
  const [pending, startTransition] = useTransition();
  const submitting = useRef(false);
  const unlinkButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const confirmationId = useId();

  useEffect(() => {
    if (confirmUnlink) cancelButton.current?.focus();
  }, [confirmUnlink]);

  function cancelUnlink() {
    setConfirmUnlink(false);
    setUnlinkError("");
    onUnlinkError?.("");
    // The trigger mounts again after the confirmation is dismissed.
    requestAnimationFrame(() => unlinkButton.current?.focus());
  }

  function unlink() {
    if (!transferId || submitting.current) return;
    submitting.current = true;
    setUnlinkError("");
    startTransition(async () => {
      try {
        const outcome = await unlinkAcatFromExistingTransfer(transferId, {
          recordId: row.id,
          acatTransferId: row.acatTransferId || null,
        });
        if (!outcome.ok) {
          const message = outcome.errors.map((error) => error.message).join(" ");
          setUnlinkError(message);
          onUnlinkError?.(message);
          return;
        }
        onUnlinked();
      } catch {
        const message = "The unlink result could not be confirmed. Try again or refresh to check the link.";
        setUnlinkError(message);
        onUnlinkError?.(message);
      } finally {
        submitting.current = false;
      }
    });
  }

  // Detail is fetched BY THE RECORD `id` (always present, unique) — so EVERY
  // row, including a legacy/manual "N/A"-acatTransferId row, resolves to ITS OWN
  // record. (The old by-acatTransferId read collapsed every "N/A" row onto one
  // record — the wrong-modal bug.) LINKING keys on the same record id (the
  // primary link key), so every un-linked row is linkable — the raw
  // acatTransferId rides along and the write seam stores it only when real.

  // The migrated shell (trackerShell) loads and shows its own transfer; only the shell-less drawers
  // (dashboard, tracking list, flag-off book) read and show the legacy tracker detail below.
  const hasShell = trackerShell != null;

  const refreshDetail = useCallback(async () => {
    const current = ++request.current;
    setResult(null);
    try {
      const next = await loadUnlinkedAcatDetail(row.id);
      if (request.current !== current) return;
      setResult(next);
      if (next.ok && next.status) {
        setCurrentType(next.status.type);
        typeChangedCallback.current?.(row.id, next.status.type);
      }
    } catch {
      if (request.current === current) setResult({ ok: false, reason: "error" });
    }
  }, [row.id]);

  useEffect(() => {
    setCurrentType(undefined);
    if (hasShell) return;
    void refreshDetail();
    return () => { request.current += 1; };
  }, [refreshDetail, hasShell]);

  // Refresh only the detail projection; the form retains its completed save.
  const handleScopeChanged = useCallback((scope: "FULL" | "PARTIAL") => {
    const type = scope === "FULL" ? "Full transfer" : "Partial transfer";
    setCurrentType(type);
    typeChangedCallback.current?.(row.id, type);
    if (!hasShell) void refreshDetail();
  }, [row.id, refreshDetail, hasShell]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || pending) return;
      if (confirmUnlink) {
        setConfirmUnlink(false);
        setUnlinkError("");
        onUnlinkError?.("");
        requestAnimationFrame(() => unlinkButton.current?.focus());
      } else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onUnlinkError, confirmUnlink, pending]);

  const detail: AcatStatus | null =
    result?.ok && result.status ? result.status : null;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby={hasShell ? undefined : titleId}
      aria-label={hasShell ? "Transfer drawer" : undefined}>
      <button
        type="button"
        className={styles.scrim}
        aria-label="Close"
        onClick={onClose}
        disabled={pending}
      />
      <div className={styles.panel}>
        {hasShell ? trackerShell : (
          <>
          <button type="button" className={styles.back} onClick={onClose} disabled={pending}>
            ‹ Close
          </button>

          <div className={styles.header}>
            <div>
              <h2 className={styles.title} id={titleId}>{row.clientName ?? "—"}</h2>
              <p className={styles.subtitle}>
                {(currentType === undefined ? row.type : currentType) ?? "Transfer"} in
                {row.transferringContra ? ` · from ${row.transferringContra}` : ""}
              </p>
            </div>
            {(() => {
              // Friendly label + catalog tone — same catalog the list header and
              // the detail card use, so the drawer never disagrees (ticket).
              const meta = resolveAcatStatus(row.status);
              return <Pill tone={TONE[meta.tone]}>{meta.label}</Pill>;
            })()}
          </div>

          <div className={styles.tiles}>
            <MetaTile label="Value" value={usdFromCents(row.statementAmount)} />
            <MetaTile
              label="Receiving account"
              value={row.apexAccountId ?? "—"}
            />
            <MetaTile
              label="Control #"
              value={row.controlNumber ?? "To come"}
            />
            <MetaTile label="ACAT date" value={row.acatDate ?? "—"} />
          </div>

          {dayToDayText && (dayToDayText.loadError
            ? <p role="alert">{dayToDayText.loadError}</p>
            : <div>
                <p>Notes</p>
                <p>{dayToDayText.notes === "" ? "—" : dayToDayText.notes}</p>
                <p>Trade instructions</p>
                <p>{dayToDayText.tradeInstructions === "" ? "—" : dayToDayText.tradeInstructions}</p>
              </div>)}
          </>
        )}

        {!readOnly && editor}
        {!readOnly && feeSection}

        {!hasShell && (
          <div className={styles.body}>
            {result == null ? (
              <p className={styles.note}>Loading positions…</p>
            ) : !result.ok ? (
              <p className={styles.note}>
                {result.reason === "forbidden"
                  ? "You don't have access to this ACAT's detail."
                  : "ACAT detail unavailable."}
              </p>
            ) : detail ? (
              <AcatStatusCard status={detail} />
            ) : (
              // The record exists but carries no by-record detail/positions (a
              // manual record may legitimately have none) — an empty state, NOT
              // another record's data.
              <p className={styles.note}>No positions recorded for this ACAT.</p>
            )}
          </div>
        )}

        {historySection}

        {readOnly ? (
          <div className={styles.linkActions}>
            {transferId ? <>
              <p className={styles.note}>Linked to an asset transfer</p>
              <Link href={`/asset-transfer/${transferId}`} className={styles.viewTransfer}>
                View transfer →
              </Link>
            </> : <p className={styles.note}>Not linked to an asset transfer</p>}
          </div>
        ) : <>
        <TransferPreparationPanel recordId={row.id} onScopeChanged={handleScopeChanged} />

        {transferId ? (
          <div className={styles.linkActions}>
            <Link href={`/asset-transfer/${transferId}`} className={styles.viewTransfer}>
              View transfer →
            </Link>
            {!confirmUnlink ? (
              <button ref={unlinkButton} type="button" className={styles.unlinkButton}
                onClick={() => { setConfirmUnlink(true); onUnlinkError?.(""); }}>
                Unlink transfer
              </button>
            ) : (
              <section className={styles.confirmation} aria-labelledby={confirmationId} aria-busy={pending}>
                <h3 id={confirmationId}>Unlink transfer?</h3>
                <p>This removes the association in AoA. The transfer and Transfer Tracker record will remain.</p>
                {unlinkError && <p role="alert" className={styles.unlinkError}>{unlinkError}</p>}
                <div className={styles.confirmationActions}>
                  <button ref={cancelButton} type="button" className={styles.cancelButton}
                    onClick={cancelUnlink} disabled={pending}>Cancel</button>
                  <button type="button" className={styles.unlinkButton} onClick={unlink} disabled={pending}>
                    {pending ? "Unlinking…" : "Unlink transfer"}
                  </button>
                </div>
              </section>
            )}
          </div>
        ) : (
          <AcatLinkPicker
            // The record PK — guaranteed non-empty (fetchAcatList drops id-less
            // rows) — is the primary link key, so EVERY un-linked row gets the
            // picker; the list mapper coerces a missing acatTransferId to "",
            // which the seam treats as null (no UUID stored).
            acatRecordId={row.id}
            acatTransferId={row.acatTransferId === "" ? null : row.acatTransferId}
            // statementAmount is tracker cents; the picker's value is a dollar
            // amount, so convert (matches the Value tile / AcatStatusCard).
            defaultValue={
              row.statementAmount == null ? null : row.statementAmount / 100
            }
            onLinked={onLinked}
          />
        )}
        </>}
      </div>
    </div>
  );
}
