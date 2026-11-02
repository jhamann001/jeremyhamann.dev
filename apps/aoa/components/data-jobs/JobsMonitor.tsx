"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Pill, StatTile, SummaryGrid } from "@/components/ui";
import type { JobFilter, JobHistoryResponse, JobListResponse, JobStatus, JobSummary } from "@/lib/data-jobs/contracts";
import { applicationAttention } from "@/lib/data-jobs/application-attention";
import { JobCard } from "./JobCard";
import { fetchJobMetadata, fetchMetadataPages, JobMetadataAccessError } from "./requests";
import { historyUrl, JOB_FILTERS, jobTimestamp, listUrl, uniqueById } from "./presentation";
import styles from "./jobs.module.css";

const MAX_LIST_PAGES = 5;
const MAX_HISTORY_PAGES = 3;

function ObservedJob({ job, expanded, onToggle, revision, onAccessDenied }: { job: JobSummary; expanded: boolean; onToggle: () => void; revision: string; onAccessDenied: () => void }) {
  const [history, setHistory] = useState<JobHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const pagesWanted = useRef(1);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async (cursor: string | null = null) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      if (cursor) {
        const page = await fetchJobMetadata<JobHistoryResponse>(historyUrl(job.definition.id, cursor), controller.signal);
        if (controller.signal.aborted) return;
        setError(false);
        pagesWanted.current = Math.min(MAX_HISTORY_PAGES, pagesWanted.current + 1);
        setHistory((current) => ({ ...page, runs: uniqueById([...(current?.runs ?? []), ...page.runs], (run) => run.id) }));
      } else {
        const pages = await fetchMetadataPages<JobHistoryResponse>((next) => historyUrl(job.definition.id, next), pagesWanted.current, controller.signal);
        if (controller.signal.aborted) return;
        setError(false);
        pagesWanted.current = pages.length;
        setHistory({ runs: uniqueById(pages.flatMap((page) => page.runs), (run) => run.id), nextCursor: pages.at(-1)?.nextCursor ?? null });
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (failure instanceof JobMetadataAccessError) { setHistory(null); onAccessDenied(); }
        else setError(true);
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [job.definition.id, onAccessDenied]);

  useEffect(() => {
    if (expanded && document.visibilityState === "visible") void load();
    return () => request.current?.abort();
  }, [expanded, revision, load]);

  return <JobCard job={job} expanded={expanded} onToggle={onToggle} history={{ data: history, loading, error, limited: pagesWanted.current >= MAX_HISTORY_PAGES && !!history?.nextCursor }} onRetryHistory={() => void load()} onMoreHistory={() => { if (history?.nextCursor && pagesWanted.current < MAX_HISTORY_PAGES) void load(history.nextCursor); }} />;
}

