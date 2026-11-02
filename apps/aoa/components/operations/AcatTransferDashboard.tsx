"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  openDashboardRecord,
  reviewDashboardException,
  type DashboardRecordResult,
} from "@/app/(authenticated)/operations/transfer-dashboard/actions";
import { AcatUnlinkedDrawer } from "@/components/transfers/AcatUnlinkedDrawer";
import { AcatRecordEditor } from "@/components/transfers/AcatBookActions";
import type {
  AcatDashboard,
  ContraPerformance,
  FlowSplit,
  MonthlyVolume,
  QualityException,
  QualityReview,
} from "@/lib/data/acat-dashboard";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  ChartColumn,
  ChevronDown,
  CircleCheck,
  CircleDollarSign,
  Database,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "./acat-dashboard-icons";
import styles from "./AcatTransferDashboard.module.css";

type Tab = "overview" | "residuals" | "quality" | "recon";
type QualityFilter = "UNRESOLVED" | "CLOSED" | "ALL";
type Resolution =
  | "CORRECTED"
  | "RESOLVED_MANUALLY"
  | "FALSE_POSITIVE"
  | "NOT_APPLICABLE"
  | "ACKNOWLEDGED_UNRESOLVED"
  | "DUPLICATE";
type Workflow = "ACAT" | "MANUAL" | "DRS" | "RESIDUAL" | "UNCLASSIFIED";
type OpenRecord = Extract<DashboardRecordResult, { ok: true }>;

export type ExceptionStatusFilter = "open" | "closed" | "all";

/** Initial state for static rendering; the live page passes none. */
export type DashboardInteraction = {
  tab?: Tab;
  qualityFilter?: QualityFilter;
  reviewError?: string;
};

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

const WORKFLOW_LABELS: Record<Workflow, string> = {
  ACAT: "ACAT (API)",
  MANUAL: "Manual",
  DRS: "DRS",
  RESIDUAL: "Residual",
  UNCLASSIFIED: "Unclassified",
};

// Distinct hues plus a pattern keep small Manual segments distinguishable
// from ACAT. Use the same fill for each bar segment and its legend swatch.
const VOLUME_WORKFLOWS: Array<{ workflow: Exclude<Workflow, "RESIDUAL">; color: string; pattern?: string }> = [
  { workflow: "ACAT", color: "#7c3aed" },
  {
    workflow: "MANUAL",
    color: "#0d9488",
    pattern: "repeating-linear-gradient(135deg, transparent 0px, transparent 3px, rgba(0, 0, 0, 0.2) 3px, rgba(0, 0, 0, 0.2) 5px)",
  },
  { workflow: "DRS", color: "#d97706" },
  { workflow: "UNCLASSIFIED", color: "#6b7280" },
];

const MONTH_NUMBER: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

export function pct(value: number | null) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function days(value: number | null) {
  return value == null ? "—" : `${value.toFixed(1)}d`;
}

function formatDollar(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const m = abs / 1_000_000;
    return `${sign}$${m >= 10 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}K`;
  return `${sign}$${abs.toLocaleString()}`;
}

export function formatCentsAsDollar(cents: number): string {
  return formatDollar(cents / 100);
}

function validIsoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeDateToIso(value: string | Date | null | undefined): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const trimmed = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(trimmed);
  if (iso) return validIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const mdy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(trimmed);
  if (mdy) return validIsoDate(Number(mdy[3]), Number(mdy[1]), Number(mdy[2]));
  const named = /^([a-z]+)\s+(\d{1,2}),\s*(\d{4})$/i.exec(trimmed);
  if (named) {
    const month = MONTH_NUMBER[named[1].toLowerCase()];
    return month ? validIsoDate(Number(named[3]), month, Number(named[2])) : null;
  }
  return null;
}

/** User-facing transfer dates are consistently MM-DD-YYYY. */
export function formatDateMMDDYYYY(value: string | Date | null | undefined): string {
  const iso = normalizeDateToIso(value);
  if (!iso) return "";
  const [year, month, day] = iso.split("-");
  return `${month}-${day}-${year}`;
}

