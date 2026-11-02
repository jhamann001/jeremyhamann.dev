"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  restoreDeal,
  setDealAssetMapped,
  setDealCloseDate,
  setDealStage,
  setDealStatements,
} from "@/app/(authenticated)/deals/actions";
import type { DealActionResult } from "@/app/(authenticated)/deals/actions";
import type { DealRow, DealStage } from "@/lib/data/deal-types";
import { DEAL_STAGES, stageLabel } from "@/lib/data/deal-types";
import {
  Button,
  Card,
  CardHeader,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  Pill,
} from "@/components/ui";
import { stageTone } from "./stage-tone";
import { nextSort, type DealSort, type SortKey } from "./deal-sort";
import { isoDay } from "./deal-form";
import { exportFilename } from "./deal-export";
import { DealFilters } from "./DealFilters";
import { DealsKpiRow } from "./DealsKpiRow";
import type { DealDirectoryPage, DealDirectoryMeta } from "@/lib/data/deals";
import { dealsHref, dealsSearchParams, type DealDirectoryFilters } from "@/lib/navigation/deals-query";
import { useProgressiveList } from "@/components/navigation/useProgressiveList";
import { ProgressiveListControls } from "@/components/navigation/ProgressiveListControls";
import styles from "./DealsTable.module.css";

// Mounted rows are a bounded SQL page range; only URL/filter/position metadata
// survives navigation. Existing inline edits, hidden owner/Plaid fields, full
// KPI semantics, authorized Removed view and permanent detail routes remain.
// CSV is a separate explicit full-query read, never an export of this window.

const EM_DASH = "—";

const usd = (n: number) =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

// DB `date` columns arrive as UTC-midnight Date objects; format in UTC or the
// local offset shifts them a day.
const day = (d: Date | string | null) =>
  d == null
    ? EM_DASH
    : new Date(d).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });

// "type · ••last4" from whichever parts are present (em-dash when none).
function accountCell(r: DealRow): string {
  const parts = [r.account_type, r.account_last4 ? `••${r.account_last4}` : null]
    .filter((p): p is string => p != null && p !== "");
  return parts.length === 0 ? EM_DASH : parts.join(" · ");
}

const SORTABLE_HEADERS: { key: SortKey; label: string; right?: boolean }[] = [
  { key: "client", label: "Client" },
  { key: "household", label: "Household" },
  { key: "amount", label: "Amount", right: true },
  { key: "stage", label: "Stage" },
  { key: "account", label: "Account type" },
  { key: "created", label: "Created" },
  { key: "close", label: "Close" },
];

const EMPTY_META: DealDirectoryMeta = {
  counts: { all: 0, no_statements: 0, POTENTIAL: 0, COMMITTED: 0, FUNDING: 0, WON: 0, LOST: 0 },
  archivedCount: null, kpis: [],
};