export function JobsMonitor() {
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<JobFilter>("");
  const [pages, setPages] = useState<JobListResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const request = useRef<AbortController | null>(null);
  const pagesWanted = useRef(1);

  const clearDeniedMetadata = useCallback(() => {
    request.current?.abort();
    pagesWanted.current = 1;
    setPages([]);
    setExpanded(new Set());
    setError(true);
    setLoading(false);
  }, []);

  const load = useCallback(async (cursor: string | null = null) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      if (cursor) {
        const page = await fetchJobMetadata<JobListResponse>(listUrl(query, status, cursor), controller.signal);
        if (controller.signal.aborted) return;
        setError(false);
        pagesWanted.current = Math.min(MAX_LIST_PAGES, pagesWanted.current + 1);
        setPages((current) => [...current, page]);
      } else {
        const nextPages = await fetchMetadataPages<JobListResponse>((next) => listUrl(query, status, next), pagesWanted.current, controller.signal);
        if (controller.signal.aborted) return;
        setError(false);
        pagesWanted.current = nextPages.length;
        setPages(nextPages);
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (failure instanceof JobMetadataAccessError) clearDeniedMetadata();
        else setError(true);
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [query, status, clearDeniedMetadata]);

  useEffect(() => {
    pagesWanted.current = 1;
    setPages([]);
    const refreshVisible = () => { if (document.visibilityState === "visible") void load(); };
    refreshVisible();
    const timer = window.setInterval(refreshVisible, 30_000);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      request.current?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [load]);

  const data = pages[0];
  const jobs = uniqueById(pages.flatMap((page) => page.jobs), (job) => job.definition.id);
  const nextCursor = pages.at(-1)?.nextCursor;
  const count = (statuses: JobStatus[]) => jobs.filter((job) => statuses.includes(job.status)).length;

  return <div className={styles.monitor}>
    <div className={styles.notice}>
      <Pill tone="gray">Slack alerts disabled</Pill>
      <p>Live monitoring metadata, not client records. Slack routing and delivery have not been activated. Source freshness is tracked separately from execution health.</p>
    </div>
    <form className={styles.filters} onSubmit={(event) => { event.preventDefault(); setQuery(queryInput.trim()); }}>
      <div className={styles.searchField}><label htmlFor="data-job-search">Find a source or job</label><input id="data-job-search" type="search" value={queryInput} onChange={(event) => setQueryInput(event.target.value)} maxLength={100} placeholder="Search sources and jobs" /></div>
      <div className={styles.statusField}><label htmlFor="data-job-status">Execution health</label><select id="data-job-status" value={status} onChange={(event) => setStatus(event.target.value as JobFilter)}>{JOB_FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
      <Button type="submit" variant="ghost">Search</Button>
      <Button onClick={() => void load()} disabled={loading} variant="ghost">{loading && data ? "Refreshing…" : "Refresh"}</Button>
    </form>
    {error && <div className={styles.error} role="alert"><h2>Job monitoring is temporarily unavailable</h2><p>{data ? "Previously loaded observations are shown; they may no longer represent current job health." : "The monitoring registry could not be read. No job was started and no data was changed."}</p><Button onClick={() => void load()} disabled={loading} size="sm">Try again</Button></div>}
    {!data && loading && <div className={styles.empty} role="status"><h2>Loading job observations…</h2><p>Reading the monitoring registry. Workflows are not run by this page.</p></div>}
    {data && <>
      <SummaryGrid>
        <StatTile label="Matching jobs" value={data.total} />
        <StatTile label="Needs attention · shown" value={jobs.filter((job) => ["FAILED", "OVERDUE", "STALLED"].includes(job.status) || applicationAttention(job, new Date())).length} />
        <StatTile label="Running · shown" value={count(["RUNNING"])} />
        <StatTile label="Unknown · shown" value={count(["UNKNOWN"])} />
      </SummaryGrid>
      {data.collector.stale && <div className={styles.monitoringWarning} role="status"><b>Monitoring is stale or has not started.</b> Last completed collection: {jobTimestamp(data.collector.lastCompletedAt)}. A job can fail while monitoring is unavailable; an external watchdog is not activated by this page.</div>}
      <div className={styles.listHeader}><p>{jobs.length} of {data.total} matching jobs · attention first</p><p>Registry read {jobTimestamp(data.generatedAt)} · refreshes every 30 seconds while visible</p></div>
      {jobs.length === 0 && <div className={styles.empty}><h2>{query || status ? "No jobs match these filters" : "No jobs are registered for this environment"}</h2><p>{query || status ? "Try a different source name or select all statuses." : "An empty registry is not evidence that every data source is monitored."}</p>{(query || status) && <Button variant="ghost" onClick={() => { setQueryInput(""); setQuery(""); setStatus(""); }}>Clear filters</Button>}</div>}
      <div className={styles.jobList}>{jobs.map((job) => <ObservedJob key={job.definition.id} job={job} expanded={expanded.has(job.definition.id)} revision={data.generatedAt} onAccessDenied={clearDeniedMetadata} onToggle={() => setExpanded((current) => { const next = new Set(current); if (next.has(job.definition.id)) next.delete(job.definition.id); else next.add(job.definition.id); return next; })} />)}</div>
      {nextCursor && pages.length < MAX_LIST_PAGES && <Button className={styles.moreJobs} variant="ghost" onClick={() => void load(nextCursor)} disabled={loading}>Load more jobs</Button>}
      {nextCursor && pages.length >= MAX_LIST_PAGES && <p className={styles.muted}>Showing up to 100 matching jobs. Narrow the search or status filter to see a smaller set.</p>}
    </>}
    <details className={styles.help}>
      <summary>What these statuses do—and do not—tell you</summary>
      <p><b>Execution health</b> reflects observed provider activity. <b>Source freshness</b> answers whether the data itself is current. <b>Monitoring freshness</b> answers whether our observations are current. These are separate checks.</p>
      <p>Provider success is not proof of an AOA commit. Cloud Scheduler delivery acknowledgement confirms delivery only. Unknown, partial, and missing run evidence are never counted as successful imports. Retries are linked only when provider evidence supports that link.</p>
      <p>Run dates are shown in Eastern time; next-run dates use the job’s reported timezone. Calculated expectations are labeled. Manual, event-driven, paused, or unknown schedules do not get an invented next run.</p>
    </details>
  </div>;
}
