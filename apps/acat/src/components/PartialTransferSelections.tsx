"use client";

import { useState } from "react";
import useSWR from "swr";

interface SelectionAsset {
  id: string;
  symbol: string;
  description: string;
  expectedQty: number;
  includeInTransfer: boolean | null;
}

export default function PartialTransferSelections({ acatId, onSaved, onDirtyChange }: {
  acatId: string;
  onSaved: () => Promise<unknown>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [changes, setChanges] = useState<Record<string, boolean | null>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const endpoint = `/api/acats/${encodeURIComponent(acatId)}/paperwork-assets`;
  const { data, error, isLoading, mutate } = useSWR<{ assets: SelectionAsset[] }>(open ? endpoint : null);
  const dirty = Object.keys(changes).length > 0;

  async function save() {
    setSaving(true); setMessage(null); setSaveError(null);
    try {
      const response = await fetch(endpoint, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assets: Object.entries(changes).map(([id, includeInTransfer]) => ({ id, includeInTransfer })) }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? "Could not save selections");
      await Promise.all([mutate(), onSaved()]);
      setChanges({}); onDirtyChange(false);
      setMessage(`Selections saved ${new Date().toLocaleTimeString("en-US")}. They will be here when you reopen this transfer.`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save selections");
    } finally { setSaving(false); }
  }

  return <div className="rounded-lg border border-card-border p-3">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="text-sm font-semibold text-accent">{open ? "Hide" : "Review"} saved transfer selections</button>
    <p className="mt-1 text-xs text-muted">Yes/No choices are saved on this transfer. Edit them here without re-uploading the mapping CSV. New holdings still need a decision.</p>
    {dirty && <p className="mt-2 text-xs font-semibold text-[color:var(--warning)]">Unsaved selections — save before generating a new form.</p>}
    {open && <>
      {isLoading && <p className="mt-2 text-xs text-muted">Loading saved selections…</p>}
      {error && <p role="alert" className="mt-2 text-xs text-[color:var(--danger)]">Could not load selections. <button type="button" onClick={() => void mutate()} className="underline">Retry</button></p>}
      {data?.assets && <div className="mt-3 max-h-80 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-[var(--bg-card)] text-muted"><tr><th className="p-2">#</th><th className="p-2">Security</th><th className="p-2">Include in transfer?</th></tr></thead>
          <tbody>{data.assets.map((asset, index) => {
            const choice = Object.hasOwn(changes, asset.id) ? changes[asset.id] : asset.includeInTransfer;
            return <tr key={asset.id} className="border-t border-card-border">
              <td className="p-2">{index + 1}</td><td className="p-2"><span className="font-semibold">{asset.symbol || asset.description}</span><p className="text-muted">{asset.description}</p></td>
              <td className="p-2"><select aria-label={`Include ${asset.symbol || asset.description} in transfer`} value={choice === true ? "yes" : choice === false ? "no" : "undecided"} disabled={saving} onChange={(event) => {
                setChanges((current) => ({ ...current, [asset.id]: event.target.value === "yes" ? true : event.target.value === "no" ? false : null }));
                onDirtyChange(true); setMessage(null); setSaveError(null);
              }} className="rounded border border-card-border bg-[var(--bg-card)] p-2 text-foreground"><option value="undecided">Undecided</option><option value="yes">Yes</option><option value="no">No</option></select></td>
            </tr>;
          })}</tbody>
        </table>
        {data.assets.length === 0 && <p className="p-2 text-muted">No holdings saved yet. Upload or sync the asset mapping once to start.</p>}
      </div>}
    </>}
    {dirty && <button type="button" disabled={saving} onClick={() => void save()} className="mt-3 rounded bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{saving ? "Saving…" : "Save transfer selections"}</button>}
    {message && <p role="status" className="mt-2 text-xs text-[color:var(--success)]">{message}</p>}
    {saveError && <p role="alert" className="mt-2 text-xs text-[color:var(--danger)]">{saveError}</p>}
  </div>;
}
