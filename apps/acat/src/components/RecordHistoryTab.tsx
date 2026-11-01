"use client";

import useSWR from "swr";
import { Clock3, History, Loader2 } from "lucide-react";
import { AcatRecord, ACAT_STATUS_LABELS, AcatStatus } from "@/lib/types";
import { getField } from "@/lib/record-fields";

export interface RecordHistoryEntry {
  id: string;
  action: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  performedBy: string | null;
  timestamp: string;
}

function displayField(field: string | null): string {
  if (!field) return "Record";
  return getField(field as keyof AcatRecord)?.label ?? field.replace(/([A-Z])/g, " $1").trim();
}

function displayValue(field: string | null, value: string | null): string {
  if (value == null || value === "") return "blank";
  if (field === "status") {
    return ACAT_STATUS_LABELS[value as AcatStatus] ?? value;
  }
  if (field === "residualMonitoringRequired") return value === "true" ? "Yes" : "No";
  return value;
}

function actionSummary(entry: RecordHistoryEntry): string {
  if (entry.action === "update" && entry.field) {
    return `${displayField(entry.field)} changed`;
  }
  if (entry.action === "DELETE") return "Record deleted";
  if (entry.action === "RESTORE") return "Record restored";
  if (entry.action === "fee-auto-apply") return "Fee schedule applied";
  if (entry.action === "recon-auto-complete") return "Security recon completed";
  if (entry.action === "recon-auto-uncomplete") return "Security recon reopened";
  if (entry.action === "manual-form-generated") return "Transfer form generated";
  return entry.action.replace(/[-_]/g, " ");
}

export default function RecordHistoryTab({ acat }: { acat: AcatRecord }) {
  const key = `/api/acats/${acat.id}/history?v=${encodeURIComponent(acat.lastUpdated)}`;
  const { data, error, isLoading, mutate } = useSWR<RecordHistoryEntry[]>(key);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
        <Loader2 size={15} className="animate-spin" />
        Loading history…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-[color:var(--danger-border)] bg-[color:var(--danger-bg)] p-4 text-sm text-[color:var(--danger)]">
        <p className="font-semibold">History could not be loaded.</p>
        <button type="button" onClick={() => void mutate()} className="mt-2 underline">
          Try again
        </button>
      </div>
    );
  }

  const entries = data ?? [];
  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center text-muted">
        <History size={22} className="opacity-50" />
        <p className="text-sm font-medium">No recorded changes yet</p>
        <p className="text-xs">Future edits will appear here with who made them.</p>
      </div>
    );
  }

  return (
    <ol className="space-y-2" aria-label="Record change history">
      {entries.map((entry) => (
        <li key={entry.id} className="rounded-xl border border-card-border bg-[var(--bg-card)] p-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold capitalize text-foreground">
                {actionSummary(entry)}
              </p>
              {entry.action === "update" && entry.field && (
                <p className="mt-1 break-words text-xs text-muted">
                  <span className="line-through opacity-70">{displayValue(entry.field, entry.oldValue)}</span>
                  <span className="mx-1.5">→</span>
                  <span className="font-medium text-foreground">{displayValue(entry.field, entry.newValue)}</span>
                </p>
              )}
              <p className="mt-1.5 text-[11px] text-muted">
                {entry.performedBy || "System"}
              </p>
            </div>
            <time
              dateTime={entry.timestamp}
              className="flex shrink-0 items-center gap-1 text-[10px] text-muted"
            >
              <Clock3 size={10} />
              {new Date(entry.timestamp).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </time>
          </div>
        </li>
      ))}
    </ol>
  );
}
