"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  Database,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { formatCentsAsDollar, formatDateMMDDYYYY } from "@/lib/format";
import { AcatRecord, TransferWorkflow, TRANSFER_WORKFLOW_LABELS } from "@/lib/types";
import {
  DATA_QUALITY_RULES,
  DataQualityException,
  MonthlyVolume,
  contraPerformance,
  dashboardDataQualityExceptions,
  finalizedSummary,
  flowSummary,
  monthlyTransferVolume,
  reconCoverage,
  residualBenchmarks,
  residualMonitorQueue,
  workflowTimings,
} from "@/lib/transfer-analytics";
import { DataQualityFocus, dataQualityFocusFor } from "@/lib/data-quality-focus";

interface TransferDashboardProps {
  acats: AcatRecord[];
  onSelectRecord: (id: string, focus?: DataQualityFocus) => void;
}

type Tab = "overview" | "residuals" | "quality" | "recon";
type ReviewStatus = "OPEN" | "IN_REVIEW" | "CLOSED";
type Resolution =
  | "CORRECTED"
  | "RESOLVED_MANUALLY"
  | "FALSE_POSITIVE"
  | "NOT_APPLICABLE"
  | "ACKNOWLEDGED_UNRESOLVED"
  | "DUPLICATE";

interface Review {
  id: string;
  acatRecordId: string;
  ruleKey: string;
  fingerprint: string;
  status: ReviewStatus;
  resolution?: Resolution | null;
  note?: string | null;
  reviewedBy?: string | null;
}

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "residuals", label: "Residual monitoring" },
  { key: "quality", label: "Data quality" },
  { key: "recon", label: "Reconciliation" },
];

const RESOLUTION_LABELS: Record<Resolution, string> = {
  CORRECTED: "Corrected",
  RESOLVED_MANUALLY: "Resolved manually",
  FALSE_POSITIVE: "False positive",
  NOT_APPLICABLE: "Not applicable",
  ACKNOWLEDGED_UNRESOLVED: "Acknowledged — unable to resolve",
  DUPLICATE: "Duplicate",
};

function pct(value: number | null) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function days(value: number | null) {
  return value == null ? "—" : `${value.toFixed(1)}d`;
}

function StatCard({
  label,
  value,
  detail,
  tone = "default",
  onClick,
}: {
  label: string;
  value: string | number;
  detail: string;
  tone?: "default" | "success" | "danger" | "warning";
  onClick?: () => void;
}) {
  const colors = {
    default: "text-foreground",
    success: "text-[color:var(--success)]",
    danger: "text-[color:var(--danger)]",
    warning: "text-[color:var(--warning)]",
  };
  const content = (
    <>
      <p className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</p>
      <p className={`mt-2 text-3xl font-bold tabular-nums ${colors[tone]}`}>{value}</p>
      <p className="mt-1 text-xs text-muted">{detail}</p>
    </>
  );
  return onClick ? (
    <button onClick={onClick} className="rounded-xl border border-card-border bg-[var(--bg-card)] p-4 text-left transition hover:border-accent">
      {content}
    </button>
  ) : (
    <div className="rounded-xl border border-card-border bg-[var(--bg-card)] p-4">{content}</div>
  );
}

