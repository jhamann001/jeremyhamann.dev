"use client";

import { ChevronDown } from "lucide-react";
import {
  AcatRecord,
  AcatStatus,
  ACAT_STATUS_LABELS,
} from "@/lib/types";
import { formatCentsAsDollar } from "@/lib/format";
import { getIssueCount, sumStatementAmount } from "@/lib/acat-derivations";
import { RecordFieldKey } from "@/lib/record-fields";
import RecordRow, { RowDensity } from "./RecordRow";

interface RecordGroupProps {
  status: AcatStatus;
  records: AcatRecord[];
  collapsed: boolean;
  selectedId: string | null;
  density: RowDensity;
  now: number;
  visibleColumns: Set<RecordFieldKey>;
  /**
   * User-defined column order forwarded to each row so cells stay in lock-
   * step with the draggable records header. Optional for backwards-
   * compatibility — callers (and tests) that omit it get the schema-default
   * order from `RecordRow`.
   */
  columnOrder?: readonly RecordFieldKey[];
  onToggle: (status: AcatStatus) => void;
  onOpenRecord: (id: string) => void;
  onRecordMutate?: () => void | Promise<void>;
}

const STATUS_DOT: Record<AcatStatus, string> = {
  WaitingForApex: "bg-[color:var(--status-slate-dot)]",
  PendingAccountOpening: "bg-[color:var(--status-blue-dot)]",
  WaitingOnClient: "bg-[color:var(--status-amber-dot)]",
  WaitingForStatement: "bg-[color:var(--status-amber-dot)]",
  AcatReceived: "bg-[color:var(--status-sky-dot)]",
  ToCome: "bg-[color:var(--status-indigo-dot)]",
  Submitted: "bg-[color:var(--status-violet-dot)]",
  PendingReview: "bg-[color:var(--status-cyan-dot)]",
  PendingContraResponse: "bg-[color:var(--status-teal-dot)]",
  Accepted: "bg-[color:var(--status-emerald-dot)]",
  PendingSettlement: "bg-[color:var(--status-lime-dot)]",
  PendingBookkeeping: "bg-[color:var(--status-purple-dot)]",
  Matched: "bg-[color:var(--status-green-dot)]",
  Mismatch: "bg-[color:var(--status-red-dot)]",
  Pending: "bg-[color:var(--status-amber-dot)]",
  Completed: "bg-[color:var(--status-green-dot)]",
  Rejected: "bg-[color:var(--status-red-dot)]",
  Purged: "bg-[color:var(--status-gray-dot)]",
  Canceled: "bg-[color:var(--status-orange-dot)]",
  Deferred: "bg-[color:var(--status-yellow-dot)]",
};

export default function RecordGroup({
  status,
  records,
  collapsed,
  selectedId,
  density,
  now,
  visibleColumns,
  columnOrder,
  onToggle,
  onOpenRecord,
  onRecordMutate,
}: RecordGroupProps) {
  const issueTotal = records.reduce((sum, r) => sum + (getIssueCount(r) > 0 ? 1 : 0), 0);
  const statementTotalCents = sumStatementAmount(records);

  return (
    <section className="border-b border-card-border" data-status={status}>
      <header
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={() => onToggle(status)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle(status);
          }
        }}
        className="sticky top-0 z-[1] flex cursor-pointer items-center gap-3 border-b border-card-border bg-[var(--bg-card)] px-6 py-2.5 transition hover:bg-[var(--bg-hover)]"
      >
        <ChevronDown
          size={14}
          className={`text-muted transition-transform ${
            collapsed ? "-rotate-90" : ""
          }`}
        />
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[status] ?? "bg-[color:var(--status-gray-dot)]"}`}
        />
        <span className="text-sm font-semibold text-foreground">
          {ACAT_STATUS_LABELS[status]}
        </span>
        <span className="rounded-full bg-[var(--bg-hover)] px-2 py-0.5 font-mono text-[10px] font-bold text-muted">
          {records.length}
        </span>
        <div className="ml-auto flex items-center gap-4 text-[11px] text-muted">
          {issueTotal > 0 && (
            <span>
              <strong className="font-semibold text-[color:var(--danger)]">
                {issueTotal}
              </strong>{" "}
              with issues
            </span>
          )}
          {statementTotalCents > 0 && (
            <span>
              Statement Total{" "}
              <strong className="font-semibold text-foreground">
                {formatCentsAsDollar(statementTotalCents)}
              </strong>
            </span>
          )}
        </div>
      </header>

      {!collapsed && (
        <div role="list">
          {records.map((r) => (
            <RecordRow
              key={r.id}
              acat={r}
              selected={r.id === selectedId}
              density={density}
              now={now}
              visibleColumns={visibleColumns}
              columnOrder={columnOrder}
              onOpen={onOpenRecord}
              onMutate={onRecordMutate}
            />
          ))}
        </div>
      )}
    </section>
  );
}
