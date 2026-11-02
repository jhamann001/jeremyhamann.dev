"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { stageLabel, type TransferStage } from "@/lib/data/transfer-types";
import type { TransferValidationError } from "@/lib/data/transfer-validate";
import {
  attachableTransfers,
  type LinkTarget,
} from "@/lib/data/acat-link";
import {
  attachAcatToExistingTransfer,
  linkAcatToNewTransfer,
  loadLinkTargets,
  type LinkTargetsResult,
} from "@/app/(authenticated)/acat-tracking/actions";
import styles from "./AcatLinkPicker.module.css";
import { acatLinkTargetMatches } from "./acat-link-search";

// The link / onboard picker (WO ticket, transfer-centric step 3) — embedded
// in the UN-LINKED footer of the shared ACAT-detail drawer (replaces PR #145's
// static linkHint). Presentational + action-invoking ONLY: no write happens
// here — every write is a co-located "use server" action that re-gates and runs
// under RLS. Two modes:
//   • Existing — typeahead over the caller's visible clients/households; picking
//     one reveals that party's attachable OPEN transfers (attach onto one, no
//     duplicate) or creates a new IN_TRANSFER transfer.
//   • Prospect — a free-text name → a new transfer with null CRM ids (the
//     unmatched marker, flagged for cleanup).
// Targets load lazily on first mount (the drawer only mounts for ADMIN/OPS).

type Loaded = Extract<LinkTargetsResult, { ok: true }>;

type Mode = "existing" | "prospect";