function Section({ title, subtitle, children, open = false }: { title: string; subtitle: string; children: React.ReactNode; open?: boolean }) {
  return (
    <details open={open} className="group rounded-xl border border-card-border bg-[var(--bg-card)]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="mt-0.5 text-xs text-muted">{subtitle}</p>
        </div>
        <ChevronDown size={16} className="shrink-0 text-muted transition group-open:rotate-180" />
      </summary>
      <div className="border-t border-card-border p-5">{children}</div>
    </details>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-dashed border-card-border p-8 text-center text-sm text-muted">{children}</div>;
}

// Distinct hues plus a pattern keep small Manual segments distinguishable
// from ACAT. Use the same fill for each bar segment and its legend swatch.
const VOLUME_WORKFLOWS: Array<{ workflow: TransferWorkflow; color: string; pattern?: string }> = [
  { workflow: "ACAT", color: "#7c3aed" },
  {
    workflow: "MANUAL",
    color: "#0d9488",
    pattern: "repeating-linear-gradient(135deg, transparent 0px, transparent 3px, rgba(0, 0, 0, 0.2) 3px, rgba(0, 0, 0, 0.2) 5px)",
  },
  { workflow: "DRS", color: "#d97706" },
  { workflow: "UNCLASSIFIED", color: "#6b7280" },
];

function MonthlyVolumeChart({ items }: { items: MonthlyVolume[] }) {
  const maxTotal = Math.max(1, ...items.map((item) => item.total));
  return (
    <div role="img" aria-label="Monthly transfer requests by workflow">
      <div className="mb-5 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted">
        {VOLUME_WORKFLOWS.map(({ workflow, color, pattern }) => (
          <span key={workflow} className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-3 w-4 rounded-sm" style={{ backgroundColor: color, backgroundImage: pattern }} />
            {TRANSFER_WORKFLOW_LABELS[workflow]}
          </span>
        ))}
      </div>
      <div className="overflow-x-auto pb-2">
        <div className="flex h-64 min-w-[920px] items-end gap-2 border-b border-card-border px-1">
          {items.map((item) => {
            const [month, year] = item.label.split(" ");
            const height = item.total === 0 ? 2 : Math.max(8, (item.total / maxTotal) * 184);
            const breakdown = VOLUME_WORKFLOWS
              .map(({ workflow }) => `${TRANSFER_WORKFLOW_LABELS[workflow]} ${item.workflows[workflow]}`)
              .join(", ");
            return (
              <div
                key={item.month}
                className="flex min-w-[48px] flex-1 flex-col items-center justify-end self-stretch"
                aria-label={`${item.label}: ${item.total} requests; ${breakdown}`}
                title={`${item.label}: ${item.total} requests\n${breakdown}`}
              >
                <span className="mb-1 text-[11px] font-semibold tabular-nums text-foreground">{item.total}</span>
                <div className="flex w-8 flex-col-reverse overflow-hidden rounded-t-sm bg-[var(--bg-hover)]" style={{ height }}>
                  {VOLUME_WORKFLOWS.map(({ workflow, color, pattern }) => {
                    const count = item.workflows[workflow];
                    return count > 0 ? (
                      <span
                        key={workflow}
                        style={{
                          backgroundColor: color,
                          backgroundImage: pattern,
                          height: `${(count / item.total) * 100}%`,
                          boxShadow: "inset 0 1px 0 var(--bg-card)",
                        }}
                      />
                    ) : null;
                  })}
                </div>
                <span className="mt-2 text-[10px] font-medium uppercase text-muted">{month}</span>
                <span className="text-[10px] text-muted">{year}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RecordButton({ record, onSelectRecord, detail }: { record: AcatRecord; onSelectRecord: (id: string) => void; detail?: string }) {
  return (
    <button onClick={() => onSelectRecord(record.id)} className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-[var(--bg-hover)]">
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{record.clientName}</span>
        <span className="block truncate text-xs text-muted">{record.transferringContra || "No contra"}{detail ? ` · ${detail}` : ""}</span>
      </span>
      <ArrowRight size={14} className="shrink-0 text-muted" />
    </button>
  );
}

export default function TransferDashboard({ acats, onSelectRecord }: TransferDashboardProps) {
  const [tab, setTab] = useState<Tab>("overview");
  const [reviews, setReviews] = useState<Review[]>([]);
  const [reviewError, setReviewError] = useState("");
  const [qualityFilter, setQualityFilter] = useState<"UNRESOLVED" | "CLOSED" | "ALL">("UNRESOLVED");
  const [qualityRuleFilter, setQualityRuleFilter] = useState("ALL");
  const [qualitySearch, setQualitySearch] = useState("");
  const [savingKey, setSavingKey] = useState("");

  useEffect(() => {
    fetch("/api/data-quality-reviews")
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load exception reviews");
        return response.json();
      })
      .then((value: Review[]) => setReviews(value))
      .catch((error: Error) => setReviewError(error.message));
  }, []);

  const summary = useMemo(() => finalizedSummary(acats), [acats]);
  const timings = useMemo(() => workflowTimings(acats), [acats]);
  const monthly = useMemo(() => monthlyTransferVolume(acats), [acats]);
  const acatContras = useMemo(() => contraPerformance(acats, "ACAT"), [acats]);
  const manualContras = useMemo(() => contraPerformance(acats, "MANUAL"), [acats]);
  const flow = useMemo(() => flowSummary(acats), [acats]);
  const residuals = useMemo(() => residualBenchmarks(acats), [acats]);
  const residualQueue = useMemo(() => residualMonitorQueue(acats), [acats]);
  const recon = useMemo(() => reconCoverage(acats), [acats]);
  const exceptions = useMemo<DataQualityException[]>(
    () => dashboardDataQualityExceptions(acats),
    [acats]
  );
  const reviewByKey = useMemo(
    () => new Map(reviews.map((review) => [`${review.acatRecordId}|${review.ruleKey}|${review.fingerprint}`, review])),
    [reviews]
  );
  const withReviews = exceptions.map((item) => ({
    ...item,
    review: reviewByKey.get(`${item.record.id}|${item.ruleKey}|${item.fingerprint}`),
  }));
  const unresolvedCount = withReviews.filter((item) => item.review?.status !== "CLOSED").length;
  const normalizedQualitySearch = qualitySearch.trim().toLocaleLowerCase();
  const searchFilteredExceptions = normalizedQualitySearch
    ? withReviews.filter((item) => item.record.clientName.toLocaleLowerCase().includes(normalizedQualitySearch))
    : withReviews;
  const statusFilteredExceptions = searchFilteredExceptions.filter((item) => {
    if (qualityFilter === "ALL") return true;
    if (qualityFilter === "CLOSED") return item.review?.status === "CLOSED";
    return item.review?.status !== "CLOSED";
  });
  const exceptionTypeOptions = useMemo(() => {
    const options = new Map<string, { title: string; count: number }>();
    for (const item of statusFilteredExceptions) {
      const current = options.get(item.ruleKey);
      options.set(item.ruleKey, {
        title: item.title,
        count: (current?.count ?? 0) + 1,
      });
    }
    return [...options.entries()]
      .map(([ruleKey, option]) => ({ ruleKey, ...option }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [statusFilteredExceptions]);
  const effectiveQualityRuleFilter =
    qualityRuleFilter === "ALL" || exceptionTypeOptions.some((item) => item.ruleKey === qualityRuleFilter)
      ? qualityRuleFilter
      : "ALL";
  const visibleExceptions = statusFilteredExceptions.filter(
    (item) => effectiveQualityRuleFilter === "ALL" || item.ruleKey === effectiveQualityRuleFilter
  );

  const saveReview = async (item: DataQualityException, status: ReviewStatus, resolution?: Resolution, note?: string) => {
    const key = `${item.record.id}|${item.ruleKey}|${item.fingerprint}`;
    setSavingKey(key);
    setReviewError("");
    try {
      const response = await fetch("/api/data-quality-reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          acatRecordId: item.record.id,
          ruleKey: item.ruleKey,
          fingerprint: item.fingerprint,
          status,
          resolution: resolution ?? null,
          note: note?.trim() || null,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not save review");
      setReviews((current) => [body, ...current.filter((review) => review.id !== body.id)]);
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "Could not save review");
    } finally {
      setSavingKey("");
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="shrink-0 border-b border-card-border bg-[var(--bg-card)] px-7 py-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-foreground">Transfer operations</h1>
            <p className="mt-1 text-sm text-muted">Operational outcomes, cycle time, residual sweeps, and reconciliation coverage</p>
          </div>
          <p className="shrink-0 whitespace-nowrap text-xs text-muted">Updated {formatDateMMDDYYYY(new Date())}</p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto max-w-[1500px] space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <StatCard label="All transfers" value={summary.total} detail={`${summary.validFinalized} finalized · ${summary.Purged} purged`} />
            <StatCard label="Completed" value={summary.Completed} detail={`${pct(summary.completedRate)} of valid finalized`} tone="success" />
            <StatCard label="Rejected" value={summary.Rejected} detail={`${pct(summary.rejectionRate)} of valid finalized`} tone="danger" />
            <StatCard label="Active" value={summary.active} detail={`${summary.Canceled} canceled · ${pct(summary.canceledRate)}`} />
            <StatCard label="Data quality" value={unresolvedCount} detail="unresolved exception instances" tone={unresolvedCount ? "warning" : "success"} onClick={() => setTab("quality")} />
          </div>

          <nav className="flex gap-1 overflow-x-auto rounded-xl border border-card-border bg-[var(--bg-card)] p-1" aria-label="Dashboard sections">
            {TABS.map((item) => (
              <button
                key={item.key}
                onClick={() => setTab(item.key)}
                className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition ${tab === item.key ? "bg-[var(--invert-bg)] text-[var(--invert-text)]" : "text-muted hover:bg-[var(--bg-hover)] hover:text-foreground"}`}
              >
                {item.label}
                {item.key === "quality" && unresolvedCount > 0 ? ` (${unresolvedCount})` : ""}
                {item.key === "residuals" && residualQueue.length > 0 ? ` (${residualQueue.length})` : ""}
              </button>
            ))}
          </nav>

          {tab === "overview" && (
            <div className="space-y-3">
              <Section title="Cycle time by transfer workflow" subtitle="Business-day medians; weekends and ACATS processing holidays are excluded" open>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-left text-sm">
                    <thead className="text-xs uppercase tracking-wider text-muted">
                      <tr><th className="pb-3">Workflow</th><th className="pb-3">Client request → Apex</th><th className="pb-3">Apex → complete</th><th className="pb-3">Request → complete</th></tr>
                    </thead>
                    <tbody className="divide-y divide-card-border">
                      {timings.map((item) => (
                        <tr key={item.workflow}>
                          <td className="py-3 font-medium text-foreground">{TRANSFER_WORKFLOW_LABELS[item.workflow]}</td>
                          {[item.requestToSubmit, item.submitToComplete, item.requestToComplete].map((metric, index) => (
                            <td key={index} className="py-3 text-foreground"><span className="font-semibold tabular-nums">{days(metric.median)}</span><span className="ml-2 text-xs text-muted">n={metric.sampleSize}</span></td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-3 text-xs text-muted">Use the median for the typical case; P75 and P90 are available in the underlying analytics and are used for monitoring thresholds.</p>
              </Section>

              <Section title="Transfer requests over time" subtitle={`Monthly client-request volume since ${monthly[0]?.label ?? "Jun 2025"}; residual movements are excluded from request totals`}>
                <MonthlyVolumeChart items={monthly} />
                <details className="mt-4 rounded-lg border border-card-border">
                  <summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-foreground">View monthly data</summary>
                  <div className="overflow-x-auto border-t border-card-border p-4">
                    <table className="w-full min-w-[720px] text-left text-sm">
                      <thead className="text-xs uppercase tracking-wider text-muted"><tr><th className="pb-3">Month</th><th className="pb-3">Requests</th><th className="pb-3">ACAT</th><th className="pb-3">Manual</th><th className="pb-3">DRS</th><th className="pb-3">Unclassified</th></tr></thead>
                      <tbody className="divide-y divide-card-border">
                        {monthly.map((item) => <tr key={item.month}><td className="py-2.5 font-medium text-foreground">{item.label}</td><td className="py-2.5 font-semibold tabular-nums">{item.total}</td><td className="py-2.5 tabular-nums">{item.workflows.ACAT}</td><td className="py-2.5 tabular-nums">{item.workflows.MANUAL}</td><td className="py-2.5 tabular-nums">{item.workflows.DRS}</td><td className="py-2.5 tabular-nums">{item.workflows.UNCLASSIFIED}</td></tr>)}
                      </tbody>
                    </table>
                  </div>
                </details>
              </Section>

              <Section title="Direction and asset flow" subtitle="Completed transfer counts and statement values">
                <div className="grid gap-3 md:grid-cols-3">
                  <FlowCard label="Incoming" icon={<ArrowDownLeft size={18} className="text-[color:var(--success)]" />} flow={flow.incoming} />
                  <FlowCard label="Outgoing" icon={<ArrowUpRight size={18} className="text-[color:var(--danger)]" />} flow={flow.outgoing} />
                  <div className="rounded-lg bg-[var(--bg-hover)] p-4">
                    <CircleDollarSign size={18} className="text-accent" />
                    <p className="mt-3 text-2xl font-bold">{formatCentsAsDollar(flow.netAmount)}</p>
                    <p className="text-xs text-muted">Net completed flow</p>
                    <dl className="mt-3 space-y-2 border-t border-card-border pt-3 text-xs">
                      <div className="flex items-center justify-between gap-3"><dt className="text-muted">Full / partial</dt><dd className="font-semibold tabular-nums text-foreground">{formatCentsAsDollar(flow.requestedNetAmount)}</dd></div>
                      <div className="flex items-center justify-between gap-3"><dt className="text-muted">Residual</dt><dd className="font-semibold tabular-nums text-foreground">{formatCentsAsDollar(flow.residualNetAmount)}</dd></div>
                    </dl>
                  </div>
                </div>
              </Section>

              <Section title="Top contras" subtitle="Workflow-specific contra performance; purged records are excluded">
                <div className="mb-4 rounded-lg bg-[var(--bg-hover)] px-4 py-3 text-xs leading-5 text-muted">
                  <span className="font-semibold text-foreground">Completed</span> is the number completed. <span className="font-semibold text-foreground">Finalized transfers</span> counts completed, rejected, and canceled transfers; active and purged transfers are excluded. <span className="font-semibold text-foreground">Rejected %</span> is rejected transfers divided by finalized transfers. <span className="font-semibold text-foreground">Median submit → complete</span> measures business days from Ops Submission Date to Apex → Apex Completion Date for completed transfers with both dates; weekends and ACATS processing holidays are excluded.
                </div>
                <div className="grid gap-4 xl:grid-cols-2">
                  <ContraPanel title="Top ACAT / API contras" items={acatContras} />
                  <ContraPanel title="Top Manual contras" items={manualContras} />
                </div>
              </Section>
            </div>
          )}

          {tab === "residuals" && (
            <div className="space-y-3">
              <Section title="Residual follow-up queue" subtitle="Completed transfers explicitly marked for monitoring with no linked residual after their follow-up date" open>
                {residualQueue.length === 0 ? <Empty>No monitored transfers currently need residual follow-up.</Empty> : <div className="divide-y divide-card-border rounded-lg border border-card-border">{residualQueue.map((item) => <RecordButton key={item.record.id} record={item.record} onSelectRecord={onSelectRecord} detail={`${item.daysPastFollowUp}d past follow-up · ${formatDateMMDDYYYY(item.followUpDate)}`} />)}</div>}
              </Section>
              <Section title="Observed sweep timing by contra" subtitle="Original transfer completion → linked residual completion; benchmarks require associated control numbers">
                {residuals.length === 0 ? <Empty>No linked residual history is available yet.</Empty> : <div className="max-h-96 overflow-auto"><table className="w-full text-left text-sm"><thead className="sticky top-0 bg-[var(--bg-card)] text-xs uppercase tracking-wider text-muted"><tr><th className="pb-3">Contra</th><th className="pb-3">Sample</th><th className="pb-3">Median</th><th className="pb-3">P75</th><th className="pb-3">P90</th></tr></thead><tbody className="divide-y divide-card-border">{residuals.map((item) => <tr key={item.contra}><td className="py-3 font-medium text-foreground">{item.contra}</td><td className="py-3">{item.sampleSize}</td><td className="py-3">{days(item.medianDays)}</td><td className="py-3">{days(item.p75Days)}</td><td className="py-3">{days(item.p90Days)}</td></tr>)}</tbody></table></div>}
                <p className="mt-3 text-xs text-muted">The monitor uses a contra-specific P75 once there are at least 10 linked residuals; otherwise it falls back to the global history.</p>
              </Section>
            </div>
          )}

          {tab === "quality" && (
            <div className="space-y-3">
              <Section title="What the queue checks" subtitle={`${DATA_QUALITY_RULES.length} automated controls; multiple request methods are allowed`}>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {DATA_QUALITY_RULES.map((rule) => (
                    <div key={rule.ruleKey} className="rounded-lg bg-[var(--bg-hover)] p-3">
                      <h3 className="text-xs font-semibold text-foreground">{rule.title}</h3>
                      <p className="mt-1 text-xs leading-5 text-muted">{rule.description}</p>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-xs text-muted">Request Method records how the transfer was received; Transfer Workflow records how it was completed. Selecting more than one request method is valid and is not flagged.</p>
              </Section>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-card-border bg-[var(--bg-card)] p-4">
                <div><h2 className="text-sm font-semibold text-foreground">Exception queue</h2><p className="text-xs text-muted">Closing an exception closes this rule instance only; the transfer record remains unchanged.</p></div>
                <div className="flex flex-wrap items-center gap-2">
                  <label>
                    <span className="sr-only">Search data quality by client</span>
                    <input
                      type="search"
                      value={qualitySearch}
                      onChange={(event) => setQualitySearch(event.target.value)}
                      placeholder="Search client name…"
                      aria-label="Search data quality by client"
                      className="form-input min-w-56 text-xs"
                    />
                  </label>
                  <label>
                    <span className="sr-only">Exception type</span>
                    <select
                      aria-label="Exception type"
                      value={effectiveQualityRuleFilter}
                      onChange={(event) => setQualityRuleFilter(event.target.value)}
                      className="form-input min-w-64 text-xs"
                    >
                      <option value="ALL">All exception types ({statusFilteredExceptions.length})</option>
                      {exceptionTypeOptions.map((item) => (
                        <option key={item.ruleKey} value={item.ruleKey}>
                          {item.title} ({item.count})
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="flex gap-1">{(["UNRESOLVED", "CLOSED", "ALL"] as const).map((filter) => <button key={filter} onClick={() => setQualityFilter(filter)} className={`rounded-md px-3 py-1.5 text-xs font-semibold ${qualityFilter === filter ? "bg-[var(--invert-bg)] text-[var(--invert-text)]" : "bg-[var(--bg-hover)] text-muted"}`}>{filter === "UNRESOLVED" ? "Open" : filter === "CLOSED" ? "Closed" : "All"}</button>)}</div>
                </div>
              </div>
              {reviewError && <div className="rounded-lg border border-[color:var(--danger-border)] bg-[color:var(--danger-bg)] p-3 text-sm text-[color:var(--danger)]">{reviewError}</div>}
              {visibleExceptions.length === 0 ? <Empty>No exceptions in this view.</Empty> : <div aria-label="Exception results" className="space-y-2">{visibleExceptions.map((item) => {
                const key = `${item.record.id}|${item.ruleKey}|${item.fingerprint}`;
                return <ExceptionCard key={key} item={item} review={item.review} saving={savingKey === key} onOpenRecord={onSelectRecord} onSave={saveReview} />;
              })}</div>}
            </div>
          )}

          {tab === "recon" && (
            <div className="space-y-3">
              <div className="grid gap-3 md:grid-cols-4">
                <StatCard label="Coverage" value={pct(recon.coverageRate)} detail={`${recon.tracked} of ${recon.eligible} eligible tracked`} />
                <StatCard label="Matched" value={recon.matched} detail={`Match rate ${pct(recon.matchRate)}`} tone="success" />
                <StatCard label="Needs review" value={recon.mismatch} detail={`${recon.pending} tracked and pending`} tone={recon.mismatch ? "warning" : "default"} />
                <StatCard label="Not tracked" value={recon.notTracked} detail="No recon evidence; not a mismatch" />
              </div>
              <Section title="How to read reconciliation" subtitle="Coverage and result quality are intentionally separate" open>
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="rounded-lg bg-[var(--bg-hover)] p-4"><Database size={18} className="text-accent" /><h3 className="mt-3 text-sm font-semibold">Tracked</h3><p className="mt-1 text-xs text-muted">A record has saved positions, a Apex upload, or a recon completion stamp.</p></div>
                  <div className="rounded-lg bg-[var(--bg-hover)] p-4"><ShieldCheck size={18} className="text-[color:var(--success)]" /><h3 className="mt-3 text-sm font-semibold">Match rate</h3><p className="mt-1 text-xs text-muted">Calculated only from tracked records with a matched or mismatch outcome.</p></div>
                  <div className="rounded-lg bg-[var(--bg-hover)] p-4"><RefreshCw size={18} className="text-muted" /><h3 className="mt-3 text-sm font-semibold">Not tracked</h3><p className="mt-1 text-xs text-muted">Historical records without recon data stay neutral and never lower the match rate.</p></div>
                </div>
              </Section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FlowCard({
  label,
  icon,
  flow,
}: {
  label: "Incoming" | "Outgoing";
  icon: React.ReactNode;
  flow: {
    totalCount: number;
    totalAmount: number;
    requestedCount: number;
    requestedAmount: number;
    residualCount: number;
    residualAmount: number;
  };
}) {
  return (
    <div className="rounded-lg bg-[var(--bg-hover)] p-4">
      {icon}
      <p className="mt-3 text-2xl font-bold">{flow.totalCount}</p>
      <p className="text-xs text-muted">{label} total · {formatCentsAsDollar(flow.totalAmount)}</p>
      <dl className="mt-3 space-y-2 border-t border-card-border pt-3 text-xs">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted">Full / partial</dt>
          <dd className="font-semibold tabular-nums text-foreground">{flow.requestedCount} · {formatCentsAsDollar(flow.requestedAmount)}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted">Residual</dt>
          <dd className="font-semibold tabular-nums text-foreground">{flow.residualCount} · {formatCentsAsDollar(flow.residualAmount)}</dd>
        </div>
      </dl>
    </div>
  );
}

function ContraPanel({ title, items }: { title: string; items: ReturnType<typeof contraPerformance> }) {
  return (
    <div className="min-w-0 rounded-lg border border-card-border p-4">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {items.length === 0 ? (
        <p className="mt-4 text-sm text-muted">No completed or finalized transfers in this workflow.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[560px] table-fixed text-left text-sm">
            <colgroup><col className="w-[22%]" /><col className="w-[12%]" /><col className="w-[12%]" /><col className="w-[16%]" /><col className="w-[18%]" /><col className="w-[20%]" /></colgroup>
            <thead className="text-xs uppercase tracking-wider text-muted">
              <tr className="align-bottom"><th className="pb-3 pr-2 leading-4 whitespace-normal">Contra</th><th className="pb-3 pr-2 leading-4 whitespace-normal">Completed</th><th className="pb-3 pr-2 leading-4 whitespace-normal">Finalized transfers</th><th className="pb-3 pr-2 leading-4 whitespace-normal">Rejected %</th><th className="pb-3 pr-2 leading-4 whitespace-normal">Median submit → complete</th><th className="pb-3 leading-4 whitespace-normal">Completed assets</th></tr>
            </thead>
            <tbody className="divide-y divide-card-border">
              {items.slice(0, 5).map((item) => <tr key={item.contra}><td className="py-3 pr-2 font-medium text-foreground">{item.contra}</td><td className="py-3 pr-2 tabular-nums">{item.completed}</td><td className="py-3 pr-2 tabular-nums">{item.finalized}</td><td className="py-3 pr-2 tabular-nums">{pct(item.rejectionRate)}</td><td className="py-3 pr-2 tabular-nums">{days(item.medianApexDays)}</td><td className="py-3 tabular-nums">{formatCentsAsDollar(item.completedAmount)}</td></tr>)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ExceptionCard({
  item,
  review,
  saving,
  onOpenRecord,
  onSave,
}: {
  item: DataQualityException;
  review?: Review;
  saving: boolean;
  onOpenRecord: (id: string, focus?: DataQualityFocus) => void;
  onSave: (item: DataQualityException, status: ReviewStatus, resolution?: Resolution, note?: string) => Promise<void>;
}) {
  const [resolution, setResolution] = useState<Resolution>(review?.resolution ?? "CORRECTED");
  const [note, setNote] = useState(review?.note ?? "");
  const closed = review?.status === "CLOSED";
  const noteRequired = resolution === "FALSE_POSITIVE" || resolution === "ACKNOWLEDGED_UNRESOLVED";
  return (
    <div className="rounded-xl border border-card-border bg-[var(--bg-card)] p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 gap-3">
          {item.severity === "high" ? <AlertTriangle size={18} className="mt-0.5 shrink-0 text-[color:var(--danger)]" /> : item.severity === "medium" ? <BarChart3 size={18} className="mt-0.5 shrink-0 text-[color:var(--warning)]" /> : <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-muted" />}
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold text-foreground">{item.title}</h3>{closed && <span className="rounded-full bg-[color:var(--success-bg)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[color:var(--success)]">Closed</span>}</div><p className="mt-1 text-xs text-muted">{item.record.clientName} · {item.detail}</p></div>
        </div>
        <button
          onClick={() => onOpenRecord(item.record.id, dataQualityFocusFor(item))}
          className="inline-flex items-center gap-1 text-xs font-semibold text-accent"
        >
          Fix in transfer <ArrowRight size={12} />
        </button>
      </div>
      {!closed && (
        <div className="mt-4 grid gap-2 border-t border-card-border pt-4 lg:grid-cols-[220px_1fr_auto_auto]">
          <select value={resolution} onChange={(event) => setResolution(event.target.value as Resolution)} className="form-input text-xs">{Object.entries(RESOLUTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <input value={note} onChange={(event) => setNote(event.target.value)} placeholder={noteRequired ? "Note required" : "Optional note"} className="form-input text-xs" />
          <button disabled={saving} onClick={() => onSave(item, "IN_REVIEW", undefined, note)} className="rounded-lg border border-card-border px-3 py-2 text-xs font-semibold text-foreground disabled:opacity-50">Mark in review</button>
          <button disabled={saving || (noteRequired && !note.trim())} onClick={() => onSave(item, "CLOSED", resolution, note)} className="rounded-lg bg-[var(--invert-bg)] px-3 py-2 text-xs font-semibold text-[var(--invert-text)] disabled:opacity-50">Close exception</button>
        </div>
      )}
      {closed && <p className="mt-3 border-t border-card-border pt-3 text-xs text-muted">{review?.resolution ? RESOLUTION_LABELS[review.resolution] : "Closed"}{review?.note ? ` · ${review.note}` : ""}</p>}
    </div>
  );
}
