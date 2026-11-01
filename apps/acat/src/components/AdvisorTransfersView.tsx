"use client";

import { useMemo, useState } from "react";
import { ACAT_STATUS_LABELS, TERMINAL_STATUSES } from "@/lib/types";
import { formatCentsExact, formatDateMMDDYYYY } from "@/lib/format";
import type { AdvisorAcatRecord } from "@/lib/advisor-redaction";
import { ChevronDown, ChevronRight, Loader2, Search } from "lucide-react";

// ticket: Advisor read-only transfers view.
//
// Deliberately NOT a reuse of `RecordsView` — that component is wired
// to mutating actions (open detail drawer, edit, recon flows) and a
// much wider column set. The advisor surface is a separate, narrower
// table that only renders what `redactForAdvisor` returns, so there's
// no way for an ops-only field to sneak back in through a shared
// component.

type FilterMode = "active" | "all" | "completed";

interface AdvisorTransfersViewProps {
  acats: AdvisorAcatRecord[];
  loading: boolean;
  error: string | null;
  lastRefreshedAt: number | null;
}

export default function AdvisorTransfersView({
  acats,
  loading,
  error,
  lastRefreshedAt,
}: AdvisorTransfersViewProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterMode>("active");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return acats
      .filter((a) => {
        if (filter === "active") return !TERMINAL_STATUSES.has(a.status);
        if (filter === "completed") return TERMINAL_STATUSES.has(a.status);
        return true;
      })
      .filter((a) => {
        if (!q) return true;
        return (
          a.clientName.toLowerCase().includes(q) ||
          (a.transferringContra?.toLowerCase().includes(q) ?? false) ||
          (a.wealthAdvisor?.toLowerCase().includes(q) ?? false)
        );
      })
      .sort((a, b) => {
        const at = new Date(a.acatDate).getTime();
        const bt = new Date(b.acatDate).getTime();
        return bt - at;
      });
  }, [acats, filter, query]);

  const summary = useMemo(() => {
    let active = 0;
    let completed = 0;
    for (const a of acats) {
      if (TERMINAL_STATUSES.has(a.status)) completed++;
      else active++;
    }
    return { active, completed, total: acats.length };
  }, [acats]);

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex flex-col gap-3 border-b border-card-border px-6 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-foreground">
              Client Transfers
            </h1>
            <p className="mt-1 text-xs text-muted">
              Read-only view of ACAT transfers. Account numbers, fees, and
              internal notes aren&rsquo;t shown.
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span>
              <strong className="text-foreground">{summary.active}</strong>{" "}
              active
            </span>
            <span>·</span>
            <span>
              <strong className="text-foreground">{summary.completed}</strong>{" "}
              completed
            </span>
            {lastRefreshedAt && (
              <>
                <span>·</span>
                <span title={formatDateMMDDYYYY(new Date(lastRefreshedAt))}>
                  refreshed {timeAgo(lastRefreshedAt)}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-faint"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by client, contra, or advisor"
              className="w-full rounded-md border border-card-border bg-[var(--bg-card)] py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            />
          </div>
          <div className="inline-flex rounded-md border border-card-border bg-[var(--bg-card)] p-0.5 text-xs">
            <FilterPill
              label="Active"
              active={filter === "active"}
              onClick={() => setFilter("active")}
            />
            <FilterPill
              label="Completed"
              active={filter === "completed"}
              onClick={() => setFilter("completed")}
            />
            <FilterPill
              label="All"
              active={filter === "all"}
              onClick={() => setFilter("all")}
            />
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-auto">
        {error && (
          <div className="m-6 rounded-md border border-[color:var(--danger)]/30 bg-[color:var(--danger)]/10 px-4 py-3 text-sm text-[color:var(--danger)]">
            Couldn&rsquo;t load transfers: {error}
          </div>
        )}

        {loading && acats.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="flex items-center gap-2 text-sm text-muted">
              <Loader2 size={14} className="animate-spin text-accent" />
              Loading transfers…
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            isFilteredQuery={Boolean(query) || filter !== "all"}
          />
        ) : (
          <ul className="divide-y divide-card-border">
            {filtered.map((acat) => (
              <TransferRow key={acat.id} acat={acat} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function FilterPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-3 py-1 transition ${
        active
          ? "bg-[var(--invert-bg)] text-[var(--invert-text)] shadow-sm"
          : "text-muted hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}

function TransferRow({ acat }: { acat: AdvisorAcatRecord }) {
  const [expanded, setExpanded] = useState(false);
  const statusLabel = ACAT_STATUS_LABELS[acat.status] ?? acat.status;
  const isTerminal = TERMINAL_STATUSES.has(acat.status);
  const expectedValue =
    typeof acat.statementAmount === "number"
      ? formatCentsExact(acat.statementAmount)
      : "—";

  return (
    <li>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-4 px-6 py-3 text-left transition hover:bg-[var(--bg-card)]/40"
      >
        <span className="text-muted-faint">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="flex-1 truncate font-medium text-foreground">
          {acat.clientName}
        </span>
        <span className="hidden sm:block w-40 truncate text-sm text-muted">
          {acat.transferringContra ?? "—"}
        </span>
        <span className="hidden w-32 truncate text-sm text-muted lg:block">
          {acat.direction ?? "—"}
          {acat.type ? ` · ${acat.type}` : ""}
        </span>
        <span className="hidden w-24 text-right text-sm tabular-nums text-muted sm:block">
          {expectedValue}
        </span>
        <StatusBadge label={statusLabel} terminal={isTerminal} />
      </button>
      {expanded && <TransferDetail acat={acat} />}
    </li>
  );
}

function TransferDetail({ acat }: { acat: AdvisorAcatRecord }) {
  return (
    <div className="border-t border-card-border bg-[var(--bg-card)]/30 px-6 py-4">
      <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <DetailField label="Client" value={acat.clientName} />
        <DetailField
          label="Transferring contra"
          value={acat.transferringContra}
        />
        <DetailField label="Wealth advisor" value={acat.wealthAdvisor} />
        <DetailField label="Direction" value={acat.direction} />
        <DetailField label="Type" value={acat.type} />
        <DetailField label="Account type" value={acat.accountType} />
        <DetailField
          label="Original client request"
          value={formatDateMMDDYYYY(acat.originalClientRequestDate) || null}
        />
        <DetailField
          label="Submitted to Apex"
          value={formatDateMMDDYYYY(acat.opsSubmissionDateToApex) || null}
        />
        <DetailField
          label="Apex completion"
          value={formatDateMMDDYYYY(acat.apexCompletionDate) || "—"}
        />
        <DetailField
          label="Expected value"
          value={
            typeof acat.statementAmount === "number"
              ? formatCentsExact(acat.statementAmount)
              : null
          }
        />
        {acat.custodian && (
          <DetailField
            label="Custodian SLA"
            value={`${acat.custodian.name} · ~${acat.custodian.avgProcessingDays} business days`}
          />
        )}
        {acat.additionalResources && (
          <AdditionalResourcesField value={acat.additionalResources} />
        )}
      </dl>
    </div>
  );
}

// Renders the free-text "additional resources" field. By convention
// ops puts a CRM task URL here, but the field is free-form, so
// detect the bare-URL case and render an anchor; otherwise fall back
// to plain text so we don't accidentally linkify garbage.
function AdditionalResourcesField({ value }: { value: string }) {
  const trimmed = value.trim();
  const isBareUrl = /^https?:\/\/\S+$/.test(trimmed);
  return (
    <div className="flex flex-col">
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-faint">
        Additional resources
      </dt>
      <dd className="text-foreground">
        {isBareUrl ? (
          <a
            href={trimmed}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline-offset-2 hover:underline"
          >
            Open Crm task
          </a>
        ) : (
          trimmed
        )}
      </dd>
    </div>
  );
}

function DetailField({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div className="flex flex-col">
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-faint">
        {label}
      </dt>
      <dd className="text-foreground">{value || "—"}</dd>
    </div>
  );
}

function StatusBadge({ label, terminal }: { label: string; terminal: boolean }) {
  return (
    <span
      className={`inline-block w-32 shrink-0 truncate rounded-full border px-2 py-0.5 text-center text-[11px] font-medium sm:w-40 ${
        terminal
          ? "border-card-border bg-[var(--bg-card)] text-muted"
          : "border-accent/30 bg-accent/10 text-accent"
      }`}
      title={label}
    >
      {label}
    </span>
  );
}

function EmptyState({ isFilteredQuery }: { isFilteredQuery: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <p className="text-sm text-foreground">
        {isFilteredQuery ? "No transfers match your filters." : "No transfers yet."}
      </p>
      <p className="text-xs text-muted">
        {isFilteredQuery
          ? "Try a different search or switch the status filter."
          : "Once a client transfer is opened it will appear here."}
      </p>
    </div>
  );
}

function timeAgo(ts: number): string {
  const delta = Math.max(0, Date.now() - ts);
  const seconds = Math.round(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}