export function exceptionIsOpen(row: QualityException): boolean {
  return row.review == null || row.review.status !== "CLOSED";
}

export function openExceptionCount(rows: readonly QualityException[]): number {
  return rows.filter(exceptionIsOpen).length;
}

export function exceptionKey(row: Pick<QualityException, "record" | "ruleKey" | "fingerprint">): string {
  return `${row.record.id}|${row.ruleKey}|${row.fingerprint}`;
}

export function filterQualityExceptions(
  rows: readonly QualityException[],
  filter: { status: ExceptionStatusFilter; ruleKey: string; clientQuery: string },
): QualityException[] {
  const query = filter.clientQuery.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    const clientOk = query === "" || (row.record.clientName ?? "").toLocaleLowerCase().includes(query);
    const statusOk = filter.status === "all"
      || (filter.status === "closed" && row.review?.status === "CLOSED")
      || (filter.status === "open" && exceptionIsOpen(row));
    const typeOk = filter.ruleKey === "" || row.ruleKey === filter.ruleKey;
    return clientOk && statusOk && typeOk;
  });
}

/** The tracker's queue composition: search, then status, then the counted type options. */
export function qualityView(
  rows: readonly QualityException[],
  filter: { status: QualityFilter; ruleKey: string; clientQuery: string },
) {
  const status: ExceptionStatusFilter = filter.status === "ALL" ? "all" : filter.status === "CLOSED" ? "closed" : "open";
  const statusFiltered = filterQualityExceptions(rows, { status, ruleKey: "", clientQuery: filter.clientQuery });
  const counts = new Map<string, { title: string; count: number }>();
  for (const item of statusFiltered) {
    counts.set(item.ruleKey, { title: item.title, count: (counts.get(item.ruleKey)?.count ?? 0) + 1 });
  }
  const options = [...counts.entries()]
    .map(([ruleKey, option]) => ({ ruleKey, ...option }))
    .sort((a, b) => a.title.localeCompare(b.title));
  const effectiveRule = filter.ruleKey === "ALL" || options.some((item) => item.ruleKey === filter.ruleKey) ? filter.ruleKey : "ALL";
  const visible = statusFiltered.filter((item) => effectiveRule === "ALL" || item.ruleKey === effectiveRule);
  return { statusFiltered, options, effectiveRule, visible };
}

export function closeRequiresNote(resolution: string, note: string): boolean {
  return (resolution === "FALSE_POSITIVE" || resolution === "ACKNOWLEDGED_UNRESOLVED") && note.trim() === "";
}

export function reviewAfterWrite(
  result: { ok: true } | { ok: false; reason: string },
): { open: boolean; reason: string | null } {
  if (!result.ok) return { open: true, reason: result.reason };
  return { open: false, reason: null };
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
  const content = (
    <>
      <p className={styles.statLabel}>{label}</p>
      <p className={`${styles.statValue} ${styles[`tone_${tone}`]}`}>{value}</p>
      <p className={styles.statDetail}>{detail}</p>
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className={`${styles.statCard} ${styles.statButton}`}>{content}</button>
  ) : (
    <div className={styles.statCard}>{content}</div>
  );
}

