"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import type { AcatRecord } from "@/lib/types";
import { CLIENT_IDENTITY_ERROR, CLIENT_IDENTITY_REASON_MAX_LENGTH, ClientIdentityRelinkRequest } from "@/lib/client-identity-contract";
import { useClientIdentityStatus } from "@/hooks/use-client-identity-status";
import ClientIdentitySelection from "./ClientIdentitySelection";
import { getLinkedClients } from "./client-identity-display";

interface Props {
  acat: AcatRecord;
  onClose: () => void;
  onSaved: () => void;
}

export default function ClientIdentityRelinkDialog({ acat, onClose, onSaved }: Props) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const { status, loading: statusLoading, error: statusError, refresh } = useClientIdentityStatus();
  // Freeze the reviewed version while the dialog is open. Background record
  // refreshes must not silently authorize a write against a newer identity.
  const [reviewed] = useState(() => ({ version: acat.identityVersion, account: acat.apexAccountId, name: acat.clientName }));
  const [selected, setSelected] = useState(() => getLinkedClients(acat));
  const [account, setAccount] = useState(acat.apexAccountId);
  const [reason, setReason] = useState("");
  const [replaceDisplayName, setReplaceDisplayName] = useState(false);
  const [acknowledgeMappingInvalidation, setAcknowledgeMappingInvalidation] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const mappingAcknowledgmentNeeded = replaceDisplayName && Boolean(acat.mappingAccountId);
  const versionAvailable = Number.isInteger(reviewed.version);
  // Creation cutover does not disable verified corrections to existing rows.
  const canVerify = status?.health === "FRESH" && !statusLoading && !statusError;
  const pendingAccountAllowed = selected.length === 1 && status?.pendingAccountPolicy === "PENDING_ACCOUNT_OPENING_ONLY" && acat.status === "PendingAccountOpening";
  const accountRequired = !pendingAccountAllowed;
  const canSave = selected.length > 0 && (!accountRequired || Boolean(account.trim())) && reason.trim() && canVerify && versionAvailable && !conflict && (!mappingAcknowledgmentNeeded || acknowledgeMappingInvalidation);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector("input")?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  const save = async () => {
    if (!canSave || saving || !selected.length || reviewed.version == null) return;
    setSaving(true);
    setError(null);
    const body: ClientIdentityRelinkRequest = {
      cedarRidgeUserIds: selected.map((client) => client.cedarRidgeUserId),
      expectedIdentityVersion: reviewed.version,
      reason: reason.trim(),
      ...(account.trim() !== reviewed.account.trim() ? { apexAccountId: account.trim() } : {}),
      ...(replaceDisplayName ? { replaceDisplayName: true } : {}),
      ...(mappingAcknowledgmentNeeded && acknowledgeMappingInvalidation ? { acknowledgeMappingInvalidation: true } : {}),
    };
    try {
      const response = await fetch(`/api/acats/${acat.id}/client-identity`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        if (result.code === CLIENT_IDENTITY_ERROR.IDENTITY_CONFLICT) {
          setConflict(true);
          throw new Error("This record's client details changed. Close and reopen this dialog to review the latest record before saving.");
        }
        if (result.code === CLIENT_IDENTITY_ERROR.DIRECTORY_STALE || result.code === CLIENT_IDENTITY_ERROR.DIRECTORY_UNAVAILABLE) void refresh();
        throw new Error(result.error || "Could not save the client link. Try again.");
      }
      onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the client link. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[var(--panel-backdrop)] p-4" onClick={(event) => event.stopPropagation()}>
      <div
        ref={dialog}
        data-client-identity-dialog
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-card-border bg-[var(--bg-card)] p-5 shadow-xl"
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!saving) onClose(); }
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") event.stopPropagation();
          if (event.key === "Tab") {
            const focusable = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]');
            if (!focusable?.length) return;
            const first = focusable[0]; const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
          }
        }}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold">{getLinkedClients(acat).length ? "Review client link" : "Link client"}</h2>
          <button type="button" disabled={saving} aria-label="Close client link dialog" onClick={onClose} className="rounded p-1 hover:bg-[var(--bg-hover)]"><X size={18} /></button>
        </div>
        <p className="mb-4 text-xs text-muted">Current record name: <strong>{reviewed.name}</strong>. Linking preserves this historical name unless you choose to replace it.</p>
        <ClientIdentitySelection selected={selected} disabled={saving} onChange={setSelected} />
        <label className="mt-4 block text-xs font-medium">Apex Account #
          <input className="form-input mt-1" value={account} disabled={saving} onChange={(event) => setAccount(event.target.value)} />
        </label>
        <p className="mt-1 text-xs text-muted">Enter the complete receiving account number. It must belong to every selected person.{selected.length > 1 ? " All selected people must be verified joint holders of this account." : ""}{pendingAccountAllowed ? " This record can remain without an account number while account opening is pending." : ""}</p>
        <label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" checked={replaceDisplayName} disabled={saving} onChange={(event) => { setReplaceDisplayName(event.target.checked); setAcknowledgeMappingInvalidation(false); }} /><span>Replace the historical display name with the directory name</span></label>
        {mappingAcknowledgmentNeeded && <label className="mt-2 flex items-start gap-2 text-xs text-muted"><input type="checkbox" checked={acknowledgeMappingInvalidation} disabled={saving} onChange={(event) => setAcknowledgeMappingInvalidation(event.target.checked)} /><span>I understand that a changed name clears the saved statement-account mapping link and it will need to be selected again.</span></label>}
        <label className="mt-4 block text-xs font-medium">Reason for this change
          <textarea className="form-input mt-1 min-h-20" value={reason} maxLength={CLIENT_IDENTITY_REASON_MAX_LENGTH} disabled={saving} onChange={(event) => setReason(event.target.value)} />
        </label>
        {!canVerify && <div className="mt-3 text-xs"><p role="status">{statusError || (statusLoading ? "Checking client directory…" : status?.health === "STALE" ? "The client directory needs a fresh verified update before linking." : "Client verification is unavailable. Linking is paused.")}</p><button type="button" className="mt-1 text-accent underline" onClick={() => void refresh()}>Check directory again</button></div>}
        {!versionAvailable && <p role="alert" className="mt-3 text-xs">Refresh this record before linking its client.</p>}
        {error && <p role="alert" className="mt-3 text-sm text-[color:var(--danger)]">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="rounded border border-card-border px-3 py-2 text-sm" disabled={saving} onClick={() => { if (conflict) onSaved(); onClose(); }}>{conflict ? "Close and refresh record" : "Cancel"}</button>
          <button type="button" className="inline-flex items-center gap-2 rounded bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={!canSave || saving} onClick={() => void save()}>{saving && <Loader2 size={14} className="animate-spin" />}Save client link</button>
        </div>
      </div>
    </div>
  );
}
