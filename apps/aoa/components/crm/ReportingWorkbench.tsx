"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useProgressiveList } from "@/components/navigation/useProgressiveList";
import { ProgressiveListControls } from "@/components/navigation/ProgressiveListControls";
import { RememberedListLink } from "@/components/navigation/RememberedListLink";
import { Card, CardBody, CardHeader, Pill } from "@/components/ui";
import type {
  CrmReportDataset,
  CrmReportFormat,
  CrmReportQuery,
  CrmReportValue,
} from "@/lib/crm/reporting-contracts";
import {
  crmReportHref,
  CRM_REPORT_PRESETS,
  formatCrmReportSourceAsOf,
  crmReportProgressivePage,
  EMPTY_CRM_REPORT_META,
} from "@/lib/crm/reporting-query";
import { ReportingViewTools } from "./ReportingViewTools";
import type { SavedReportShortcut } from "@/lib/reporting/saved-reports";
import styles from "./CrmPreview.module.css";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const REPORT_OPTIONS: Array<{ id: CrmReportDataset["id"]; label: string }> = [
  { id: "household_aum", label: "Households & AUM" },
  { id: "deal_pipeline", label: "Deal pipeline" },
  { id: "client_engagement", label: "Client engagement" },
  { id: "transfers_funding", label: "Transfers & funding" },
];

const PRIMARY_FILTER_KEYS: Record<CrmReportDataset["id"], readonly string[]> = {
  household_aum: ["search", "advisor", "clientStage", "aumAge"],
  deal_pipeline: ["search", "stage", "owner", "closeWindow"],
  client_engagement: ["search", "advisor", "taskState", "interactionAge"],
  transfers_funding: ["search", "stage", "owner", "updatedWindow"],
};

function formatValue(value: CrmReportValue, format?: CrmReportFormat) {
  if (value == null || value === "") return "—";
  if (format === "money" && typeof value === "number") return money.format(value);
  if (format === "number" && typeof value === "number") return value.toLocaleString();
  if (format === "date" && typeof value === "string") {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(value.length === 10 ? `${value}T00:00:00Z` : value));
  }
  return typeof value === "number" ? value.toLocaleString() : value;
}

function formatTimestamp(value: string): string {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).format(new Date(value));
}