export function AcatLinkPicker({
  acatRecordId,
  acatTransferId,
  defaultValue,
  onLinked,
}: {
  /** The tracker record PK — always present, the PRIMARY link key. */
  acatRecordId: string;
  /** The tracker's RAW acatTransferId (may be null or a placeholder like
   *  "N/A") — normalization lives ONLY in acat-link.ts (D2). */
  acatTransferId: string | null;
  /** Prefill from the ACAT statementAmount (editable; required > 0). */
  defaultValue: number | null;
  /** When set, a successful link stays on the page and reports the transfer
   *  id here instead of navigating to the transfer. */
  onLinked?: (transferId: string) => void;
}) {
  // The AcatLinkKey every write action receives: record id primary, raw UUID
  // passed through for the seam to normalize.
  const acat = { recordId: acatRecordId, acatTransferId } as const;
  const [mode, setMode] = useState<Mode>("existing");
  const [targets, setTargets] = useState<Loaded | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<{
    target: LinkTarget;
    label: string;
  } | null>(null);
  const [chosenTransferId, setChosenTransferId] = useState<string | null>(null);

  const [prospectName, setProspectName] = useState("");
  const [value, setValue] = useState(defaultValue != null ? String(defaultValue) : "");
  const [errors, setErrors] = useState<TransferValidationError[]>([]);
  const [pending, startTransition] = useTransition();
  // Synchronous double-submit guard: a fast double-click can fire two clicks
  // before `pending` re-renders the button disabled, which would create two
  // links. The ref flips the instant the first click lands, so the second is a
  // no-op; it's released only on a returned failure (success navigates away).
  const submittingRef = useRef(false);

  // Lazy first-open load — the tracking page stays non-blocking (the drawer's
  // by-id detail loads separately). A forbidden/error result degrades quietly.
  useEffect(() => {
    let live = true;
    loadLinkTargets().then((res) => {
      if (!live) return;
      if (res.ok) setTargets(res);
      else setLoadFailed(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!targets || q.length === 0) return [];
    return acatLinkTargetMatches(targets, q);
  }, [targets, q]);

  // Attach candidates: the chosen party's OPEN, ACAT-less transfers (reuses the
  // pure attachableTransfers decision helper on the loaded open transfers).
  const candidates = useMemo(() => {
    if (!targets || !selected) return [];
    const openSnake = targets.openTransfers.map((t) => ({
      id: t.id,
      name: t.name,
      stage: t.stage,
      // loadLinkTargets pre-filters to ACAT-less rows (both link ids null).
      acat_transfer_id: null as string | null,
      acat_record_id: null as string | null,
      client_sf_id: t.clientSfId,
      household_sf_id: t.householdSfId,
    }));
    return attachableTransfers(openSnake, selected.target);
  }, [targets, selected]);

  const fieldError = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of errors) if (!map.has(e.field)) map.set(e.field, e.message);
    return map;
  }, [errors]);

  const pick = (m: { label: string; target: LinkTarget }) => {
    setSelected({ target: m.target, label: m.label });
    setChosenTransferId(null);
    setQuery("");
    setOpen(false);
    setErrors([]);
  };

  const submit = () => {
    if (submittingRef.current) return; // hard guard against a fast double-click
    submittingRef.current = true;
    setErrors([]);
    startTransition(async () => {
      const release = () => {
        submittingRef.current = false;
      };
      const stay = onLinked ? { stay: true } : undefined;
      let res: { ok: false; errors: TransferValidationError[] } | { ok: true; transferId: string } | void;
      if (mode === "prospect") {
        if (prospectName.trim() === "") {
          setErrors([
            { field: "client_first_name", message: "Enter the prospect's name." },
          ]);
          release();
          return;
        }
        res = await linkAcatToNewTransfer(
          { kind: "prospect", name: prospectName },
          acat,
          Number(value),
          stay,
        );
      } else if (!selected) {
        setErrors([{ field: "form", message: "Search for and pick a client or household first." }]);
        release();
        return;
      } else if (chosenTransferId) {
        res = await attachAcatToExistingTransfer(chosenTransferId, acat, stay);
      } else {
        res = await linkAcatToNewTransfer(selected.target, acat, Number(value), stay);
      }
      // Success redirects inside the action (navigates away, ref stays locked);
      // only a returned failure lands here — show it and release the lock.
      if (res && !res.ok) {
        setErrors(res.errors);
        release();
      } else if (res?.ok && onLinked) {
        onLinked(res.transferId);
        release();
      }
    });
  };

  const bannerError = fieldError.get("form") ?? fieldError.get("acat_transfer_id");
  const isAttach = mode === "existing" && chosenTransferId != null;

  return (
    <div className={styles.wrap}>
      <p className={styles.heading}>Link this ACAT to a transfer</p>

      <div className={styles.modes} role="tablist" aria-label="Link mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "existing"}
          className={`${styles.mode} ${mode === "existing" ? styles.modeOn : ""}`.trim()}
          onClick={() => {
            setMode("existing");
            setErrors([]);
          }}
        >
          Existing client
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "prospect"}
          className={`${styles.mode} ${mode === "prospect" ? styles.modeOn : ""}`.trim()}
          onClick={() => {
            setMode("prospect");
            setSelected(null);
            setChosenTransferId(null);
            setErrors([]);
          }}
        >
          Prospect (new)
        </button>
      </div>

      {bannerError && (
        <p className={styles.banner} role="alert">
          {bannerError}
        </p>
      )}

      {mode === "existing" ? (
        <>
          {loadFailed ? (
            <p className={styles.note}>
              Couldn&apos;t load clients right now — reopen the drawer to retry.
            </p>
          ) : !targets ? (
            <p className={styles.note}>Loading clients…</p>
          ) : selected ? (
            <div className={styles.selected}>
              <div className={styles.selectedHead}>
                <span className={styles.selectedName}>{selected.label}</span>
                <button
                  type="button"
                  className={styles.change}
                  onClick={() => {
                    setSelected(null);
                    setChosenTransferId(null);
                  }}
                >
                  Change
                </button>
              </div>

              {candidates.length > 0 && (
                <fieldset className={styles.candidates}>
                  <legend className={styles.legend}>
                    This client has open transfers — attach, or create a new one:
                  </legend>
                  <label className={styles.candidate}>
                    <input
                      type="radio"
                      name="attach"
                      checked={chosenTransferId == null}
                      onChange={() => setChosenTransferId(null)}
                    />
                    <span>Create a new transfer</span>
                  </label>
                  {candidates.map((c) => (
                    <label key={c.id} className={styles.candidate}>
                      <input
                        type="radio"
                        name="attach"
                        checked={chosenTransferId === c.id}
                        onChange={() => setChosenTransferId(c.id)}
                      />
                      <span>
                        Attach to {c.name} ·{" "}
                        {stageLabel(c.stage as TransferStage)}
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}
            </div>
          ) : (
            <div className={styles.searchWrap}>
              <input
                className={styles.input}
                type="text"
                placeholder="Search clients & households…"
                autoComplete="off"
                aria-label="Search clients and households"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setOpen(e.target.value.trim().length > 0);
                }}
                onFocus={() => setOpen(q.length > 0)}
              />
              {open && (
                <div className={styles.results}>
                  {matches.length === 0 ? (
                    <div className={styles.empty}>No matches</div>
                  ) : (
                    matches.map((m) => (
                      <button
                        key={m.key}
                        type="button"
                        className={styles.item}
                        onClick={() => pick(m)}
                      >
                        <span className={styles.itemName}>{m.label}</span>
                        <span className={styles.itemSub}>{m.sub}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="acat-prospect-name">
            Prospect name
          </label>
          <input
            id="acat-prospect-name"
            className={
              fieldError.has("client_first_name")
                ? `${styles.input} ${styles.inputBad}`
                : styles.input
            }
            type="text"
            placeholder="e.g. Dana Prospect"
            value={prospectName}
            onChange={(e) => setProspectName(e.target.value)}
          />
          {fieldError.has("client_first_name") && (
            <span className={styles.error} role="alert">
              {fieldError.get("client_first_name")}
            </span>
          )}
          <p className={styles.prospectNote}>
            Not yet in the system — a free-text name only, no CRM record. The
            transfer is flagged unmatched for later cleanup.
          </p>
        </div>
      )}

      {!isAttach && (mode === "prospect" || selected) && (
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="acat-link-value">
            Transfer value (USD)
          </label>
          <input
            id="acat-link-value"
            className={
              fieldError.has("value")
                ? `${styles.input} ${styles.inputBad}`
                : styles.input
            }
            inputMode="decimal"
            placeholder="500000"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          {fieldError.has("value") && (
            <span className={styles.error} role="alert">
              {fieldError.get("value")}
            </span>
          )}
        </div>
      )}

      <div className={styles.actions}>
        <Button
          variant="primary"
          size="sm"
          type="button"
          onClick={submit}
          disabled={pending || (mode === "existing" && !selected)}
        >
          {pending ? "Linking…" : isAttach ? "Attach ACAT" : "Link ACAT"}
        </Button>
      </div>
    </div>
  );
}
