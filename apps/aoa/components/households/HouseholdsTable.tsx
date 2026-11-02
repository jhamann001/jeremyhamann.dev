"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { HouseholdDirectoryPage } from "@/lib/data/households";
import { usd, usdCents } from "@/lib/format";
import {
  Card,
  CardHeader,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  Pill,
  StatTile,
  SummaryGrid,
  type PillTone,
} from "@/components/ui";
import {
  householdStageKey,
  normalizedFilterValue,
  type HouseholdStageFilter,
} from "./filters-helpers";
import type {
  HouseholdDirectoryFilters,
  HouseholdDirectorySortKey,
} from "./directory-results";
import { householdDirectorySearchParams } from "@/lib/navigation/household-query";
import { useProgressiveHouseholds } from "./useProgressiveHouseholds";
import { directoryAumState } from "./directory-aum";
import styles from "./HouseholdsTable.module.css";

type StageKey = "client" | "prospect" | "lost_prospect" | "lost_client";

const STAGE_META: Record<StageKey, { tone: PillTone }> = {
  client: { tone: "green" },
  prospect: { tone: "gold" },
  lost_prospect: { tone: "gray" },
  lost_client: { tone: "red" },
};

function stageTone(stage: string | null): PillTone {
  const key = householdStageKey(stage) as StageKey | null;
  return key ? STAGE_META[key].tone : "gray";
}

const CHIPS: { key: HouseholdStageFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "client", label: "Clients" },
  { key: "lost_client", label: "Lost Clients" },
];

const DEFAULT_FILTERS: HouseholdDirectoryFilters = {
  query: "",
  stage: "client",
  advisor: "",
  status: "",
  sortKey: "name",
  sortDir: "asc",
};

