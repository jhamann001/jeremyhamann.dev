"use client";

import { useRef } from "react";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock,
} from "lucide-react";
import { AcatRecord } from "@/lib/types";
import { formatCentsExact, formatDateMMDDYYYY } from "@/lib/format";
import {
  getDaysOpen,
  getAgingTier,
  getExpectedCompletionDate,
  getExpectedProcessingDays,
  getIssueCount,
  getReconStatus,
} from "@/lib/acat-derivations";
import {
  ADVISOR_OPTIONS,
  RecordField,
  RecordFieldKey,
  defaultColumnOrder,
  formatFieldValue,
  orderedVisibleFields,
} from "@/lib/record-fields";
import { getColumnWidthPx } from "@/lib/column-display";
import { useInlineEdit, UseInlineEditApi } from "@/hooks/use-inline-edit";
import InlineField, { InlineFieldType } from "./InlineField";
import StatusBadge from "./StatusBadge";
import { useToast } from "./Toast";

export type RowDensity = "compact" | "comfortable";

interface RecordRowProps {
  acat: AcatRecord;
  selected: boolean;
  density: RowDensity;
  now: number;
  visibleColumns: Set<RecordFieldKey>;
  /**
   * User-defined column order. Cells render in this order so rows stay in
   * lock-step with the draggable header. When omitted, the row falls back
   * to the schema-default order — preserving callers (and tests) that pre-
   * date the drag-to-reorder feature.
   */
  columnOrder?: readonly RecordFieldKey[];
  onOpen: (id: string) => void;
  /** Revalidate the tracker after a successful inline update. */
  onMutate?: () => void | Promise<void>;
}

const TABLE_EDITABLE_FIELDS: ReadonlySet<RecordFieldKey> = new Set([
  "dtccNumber",
  "controlNumber",
  "apexAccountId",
  "wealthAdvisor",
  "acatDate",
  "originalClientRequestDate",
  "opsSubmissionDateToApex",
  "apexCompletionDate",
  "feeRequestSubmitted",
  "feeRequestCompleted",
  "notes",
]);

/**
 * Legacy width helpers retained for backward compatibility (re-exported so
 * external callers that referenced ROW_COL_CLASSES keep building).
 */
export const ROW_COL_CLASSES = {
  client: "min-w-[200px]",
  status: "min-w-[140px]",
  contra: "min-w-[140px]",
  dir: "min-w-[60px]",
  ctrl: "min-w-[110px]",
  apex: "min-w-[110px]",
  advisor: "min-w-[140px]",
  date: "min-w-[100px]",
  days: "min-w-[60px] text-right",
  assets: "min-w-[60px] text-right",
  issues: "min-w-[60px] text-right",
  aum: "min-w-[100px] text-right",
  chev: "w-[16px] shrink-0 text-muted",
} as const;