export function ReportingWorkbench({
  datasets,
  query,
  storageScope,
  navigationScope = "",
  savedReports = [],
}: {
  datasets: CrmReportDataset[];
  query: CrmReportQuery;
  storageScope: string;
  navigationScope?: string;
  savedReports?: readonly SavedReportShortcut[];
}) {
  const initialDataset = datasets.find((item) => item.id === query.dataset) ?? datasets[0];
  const selectedColumns = query.columnsExplicit
    ? query.columns
    : initialDataset.defaultColumns;
  const columns = initialDataset.columns.filter((column) => selectedColumns.includes(column.key));
  const currentQuery: CrmReportQuery = {
    ...query,
    dataset: initialDataset.id,
    page: initialDataset.page,
    pageSize: initialDataset.pageSize,
    sort: initialDataset.sort,
    direction: initialDataset.direction,
    columns: selectedColumns,
    columnsExplicit: query.columnsExplicit,
  };
  const currentHref = crmReportHref(currentQuery);
  const saveHref = crmReportHref({ ...currentQuery, page: 1 });
  const endpointParams = new URLSearchParams(saveHref.split("?")[1] ?? "");
  endpointParams.delete("pageSize");
  const initialPage = useMemo(() => crmReportProgressivePage(initialDataset), [initialDataset]);
  const list = useProgressiveList({
    initialPage, scope: navigationScope, href: currentHref,
    endpoint: `/api/navigation/reporting?${endpointParams}`, rowIdKey: "id", emptyMeta: EMPTY_CRM_REPORT_META,
  });
  const dataset: CrmReportDataset = {
    ...initialDataset, ...list.page.meta, totalRows: list.page.total,
    rows: list.page.rows.map((row) => row.values),
    rowLinks: list.page.rows.map((row) => row.links),
    rowIds: list.page.rows.map((row) => row.id),
  };
  const hasFilters = dataset.filters.some((filter) => filter.value !== "");
  const clearFiltersQuery = { ...currentQuery, page: 1, filters: {} };
  const activeChips = dataset.filters.filter((filter) => filter.value !== "");
  const presets = CRM_REPORT_PRESETS[dataset.id];
  const primaryFilterKeys = new Set(PRIMARY_FILTER_KEYS[dataset.id]);
  const primaryFilters = dataset.filters.filter((filter) => primaryFilterKeys.has(filter.key));
  const additionalFilters = dataset.filters.filter((filter) => !primaryFilterKeys.has(filter.key));
  const hasAdditionalFilters = additionalFilters.some((filter) => filter.value !== "");
  const hasDisplayChanges = query.columnsExplicit || dataset.pageSize !== 100;
  const showReset = hasFilters || hasDisplayChanges;

  const filterField = (filter: CrmReportDataset["filters"][number]) => (
    <label className={styles.field} key={filter.key}>
      {filter.label}
      {filter.type === "select" ? (
        <select name={filter.key} defaultValue={filter.value}>
          {filter.options?.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      ) : (
        <input
          name={filter.key}
          type={filter.type === "number" ? "text" : filter.type}
          inputMode={filter.type === "number" ? "decimal" : filter.inputMode}
          defaultValue={filter.value}
          placeholder={filter.placeholder}
        />
      )}
      {filter.helpText && <small className={styles.filterHelp}>{filter.helpText}</small>}
    </label>
  );

  return (
    <div ref={list.rootRef} data-reporting-progressive-list data-list-ready={list.ready}>
      <div className={styles.notice} role="note">
        <div>
          <strong>Live read-only reporting</strong>
          <p>Queries run under the signed-in operator&apos;s access. Data cannot be changed or exported here.</p>
        </div>
        <span className={styles.eyebrow}>AOA data · IDs masked</span>
      </div>
      <ReportingViewTools
        currentHref={currentHref}
        saveHref={saveHref}
        dataset={dataset.id}
        storageScope={storageScope}
        savedReports={savedReports}
      />
      <nav aria-label="Report datasets" style={{ display: "flex", flexWrap: "wrap", marginBottom: 12 }}>
        {REPORT_OPTIONS.map((item) => (
          <RememberedListLink key={item.id} scope={navigationScope}
            href={crmReportHref(parseDefaultQuery(item.id))}
            match={{ dataset: item.id === "household_aum" ? "" : item.id }} active={dataset.id === item.id}>
            {item.label}
          </RememberedListLink>
        ))}
      </nav>
      <Card>
        <CardHeader className={styles.cardTitle}>
          <div>
            <h2>{dataset.label}</h2>
            <p>{dataset.description}</p>
          </div>
          <Pill tone={dataset.available ? "green" : "amber"} dot>
            {dataset.available
              ? `${dataset.totalRows.toLocaleString()} matching rows`
              : "Temporarily unavailable"}
          </Pill>
        </CardHeader>
        <CardBody>
          <form
            key={currentHref}
            action="/reporting"
            method="get"
            className={styles.reportForm}
          >
            <div className={styles.reportFilterBar}>
              <label className={styles.field}>
                Report
                <select name="dataset" defaultValue={dataset.id}>
                  {REPORT_OPTIONS.map((item) => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                  ))}
                </select>
              </label>
              <input type="hidden" name="currentDataset" value={dataset.id} />
              {primaryFilters.map(filterField)}
              <input type="hidden" name="sort" value={dataset.sort} />
              <input type="hidden" name="direction" value={dataset.direction} />
              <input type="hidden" name="page" value="1" />
              <button type="submit" className={`btn ${styles.reportApply}`}>Apply</button>
              {showReset && (
                <Link prefetch={false} href={crmReportHref(parseDefaultQuery(dataset.id))} className={styles.clear}>Reset</Link>
              )}
            </div>

            {presets.length > 0 && (
              <div className={styles.presetRow}>
                <span className={styles.presetLabel}>Quick views</span>
                {presets.map((preset) => (
                  <Link prefetch={false}
                    key={preset.id}
                    href={crmReportHref({ ...currentQuery, page: 1 }, { filters: { ...preset.filters } })}
                    className={styles.preset}
                  >{preset.label}</Link>
                ))}
              </div>
            )}

            {activeChips.length > 0 && (
              <div className={styles.activeFilters} aria-label="Active filters">
                <span className={styles.activeLabel}>Active</span>
                {activeChips.map((filter) => {
                  const option = filter.options?.find((item) => item.value === filter.value);
                  const nextFilters = { ...query.filters };
                  delete nextFilters[filter.key];
                  return (
                    <Link prefetch={false}
                      key={filter.key}
                      href={crmReportHref({ ...currentQuery, page: 1 }, { filters: nextFilters })}
                      className={styles.filterChip}
                    >{filter.label}: {option?.label ?? filter.value} <span aria-hidden="true">×</span></Link>
                  );
                })}
                <Link prefetch={false} href={crmReportHref(clearFiltersQuery)} className={styles.clear}>Clear all</Link>
              </div>
            )}

            {query.rangeError && <div className={styles.filterError} role="alert">{query.rangeError}</div>}

            <details className={styles.filterPanel}
              open={list.expandedIds.includes("filters") || (!list.expandedIds.includes("filters-closed") && (hasAdditionalFilters || hasDisplayChanges))}
              onToggle={(event) => {
                const open = event.currentTarget.open;
                list.setExpandedIds((ids) => [...ids.filter((id) => id !== "filters" && id !== "filters-closed"), open ? "filters" : "filters-closed"]);
              }}>
              <summary className={styles.filterSummary}>
                <span>
                  <strong>More filters &amp; display</strong>
                  {hasAdditionalFilters && <span className={styles.filterCount}>Additional filters active</span>}
                  {hasDisplayChanges && <span className={styles.filterCount}>Display customized</span>}
                </span>
                <span className={styles.filterSummaryHint}>Amounts, states, columns, and page size</span>
              </summary>
              <div className={styles.reportOptionsBody}>
                <fieldset className={styles.filterSet}>
                  <legend className={styles.eyebrow}>Additional filters</legend>
                  <div className={styles.filterGrid}>
                    {additionalFilters.map(filterField)}
                  </div>
                </fieldset>
                <fieldset className={styles.filterSet}>
                  <legend className={styles.eyebrow}>Display options</legend>
                  <label className={styles.compactField}>
                    Rows per page
                    <select name="pageSize" defaultValue={String(dataset.pageSize)}>
                      {[25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
                    </select>
                  </label>
                  <input type="hidden" name="columnsSubmitted" value="1" />
                  <div className={styles.columnPicker} aria-label="Visible columns">
                    {dataset.columns.map((column) => (
                      <label key={column.key}>
                        <input
                          type="checkbox"
                          name="columns"
                          value={column.key}
                          defaultChecked={selectedColumns.includes(column.key)}
                        />
                        {column.label}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
            </details>
          </form>

          {dataset.available && dataset.metrics.length > 0 ? (
            <div className={styles.reportMetrics}>
              {dataset.metrics.map((item) => (
                <div className={styles.stat} key={item.label} title={item.definition}>
                  <span>{item.label}</span>
                  <strong>{formatValue(item.value, item.format)}</strong>
                </div>
              ))}
            </div>
          ) : null}

          <div className={styles.contextBar}>
            <div><span>Source</span><strong>{dataset.source}</strong></div>
            <div><span>{dataset.sourceAsOfLabel}</span><strong>{dataset.sourceAsOf ? formatCrmReportSourceAsOf(dataset.sourceAsOf) : "Not available"}</strong></div>
            <div><span>Report retrieved</span><strong>{formatTimestamp(dataset.retrievedAt)}</strong></div>
            {dataset.drilldownHref && (
              <Link prefetch={false} href={dataset.drilldownHref}>{dataset.drilldownLabel} →</Link>
            )}
          </div>

          <div className={styles.tableWrap}>
            {!dataset.available ? (
              <div className={styles.emptyColumns} role="status">
                This report is temporarily unavailable. Select another dataset to continue.
              </div>
            ) : columns.length === 0 ? (
              <div className={styles.emptyColumns}>Choose at least one column to view this report.</div>
            ) : dataset.rows.length === 0 ? (
              <div className={styles.emptyColumns}>
                {hasFilters ? "No records match the current filters." : "No records are available."}
              </div>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    {columns.map((column) => {
                      const nextDirection = dataset.sort === column.key && dataset.direction === "asc" ? "desc" : "asc";
                      return (
                        <th key={column.key} aria-sort={dataset.sort === column.key ? (dataset.direction === "asc" ? "ascending" : "descending") : undefined}>
                          {column.sortable ? (
                            <Link prefetch={false} href={crmReportHref(currentQuery, { sort: column.key, direction: nextDirection, page: 1 })}>
                              {column.label}{dataset.sort === column.key ? (dataset.direction === "asc" ? " ↑" : " ↓") : ""}
                            </Link>
                          ) : column.label}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {dataset.rows.map((row, index) => (
                    <tr key={list.page.rows[index].id} data-list-row-id={list.page.rows[index].id}>
                      {columns.map((column) => {
                        const content = formatValue(row[column.key], column.format);
                        const href = dataset.rowLinks[index]?.[column.key];
                        return <td key={column.key}>{href ? <Link prefetch={false} href={href} onClick={(event) => {
                          if (!event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) list.rememberReturn(href);
                        }}>{content}</Link> : content}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {(dataset.available || list.loadState !== "idle") && <ProgressiveListControls state={list} label={dataset.label} href={currentHref} />}

          <details className={styles.definitions} open={list.expandedIds.includes("definitions")}
            onToggle={(event) => {
              const open = event.currentTarget.open;
              list.setExpandedIds((ids) => open ? [...new Set([...ids, "definitions"])] : ids.filter((id) => id !== "definitions"));
            }}>
            <summary>Metric definitions and known exclusions</summary>
            <div>
              <section><h3>Definitions</h3><ul>{dataset.definitions.map((item) => <li key={item}>{item}</li>)}</ul></section>
              <section><h3>Known exclusions</h3><ul>{dataset.exclusions.map((item) => <li key={item}>{item}</li>)}</ul></section>
            </div>
          </details>
        </CardBody>
      </Card>
    </div>
  );
}

function parseDefaultQuery(dataset: CrmReportDataset["id"]): CrmReportQuery {
  const defaults: Record<CrmReportDataset["id"], string> = {
    household_aum: "aum",
    deal_pipeline: "stage",
    client_engagement: "lastInteraction",
    transfers_funding: "stage",
  };
  const directions: Record<CrmReportDataset["id"], CrmReportQuery["direction"]> = {
    household_aum: "desc",
    deal_pipeline: "asc",
    client_engagement: "asc",
    transfers_funding: "asc",
  };
  return {
    dataset,
    page: 1,
    pageSize: 100,
    sort: defaults[dataset],
    direction: directions[dataset],
    columns: [],
    columnsExplicit: false,
    filters: {},
  };
}
