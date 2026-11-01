import Link from "next/link";
import { ChevronRight } from "lucide-react";

interface CustodianFeeSummary {
  id: string;
  feeType: string;
  accountType: "ANY" | "IRA" | "BROKERAGE";
  transferType: "ANY" | "FULL" | "PARTIAL";
  amount: number | null;
  amountText: string | null;
}

type PlaybookTransferType =
  | "ACAT_API"
  | "MANUAL"
  | "MIXED"
  | "INTERNAL"
  | "UNCONFIRMED";
type DocStatus = "DOCUMENTED" | "PARTIAL" | "NEEDS_CALL";

const TRANSFER_TYPE_LABELS: Record<PlaybookTransferType, string> = {
  ACAT_API: "ACAT",
  MANUAL: "Manual",
  MIXED: "Mixed",
  INTERNAL: "Internal",
  UNCONFIRMED: "Unconfirmed",
};

const DOC_STATUS_LABELS: Record<DocStatus, string> = {
  DOCUMENTED: "Documented",
  PARTIAL: "Partial",
  NEEDS_CALL: "Needs call",
};

type TimingSpeed = "fast" | "typical" | "slow";

const TIMING_SPEED_STYLES: Record<
  TimingSpeed,
  { label: string; text: string; dot: string }
> = {
  fast: {
    label: "Fast (5 business days or fewer)",
    text: "text-[color:var(--success)]",
    dot: "bg-[color:var(--success)]",
  },
  typical: {
    label: "Typical (6–10 business days)",
    text: "text-[color:var(--warning)]",
    dot: "bg-[color:var(--warning)]",
  },
  slow: {
    label: "Slow (more than 10 business days)",
    text: "text-[color:var(--danger)]",
    dot: "bg-[color:var(--danger)]",
  },
};

export function timingSpeed(days: number): TimingSpeed {
  if (days <= 5) return "fast";
  if (days <= 10) return "typical";
  return "slow";
}

export interface CustodianSummary {
  id: string;
  name: string;
  avgProcessingDays: number;
  observedAvgProcessingBusinessDays: number | null;
  observedCompletedTransfers: number;
  contactEmail: string | null;
  reviewStatus: "NEEDS_SETUP" | "VERIFIED";
  transferType: PlaybookTransferType | null;
  documentationStatus: DocStatus | null;
  dtcNumber: string | null;
  hasInboundRecords: boolean;
  fees: CustodianFeeSummary[];
}

export type Segment = "all" | "acat" | "manual" | "mixed" | "needsPlaybook";

export const SEGMENTS: { key: Segment; label: string }[] = [
  { key: "all", label: "All" },
  { key: "acat", label: "ACAT" },
  { key: "manual", label: "Manual" },
  { key: "mixed", label: "Mixed" },
  { key: "needsPlaybook", label: "Needs playbook" },
];

export function needsPlaybook(custodian: CustodianSummary): boolean {
  return (
    custodian.hasInboundRecords &&
    custodian.documentationStatus !== "DOCUMENTED"
  );
}

export default function CustodianCard({
  custodian,
}: {
  custodian: CustodianSummary;
}) {
  const feeCount = custodian.fees.length;
  const unknownAmount = custodian.fees.some(
    (fee) => fee.amount == null && Boolean(fee.amountText)
  );
  const speed =
    custodian.observedAvgProcessingBusinessDays == null
      ? null
      : timingSpeed(custodian.observedAvgProcessingBusinessDays);
  const speedStyle = speed == null ? null : TIMING_SPEED_STYLES[speed];

  return (
    <Link
      href={`/admin/custodians/${custodian.id}`}
      className="group flex items-center gap-3 rounded-xl border border-card-border bg-[var(--bg-card)] p-4 shadow-sm transition hover:border-accent/40 hover:bg-[var(--bg-hover)]"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground">
            {custodian.name}
          </span>
          {custodian.transferType && (
            <span
              className="inline-flex items-center rounded-full border border-[color:var(--accent)]/30 bg-[color:var(--accent)]/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-accent"
              title="Transfer type"
            >
              {TRANSFER_TYPE_LABELS[custodian.transferType]}
            </span>
          )}
          {custodian.documentationStatus && (
            <span
              className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${
                custodian.documentationStatus === "DOCUMENTED"
                  ? "border-[color:var(--success-border)] bg-[color:var(--success-bg)] text-[color:var(--success)]"
                  : "border-[color:var(--warning-border)] bg-[color:var(--warning-bg)] text-[color:var(--warning)]"
              }`}
              title="Documentation status"
            >
              {DOC_STATUS_LABELS[custodian.documentationStatus]}
            </span>
          )}
          {custodian.reviewStatus === "NEEDS_SETUP" && (
            <span
              className="inline-flex items-center rounded-full border border-[color:var(--warning-border)] bg-[color:var(--warning-bg)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[color:var(--warning)]"
              title="Auto-created from an ingested contra — needs admin review"
            >
              Needs setup
            </span>
          )}
          {needsPlaybook(custodian) && (
            <span
              className="inline-flex items-center rounded-full border border-[color:var(--warning-border)] bg-[color:var(--warning-bg)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[color:var(--warning)]"
              title="Assets have transferred in from this contra but its transfer playbook isn't documented yet"
            >
              Needs playbook
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted">
          {custodian.dtcNumber && (
            <span className="font-mono text-foreground" title="DTC / clearing #">
              DTC {custodian.dtcNumber}
            </span>
          )}
          <span>
            {feeCount === 0
              ? "No fees on file"
              : `${feeCount} fee${feeCount === 1 ? "" : "s"}`}
          </span>
          {custodian.observedAvgProcessingBusinessDays == null ? (
            <span>No completed timing data</span>
          ) : (
            <span
              className={`inline-flex items-center gap-1.5 font-medium ${speedStyle?.text ?? ""}`}
              title={speedStyle?.label}
            >
              <span
                aria-hidden="true"
                className={`h-2 w-2 shrink-0 rounded-full ${speedStyle?.dot ?? ""}`}
              />
              ~{custodian.observedAvgProcessingBusinessDays} business days avg ·{" "}
              {custodian.observedCompletedTransfers} completed
            </span>
          )}
          {unknownAmount && (
            <span className="font-medium text-[color:var(--warning)]">
              Has unknown-amount fee
            </span>
          )}
        </div>
      </div>
      <ChevronRight
        size={16}
        className="shrink-0 text-muted-faint transition group-hover:text-accent"
      />
    </Link>
  );
}
