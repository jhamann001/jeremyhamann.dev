"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  loadTradeReconciliationHistory,
  saveTradeReconciliationBulkReview,
  saveTradeReconciliationNote,
  saveTradeReconciliationReview,
} from "@/app/(authenticated)/operations/trade-reconciliation/actions";
import { Button, Card, CardBody, Pill, StatTile, Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import {
  BREAK_CLASSIFICATIONS,
  MAX_TRADE_RECONCILIATION_BULK_REVIEW_ROWS,
  comparisonBasisFor,
  comparisonValuesFor,
  formatMatchRate,
  summarizeReconciliation,
  type BreakClassification,
  type ReconciliationResult,
  type ReconciliationRow,
} from "@/lib/operations/trade-reconciliation";
import type { ReconciliationHistoryRow, TradeReconciliationRunSummary } from "@/lib/data/trade-reconciliation";
import styles from "./TradeReconciliationPrototype.module.css";
import { ReconciliationHistoryWorkspace } from "./ReconciliationHistoryWorkspace";
import { reconciliationHref, reconciliationNavigation, type ReconciliationNavigation } from "@/lib/operations/reconciliation-history-query";
import { getBrowserListNavigationMemory } from "@/lib/navigation/list-memory";
import { getHouseholdHistoryReturnTarget, prepareListHistoryReturn } from "@/lib/navigation/history-entry";

type CurrentView = "summary" | "breaks" | "detail" | "aggregated";
type HistoryView = "daily" | "monthly" | "quarterly";
type BreakFilter = "all" | "unresolved" | "explained";
type DetailColumn =
  | "account"
  | "assetType"
  | "symbol"
  | "side"
  | "matchMethod"
  | "matchBasis"
  | "apexComparedValue"
  | "meridianComparedValue"
  | "difference"
  | "apexQuantity"
  | "meridianQuantity"
  | "apexNetAmount"
  | "apexGrossAmount"
  | "meridianNotionalAmount"
  | "Fjfmsx4vPLxctbBz"
  | "meridianOrderId"
  | "apexActivityId"
  | "meridianBasketId"
  | "meridianClientBasketId"
  | "apexTimestamp"
  | "meridianTimestamp"
  | "notes"
  | "result";

const CURRENT_VIEWS: Array<{ id: CurrentView; label: string }> = [
  { id: "summary", label: "Summary" },
  { id: "breaks", label: "Breaks" },
  { id: "detail", label: "Detail" },
  { id: "aggregated", label: "Aggregated" },
];

const HISTORY_VIEWS: Array<{ id: HistoryView; label: string }> = [
  { id: "daily", label: "Daily" },
  { id: "monthly", label: "Monthly" },
  { id: "quarterly", label: "Quarterly" },
];

const DETAIL_COLUMNS: Array<{ id: DetailColumn; label: string }> = [
  { id: "account", label: "Account" },
  { id: "assetType", label: "Asset type" },
  { id: "symbol", label: "Symbol" },
  { id: "side", label: "Side" },
  { id: "matchMethod", label: "Match method" },
  { id: "matchBasis", label: "Compared as" },
  { id: "apexComparedValue", label: "Apex compared value" },
  { id: "meridianComparedValue", label: "Meridian compared value" },
  { id: "difference", label: "Difference" },
  { id: "apexQuantity", label: "Apex quantity" },
  { id: "meridianQuantity", label: "Meridian quantity" },
  { id: "apexNetAmount", label: "Apex net amount" },
  { id: "apexGrossAmount", label: "Apex gross amount" },
  { id: "meridianNotionalAmount", label: "Meridian notional" },
  { id: "Fjfmsx4vPLxctbBz", label: "Apex order ID" },
  { id: "meridianOrderId", label: "Meridian order ID" },
  { id: "apexActivityId", label: "Apex activity ID" },
  { id: "meridianBasketId", label: "Meridian basket ID" },
  { id: "meridianClientBasketId", label: "Meridian client basket ID" },
  { id: "apexTimestamp", label: "Apex timestamp" },
  { id: "meridianTimestamp", label: "Meridian timestamp" },
  { id: "notes", label: "Notes" },
  { id: "result", label: "Result" },
];

const DEFAULT_DETAIL_COLUMNS: DetailColumn[] = [
  "account",
  "assetType",
  "symbol",
  "side",
  "matchMethod",
  "matchBasis",
  "apexComparedValue",
  "meridianComparedValue",
  "difference",
  "notes",
  "result",
];

const SUMMARY_DETAIL_COLUMNS: DetailColumn[] = [
  "account",
  "symbol",
  "side",
  "matchBasis",
  "apexComparedValue",
  "meridianComparedValue",
  "difference",
  "notes",
  "result",
];

function resultLabel(result: ReconciliationResult): string {
  if (result === "QUANTITY_BREAK") return "Quantity break";
  if (result === "DOLLAR_BREAK") return "Dollar break";
  if (result === "APEX_ONLY") return "Apex only";
  if (result === "MERIDIAN_ONLY") return "Meridian only";
  return "Matched";
}

function resultTone(result: ReconciliationResult): "green" | "amber" | "red" {
  if (result === "MATCHED") return "green";
  if (result === "QUANTITY_BREAK" || result === "DOLLAR_BREAK") return "red";
  return "amber";
}

function Quantity({ value }: { value: number | null }) {
  return <>{value === null ? <span className={styles.missing}>—</span> : value.toLocaleString(undefined, { maximumFractionDigits: 4 })}</>;
}

function Money({ value }: { value: number | null }) {
  return <>{value === null ? <span className={styles.missing}>—</span> : value.toLocaleString(undefined, { style: "currency", currency: "USD" })}</>;
}

function matchMethodLabel(row: ReconciliationRow): string {
  if (row.matchMethod === "ORDER_ID") return "Order ID";
  if (row.matchMethod === "ACCOUNT_SYMBOL_SIDE_VALUE") return "Account + symbol + side + value";
  return "No match";
}

function ComparedValue({ row, source }: { row: ReconciliationRow; source: "apex" | "meridian" }) {
  const basis = comparisonBasisFor(row);
  const value = comparisonValuesFor(row)[source];
  return basis === "DOLLARS" ? <Money value={value} /> : <Quantity value={value} />;
}

function BreakNote({ row }: { row: ReconciliationRow }) {
  const explanation = row.explanation?.trim();
  if (!explanation) return <span className={styles.missing}>—</span>;

  return (
    <span className={styles.breakNote}>
      {row.classification && <b>{row.classification}</b>}
      <span>{explanation}</span>
    </span>
  );
}

function detailCell(row: ReconciliationRow, column: DetailColumn) {
  const comparison = comparisonValuesFor(row);
  switch (column) {
    case "account": return <span className={styles.mono}>{row.account}</span>;
    case "assetType": return row.assetType.replaceAll("_", " ");
    case "symbol": return <b>{row.symbol}</b>;
    case "side": return row.side;
    case "matchMethod": return matchMethodLabel(row);
    case "matchBasis": return comparisonBasisFor(row) === "DOLLARS" ? "Dollars" : "Shares";
    case "apexComparedValue": return <ComparedValue row={row} source="apex" />;
    case "meridianComparedValue": return <ComparedValue row={row} source="meridian" />;
    case "difference": return comparisonBasisFor(row) === "DOLLARS"
      ? <Money value={comparison.difference} />
      : <Quantity value={comparison.difference} />;
    case "apexQuantity": return <Quantity value={row.apexQuantity} />;
    case "meridianQuantity": return <Quantity value={row.meridianQuantity} />;
    case "apexNetAmount": return <Money value={row.apexNetAmount} />;
    case "apexGrossAmount": return <Money value={row.apexGrossAmount} />;
    case "meridianNotionalAmount": return <Money value={row.meridianNotionalAmount} />;
    case "Fjfmsx4vPLxctbBz": return <span className={styles.mono}>{row.Fjfmsx4vPLxctbBz ?? "—"}</span>;
    case "meridianOrderId": return <span className={styles.mono}>{row.meridianOrderId ?? "—"}</span>;
    case "apexActivityId": return <span className={styles.mono}>{row.apexActivityId ?? "—"}</span>;
    case "meridianBasketId": return <span className={styles.mono}>{row.meridianBasketId ?? "—"}</span>;
    case "meridianClientBasketId": return <span className={styles.mono}>{row.meridianClientBasketId ?? "—"}</span>;
    case "apexTimestamp": return row.apexTimestamp ?? "—";
    case "meridianTimestamp": return row.meridianTimestamp ?? "—";
    case "notes": return <BreakNote row={row} />;
    case "result": return <Pill tone={resultTone(row.result)}>{resultLabel(row.result)}</Pill>;
  }
}

function DetailTable({
  rows,
  columns = DEFAULT_DETAIL_COLUMNS,
}: {
  rows: ReconciliationRow[];
  columns?: DetailColumn[];
}) {
  return (
    <div className={styles.tableWrap}>
      <Table>
        <THead>
          <TR>
            {columns.map((column) => <TH key={column}>{DETAIL_COLUMNS.find((item) => item.id === column)?.label}</TH>)}
          </TR>
        </THead>
        <TBody>
          {rows.map((row) => (
            <TR key={row.id}>
              {columns.map((column) => <TD key={column}>{detailCell(row, column)}</TD>)}
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

type ReconciliationHistory = Record<HistoryView, ReconciliationHistoryRow[]>;

function historyDate(value?: string): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    dateStyle: "medium",
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function historyTimestamp(value?: string): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function HistoryTable({ view, history }: { view: HistoryView; history: ReconciliationHistory }) {
  return (
    <div className={styles.tableWrap}>
      <Table>
        <THead>
          <TR>
            {view === "daily"
              ? <><TH>Run date</TH><TH>Trade date</TH><TH>Completed at</TH></>
              : <TH>Period</TH>}
            <TH>Raw matches</TH><TH>Explained</TH><TH>Unresolved</TH><TH>Meridian match rate</TH>
          </TR>
        </THead>
        <TBody>
          {history[view].map((row) => (
            <TR key={`${row.period}:${row.runId ?? "rollup"}`}>
              {view === "daily"
                ? <>
                    <TD><b>{row.runId
                      ? <Link href={`/operations/trade-reconciliation?run=${encodeURIComponent(row.runId)}`}>{historyDate(row.runDate ?? row.period)} →</Link>
                      : historyDate(row.runDate ?? row.period)}</b></TD>
                    <TD>{historyDate(row.tradeDate)}</TD>
                    <TD>{historyTimestamp(row.completedAt)}</TD>
                  </>
                : <TD><b>{row.period}</b></TD>}
              <TD>{row.matched}</TD><TD>{row.explained}</TD><TD>{row.unresolved}</TD><TD>{row.rate}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

export function TradeReconciliationPrototype({
  initialRows = [],
  initialHistory = { daily: [], monthly: [], quarterly: [] },
  initialRunNote = "",
  historyInitiallyLoaded = true,
  liveRunId = null,
  currentRunAvailable = false,
  historyIsSynthetic = false,
  initialSummary = null,
  navigationScope,
  initialNavigation = { tab: "current", history: "daily" },
}: {
  initialRows?: ReconciliationRow[];
  initialHistory?: ReconciliationHistory;
  initialRunNote?: string;
  historyInitiallyLoaded?: boolean;
  liveRunId?: string | null;
  currentRunAvailable?: boolean;
  historyIsSynthetic?: boolean;
  initialSummary?: TradeReconciliationRunSummary | null;
  navigationScope?: string;
  initialNavigation?: ReconciliationNavigation;
}) {
  const [mode, setMode] = useState<"current" | "history">(initialNavigation.tab);
  const [history, setHistory] = useState(initialHistory);
  const [historyLoaded, setHistoryLoaded] = useState(historyInitiallyLoaded);
  const [historyError, setHistoryError] = useState(false);
  const [historyLoading, startHistoryLoading] = useTransition();
  const [currentView, setCurrentView] = useState<CurrentView>("summary");
  const [historyView, setHistoryView] = useState<HistoryView>(initialNavigation.history);
  const [historyHref, setHistoryHref] = useState(reconciliationHref({ ...initialNavigation, tab: "history" }));
  const [breakFilter, setBreakFilter] = useState<BreakFilter>("unresolved");
  const [query, setQuery] = useState("");
  const [detailColumns, setDetailColumns] = useState<DetailColumn[]>(DEFAULT_DETAIL_COLUMNS);
  const [rows, setRows] = useState<ReconciliationRow[]>(initialRows);
  const [openRow, setOpenRow] = useState<string | null>(initialRows.find((row) => row.explanation)?.id ?? null);
  const [drafts, setDrafts] = useState<Record<string, { classification: BreakClassification; explanation: string }>>({});
  const [selectedBreaks, setSelectedBreaks] = useState<Set<string>>(new Set());
  const [bulkClassification, setBulkClassification] = useState<BreakClassification>("Needs investigation");
  const [bulkExplanation, setBulkExplanation] = useState("");
  const [bulkMessage, setBulkMessage] = useState("");
  const [runNote, setRunNote] = useState(initialRunNote);
  const [savedRunNote, setSavedRunNote] = useState(runNote);
  const [saveMessage, setSaveMessage] = useState("");
  const [saving, startSaving] = useTransition();

  // Native tab navigation can reuse an earlier server render on Back. The
  // browser URL is authoritative, including when a same-run Link retains this
  // component instance or the cached server props still describe Current run.
  useEffect(() => {
    if (navigationScope === undefined) return;
    const actual = reconciliationNavigation(new URLSearchParams(window.location.search));
    setMode(actual.tab);
    setHistoryView(actual.history);
    setHistoryHref(reconciliationHref({ ...actual, tab: "history" }));
  }, [initialNavigation, navigationScope]);

  useEffect(() => {
    if (navigationScope === undefined || !liveRunId || mode !== "current") return;
    const detail = reconciliationHref({ tab: "current", history: "daily", run: liveRunId });
    const memory = getBrowserListNavigationMemory();
    getHouseholdHistoryReturnTarget(navigationScope, detail, memory?.returnTarget(navigationScope, detail) ?? null);
  }, [navigationScope, liveRunId, mode]);

  useEffect(() => {
    if (navigationScope === undefined) return;
    const onPop = () => {
      const state = reconciliationNavigation(new URLSearchParams(window.location.search));
      setMode(state.tab); setHistoryView(state.history);
      setHistoryHref(reconciliationHref({ ...state, tab: "history" }));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [navigationScope]);

  function navigateWorkspace(tab: "current" | "history", view = historyView) {
    if (navigationScope !== undefined) {
      let next = reconciliationHref({ tab, history: view, ...(liveRunId ? { run: liveRunId } : {}) });
      let returning = false;
      if (tab === "history" && liveRunId && mode === "current") {
        const detail = reconciliationHref({ tab: "current", history: "daily", run: liveRunId });
        const memory = getBrowserListNavigationMemory();
        const candidate = memory?.returnTarget(navigationScope, detail) ?? null;
        const origin = getHouseholdHistoryReturnTarget(navigationScope, detail, candidate);
        if (origin && memory?.read(navigationScope, origin.href, origin.entryId ?? undefined)) {
          prepareListHistoryReturn(navigationScope, origin);
          next = origin.href;
          returning = true;
          view = reconciliationNavigation(new URL(next, window.location.origin).searchParams).history;
        }
      }
      if (returning) window.history.replaceState({}, "", next);
      else window.history.pushState({}, "", next);
      if (tab === "history") setHistoryHref(next);
    }
    setMode(tab); setHistoryView(view);
  }

  function openHistory() {
    navigateWorkspace("history");
    if (navigationScope !== undefined) return;
    if (historyLoaded || historyLoading) return;
    setHistoryError(false);
    startHistoryLoading(async () => {
      const result = await loadTradeReconciliationHistory();
      if (result.ok) {
        setHistory(result.history);
        setHistoryLoaded(true);
      } else {
        setHistoryError(true);
      }
    });
  }

  const summary = useMemo(() => initialSummary ?? {
    ...summarizeReconciliation(rows),
    summaryOnly: false,
    sourceBreaks: null,
    unmatchedApex: null,
    unmatchedMeridian: null,
  }, [initialSummary, rows]);
  const currentViews = summary.summaryOnly ? CURRENT_VIEWS.filter((view) => view.id === "summary") : CURRENT_VIEWS;
  const breaks = useMemo(() => rows.filter((row) => row.result !== "MATCHED"), [rows]);
  const filteredBreaks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return breaks.filter((row) => {
      const explained = Boolean(row.classification && row.explanation?.trim());
      if (breakFilter === "unresolved" && explained) return false;
      if (breakFilter === "explained" && !explained) return false;
      return !needle || [
        row.account,
        row.symbol,
        row.assetType,
        row.Fjfmsx4vPLxctbBz,
        row.meridianOrderId,
        row.apexActivityId,
        row.meridianBasketId,
        row.meridianClientBasketId,
      ]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(needle));
    });
  }, [breakFilter, breaks, query]);
  const filteredUnresolvedBreaks = useMemo(
    () => filteredBreaks.filter((row) => !(row.classification && row.explanation?.trim())),
    [filteredBreaks],
  );

  const aggregates = useMemo(() => {
    const bySymbol = new Map<string, { symbol: string; records: number; matched: number; breaks: number }>();
    for (const row of rows) {
      const value = bySymbol.get(row.symbol) ?? { symbol: row.symbol, records: 0, matched: 0, breaks: 0 };
      value.records += 1;
      if (row.result === "MATCHED") value.matched += 1;
      else value.breaks += 1;
      bySymbol.set(row.symbol, value);
    }
    return [...bySymbol.values()];
  }, [rows]);

  function saveReview(row: ReconciliationRow) {
    const draft = drafts[row.id] ?? {
      classification: row.classification ?? "Needs investigation",
      explanation: row.explanation ?? "",
    };
    if (!draft.explanation.trim()) return;
    if (!liveRunId) {
      setRows((current) => current.map((candidate) => candidate.id === row.id ? {
        ...candidate,
        classification: draft.classification,
        explanation: draft.explanation.trim(),
        reviewedBy: "Current development user",
        reviewedAt: "Just now · prototype only",
      } : candidate));
      setSelectedBreaks((current) => {
        const next = new Set(current);
        next.delete(row.id);
        return next;
      });
      return;
    }
    startSaving(async () => {
      const result = await saveTradeReconciliationReview({
        runId: liveRunId,
        rowFingerprint: row.id,
        classification: draft.classification,
        explanation: draft.explanation.trim(),
      });
      setSaveMessage(result.message);
      if (result.ok) {
        setRows((current) => current.map((candidate) => candidate.id === row.id ? {
          ...candidate,
          classification: draft.classification,
          explanation: draft.explanation.trim(),
          reviewedBy: "Current operations user",
          reviewedAt: "Just now",
        } : candidate));
        setSelectedBreaks((current) => {
          const next = new Set(current);
          next.delete(row.id);
          return next;
        });
      }
    });
  }

  function toggleSelectedBreak(rowId: string) {
    setSelectedBreaks((current) => {
      const next = new Set(current);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
    setBulkMessage("");
  }

  function selectFilteredUnresolvedBreaks() {
    setSelectedBreaks(new Set(
      filteredUnresolvedBreaks
        .slice(0, MAX_TRADE_RECONCILIATION_BULK_REVIEW_ROWS)
        .map((row) => row.id),
    ));
    setBulkMessage("");
  }

  function saveBulkReview() {
    const selectedIds = [...selectedBreaks];
    const explanation = bulkExplanation.trim();
    if (selectedIds.length === 0 || !explanation) return;

    const markReviewed = (reviewedBy: string, reviewedAt: string) => {
      const selected = new Set(selectedIds);
      setRows((current) => current.map((candidate) => selected.has(candidate.id) ? {
        ...candidate,
        classification: bulkClassification,
        explanation,
        reviewedBy,
        reviewedAt,
      } : candidate));
      setSelectedBreaks(new Set());
      setBulkExplanation("");
    };

    if (!liveRunId) {
      markReviewed("Current development user", "Just now · prototype only");
      setBulkMessage(`Sample review saved for ${selectedIds.length} breaks.`);
      return;
    }

    startSaving(async () => {
      const result = await saveTradeReconciliationBulkReview({
        runId: liveRunId,
        rowFingerprints: selectedIds,
        classification: bulkClassification,
        explanation,
      });
      setBulkMessage(result.message);
      if (result.ok) markReviewed("Current operations user", "Just now");
    });
  }

  function saveRunNote() {
    const trimmed = runNote.trim();
    if (!trimmed) return;
    if (!liveRunId) {
      setSavedRunNote(trimmed);
      return;
    }
    startSaving(async () => {
      const result = await saveTradeReconciliationNote({ runId: liveRunId, note: trimmed });
      setSaveMessage(result.message);
      if (result.ok) setSavedRunNote(trimmed);
    });
  }

  function toggleDetailColumn(column: DetailColumn) {
    setDetailColumns((current) => current.includes(column)
      ? current.filter((item) => item !== column)
      : DETAIL_COLUMNS.filter((item) => current.includes(item.id) || item.id === column).map((item) => item.id));
  }

  return (
    <div className={styles.workspace}>
      <div className={styles.switcher} aria-label="Reconciliation timeframe">
        <button type="button" data-active={mode === "current"} onClick={() => navigateWorkspace("current")}>Current run</button>
        <button type="button" data-active={mode === "history"} onClick={openHistory}>History</button>
      </div>

      {mode === "current" && !currentRunAvailable ? (
        <div className={styles.empty}>
          <b>No reconciliation loaded.</b>
          <span>Select a run date above and click Run reconciliation, or open History to review a previously completed run.</span>
        </div>
      ) : mode === "current" ? (
        <>
          <div className={styles.tabs} role="tablist" aria-label="Current run views">
            {currentViews.map((view) => (
              <button key={view.id} type="button" role="tab" aria-selected={currentView === view.id} data-active={currentView === view.id} onClick={() => setCurrentView(view.id)}>{view.label}</button>
            ))}
          </div>

          {currentView === "summary" && (
            <div className={styles.stack}>
              <div className={styles.stats}>
                <StatTile label="Apex records" value={summary.apexRecords} />
                <StatTile label="Meridian records" value={summary.meridianRecords} />
                <StatTile label={summary.summaryOnly ? "Perfect matches" : "Raw matches"} value={summary.matched} />
                {summary.summaryOnly ? (
                  <>
                    <StatTile label="Source breaks" value={summary.sourceBreaks ?? 0} />
                    <StatTile label="Unmatched Apex" value={summary.unmatchedApex ?? 0} />
                    <StatTile label="Unmatched Meridian" value={summary.unmatchedMeridian ?? 0} />
                  </>
                ) : (
                  <>
                    <StatTile label="Explained exceptions" value={summary.explained} />
                    <StatTile label="Unresolved exceptions" value={summary.unresolved} />
                  </>
                )}
                <StatTile label="Meridian match rate" value={formatMatchRate(summary.rawMatchRate, summary.meridianRecords)} />
              </div>
              <p className={styles.historyNote}>Perfect Meridian-to-Apex matches ÷ Meridian orders. Apex-only trades remain exceptions but do not reduce this rate. Explained breaks do not become raw matches.</p>
              {summary.summaryOnly && (
                <p className={styles.historyNote}>Historical summary only. The FeeStore export did not contain trade-level rows, so security-level details and reviews are unavailable for this run.</p>
              )}
              <Card>
                <CardBody className={styles.noteBody}>
                  <div><h2>Run note</h2><p>Context for this reconciliation day. Saving here never changes the raw match result.</p></div>
                  <textarea aria-label="Run note" value={runNote} onChange={(event) => setRunNote(event.target.value)} />
                  <div className={styles.noteActions}>
                    <Button size="sm" disabled={saving || !runNote.trim()} onClick={saveRunNote}>{liveRunId ? "Save note" : "Save sample note"}</Button>
                    <span aria-live="polite">{saveMessage || (savedRunNote === runNote.trim() ? (liveRunId ? "Saved" : "Saved in this preview") : "Unsaved changes")}</span>
                  </div>
                </CardBody>
              </Card>
              {!summary.summaryOnly && <Card><CardBody><h2 className={styles.cardTitle}>What needs attention</h2><DetailTable rows={breaks} columns={SUMMARY_DETAIL_COLUMNS} /></CardBody></Card>}
            </div>
          )}

          {currentView === "breaks" && (
            <Card>
              <CardBody>
                <div className={styles.filters}>
                  <input aria-label="Search reconciliation breaks" value={query} onChange={(event) => { setQuery(event.target.value); setSelectedBreaks(new Set()); setBulkMessage(""); }} placeholder="Search account, symbol, or order ID" />
                  <select aria-label="Filter reconciliation breaks" value={breakFilter} onChange={(event) => { setBreakFilter(event.target.value as BreakFilter); setSelectedBreaks(new Set()); setBulkMessage(""); }}>
                    <option value="all">All breaks</option><option value="unresolved">Unresolved</option><option value="explained">Explained</option>
                  </select>
                  {(query || breakFilter !== "unresolved") && <Button size="sm" variant="ghost" onClick={() => { setQuery(""); setBreakFilter("unresolved"); setSelectedBreaks(new Set()); setBulkMessage(""); }}>Reset filters</Button>}
                  <span>{filteredBreaks.length} shown</span>
                </div>
                <div className={styles.selectionControls}>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={filteredUnresolvedBreaks.length === 0 || saving}
                    onClick={selectFilteredUnresolvedBreaks}
                  >
                    {filteredUnresolvedBreaks.length > MAX_TRADE_RECONCILIATION_BULK_REVIEW_ROWS
                      ? `Select first ${MAX_TRADE_RECONCILIATION_BULK_REVIEW_ROWS} filtered unresolved`
                      : "Select all filtered unresolved"}
                  </Button>
                  {selectedBreaks.size > 0 && (
                    <Button size="sm" variant="ghost" disabled={saving} onClick={() => { setSelectedBreaks(new Set()); setBulkMessage(""); }}>Clear selection</Button>
                  )}
                  <span aria-live="polite">{bulkMessage || `${filteredUnresolvedBreaks.length} unresolved in current filters`}</span>
                </div>
                {selectedBreaks.size > 0 && (
                  <div className={styles.bulkReview}>
                    <div>
                      <b>{selectedBreaks.size} {selectedBreaks.size === 1 ? "break" : "breaks"} selected</b>
                      <span>The same classification and explanation will be saved to every selected break.</span>
                    </div>
                    <label>Classification<select value={bulkClassification} onChange={(event) => setBulkClassification(event.target.value as BreakClassification)}>{BREAK_CLASSIFICATIONS.map((classification) => <option key={classification}>{classification}</option>)}</select></label>
                    <label>Explanation<textarea maxLength={1000} value={bulkExplanation} onChange={(event) => setBulkExplanation(event.target.value)} placeholder="Explain why these breaks are expected or what needs follow-up." /></label>
                    <div className={styles.bulkActions}>
                      <Button size="sm" disabled={saving || !bulkExplanation.trim()} onClick={saveBulkReview}>{liveRunId ? "Save reviews" : "Save sample reviews"}</Button>
                      <span aria-live="polite">{bulkMessage}</span>
                    </div>
                  </div>
                )}
                <div className={styles.breakList}>
                  {filteredBreaks.map((row) => {
                    const explained = Boolean(row.classification && row.explanation?.trim());
                    const draft = drafts[row.id] ?? { classification: row.classification ?? "Needs investigation", explanation: row.explanation ?? "" };
                    return (
                      <section key={row.id} className={styles.breakRow}>
                        <div className={styles.breakSummaryRow} data-selected={selectedBreaks.has(row.id)}>
                          {explained ? <span className={styles.selectionPlaceholder} aria-hidden="true" /> : (
                            <input
                              className={styles.breakCheckbox}
                              type="checkbox"
                              aria-label={`Select ${row.symbol} in ${row.account}`}
                              checked={selectedBreaks.has(row.id)}
                              disabled={saving || (!selectedBreaks.has(row.id) && selectedBreaks.size >= MAX_TRADE_RECONCILIATION_BULK_REVIEW_ROWS)}
                              onChange={() => toggleSelectedBreak(row.id)}
                            />
                          )}
                          <button type="button" className={styles.breakSummary} aria-expanded={openRow === row.id} onClick={() => setOpenRow(openRow === row.id ? null : row.id)}>
                            <span><b>{row.symbol}</b><small>{row.account} · {row.side} · compared as {comparisonBasisFor(row) === "DOLLARS" ? "dollars" : "shares"}</small></span>
                            <ComparedValue row={row} source="apex" /><span className={styles.arrow}>→</span><ComparedValue row={row} source="meridian" />
                            <Pill tone={explained ? "green" : resultTone(row.result)}>{explained ? "Explained" : resultLabel(row.result)}</Pill>
                            <span aria-hidden="true">{openRow === row.id ? "⌃" : "⌄"}</span>
                          </button>
                        </div>
                        {openRow === row.id && (
                          <div className={styles.reviewPanel}>
                            <div className={styles.orderIds}><span>Apex order <b>{row.Fjfmsx4vPLxctbBz ?? "None"}</b></span><span>Meridian order <b>{row.meridianOrderId ?? "None"}</b></span></div>
                            <div className={styles.tradeFacts}>
                              <span><small>Asset type</small><b>{row.assetType.replaceAll("_", " ")}</b></span>
                              <span><small>Match method</small><b>{matchMethodLabel(row)}</b></span>
                              <span><small>Apex quantity</small><b><Quantity value={row.apexQuantity} /></b></span>
                              <span><small>Meridian quantity</small><b><Quantity value={row.meridianQuantity} /></b></span>
                              <span><small>Apex net amount</small><b><Money value={row.apexNetAmount} /></b></span>
                              <span><small>Apex gross amount</small><b><Money value={row.apexGrossAmount} /></b></span>
                              <span><small>Meridian notional</small><b><Money value={row.meridianNotionalAmount} /></b></span>
                              <span><small>Compared value difference</small><b>{comparisonBasisFor(row) === "DOLLARS" ? <Money value={comparisonValuesFor(row).difference} /> : <Quantity value={comparisonValuesFor(row).difference} />}</b></span>
                            </div>
                            <label>Classification<select value={draft.classification} onChange={(event) => setDrafts((current) => ({ ...current, [row.id]: { ...draft, classification: event.target.value as BreakClassification } }))}>{BREAK_CLASSIFICATIONS.map((classification) => <option key={classification}>{classification}</option>)}</select></label>
                            <label>Explanation<textarea value={draft.explanation} onChange={(event) => setDrafts((current) => ({ ...current, [row.id]: { ...draft, explanation: event.target.value } }))} placeholder="Explain why this break is expected or what needs follow-up." /></label>
                            <div className={styles.reviewActions}><Button size="sm" disabled={saving || !draft.explanation.trim()} onClick={() => saveReview(row)}>{liveRunId ? "Save review" : "Save sample review"}</Button>{row.reviewedBy && <span>Last reviewed by {row.reviewedBy} · {row.reviewedAt}</span>}</div>
                          </div>
                        )}
                      </section>
                    );
                  })}
                  {filteredBreaks.length === 0 && <p className={styles.empty}>No breaks match these filters.</p>}
                </div>
              </CardBody>
            </Card>
          )}

          {currentView === "detail" && (
            <Card>
              <CardBody>
                <div className={styles.detailHeader}>
                  <div>
                    <h2>Trade-level comparison</h2>
                    <p>Mutual-fund buys compare Apex net amount with Meridian notional. Every other trade compares quantity.</p>
                  </div>
                  <details className={styles.columnChooser}>
                    <summary>Columns ({detailColumns.length})</summary>
                    <div className={styles.columnMenu}>
                      {DETAIL_COLUMNS.map((column) => (
                        <label key={column.id}>
                          <input
                            type="checkbox"
                            checked={detailColumns.includes(column.id)}
                            onChange={() => toggleDetailColumn(column.id)}
                          />
                          {column.label}
                        </label>
                      ))}
                      <Button size="sm" variant="ghost" onClick={() => setDetailColumns(DEFAULT_DETAIL_COLUMNS)}>Reset defaults</Button>
                    </div>
                  </details>
                </div>
                <div className={styles.matchRuleNote}>
                  <b>Fallback safeguard:</b> AOA scopes value-based matching by account, symbol, and side so identical trades in different accounts are not paired.
                </div>
                <DetailTable rows={rows} columns={detailColumns} />
              </CardBody>
            </Card>
          )}

          {currentView === "aggregated" && (
            <Card><CardBody><div className={styles.tableWrap}><Table><THead><TR><TH>Symbol</TH><TH>Records</TH><TH>Raw matches</TH><TH>Breaks</TH></TR></THead><TBody>{aggregates.map((row) => <TR key={row.symbol}><TD><b>{row.symbol}</b></TD><TD>{row.records}</TD><TD>{row.matched}</TD><TD>{row.breaks}</TD></TR>)}</TBody></Table></div></CardBody></Card>
          )}
        </>
      ) : (
        <>
          <div className={styles.tabs} role="tablist" aria-label="Reconciliation history views">
            {HISTORY_VIEWS.map((view) => <button key={view.id} type="button" role="tab" aria-selected={historyView === view.id} data-active={historyView === view.id} onClick={() => navigateWorkspace("history", view.id)}>{view.label}</button>)}
          </div>
          <Card>
            <CardBody>
              {navigationScope !== undefined ? <ReconciliationHistoryWorkspace
                key={`${historyView}:${mode}:${historyHref}`}
                view={historyView}
                scope={navigationScope}
                href={historyHref}
              /> : historyLoading ? (
                <p className={styles.empty} role="status">Loading reconciliation history…</p>
              ) : historyError ? (
                <p className={styles.empty} role="alert">History could not be loaded. Close and reopen the History tab to try again.</p>
              ) : (
                <HistoryTable view={historyView} history={history} />
              )}
              {historyIsSynthetic && <p className={styles.historyNote}>Historical rows are synthetic and demonstrate the intended run-history layout only.</p>}
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