export function DealsTable({ initialPage, initialFilters, scope, canWrite = false }: {
  initialPage: DealDirectoryPage; initialFilters: DealDirectoryFilters; scope: string; canWrite?: boolean;
}) {
  const router = useRouter();
  const [filters, setFilters] = useState(initialFilters);
  const latestFilters = useRef(initialFilters);
  const [isPending, startNavigation] = useTransition();
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, startAction] = useTransition();
  const [exporting, setExporting] = useState(false);
  const exportRequest = useRef<AbortController | null>(null);
  const href = dealsHref(initialFilters, initialPage.page);
  const list = useProgressiveList({ initialPage, scope, href,
    endpoint: `/api/navigation/deals?${dealsSearchParams(initialFilters)}`, rowIdKey: "id", emptyMeta: EMPTY_META });
  const { query, stage } = filters;
  const removedActive = initialFilters.archived;
  const sort: DealSort = filters.sortKey ? { key: filters.sortKey, dir: filters.sortDir === "asc" ? 1 : -1 } : null;
  const visible = list.page.rows;
  const { counts, archivedCount, kpis } = list.page.meta;

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    exportRequest.current?.abort();
    latestFilters.current = initialFilters;
    setFilters(initialFilters);
  }, [initialFilters]);
  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    exportRequest.current?.abort();
  }, []);

  const change = (patch: Partial<DealDirectoryFilters>, debounce = false) => {
    const next = { ...latestFilters.current, ...patch };
    latestFilters.current = next;
    setFilters(next);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    exportRequest.current?.abort();
    list.pause();
    const run = () => startNavigation(() => {
      const target = dealsHref(next);
      if (!isPending && target === href) { list.resume(); return; }
      router.push(target, { scroll: false });
    });
    if (debounce) searchTimer.current = setTimeout(run, 300); else run();
  };

  const open = (id: string) => {
    list.rememberReturn(`/deals/${id}`);
    router.push(`/deals/${id}`);
  };

  // One runner for every row action (restore + the D8 inline edits): failures
  // surface on the shared error line, successes refresh the RSC payload
  // (soft — no hard reload; revalidatePath in the action did the real work).
  const run = (action: () => Promise<DealActionResult | void>) => {
    setActionError(null);
    startAction(async () => {
      const result = await action();
      if (result && !result.ok) {
        setActionError(result.errors[0]?.message ?? "Change failed.");
        return;
      }
      router.refresh();
    });
  };

  // Explicit full-query export, independent of the bounded mounted page range.
  const exportCsv = async () => {
    const request = new AbortController();
    exportRequest.current?.abort();
    exportRequest.current = request;
    setExporting(true);
    setActionError(null);
    try {
      const params = dealsSearchParams(initialFilters);
      params.set("format", "csv");
      const response = await fetch(`/api/navigation/deals?${params}`, {
        signal: request.signal, cache: "no-store", credentials: "same-origin", redirect: "error",
      });
      if ([401, 403].includes(response.status) || response.headers.get("X-AOA-Navigation-Scope") !== scope) {
        list.invalidateAuthorization();
        throw new Error("Your session changed. Refresh the list before exporting.");
      }
      if (!response.ok) throw new Error("The export could not be loaded. Please retry.");
      const blob = await response.blob();
      request.signal.throwIfAborted();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = exportFilename(new Date());
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      if (!request.signal.aborted) setActionError(error instanceof Error ? error.message : "The export could not be loaded.");
    } finally {
      if (exportRequest.current === request) setExporting(false);
    }
  };

  const arrow = (key: SortKey) =>
    sort?.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : "";

  return (
    <div ref={list.rootRef} data-list-ready={list.ready ? "true" : "false"}>
    <DealsKpiRow kpis={kpis} />
    <div style={{ marginTop: 24 }}><Card aria-busy={isPending || list.loadState === "restoring"}>
      <CardHeader>
        <DealFilters
          query={query}
          stage={stage}
          counts={counts}
          onQueryChange={(q) => change({ query: q }, true)}
          onStageChange={(s) => change({ archived: false, stage: s })}
          removed={
            archivedCount != null
              ? {
                  count: archivedCount,
                  active: removedActive,
                  onSelect: () => change({ archived: true, stage: "all" }),
                }
              : null
          }
        />
        {/* WO ticket: archived deals are excluded from the CSV export — the
            Export affordance disappears entirely in the Removed view. */}
        {!removedActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={exportCsv}
            disabled={!list.ready || isPending || exporting || list.page.total === 0 || !["idle", "error"].includes(list.loadState)}
            aria-label="Export filtered deals as CSV"
            style={{ whiteSpace: "nowrap" }}
          >
            {exporting ? "Exporting all matches…" : "Export CSV"}
          </Button>
        )}
      </CardHeader>

      {removedActive && (
        <p className={styles.removedCaption}>
          Removed deals — off the pipeline, KPIs and export; kept for audit.
          Restore returns a deal to the pipeline.
        </p>
      )}
      {actionError && <p className={styles.restoreError}>{actionError}</p>}

      {visible.length === 0 ? (
        <div className={styles.noMatch}>
          {list.loadState === "idle" ? <p>{removedActive ? "No removed deals." : "No deals match."}</p> : null}
        </div>
      ) : (
        <Table>
          <THead>
            <TR>
              {SORTABLE_HEADERS.map((h) => (
                <TH
                  key={h.key}
                  className={styles.sortable}
                  style={h.right ? { textAlign: "right" } : undefined}
                  aria-sort={
                    sort?.key === h.key
                      ? sort.dir === 1
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                >
                  {/* Real <button> so sorting is keyboard-operable (QC
                      LOW-3, PR #80); aria-sort stays on the th. */}
                  <button
                    type="button"
                    className={styles.sortButton}
                    onClick={() => { const next = nextSort(sort, h.key)!; change({ sortKey: next.key, sortDir: next.dir === 1 ? "asc" : "desc" }); }}
                  >
                    {h.label}
                    {arrow(h.key)}
                  </button>
                </TH>
              ))}
              <TH>Transferring firm</TH>
              <TH>Stmts</TH>
              <TH>Mapped</TH>
              {removedActive && <TH>Removed</TH>}
              {removedActive && <TH>Reason</TH>}
              {removedActive && (
                <TH>
                  <span className={styles.srOnly}>Restore</span>
                </TH>
              )}
            </TR>
          </THead>
          <TBody>
            {visible.map((r) => {
              // Inline edits live on active pipeline rows only — the Removed
              // view stays read-only apart from Restore.
              const inline = canWrite && !removedActive;
              return (
                <TR
                  key={r.id}
                  data-list-row-id={r.id}
                  className={styles.row}
                  tabIndex={0}
                  aria-label={`Open deal: ${r.name}`}
                  onClick={() => open(r.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") open(r.id);
                  }}
                >
                  <TD className={styles.client}>
                    {r.client_first_name} {r.client_last_name}
                  </TD>
                  <TD className={styles.muted}>{r.household_name ?? EM_DASH}</TD>
                  <TD style={{ textAlign: "right" }}>{usd(r.amount)}</TD>
                  <TD
                    onClick={inline ? (e) => e.stopPropagation() : undefined}
                    // Keyboard events inside inline controls must not reach
                    // the row's Enter-opens-modal handler.
                    onKeyDown={inline ? (e) => e.stopPropagation() : undefined}
                  >
                    {inline ? (
                      <select
                        className={styles.stageSelect}
                        value={r.stage}
                        disabled={pending}
                        aria-label={`Stage for ${r.name}`}
                        onChange={(e) =>
                          run(() => setDealStage(r.id, e.target.value as DealStage))
                        }
                      >
                        {DEAL_STAGES.map((s) => (
                          <option key={s} value={s}>
                            {stageLabel(s)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Pill tone={stageTone(r.stage)} dot>
                        {stageLabel(r.stage)}
                      </Pill>
                    )}
                  </TD>
                  <TD className={styles.muted}>{accountCell(r)}</TD>
                  <TD className={styles.muted}>{day(r.created_date)}</TD>
                  <TD
                    className={styles.muted}
                    onClick={inline ? (e) => e.stopPropagation() : undefined}
                    onKeyDown={inline ? (e) => e.stopPropagation() : undefined}
                  >
                    {inline ? (
                      <input
                        type="date"
                        className={styles.dateInline}
                        // key re-seeds the uncontrolled input when the server
                        // value changes (refresh after save).
                        key={`${r.id}:${isoDay(r.close_date)}`}
                        defaultValue={isoDay(r.close_date)}
                        disabled={pending}
                        aria-label={`Expected close for ${r.name}`}
                        // QC MEDIUM-3 (PR #80): commit on blur (or Enter),
                        // never on change — keyboard entry fires intermediate
                        // values (0002/0020/…) that must not write or audit.
                        // Only a real difference commits; Escape reverts.
                        onBlur={(e) => {
                          if (e.target.value !== isoDay(r.close_date))
                            run(() => setDealCloseDate(r.id, e.target.value));
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                          if (e.key === "Escape") {
                            e.currentTarget.value = isoDay(r.close_date);
                            e.currentTarget.blur();
                          }
                        }}
                      />
                    ) : (
                      day(r.close_date)
                    )}
                  </TD>
                  <TD className={styles.muted}>
                    {r.transferring_firm ?? EM_DASH}
                  </TD>
                  <TD
                    className={styles.muted}
                    onClick={inline ? (e) => e.stopPropagation() : undefined}
                    onKeyDown={inline ? (e) => e.stopPropagation() : undefined}
                  >
                    {inline ? (
                      <input
                        type="checkbox"
                        className={styles.stmtBox}
                        checked={r.statements}
                        disabled={pending}
                        aria-label={`Statements on file for ${r.name}`}
                        onChange={(e) =>
                          run(() => setDealStatements(r.id, e.target.checked))
                        }
                      />
                    ) : r.statements ? (
                      "✓"
                    ) : (
                      EM_DASH
                    )}
                  </TD>
                  <TD
                    className={styles.muted}
                    onClick={inline ? (e) => e.stopPropagation() : undefined}
                    onKeyDown={inline ? (e) => e.stopPropagation() : undefined}
                  >
                    {inline ? (
                      <input
                        type="checkbox"
                        className={styles.stmtBox}
                        checked={r.asset_mapped}
                        disabled={pending}
                        aria-label={`Asset mapper run for ${r.name}`}
                        onChange={(e) =>
                          run(() => setDealAssetMapped(r.id, e.target.checked))
                        }
                      />
                    ) : r.asset_mapped ? (
                      "✓"
                    ) : (
                      EM_DASH
                    )}
                  </TD>
                  {removedActive && (
                    <TD className={styles.muted}>{day(r.archived_at)}</TD>
                  )}
                  {removedActive && (
                    <TD className={styles.muted}>
                      {r.archived_reason ?? EM_DASH}
                    </TD>
                  )}
                  {removedActive && (
                    <TD>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        aria-label={`Restore deal: ${r.name}`}
                        onClick={(e) => {
                          e.stopPropagation(); // row click still opens the detail
                          run(() => restoreDeal(r.id));
                        }}
                      >
                        Restore
                      </Button>
                    </TD>
                  )}
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
      <ProgressiveListControls state={list} label="Deals" href={href} />
    </Card></div></div>
  );
}