export default function RecordRow({
  acat,
  selected,
  density,
  now,
  visibleColumns,
  columnOrder,
  onOpen,
  onMutate,
}: RecordRowProps) {
  const fields = orderedVisibleFields(
    columnOrder ?? defaultColumnOrder(),
    visibleColumns
  );
  const { toast } = useToast();
  const identityVersionAtEdit = useRef(acat.identityVersion);
  const inlineEdit = useInlineEdit({
    onSave: async (key, value) => {
      try {
        const res = await fetch(`/api/acats/${acat.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [key]: value === "" && key !== "apexAccountId" ? null : value, ...(key === "apexAccountId" && identityVersionAtEdit.current != null ? { expectedIdentityVersion: identityVersionAtEdit.current } : {}) }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.code === "IDENTITY_CONFLICT" ? "Client details changed. Cancel this edit and reopen it after refreshing the record." : body.error || "Could not save changes");
        }
        await onMutate?.();
        return true;
      } catch (error) {
        toast("error", "Update Failed", error instanceof Error ? error.message : "Could not save changes");
        return false;
      }
    },
  });
  const edit = { ...inlineEdit, start: (field: string, value: string) => {
    identityVersionAtEdit.current = acat.identityVersion;
    inlineEdit.start(field, value);
  } };

  const paddingClass = density === "compact" ? "py-1.5" : "py-3.5";
  const textClass = density === "compact" ? "text-[11px]" : "text-xs";

  const handleClick = () => onOpen(acat.id);
  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(acat.id);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      data-record-id={acat.id}
      aria-label={`Open ${acat.clientName}`}
      onClick={handleClick}
      onKeyDown={handleKey}
      aria-current={selected ? "true" : undefined}
      className={`flex w-max min-w-full items-center gap-3 border-b border-card-border px-6 ${paddingClass} ${textClass} cursor-pointer transition focus:outline-none focus:ring-2 focus:ring-accent/40 focus:ring-inset ${
        selected ? "bg-accent-light/60" : "hover:bg-[var(--bg-hover)]"
      }`}
    >
      {fields.map((field) => (
        <Cell
          key={field.key}
          field={field}
          record={acat}
          density={density}
          now={now}
          edit={edit}
        />
      ))}
      <div className={ROW_COL_CLASSES.chev}>
        <ChevronRight size={14} />
      </div>
    </div>
  );
}

interface CellProps {
  field: RecordField;
  record: AcatRecord;
  density: RowDensity;
  now: number;
  edit: UseInlineEditApi;
}

function Cell({ field, record, density, now, edit }: CellProps) {
  const width = getColumnWidthPx(field.key);
  const isNumeric =
    field.type === "number" ||
    field.key === "daysOpen" ||
    field.key === "assetCount" ||
    field.key === "issueCount";

  const baseStyle: React.CSSProperties = {
    width,
    minWidth: width,
    flex: `0 0 ${width}px`,
  };
  const align = isNumeric ? "text-right" : "text-left";

  // Inline-editable operational fields ----------------------------------
  if (TABLE_EDITABLE_FIELDS.has(field.key)) {
    return (
      <EditableOperationalCell
        field={field}
        record={record}
        align={align}
        style={
          field.key === "clientName"
            ? { ...baseStyle, flex: `1 1 ${width}px` }
            : baseStyle
        }
        edit={edit}
      />
    );
  }

  // Special-case visuals -------------------------------------------------
  if (field.key === "clientName") {
    return (
      <div className="min-w-0" style={{ ...baseStyle, flex: `1 1 ${width}px` }}>
        <div className="truncate font-semibold text-foreground">
          {record.clientName}
        </div>
        {density !== "compact" && (
          <div className="mt-0.5 truncate text-[10px] text-muted">
            {[record.accountType, record.type].filter(Boolean).join(" · ") ||
              record.custodianName}
          </div>
        )}
      </div>
    );
  }

  if (field.key === "status") {
    return (
      <div style={baseStyle}>
        <StatusBadge status={record.status} />
      </div>
    );
  }

  if (field.key === "direction") {
    return (
      <div style={baseStyle}>
        <DirectionTag direction={record.direction} />
      </div>
    );
  }

  if (field.key === "issueCount") {
    const issueCount = getIssueCount(record);
    return (
      <div className={align} style={baseStyle}>
        {issueCount > 0 ? (
          <span className="inline-flex items-center rounded-full border border-[color:var(--danger-border)] bg-[color:var(--danger-bg)] px-2 py-0.5 font-mono text-[10px] font-bold text-[color:var(--danger)]">
            {issueCount}
          </span>
        ) : (
          <span className="font-mono text-[11px] text-muted-faint">0</span>
        )}
      </div>
    );
  }

  if (field.key === "statementAmount") {
    return (
      <div
        className={`${align} font-semibold text-foreground`}
        style={baseStyle}
      >
        {record.statementAmount != null && record.statementAmount !== 0
          ? formatCentsExact(record.statementAmount)
          : "—"}
      </div>
    );
  }

  if (field.key === "daysOpen") {
    // ticket: color by per-custodian aging tier — green/foreground for
    // on-track, amber for warn, red for high. Terminal records render
    // muted since "days open" is a snapshot, not an SLA breach.
    const tier = getAgingTier(record, now);
    const expected = getExpectedProcessingDays(record);
    const tierClass =
      tier === "high"
        ? "text-[color:var(--danger)]"
        : tier === "warn"
          ? "text-[color:var(--warning)]"
          : tier === "none"
            ? "text-muted"
            : "text-foreground";
    return (
      <div
        className={`${align} font-semibold ${tierClass}`}
        style={baseStyle}
        title={`Custodian SLA: ${expected}d`}
      >
        {getDaysOpen(record, now)}
        <span className="ml-0.5 font-normal text-muted">d</span>
      </div>
    );
  }

  // ticket: "Expected Completion" — projected from opsSubmissionDateToApex
  // + the custodian's avgProcessingDays. Empty cell when either input is
  // missing.
  if (field.key === "expectedCompletionDate") {
    const projected = getExpectedCompletionDate(record);
    return (
      <div className={`${align} text-muted`} style={baseStyle}>
        {projected ? formatShortDate(projected) : "—"}
      </div>
    );
  }

  if (field.key === "acatDate") {
    return (
      <div className={`${align} text-muted`} style={baseStyle}>
        {formatShortDate(record.acatDate)}
      </div>
    );
  }

  // ticket: recon status → colored badge. Surfaces the auto-complete
  // signal (and the "needs review" flag when both sources are in but
  // the recon rate is below 90%).
  if (field.key === "reconStatus") {
    const status = getReconStatus(record);
    return (
      <div style={baseStyle}>
        <ReconStatusBadge status={status} />
      </div>
    );
  }

  // Generic fallback ------------------------------------------------------
  const display = formatFieldValue(field, record);
  const isMono = field.key === "controlNumber" || field.key === "apexAccountId";
  const isMuted =
    field.key === "wealthAdvisor" ||
    field.key === "controlNumber" ||
    field.key === "apexAccountId";

  return (
    <div
      className={`min-w-0 truncate ${align} ${
        isMono ? "font-mono text-[11px]" : ""
      } ${isMuted ? "text-muted" : "text-foreground"}`}
      style={baseStyle}
      title={display || undefined}
    >
      {display || "—"}
    </div>
  );
}

function EditableOperationalCell({
  field,
  record,
  align,
  style,
  edit,
}: {
  field: RecordField;
  record: AcatRecord;
  align: string;
  style: React.CSSProperties;
  edit: UseInlineEditApi;
}) {
  const raw = field.value(record);
  const value = raw == null ? "" : String(raw);
  const type: InlineFieldType =
    field.key === "notes"
      ? "textarea"
      : field.key === "wealthAdvisor"
        ? "select"
        : field.type === "date"
          ? "date"
          : "text";
  const isMono =
    field.key === "dtccNumber" ||
    field.key === "controlNumber" ||
    field.key === "apexAccountId";

  return (
    <div
      data-inline-edit
      className={`min-w-0 ${align} ${isMono ? "font-mono text-[11px]" : ""}`}
      style={style}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <InlineField
        field={String(field.key)}
        value={value}
        edit={edit}
        type={type}
        options={field.key === "wealthAdvisor" ? ADVISOR_OPTIONS : undefined}
        placeholder={`Add ${field.label.toLowerCase()}`}
        variant="block"
        ariaLabel={`Edit ${field.label} for ${record.clientName}`}
        className={`w-full min-w-0 ${align}`}
        renderValue={(displayValue) => (
          <span
            className={`block w-full truncate ${
              displayValue ? "text-foreground" : "italic text-muted-faint"
            }`}
            title={displayValue || undefined}
          >
            {displayValue
              ? field.type === "date"
                ? formatShortDate(displayValue)
                : displayValue
              : `Add ${field.label.toLowerCase()}`}
          </span>
        )}
      />
      {edit.status === "error" &&
        edit.editingField === String(field.key) && (
        <span
          role="alert"
          className="mt-0.5 block text-[9px] font-sans text-[color:var(--danger)]"
        >
          Save failed — retry or press Escape
        </span>
      )}
    </div>
  );
}

function ReconStatusBadge({ status }: { status: ReturnType<typeof getReconStatus> }) {
  if (status === "complete") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-[color:var(--success-border)] bg-[color:var(--success-bg)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--success)]">
        <CheckCircle2 size={11} />
        Complete
      </span>
    );
  }
  if (status === "needs_review") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-[color:var(--danger-border)] bg-[color:var(--danger-bg)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--danger)]">
        <AlertTriangle size={11} />
        Needs Review
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-card-border bg-[var(--bg-hover)] px-2 py-0.5 text-[10px] font-semibold text-muted">
      <Clock size={11} />
      Pending
    </span>
  );
}

function DirectionTag({ direction }: { direction?: string }) {
  if (!direction) {
    return <span className="text-[11px] text-muted-faint">—</span>;
  }
  const isIn = direction.toLowerCase().startsWith("in");
  const isOut = direction.toLowerCase().startsWith("out");
  const dir = isIn ? "in" : isOut ? "out" : "other";
  const classes = isIn
    ? "bg-[color:var(--success-bg)] text-[color:var(--success)] border-[color:var(--success-border)]"
    : isOut
      ? "bg-[color:var(--danger-bg)] text-[color:var(--danger)] border-[color:var(--danger-border)]"
      : "bg-[var(--bg-hover)] text-foreground border-card-border";
  return (
    <span
      data-direction={dir}
      className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${classes}`}
    >
      {direction.slice(0, 3).toUpperCase()}
    </span>
  );
}

function formatShortDate(raw: string): string {
  if (!raw) return "—";
  return formatDateMMDDYYYY(raw) || "—";
}