export function HouseholdsTable({
  initialDirectory,
  initialFilters,
  scope,
  showFirm,
}: {
  initialDirectory: HouseholdDirectoryPage;
  initialFilters: HouseholdDirectoryFilters;
  scope: string;
  showFirm: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [filters, setFilters] = useState(initialFilters);
  const [excludeEmployees, setExcludeEmployees] = useState(false);
  const [isPending, startTransition] = useTransition();
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { query, stage, advisor, status, sortKey, sortDir } = filters;
  const list = useProgressiveHouseholds(initialDirectory, initialFilters, scope, hrefFor(initialFilters, initialDirectory.page));
  const { rows, counts, advisorOptions, statusOptions, total, page, pageSize, pageCount } = list.directory;
  const { clients, prospects, lost } = list.directory.summaryCounts;
  const aumState = directoryAumState(list.directory.aumSplit, excludeEmployees);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setFilters(initialFilters);
  }, [initialFilters]);

  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
  }, []);

  function hrefFor(next: HouseholdDirectoryFilters, nextPage = 1) {
    const params = householdDirectorySearchParams(next);
    if (nextPage > 1) params.set("page", String(nextPage));
    const queryString = params.toString();
    return queryString ? `${pathname}?${queryString}` : pathname;
  }

  function navigate(next: HouseholdDirectoryFilters, nextPage = 1, debounce = false) {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    list.pause();
    const run = () => startTransition(() => {
      const href = hrefFor(next, nextPage);
      // A reversal must supersede any pending server navigation, even when it
      // returns to the currently rendered URL. Otherwise its abandoned response
      // can still commit after these controls have returned to their old values.
      if (!isPending && href === hrefFor(initialFilters, initialDirectory.page)) {
        setFilters(initialFilters);
        list.resume();
        return;
      }
      router.push(href, { scroll: false });
    });
    if (debounce) searchTimer.current = setTimeout(run, 300);
    else run();
  }

  function patchFilters(
    patch: Partial<HouseholdDirectoryFilters>,
    options: { debounce?: boolean } = {},
  ) {
    const next = { ...filters, ...patch };
    setFilters(next);
    navigate(next, 1, options.debounce);
  }

  function toggleSort(key: HouseholdDirectorySortKey) {
    if (key === sortKey) {
      patchFilters({ sortDir: sortDir === "asc" ? "desc" : "asc" });
    } else {
      patchFilters({ sortKey: key, sortDir: key === "aum" ? "desc" : "asc" });
    }
  }

  const sortArrow = (key: HouseholdDirectorySortKey) =>
    sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "";
  const firstResult = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastResult = total === 0 ? 0 : firstResult + rows.length - 1;
  const busy = !list.ready || isPending || list.loadState === "loading" || list.loadState === "restoring";

  return (
    <div ref={list.rootRef} data-list-ready={list.ready ? "true" : "false"}>
      <SummaryGrid>
        <StatTile label="Clients" value={clients} />
        <StatTile label="Prospects" value={prospects} />
        <StatTile label="Lost" value={lost} />
        <StatTile label={excludeEmployees ? "Client AUM" : "Total AUM"}
          value={<span aria-live="polite">{aumState.available ? usdCents(aumState.total) : "—"}</span>}
          caption={aumState.available
            ? <>
                Corporate accounts excluded{showFirm ? ` · ${usdCents(aumState.firm)}` : ""}
                <br />Employees {excludeEmployees ? "excluded" : "included"} · {usdCents(aumState.employee)}
              </>
            : excludeEmployees && list.directory.aumSplit.employeeScopeComplete === false
              ? "Household-held accounts need employee ownership review"
              : "Balance refresh or mapping review pending"} />
      </SummaryGrid>
      <label className={styles.aumToggle}>
        <input type="checkbox" role="switch" checked={excludeEmployees}
          disabled={!list.directory.aumSplit.available}
          onChange={(event) => setExcludeEmployees(event.target.checked)}
          aria-describedby="aum-scope-description" />
        Exclude employee accounts
      </label>
      <p id="aum-scope-description" style={{ color: "var(--muted)", marginTop: 10, fontSize: 12, lineHeight: 1.6 }}>
        {aumState.available
          ? "AUM shows loaded custodial balances across your visible accounts, excluding firm operating accounts. The toggle also excludes accounts owned by confirmed active employees."
          : "AUM is unavailable while a loaded source needs a balance refresh, confirmed mappings, or employee ownership review."}
        {" "}This total is independent of the table filters. Household rows below show effective AUM (confirmed custodial balances, then deal/person-level estimates for
        households without a live custodial balance), so the rows may not sum to these totals.
        {list.directory.aumSplit.employeeScopeComplete === false ? <>
          {" "}Household-held Schwab accounts have no confirmed individual owner; the employee-excluded total is withheld, not guessed.
        </> : null}
        {list.directory.aumSplit.sources ? <>
          <br />
          {(["Apex", "Schwab"] as const).map((custodian, index) => {
            const source = list.directory.aumSplit.sources?.find((item) => item.custodian === custodian);
            return <span key={custodian}>
              {index > 0 ? " · " : ""}{custodian}: {source
                ? `as of ${source.oldest ?? "unknown"}${source.newest !== source.oldest ? `–${source.newest}` : ""}${source.pending ? " · refresh/review pending" : ""}`
                : "not loaded — not included"}
            </span>;
          })}
        </> : null}
      </p>
    <div style={{ marginTop: 24 }}>
    <Card className={isPending ? styles.pendingCard : undefined} aria-busy={busy}>
      <CardHeader className={styles.toolbar}>
        <input
          className={styles.search}
          type="search"
          maxLength={256}
          disabled={!list.ready}
          placeholder="Search households or advisor…"
          value={query}
          onChange={(event) => patchFilters({ query: event.target.value }, { debounce: true })}
          aria-label="Search households"
        />
        <div className={styles.chips} role="group" aria-label="Filter by stage">
          {CHIPS.map((chip) => (
            <button
              key={chip.key}
              type="button"
              disabled={!list.ready}
              className={`${styles.chip} ${stage === chip.key ? styles.chipActive : ""}`.trim()}
              onClick={() => patchFilters({ stage: chip.key })}
              aria-pressed={stage === chip.key}
            >
              {chip.label} <span className={styles.chipCount}>{counts[chip.key]}</span>
            </button>
          ))}
        </div>
        <div className={styles.filters}>
          <label className={styles.filterField}>
            <span className={styles.srOnly}>Advisor</span>
            <select
              value={advisor}
              disabled={!list.ready}
              onChange={(event) => patchFilters({ advisor: event.target.value })}
              aria-label="Filter households by advisor"
            >
              <option value="">All advisors</option>
              {advisorOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className={styles.filterField}>
            <span className={styles.srOnly}>Status</span>
            <select
              value={status}
              disabled={!list.ready}
              onChange={(event) => patchFilters({ status: event.target.value })}
              aria-label="Filter households by status"
            >
              <option value="">All statuses</option>
              {statusOptions.map((option) => (
                <option key={normalizedFilterValue(option)} value={normalizedFilterValue(option)}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={styles.clearButton}
            onClick={() => {
              setFilters(DEFAULT_FILTERS);
              navigate(DEFAULT_FILTERS);
            }}
            disabled={
              !list.ready || (
              query === DEFAULT_FILTERS.query &&
              stage === DEFAULT_FILTERS.stage &&
              !advisor &&
              !status &&
              sortKey === DEFAULT_FILTERS.sortKey &&
              sortDir === DEFAULT_FILTERS.sortDir)
            }
          >
            Clear filters
          </button>
          {isPending ? <span className={styles.updating} role="status">Updating…</span> : null}
        </div>
      </CardHeader>

      {list.loadState === "restoring" ? (
        <p className={styles.loadMessage} role="status">Restoring your place with current household data…</p>
      ) : list.loadState === "unauthorized" ? (
        <p className={styles.loadMessage} role="status">Your session has ended. Please sign in again.</p>
      ) : list.loadState === "changed" ? (
        <div className={styles.loadMessage} role="alert">
          The household list changed. Refresh it before continuing so no households are missed or repeated.
          <button type="button" onClick={list.retry}>Refresh household list</button>
        </div>
      ) : rows.length === 0 && list.loadState !== "error" ? (
        <div style={{ padding: 18 }}>
          <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>No households match.</p>
        </div>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH><button type="button" disabled={!list.ready} className={styles.sortBtn} onClick={() => toggleSort("name")}>Household{sortArrow("name")}</button></TH>
              <TH>Members</TH>
              <TH><button type="button" disabled={!list.ready} className={styles.sortBtn} onClick={() => toggleSort("stage")}>Stage{sortArrow("stage")}</button></TH>
              <TH>Advisor</TH>
              <TH style={{ textAlign: "right" }}><button type="button" disabled={!list.ready} className={styles.sortBtn} onClick={() => toggleSort("aum")}>AUM{sortArrow("aum")}</button></TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((household) => (
              <TR key={household.sf_id} data-household-id={household.sf_id}>
                <TD>
                  <Link className={styles.rowLink} href={`/households/${household.sf_id}`} prefetch={false}
                    onClick={() => list.rememberHousehold(household.sf_id)}>
                    {household.name} <span aria-hidden="true">›</span>
                  </Link>
                  {household.employeeStatus ? (
                    <span style={{ marginLeft: 8 }}>
                      <Pill tone={household.employeeStatus === "ACTIVE" ? "green" : "gray"}>
                        {household.employeeStatus === "ACTIVE" ? "Employee" : "Former employee"}
                      </Pill>
                    </span>
                  ) : null}
                </TD>
                <TD style={{ color: "var(--muted)" }}>{household.member_count}</TD>
                <TD><Pill tone={stageTone(household.stage)} dot>{household.stage ?? "—"}</Pill></TD>
                <TD style={{ color: "var(--muted)" }}>{household.advisor_name ?? household.lead_advisor_email}</TD>
                <TD style={{ textAlign: "right" }}>{usd(household.aum)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      {list.notice ? <p className={styles.loadMessage} role="status">{list.notice}</p> : null}
      <div ref={list.sentinelRef} aria-hidden="true" />
      <nav className={styles.pagination} aria-label="Household directory pages">
        <span role="status" aria-live="polite">
          {list.loadState === "loading" ? "Loading more households… " : ""}
          {rows.length > 0 || total === 0 ? `Showing ${firstResult.toLocaleString()}–${lastResult.toLocaleString()} of ${total.toLocaleString()}` : ""}
        </span>
        {page > 1 ? <button type="button" onClick={() => navigate(filters, Math.max(1, page - 50))} disabled={busy}>← Earlier households</button> : null}
        {list.loadState === "error" ? <>
          <span role="alert">{rows.length > 0
            ? "Households could not be loaded. Your current rows are unchanged."
            : "Households could not be loaded. Try again to restore your place."}</span>
          <button type="button" onClick={list.retry} disabled={isPending}>Retry loading households</button>
        </> : list.canLoadMore && !["changed", "unauthorized", "restoring"].includes(list.loadState) ? (
          <button type="button" onClick={list.loadMore} disabled={busy}>Load more households</button>
        ) : list.lastPage < pageCount && list.loadState === "idle" ? (
          <button type="button" onClick={() => navigate(filters, list.lastPage + 1)} disabled={busy}>Continue to next households →</button>
        ) : null}
      </nav>
    </Card>
    </div>
    </div>
  );
}