function Section({ title, subtitle, children, open = false }: { title: string; subtitle: string; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className={styles.section}>
      <summary className={styles.summary}>
        <div>
          <h2 className={styles.sectionTitle}>{title}</h2>
          <p className={styles.sectionSubtitle}>{subtitle}</p>
        </div>
        <ChevronDown size={16} className={styles.chevron} />
      </summary>
      <div className={styles.sectionBody}>{children}</div>
    </details>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}

function MonthlyVolumeChart({ items }: { items: MonthlyVolume[] }) {
  const maxTotal = Math.max(1, ...items.map((item) => item.total));
  return (
    <div role="img" aria-label="Monthly transfer requests by workflow">
      <div className={styles.legend}>
        {VOLUME_WORKFLOWS.map(({ workflow, color, pattern }) => (
          <span key={workflow} className={styles.legendItem}>
            <span aria-hidden="true" className={styles.legendSwatch} style={{ backgroundColor: color, backgroundImage: pattern }} />
            {WORKFLOW_LABELS[workflow]}
          </span>
        ))}
      </div>
      <div className={styles.chartScroll}>
        <div className={styles.chart}>
          {items.map((item) => {
            const [month, year] = item.label.split(" ");
            const height = item.total === 0 ? 2 : Math.max(8, (item.total / maxTotal) * 184);
            const breakdown = VOLUME_WORKFLOWS
              .map(({ workflow }) => `${WORKFLOW_LABELS[workflow]} ${item.workflows[workflow]}`)
              .join(", ");
            return (
              <div
                key={item.month}
                className={styles.chartColumn}
                aria-label={`${item.label}: ${item.total} requests; ${breakdown}`}
                title={`${item.label}: ${item.total} requests\n${breakdown}`}
              >
                <span className={styles.chartTotal}>{item.total}</span>
                <div className={styles.chartBar} style={{ height }}>
                  {VOLUME_WORKFLOWS.map(({ workflow, color, pattern }) => {
                    const count = item.workflows[workflow];
                    return count > 0 ? (
                      <span
                        key={workflow}
                        className={styles.chartSegment}
                        style={{ backgroundColor: color, backgroundImage: pattern, height: `${(count / item.total) * 100}%` }}
                      />
                    ) : null;
                  })}
                </div>
                <span className={styles.chartMonth}>{month}</span>
                <span className={styles.chartYear}>{year}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RecordButton({ record, onSelectRecord, detail }: {
  record: QualityException["record"];
  onSelectRecord: (id: string) => void;
  detail?: string;
}) {
  return (
    <button type="button" onClick={() => onSelectRecord(record.id)} className={styles.recordButton}>
      <span className={styles.recordText}>
        <span className={styles.recordName}>{record.clientName}</span>
        <span className={styles.recordDetail}>{record.transferringContra || "No contra"}{detail ? ` · ${detail}` : ""}</span>
      </span>
      <ArrowRight size={14} className={styles.recordArrow} />
    </button>
  );
}

export function AcatTransferDashboard({ dashboard, interaction }: {
  dashboard: AcatDashboard;
  interaction?: DashboardInteraction;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(interaction?.tab ?? "overview");
  const [reviews, setReviews] = useState<Record<string, QualityReview>>({});
  const [reviewError, setReviewError] = useState(interaction?.reviewError ?? "");
  const [qualityFilter, setQualityFilter] = useState<QualityFilter>(interaction?.qualityFilter ?? "UNRESOLVED");
  const [qualityRuleFilter, setQualityRuleFilter] = useState("ALL");
  const [qualitySearch, setQualitySearch] = useState("");
  const [savingKey, setSavingKey] = useState("");
  const [openRecord, setOpenRecord] = useState<OpenRecord | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);

  const { summary, reconciliation: recon, flow, residuals } = dashboard;
  const withReviews = useMemo(
    () => dashboard.quality.exceptions.map((item) => {
      const saved = reviews[exceptionKey(item)];
      return saved ? { ...item, review: saved } : item;
    }),
    [dashboard.quality.exceptions, reviews],
  );
  const unresolvedCount = openExceptionCount(withReviews);
  const residualQueue = residuals.queue;
  const { statusFiltered, options: exceptionTypeOptions, effectiveRule, visible: visibleExceptions } = qualityView(
    withReviews,
    { status: qualityFilter, ruleKey: qualityRuleFilter, clientQuery: qualitySearch },
  );

  const selectRecord = async (id: string) => {
    setRecordError(null);
    const result = await openDashboardRecord(id);
    if (result.ok) setOpenRecord(result);
    else setRecordError(id);
  };

  const saveReview = async (item: QualityException, status: "IN_REVIEW" | "CLOSED", resolution?: Resolution, note?: string) => {
    const key = exceptionKey(item);
    setSavingKey(key);
    setReviewError("");
    try {
      const result = await reviewDashboardException({
        acatRecordId: item.record.id,
        ruleKey: item.ruleKey,
        fingerprint: item.fingerprint,
        status,
        resolution: resolution ?? null,
        note: note?.trim() || null,
      });
      const next = reviewAfterWrite(result);
      if (!result.ok) {
        setReviewError(next.reason ?? "Could not save review");
        return;
      }
      setReviews((current) => ({
        ...current,
        [key]: { ...result.review, reviewedBy: item.review?.reviewedBy ?? null, reviewedAt: item.review?.reviewedAt ?? null },
      }));
    } catch {
      setReviewError("Could not save review");
    } finally {
      setSavingKey("");
    }
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.headerRow}>
          <div>
            <h1 className={styles.title}>Transfer operations</h1>
            <p className={styles.subtitle}>Operational outcomes, cycle time, residual sweeps, and reconciliation coverage</p>
          </div>
          <p className={styles.updated} suppressHydrationWarning>Updated {formatDateMMDDYYYY(new Date())}</p>
        </div>
      </header>

      <div className={styles.body}>
        <div className={styles.inner}>
          {recordError && (
            <div role="alert" className={styles.errorBanner}>
              Could not open this transfer.{" "}
              <button type="button" className={styles.retry} onClick={() => selectRecord(recordError)}>Retry</button>
            </div>
          )}
          <div className={styles.statGrid}>
            <StatCard label="All transfers" value={summary.total} detail={`${summary.validFinalized} finalized · ${summary.Purged} purged`} />
            <StatCard label="Completed" value={summary.Completed} detail={`${pct(summary.completedRate)} of valid finalized`} tone="success" />
            <StatCard label="Rejected" value={summary.Rejected} detail={`${pct(summary.rejectionRate)} of valid finalized`} tone="danger" />
            <StatCard label="Active" value={summary.active} detail={`${summary.Canceled} canceled · ${pct(summary.canceledRate)}`} />
            <StatCard label="Data quality" value={unresolvedCount} detail="unresolved exception instances" tone={unresolvedCount ? "warning" : "success"} onClick={() => setTab("quality")} />
          </div>

          <nav className={styles.tabs} aria-label="Dashboard sections">
            {TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setTab(item.key)}
                className={`${styles.tab} ${tab === item.key ? styles.tabActive : styles.tabIdle}`}
              >
                {item.label}
                {item.key === "quality" && unresolvedCount > 0 ? ` (${unresolvedCount})` : ""}
                {item.key === "residuals" && residualQueue.length > 0 ? ` (${residualQueue.length})` : ""}
              </button>
            ))}
          </nav>

          {tab === "overview" && (
            <div className={styles.stack}>
              <Section title="Cycle time by transfer workflow" subtitle="Business-day medians; weekends and ACATS processing holidays are excluded" open>
                <div className={styles.scrollX}>
                  <table className={`${styles.table} ${styles.cycleTable}`}>
                    <thead className={styles.thead}>
                      <tr><th>Workflow</th><th>Client request → Apex</th><th>Apex → complete</th><th>Request → complete</th></tr>
                    </thead>
                    <tbody className={styles.tbody}>
                      {dashboard.workflowTimings.map((item) => (
                        <tr key={item.workflow}>
                          <td className={styles.cellStrong}>{WORKFLOW_LABELS[item.workflow]}</td>
                          {[item.requestToSubmit, item.submitToComplete, item.requestToComplete].map((metric, index) => (
                            <td key={index} className={styles.cellInk}><span className={styles.metric}>{days(metric.median)}</span><span className={styles.sample}>n={metric.sampleSize}</span></td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className={styles.footnote}>Use the median for the typical case; P75 and P90 are available in the underlying analytics and are used for monitoring thresholds.</p>
              </Section>

              <Section title="Transfer requests over time" subtitle="Monthly client-request volume since June 2025; residual movements are excluded from request totals">
                <MonthlyVolumeChart items={dashboard.monthlyVolume} />
                <details className={styles.monthly}>
                  <summary className={styles.monthlySummary}>View monthly data</summary>
                  <div className={styles.monthlyBody}>
                    <table className={`${styles.table} ${styles.monthlyTable}`}>
                      <thead className={styles.thead}><tr><th>Month</th><th>Requests</th><th>ACAT</th><th>Manual</th><th>DRS</th><th>Unclassified</th></tr></thead>
                      <tbody className={`${styles.tbody} ${styles.compactRows}`}>
                        {dashboard.monthlyVolume.map((item) => <tr key={item.month}><td className={styles.cellStrong}>{item.label}</td><td className={styles.cellBold}>{item.total}</td><td className={styles.num}>{item.workflows.ACAT}</td><td className={styles.num}>{item.workflows.MANUAL}</td><td className={styles.num}>{item.workflows.DRS}</td><td className={styles.num}>{item.workflows.UNCLASSIFIED}</td></tr>)}
                      </tbody>
                    </table>
                  </div>
                </details>
              </Section>

              <Section title="Direction and asset flow" subtitle="Completed transfer counts and statement values">
                <div className={styles.flowGrid}>
                  <FlowCard label="Incoming" icon={<ArrowDownLeft size={18} className={styles.tone_success} />} flow={flow.incoming} />
                  <FlowCard label="Outgoing" icon={<ArrowUpRight size={18} className={styles.tone_danger} />} flow={flow.outgoing} />
                  <div className={styles.flowCard}>
                    <CircleDollarSign size={18} className={styles.accent} />
                    <p className={styles.flowValue}>{formatCentsAsDollar(flow.netAmount)}</p>
                    <p className={styles.flowLabel}>Net completed flow</p>
                    <dl className={styles.flowList}>
                      <div className={styles.flowRow}><dt>Full / partial</dt><dd>{formatCentsAsDollar(flow.requestedNetAmount)}</dd></div>
                      <div className={styles.flowRow}><dt>Residual</dt><dd>{formatCentsAsDollar(flow.residualNetAmount)}</dd></div>
                    </dl>
                  </div>
                </div>
              </Section>

              <Section title="Top contras" subtitle="Workflow-specific contra performance; purged records are excluded">
                <div className={styles.explainer}>
                  <span className={styles.explainerTerm}>Completed</span> is the number completed. <span className={styles.explainerTerm}>Finalized transfers</span> counts completed, rejected, and canceled transfers; active and purged transfers are excluded. <span className={styles.explainerTerm}>Rejected %</span> is rejected transfers divided by finalized transfers. <span className={styles.explainerTerm}>Median submit → complete</span> measures business days from Ops Submission Date to Apex → Apex Completion Date for completed transfers with both dates; weekends and ACATS processing holidays are excluded.
                </div>
                <div className={styles.contraGrid}>
                  <ContraPanel title="Top ACAT / API contras" items={dashboard.topContras.acat} />
                  <ContraPanel title="Top Manual contras" items={dashboard.topContras.manual} />
                </div>
              </Section>
            </div>
          )}

          {tab === "residuals" && (
            <div className={styles.stack}>
              <Section title="Residual follow-up queue" subtitle="Completed transfers explicitly marked for monitoring with no linked residual after their follow-up date" open>
                {residualQueue.length === 0 ? <Empty>No monitored transfers currently need residual follow-up.</Empty> : <div className={styles.recordList}>{residualQueue.map((item) => <RecordButton key={item.record.id} record={item.record} onSelectRecord={selectRecord} detail={`${item.daysPastFollowUp}d past follow-up · ${formatDateMMDDYYYY(item.followUpDate)}`} />)}</div>}
              </Section>
              <Section title="Observed sweep timing by contra" subtitle="Original transfer completion → linked residual completion; benchmarks require associated control numbers">
                {residuals.benchmarks.length === 0 ? <Empty>No linked residual history is available yet.</Empty> : <div className={styles.sweepScroll}><table className={styles.table}><thead className={`${styles.thead} ${styles.stickyHead}`}><tr><th>Contra</th><th>Sample</th><th>Median</th><th>P75</th><th>P90</th></tr></thead><tbody className={styles.tbody}>{residuals.benchmarks.map((item) => <tr key={item.contra}><td className={styles.cellStrong}>{item.contra}</td><td>{item.sampleSize}</td><td>{days(item.medianDays)}</td><td>{days(item.p75Days)}</td><td>{days(item.p90Days)}</td></tr>)}</tbody></table></div>}
                <p className={styles.footnote}>The monitor uses a contra-specific P75 once there are at least 10 linked residuals; otherwise it falls back to the global history.</p>
              </Section>
            </div>
          )}

          {tab === "quality" && (
            <div className={styles.stack}>
              <Section title="What the queue checks" subtitle={`${dashboard.quality.rules.length} automated controls; multiple request methods are allowed`}>
                <div className={styles.ruleGrid}>
                  {dashboard.quality.rules.map((rule) => (
                    <div key={rule.ruleKey} className={styles.ruleCard}>
                      <h3 className={styles.ruleTitle}>{rule.title}</h3>
                      <p className={styles.ruleText}>{rule.description}</p>
                    </div>
                  ))}
                </div>
                <p className={styles.footnote}>Request Method records how the transfer was received; Transfer Workflow records how it was completed. Selecting more than one request method is valid and is not flagged.</p>
              </Section>
              <div className={styles.queueBar}>
                <div className={styles.queueTitle}><h2 className={styles.sectionTitle}>Exception queue</h2><p className={styles.queueText}>Closing an exception closes this rule instance only; the transfer record remains unchanged.</p></div>
                <div className={styles.queueControls}>
                  <label className={styles.searchField}>
                    <span className={styles.srOnly}>Search data quality by client</span>
                    <input
                      type="search"
                      value={qualitySearch}
                      onChange={(event) => setQualitySearch(event.target.value)}
                      placeholder="Search client name…"
                      aria-label="Search data quality by client"
                      className={styles.formInput}
                    />
                  </label>
                  <label className={styles.typeField}>
                    <span className={styles.srOnly}>Exception type</span>
                    <select
                      aria-label="Exception type"
                      value={effectiveRule}
                      onChange={(event) => setQualityRuleFilter(event.target.value)}
                      className={styles.formInput}
                    >
                      <option value="ALL">All exception types ({statusFiltered.length})</option>
                      {exceptionTypeOptions.map((item) => (
                        <option key={item.ruleKey} value={item.ruleKey}>
                          {item.title} ({item.count})
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className={styles.segmented}>{(["UNRESOLVED", "CLOSED", "ALL"] as const).map((filter) => <button key={filter} type="button" onClick={() => setQualityFilter(filter)} className={`${styles.segment} ${qualityFilter === filter ? styles.segmentActive : styles.segmentIdle}`}>{filter === "UNRESOLVED" ? "Open" : filter === "CLOSED" ? "Closed" : "All"}</button>)}</div>
                </div>
              </div>
              {reviewError && <div role="alert" className={styles.errorBanner}>{reviewError}</div>}
              {visibleExceptions.length === 0 ? <Empty>No exceptions in this view.</Empty> : <div aria-label="Exception results" className={styles.exceptionList}>{visibleExceptions.map((item) => {
                const key = exceptionKey(item);
                return <ExceptionCard key={key} item={item} saving={savingKey === key} onOpenRecord={selectRecord} onSave={saveReview} />;
              })}</div>}
            </div>
          )}

          {tab === "recon" && (
            <div className={styles.stack}>
              <div className={styles.reconGrid}>
                <StatCard label="Coverage" value={pct(recon.coverageRate)} detail={`${recon.tracked} of ${recon.eligible} eligible tracked`} />
                <StatCard label="Matched" value={recon.matched} detail={`Match rate ${pct(recon.matchRate)}`} tone="success" />
                <StatCard label="Needs review" value={recon.mismatch} detail={`${recon.pending} tracked and pending`} tone={recon.mismatch ? "warning" : "default"} />
                <StatCard label="Not tracked" value={recon.notTracked} detail="No recon evidence; not a mismatch" />
              </div>
              <Section title="How to read reconciliation" subtitle="Coverage and result quality are intentionally separate" open>
                <div className={styles.readGrid}>
                  <div className={styles.readCard}><Database size={18} className={styles.accent} /><h3 className={styles.readTitle}>Tracked</h3><p className={styles.readText}>A record has saved positions, an Apex upload, or a recon completion stamp.</p></div>
                  <div className={styles.readCard}><ShieldCheck size={18} className={styles.tone_success} /><h3 className={styles.readTitle}>Match rate</h3><p className={styles.readText}>Calculated only from tracked records with a matched or mismatch outcome.</p></div>
                  <div className={styles.readCard}><RefreshCw size={18} className={styles.muted} /><h3 className={styles.readTitle}>Not tracked</h3><p className={styles.readText}>Historical records without recon data stay neutral and never lower the match rate.</p></div>
                </div>
              </Section>
            </div>
          )}
        </div>
      </div>

      {openRecord && (openRecord.editsEnabled ? (
        <AcatUnlinkedDrawer
          row={openRecord.row}
          transferId={openRecord.transferId}
          editor={<AcatRecordEditor key={openRecord.row.id} row={openRecord.row} dayToDay={openRecord.dayToDay}
            onSaved={(row) => { setOpenRecord({ ...openRecord, row }); router.refresh(); }} />}
          onLinked={(transferId) => setOpenRecord({ ...openRecord, transferId })}
          onUnlinked={() => setOpenRecord({ ...openRecord, transferId: null })}
          onClose={() => setOpenRecord(null)}
        />
      ) : (
        <AcatUnlinkedDrawer
          row={openRecord.row}
          transferId={openRecord.transferId}
          readOnly
          dayToDayText={openRecord.dayToDay ? {
            notes: openRecord.row.notes ?? "",
            tradeInstructions: openRecord.row.tradeInstructions ?? "",
            loadError: openRecord.row.textLoadError,
          } : null}
          onClose={() => setOpenRecord(null)}
          onUnlinked={() => setOpenRecord(null)}
        />
      ))}
    </div>
  );
}

function FlowCard({ label, icon, flow }: { label: "Incoming" | "Outgoing"; icon: ReactNode; flow: FlowSplit }) {
  return (
    <div className={styles.flowCard}>
      {icon}
      <p className={styles.flowValue}>{flow.totalCount}</p>
      <p className={styles.flowLabel}>{label} total · {formatCentsAsDollar(flow.totalAmount)}</p>
      <dl className={styles.flowList}>
        <div className={styles.flowRow}>
          <dt>Full / partial</dt>
          <dd>{flow.requestedCount} · {formatCentsAsDollar(flow.requestedAmount)}</dd>
        </div>
        <div className={styles.flowRow}>
          <dt>Residual</dt>
          <dd>{flow.residualCount} · {formatCentsAsDollar(flow.residualAmount)}</dd>
        </div>
      </dl>
    </div>
  );
}

function ContraPanel({ title, items }: { title: string; items: ContraPerformance[] }) {
  return (
    <div className={styles.contraPanel}>
      <h3 className={styles.contraTitle}>{title}</h3>
      {items.length === 0 ? (
        <p className={styles.contraEmpty}>No completed or finalized transfers in this workflow.</p>
      ) : (
        <div className={styles.contraScroll}>
          <table className={`${styles.table} ${styles.contraTable}`}>
            <colgroup><col style={{ width: "22%" }} /><col style={{ width: "12%" }} /><col style={{ width: "12%" }} /><col style={{ width: "16%" }} /><col style={{ width: "18%" }} /><col style={{ width: "20%" }} /></colgroup>
            <thead className={`${styles.thead} ${styles.contraHead}`}>
              <tr><th>Contra</th><th>Completed</th><th>Finalized transfers</th><th>Rejected %</th><th>Median submit → complete</th><th>Completed assets</th></tr>
            </thead>
            <tbody className={`${styles.tbody} ${styles.contraBody}`}>
              {items.slice(0, 5).map((item) => <tr key={item.contra}><td className={styles.cellStrong}>{item.contra}</td><td className={styles.num}>{item.completed}</td><td className={styles.num}>{item.finalized}</td><td className={styles.num}>{pct(item.rejectionRate)}</td><td className={styles.num}>{days(item.medianApexDays)}</td><td className={styles.num}>{formatCentsAsDollar(item.completedAmount)}</td></tr>)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ExceptionCard({
  item,
  saving,
  onOpenRecord,
  onSave,
}: {
  item: QualityException;
  saving: boolean;
  onOpenRecord: (id: string) => void;
  onSave: (item: QualityException, status: "IN_REVIEW" | "CLOSED", resolution?: Resolution, note?: string) => Promise<void>;
}) {
  const review = item.review;
  const stored = review?.resolution && review.resolution in RESOLUTION_LABELS ? review.resolution as Resolution : null;
  const [resolution, setResolution] = useState<Resolution>(stored ?? "CORRECTED");
  const [note, setNote] = useState(review?.note ?? "");
  const closed = review?.status === "CLOSED";
  const noteRequired = resolution === "FALSE_POSITIVE" || resolution === "ACKNOWLEDGED_UNRESOLVED";
  return (
    <div className={styles.exceptionCard}>
      <div className={styles.exceptionHead}>
        <div className={styles.exceptionMain}>
          {item.severity === "high" ? <TriangleAlert size={18} className={`${styles.severityIcon} ${styles.tone_danger}`} /> : item.severity === "medium" ? <ChartColumn size={18} className={`${styles.severityIcon} ${styles.tone_warning}`} /> : <CircleCheck size={18} className={`${styles.severityIcon} ${styles.muted}`} />}
          <div className={styles.exceptionText}><div className={styles.exceptionTitleRow}><h3 className={styles.sectionTitle}>{item.title}</h3>{closed && <span className={styles.closedPill}>Closed</span>}</div><p className={styles.exceptionDetail}>{item.record.clientName} · {item.detail}</p></div>
        </div>
        <button type="button" onClick={() => onOpenRecord(item.record.id)} className={styles.fixLink}>
          Fix in transfer <ArrowRight size={12} />
        </button>
      </div>
      {!closed && (
        <div className={styles.exceptionForm}>
          <select value={resolution} onChange={(event) => setResolution(event.target.value as Resolution)} className={styles.formInput}>{Object.entries(RESOLUTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <input value={note} onChange={(event) => setNote(event.target.value)} placeholder={noteRequired ? "Note required" : "Optional note"} className={styles.formInput} />
          <button type="button" disabled={saving} onClick={() => onSave(item, "IN_REVIEW", undefined, note)} className={styles.secondaryButton}>Mark in review</button>
          <button type="button" disabled={saving || (noteRequired && !note.trim())} onClick={() => onSave(item, "CLOSED", resolution, note)} className={styles.primaryButton}>Close exception</button>
        </div>
      )}
      {closed && <p className={styles.closedNote}>{stored ? RESOLUTION_LABELS[stored] : "Closed"}{review?.note ? ` · ${review.note}` : ""}</p>}
    </div>
  );
}
