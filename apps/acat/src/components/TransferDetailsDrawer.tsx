"use client";

import { useEffect } from "react";
import { ExternalLink, X } from "lucide-react";
import { AcatRecord } from "@/lib/types";
import AcatDetail from "./AcatDetail";
import { DataQualityFocus } from "@/lib/data-quality-focus";

interface TransferDetailsDrawerProps {
  acat: AcatRecord;
  onClose: () => void;
  onMutate: () => void;
  onOpenFullRecord: () => void;
  focus?: DataQualityFocus;
}

export default function TransferDetailsDrawer({
  acat,
  onClose,
  onMutate,
  onOpenFullRecord,
  focus,
}: TransferDetailsDrawerProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={acat.clientName}>
      <button
        type="button"
        aria-label="Close transfer details"
        onClick={onClose}
        className="absolute inset-0 bg-black/35"
      />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-5xl flex-col border-l border-card-border bg-surface shadow-2xl">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-card-border bg-[var(--bg-card)] px-5 py-2.5">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted">
              {focus ? "Editing from Data Quality" : "Transfer details"}
            </p>
            {focus && (
              <p className="truncate text-xs font-semibold text-[color:var(--warning)]">
                Fix: {focus.fieldLabel}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenFullRecord}
              className="inline-flex items-center gap-1.5 rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-xs font-semibold text-foreground shadow-sm hover:bg-[var(--bg-hover)]"
            >
              Full record <ExternalLink size={13} />
            </button>
            <button
              type="button"
              aria-label="Close transfer details"
              onClick={onClose}
              className="rounded-lg border border-card-border bg-[var(--bg-card)] p-2 text-muted shadow-sm hover:bg-[var(--bg-hover)] hover:text-foreground"
            >
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <AcatDetail
            acat={acat}
            layout="drawer"
            onMutate={onMutate}
            onDeleted={onClose}
            focus={focus}
          />
        </div>
      </aside>
    </div>
  );
}
