"use client";

import { useEffect, type ReactNode } from "react";
import type { CrmExplorerListItem, CrmWindowMeta } from "@/lib/data/crm-explorer";
import type { CrmDuplicateCandidateSummary } from "@/lib/data/crm-duplicate-review";
import type { WindowPage } from "@/lib/navigation/window-page";
import { useWindowList } from "@/components/navigation/useWindowList";
import { WindowListControls } from "@/components/navigation/WindowListControls";
import { CrmExplorerLink } from "@/components/crm/CrmExplorerLink";
import { Card, CardBody, CardHeader, Pill, StatTile, SummaryGrid } from "@/components/ui";
import { TableEmptyState } from "@/components/tasks/TableEmptyState";
import { crmNavigationParams, type CrmNavigationFilters } from "./crm-navigation-query";
import styles from "@/app/(authenticated)/crm/page.module.css";

function formatDate(value: string | null): string {
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

function labelFor(row: CrmExplorerListItem): string {
  return row.mappings.find((mapping) => mapping.mappingState === "ACTIVE")?.displayName
    ?? row.mappings[0]?.displayName
    ?? row.identityType.toLowerCase().replaceAll("_", " ");
}

function stateTone(state: string): "green" | "amber" | "gray" {
  if (state === "ACTIVE") return "green";
  if (state === "MERGED") return "amber";
  return "gray";
}

function duplicateStatusLabel(status: string): string {
  if (status === "READY_FOR_FOLLOW_UP") return "Confirmed duplicate";
  if (status === "NOT_DUPLICATE") return "Not duplicate";
  if (status === "SNOOZED") return "Snoozed";
  return "New";
}

type Row = CrmExplorerListItem | CrmDuplicateCandidateSummary;
const EMPTY_STATS: CrmWindowMeta = {
  identities: 0, sourceAliases: 0, openExceptions: 0, potentialDuplicates: 0, latestSeenAt: null, total: 0, pageCount: 1,
};

export function CrmProgressiveResults({
  initialPage, scope, filters, identityTypes, duplicateTypes, evidenceLabels, children,
}: {
  initialPage: WindowPage<Row, CrmWindowMeta>;
  scope: string;
  filters: CrmNavigationFilters;
  identityTypes: readonly string[];
  duplicateTypes: readonly string[];
  evidenceLabels: Record<string, string>;
  children: ReactNode;
}) {
  const params = crmNavigationParams(filters);
  if (initialPage.firstPage > 1) params.set("page", String(initialPage.firstPage));
  const href = params.size ? `/crm?${params.toString()}` : "/crm";
  const endpointParams = crmNavigationParams(filters).toString();
  const endpoint = `/api/navigation/${filters.duplicateView ? "crm-duplicates" : "crm"}/window${endpointParams ? `?${endpointParams}` : ""}`;
  const list = useWindowList({
    initialPage, scope, href, endpoint, rowIdKey: "id", emptyMeta: EMPTY_STATS,
  });
  const { rootRef, expandedIds, setExpandedIds } = list;
  useEffect(() => {
    for (const disclosure of rootRef.current?.querySelectorAll<HTMLDetailsElement>("details[data-crm-disclosure]") ?? []) {
      const open = expandedIds.includes(disclosure.dataset.crmDisclosure!)
        || disclosure.dataset.validationOpen === "true";
      if (disclosure.open !== open) disclosure.open = open;
    }
  }, [expandedIds, rootRef]);
  useEffect(() => {
    const root = rootRef.current;
    const onToggle = (event: Event) => {
      const disclosure = event.target;
      if (!(disclosure instanceof HTMLDetailsElement) || !disclosure.dataset.crmDisclosure) return;
      const id = disclosure.dataset.crmDisclosure;
      if (!disclosure.open) delete disclosure.dataset.validationOpen;
      setExpandedIds((ids) => disclosure.open ? [...new Set([...ids, id])] : ids.filter((value) => value !== id));
    };
    root?.addEventListener("toggle", onToggle, true);
    return () => root?.removeEventListener("toggle", onToggle, true);
  }, [rootRef, setExpandedIds]);
  const duplicateView = filters.duplicateView;
  const duplicateEntityType = filters.type;
  const CRM_EXPLORER_TYPES = identityTypes;
  const CRM_DUPLICATE_ENTITY_TYPES = duplicateTypes;
  const CRM_DUPLICATE_EVIDENCE_LABELS = evidenceLabels;
  const result = { ...list.page, ...filters, total: list.page.meta.total, stats: list.page.meta, rows: list.page.rows as CrmExplorerListItem[] };
  const duplicateResult = duplicateView
    ? { ...list.page, total: list.page.meta.total, ok: true, rows: list.page.rows as CrmDuplicateCandidateSummary[] }
    : null;
  const hasCurrentSummary = list.loadState === "idle" || list.loadState === "loading"
    || (list.loadState === "error" && list.page.rows.length > 0);
  const summaryValue = (value: number) => hasCurrentSummary ? value.toLocaleString() : "—";

  return (
    <div ref={list.rootRef} data-list-ready={list.ready} data-crm-progressive-list>
      <SummaryGrid>
        <StatTile label="CRM IDs" value={summaryValue(result.stats.identities)} />
        <StatTile label="Source aliases" value={summaryValue(result.stats.sourceAliases)} />
        <StatTile label="Open exceptions" value={summaryValue(result.stats.openExceptions)} />
        <StatTile label="Potential duplicates" value={summaryValue(result.stats.potentialDuplicates)} />
        <StatTile label="Latest registry sighting" value={hasCurrentSummary ? formatDate(result.stats.latestSeenAt) : "—"} />
      </SummaryGrid>

      {children}
      <Card className={styles.explorerCard}>
        <CardHeader className={styles.cardHeader}>
          <div>
            <h2>{duplicateView ? "Duplicate review" : "Identity registry"}</h2>
            <p className={styles.cardHint}>
              {duplicateView
                ? "Review duplicate signals and reversible AOA canonicalization without changing CRM."
                : "Search by a CRM ID or any existing system ID."}
            </p>
          </div>
          <Pill tone="gray">
            {hasCurrentSummary ? `${(duplicateResult?.ok ? duplicateResult.total : result.total).toLocaleString()} matching`
              : list.loadState === "restoring" ? "Loading totals…" : "Totals unavailable"}
          </Pill>
        </CardHeader>
        <CardBody>
          <form action="/crm" method="get" className={styles.filters}>
            <label className={styles.searchField}>
              <span>CRM or source ID</span>
              <input name="q" disabled={Boolean(duplicateView)} defaultValue={result.query} placeholder="hld_… or Salesforce / AOA ID" />
            </label>
            <label>
              <span>Type</span>
              <select name="type" defaultValue={(duplicateView ? duplicateEntityType : result.type) ?? ""}>
                <option value="">All types</option>
                {(duplicateView ? CRM_DUPLICATE_ENTITY_TYPES : CRM_EXPLORER_TYPES).map((value) => (
                  <option key={value} value={value}>{value.replaceAll("_", " ")}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Lifecycle</span>
              <select name="state" disabled={Boolean(duplicateView)} defaultValue={result.state ?? ""}>
                <option value="">All states</option>
                <option value="ACTIVE">Active</option>
                <option value="MERGED">Merged</option>
                <option value="ARCHIVED">Archived</option>
              </select>
            </label>
            <label>
              <span>Review view</span>
              <select name="duplicates" defaultValue={duplicateView ?? ""}>
                <option value="">Identity registry</option>
                <option value="potential">Potential duplicates</option>
                <option value="snoozed">Snoozed duplicates</option>
                <option value="confirmed">Confirmed duplicates</option>
                <option value="not_duplicate">Not duplicates</option>
                <option value="all">All duplicate decisions</option>
              </select>
            </label>
            <label>
              <span>Exception state</span>
              <select name="exceptions" disabled={Boolean(duplicateView)} defaultValue={result.exceptionsOnly ? "open" : ""}>
                <option value="">All records</option>
                <option value="open">Open exceptions</option>
              </select>
            </label>
            <button type="submit" className="btn">Apply</button>
            {(result.query || (duplicateView ? duplicateEntityType : result.type)
              || result.state || result.exceptionsOnly || duplicateView) && (
              <CrmExplorerLink href="/crm" className={styles.clear}>Clear</CrmExplorerLink>
            )}
          </form>

          {duplicateResult?.ok ? (
            duplicateResult.rows.length === 0 ? (hasCurrentSummary ? (
              <TableEmptyState
                title="No duplicate reviews match"
                hint={duplicateView === "potential"
                  ? "No active duplicate candidate currently needs attention."
                  : "Choose another review view to see other decisions."}
              />
            ) : null) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Records to compare</th>
                      <th>Scope</th>
                      <th>Why it was flagged</th>
                      <th>Review state</th>
                      <th><span className={styles.srOnly}>Review</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {duplicateResult.rows.map((candidate) => (
                      <tr key={candidate.id} data-list-row-id={candidate.id}>
                        <td>
                          <div className={styles.primary}>{candidate.leftName}</div>
                          <div className={styles.duplicateVersus}>compared with</div>
                          <div className={styles.primary}>{candidate.rightName}</div>
                        </td>
                        <td><Pill tone="blue">{candidate.entityType}</Pill></td>
                        <td>
                          <div className={styles.aliasList}>
                            {candidate.evidenceCodes.map((code) => (
                              <span key={code}>{CRM_DUPLICATE_EVIDENCE_LABELS[code]}</span>
                            ))}
                            {candidate.hardConflictCodes.length > 0 && (
                              <span className={styles.conflictText}>
                                {candidate.hardConflictCodes.length} blocking conflict
                                {candidate.hardConflictCodes.length === 1 ? "" : "s"}
                              </span>
                            )}
                            <span className={styles.learningNote}>
                              Shadow: {candidate.learning.recommendation === "CONFIRM_DUPLICATE"
                                ? "likely duplicate"
                                : candidate.learning.recommendation === "KEEP_SEPARATE"
                                  ? "likely separate"
                                  : "manual review"} · {candidate.learning.confidence.toLowerCase()} confidence
                            </span>
                          </div>
                        </td>
                        <td>
                          <Pill tone={candidate.status === "READY_FOR_FOLLOW_UP" ? "amber" : candidate.status === "NOT_DUPLICATE" ? "green" : "gray"}>
                            {duplicateStatusLabel(candidate.status)}
                          </Pill>
                        </td>
                        <td>
                          <CrmExplorerLink href={`/crm/duplicates/${encodeURIComponent(candidate.id)}`} onClick={(event) => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) list.rememberReturn(`/crm/duplicates/${encodeURIComponent(candidate.id)}`); }} className={styles.inspect}>
                            Compare →
                          </CrmExplorerLink>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : result.rows.length === 0 ? (hasCurrentSummary ? (
            <TableEmptyState
              title="No CRM identities match"
              hint="Clear or change the ID, type, lifecycle, or exception filters."
            />
          ) : null) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>CRM identity</th>
                    <th>Source aliases</th>
                    <th>Freshness</th>
                    <th>Issues</th>
                    <th><span className={styles.srOnly}>Open</span></th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row) => (
                    <tr key={row.id} data-list-row-id={row.id}>
                      <td>
                        <div className={styles.primary}>{labelFor(row)}</div>
                        <div className={styles.identityLine}>
                          <code>{row.id}</code>
                          <Pill tone="blue">{row.identityType}</Pill>
                          <Pill tone={stateTone(row.lifecycleState)}>{row.lifecycleState}</Pill>
                        </div>
                      </td>
                      <td>
                        <div className={styles.aliasList}>
                          {row.mappings.slice(0, 2).map((mapping) => (
                            <span key={mapping.id} title={mapping.sourceKey}>
                              <b>{mapping.sourceSystem}</b> · {mapping.sourceNamespace} · <code>{mapping.sourceKey}</code>
                            </span>
                          ))}
                          {row.aliasCount > 2 && <span>+{row.aliasCount - 2} more aliases</span>}
                        </div>
                      </td>
                      <td>{formatDate(row.latestSeenAt)}</td>
                      <td>
                        {row.openExceptionCount > 0
                          ? <Pill tone="red" dot>{row.openExceptionCount} open</Pill>
                          : <Pill tone="green">Clear</Pill>}
                      </td>
                      <td><CrmExplorerLink href={`/crm/${encodeURIComponent(row.id)}`} onClick={(event) => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) list.rememberReturn(`/crm/${encodeURIComponent(row.id)}`); }} className={styles.inspect}>Inspect →</CrmExplorerLink></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <WindowListControls state={list} label={duplicateView ? "Duplicate reviews" : "CRM identities"} href={href} total={list.page.meta.total} />
        </CardBody>
      </Card>

    </div>
  );
}
