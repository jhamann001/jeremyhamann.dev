"use client";

import { useState } from "react";
import useSWR from "swr";
import { Download, History, RefreshCw } from "lucide-react";

interface SavedDocument {
  id: string;
  kind: "MAPPING_CSV" | "TRANSFER_FORM";
  filename: string;
  createdAt: string;
  createdBy: string;
  positionCount: number;
  includedCount: number;
  excludedCount: number;
  undecidedCount: number;
}
interface HistoryResponse { documents: SavedDocument[]; nextCursor: string | null }

export default function TransferDocumentHistory({ acatId }: { acatId: string }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const base = `/api/acats/${encodeURIComponent(acatId)}/documents`;
  const { data, error, isLoading, mutate } = useSWR<HistoryResponse>(cursor ? `${base}?cursor=${encodeURIComponent(cursor)}` : base);
  return (
    <section aria-label="Saved inputs and paperwork" className="rounded-xl border border-card-border bg-[var(--bg-card)] p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground"><History size={16} className="text-accent" />Saved inputs & paperwork</h3>
        <button type="button" aria-label="Refresh saved paperwork" onClick={() => void mutate()} className="rounded p-1 text-muted hover:text-accent"><RefreshCw size={14} /></button>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted">Download a previously saved version without uploading or generating again. CSVs contain this transfer’s matching-account holdings and Yes/No selections, not the entire original spreadsheet.</p>
      <p className="mt-1 text-xs leading-relaxed text-muted">PDF copies are saved as generated. Later edits or signatures in a downloaded copy are not synced back.</p>
      {isLoading && <p className="mt-3 text-sm text-muted">Loading saved documents…</p>}
      {error && <p role="alert" className="mt-3 text-sm text-[color:var(--danger)]">Could not load saved documents. Try refreshing.</p>}
      {!isLoading && !error && !data?.documents?.length && <p className="mt-3 text-sm text-muted">No saved documents yet. Future mapping uploads and generated forms will appear here; older local downloads cannot be recovered automatically.</p>}
      <ul className="mt-3 divide-y divide-card-border">
        {(data?.documents ?? []).map((document) => {
          const href = `${base}/${encodeURIComponent(document.id)}`;
          return <li key={document.id} className="py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-accent">{document.kind === "TRANSFER_FORM" ? "Generated form" : "Saved mapping CSV"}</p>
                <p className="break-all text-sm font-medium text-foreground">{document.filename}</p>
                <p className="mt-1 text-xs text-muted">{new Date(document.createdAt).toLocaleString("en-US")} · {document.createdBy}</p>
                <p className="mt-1 text-xs text-muted">{document.positionCount} holdings · {document.includedCount} included · {document.excludedCount} excluded · {document.undecidedCount} undecided</p>
              </div>
              <div className="flex flex-wrap gap-3 text-xs font-semibold text-accent">
                <a href={href} download className="inline-flex items-center gap-1 hover:underline"><Download size={13} />{document.kind === "TRANSFER_FORM" ? "Download PDF" : "Download saved CSV"}</a>
                {document.kind === "TRANSFER_FORM" && <a href={`${href}?input=1`} download className="inline-flex items-center gap-1 hover:underline"><Download size={13} />Inputs used (CSV)</a>}
              </div>
            </div>
          </li>;
        })}
      </ul>
      {(cursor || data?.nextCursor) && <div className="mt-2 flex gap-4 text-xs font-semibold text-accent">
        {cursor && <button type="button" onClick={() => setCursor(null)}>Latest documents</button>}
        {data?.nextCursor && <button type="button" onClick={() => setCursor(data.nextCursor)}>Older documents</button>}
      </div>}
    </section>
  );
}
