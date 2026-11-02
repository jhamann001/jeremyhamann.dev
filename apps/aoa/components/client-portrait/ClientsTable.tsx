"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ClientDirectoryPage } from "@/lib/data/clients";
import { clientDirectorySearchParams } from "@/lib/navigation/client-query";
import { useProgressiveList } from "@/components/navigation/useProgressiveList";
import { ProgressiveListControls } from "@/components/navigation/ProgressiveListControls";
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
  type PillTone,
} from "@/components/ui";
import {
  clientStageKey,
  type ClientDirectoryFilters,
  type ClientDirectorySortKey,
  type ClientStageFilter,
} from "./directory-results";
import styles from "./ClientsTable.module.css";

const STAGE_META: Record<Exclude<ClientStageFilter, "all">, { tone: PillTone }> = {
  client: { tone: "green" },
  prospect: { tone: "gold" },
  lost_prospect: { tone: "gray" },
  lost_client: { tone: "red" },
};

function stageTone(stage: string | null): PillTone {
  const key = clientStageKey(stage);
  return key ? STAGE_META[key].tone : "gray";
}

const CHIPS: { key: ClientStageFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "client", label: "Clients" },
  { key: "prospect", label: "Prospects" },
  { key: "lost_prospect", label: "Lost Prospects" },
  { key: "lost_client", label: "Lost Clients" },
];

const DEFAULT_FILTERS: ClientDirectoryFilters = {
  query: "",
  stage: "client",
  sortKey: "name",
  sortDir: "asc",
};

const EMPTY_META = { counts: { all: 0, client: 0, prospect: 0, lost_prospect: 0, lost_client: 0 } };

export function ClientsTable({
  initialDirectory, initialFilters, scope,
}: {
  initialDirectory: ClientDirectoryPage;
  initialFilters: ClientDirectoryFilters;
  scope: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [filters, setFilters] = useState(initialFilters);
  const [isPending, startTransition] = useTransition();
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { query, stage, sortKey, sortDir } = filters;
  const href = hrefFor(initialFilters, initialDirectory.page);
  const list = useProgressiveList({
    initialPage: { ...initialDirectory, meta: { counts: initialDirectory.counts } },
    scope, href, endpoint: `/api/navigation/clients?${clientDirectorySearchParams(initialFilters)}`,
    rowIdKey: "sf_id", emptyMeta: EMPTY_META,
  });
  const { rows, meta: { counts } } = list.page;

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setFilters(initialFilters);
  }, [initialFilters]);

  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
  }, []);

  function hrefFor(next: ClientDirectoryFilters, nextPage = 1) {
    const params = clientDirectorySearchParams(next);
    if (nextPage > 1) params.set("page", String(nextPage));
    const queryString = params.toString();
    return queryString ? `${pathname}?${queryString}` : pathname;
  }

  function navigate(next: ClientDirectoryFilters, nextPage = 1, debounce = false) {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    list.pause();
    const run = () => startTransition(() => {
      const nextHref = hrefFor(next, nextPage);
      if (!isPending && nextHref === href) { setFilters(initialFilters); list.resume(); return; }
      router.push(nextHref, { scroll: false });
    });
    if (debounce) searchTimer.current = setTimeout(run, 300);
    else run();
  }

  function patchFilters(
    patch: Partial<ClientDirectoryFilters>,
    options: { debounce?: boolean } = {},
  ) {
    const next = { ...filters, ...patch };
    setFilters(next);
    navigate(next, 1, options.debounce);
  }

  function toggleSort(key: ClientDirectorySortKey) {
    if (key === sortKey) {
      patchFilters({ sortDir: sortDir === "asc" ? "desc" : "asc" });
    } else {
      patchFilters({ sortKey: key, sortDir: "asc" });
    }
  }

  const sortArrow = (key: ClientDirectorySortKey) =>
    sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "";

  return (
    <div ref={list.rootRef} data-list-ready={list.ready ? "true" : "false"}><Card className={isPending ? styles.pendingCard : undefined} aria-busy={isPending || list.loadState === "restoring"}>
      <CardHeader className={styles.toolbar}>
        <input
          className={styles.search}
          type="search"
          placeholder="Search clients, household, or advisor…"
          value={query}
          onChange={(event) => patchFilters({ query: event.target.value }, { debounce: true })}
          aria-label="Search clients"
        />
        <div className={styles.chips} role="group" aria-label="Filter by stage">
          {CHIPS.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className={`${styles.chip} ${stage === chip.key ? styles.chipActive : ""}`.trim()}
              onClick={() => patchFilters({ stage: chip.key })}
              aria-pressed={stage === chip.key}
            >
              {chip.label} <span className={styles.chipCount}>{counts[chip.key]}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className={styles.clearButton}
          onClick={() => {
            setFilters(DEFAULT_FILTERS);
            navigate(DEFAULT_FILTERS);
          }}
          disabled={
            query === DEFAULT_FILTERS.query &&
            stage === DEFAULT_FILTERS.stage &&
            sortKey === DEFAULT_FILTERS.sortKey &&
            sortDir === DEFAULT_FILTERS.sortDir
          }
        >
          Clear filters
        </button>
        {isPending ? <span className={styles.updating} role="status">Updating…</span> : null}
      </CardHeader>

      {rows.length === 0 ? (
        <div style={{ padding: 18 }}>
          {list.loadState === "idle" ? <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>No clients match.</p> : null}
        </div>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH><button type="button" className={styles.sortBtn} onClick={() => toggleSort("name")}>Client{sortArrow("name")}</button></TH>
              <TH><button type="button" className={styles.sortBtn} onClick={() => toggleSort("household")}>Household{sortArrow("household")}</button></TH>
              <TH>Stage</TH>
              <TH>Advisor</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((client) => (
              <TR key={client.sf_id} data-list-row-id={client.sf_id}>
                <TD>
                  <Link className={styles.rowLink} href={`/client-portrait/${client.sf_id}`} prefetch={false} onClick={() => list.rememberReturn(`/client-portrait/${client.sf_id}`)}>
                    {client.name || "—"} <span aria-hidden="true">›</span>
                  </Link>
                  {client.employeeStatus ? (
                    <span style={{ marginLeft: 8 }}>
                      <Pill tone={client.employeeStatus === "ACTIVE" ? "green" : "gray"}>
                        {client.employeeStatus === "ACTIVE" ? "Employee" : "Former employee"}
                      </Pill>
                    </span>
                  ) : null}
                </TD>
                <TD>
                  {client.household_id && client.household_name ? (
                    <Link className={styles.hhLink} href={`/households/${client.household_id}`} prefetch={false} onClick={() => list.rememberReturn(`/households/${client.household_id}`)}>
                      {client.household_name}
                    </Link>
                  ) : (
                    <span style={{ color: "var(--faint)" }}>—</span>
                  )}
                </TD>
                <TD>
                  {client.household_stage ? (
                    <Pill tone={stageTone(client.household_stage)} dot>{client.household_stage}</Pill>
                  ) : (
                    <span style={{ color: "var(--faint)" }}>—</span>
                  )}
                </TD>
                <TD style={{ color: "var(--muted)" }}>
                  {client.advisor_name ?? client.lead_advisor_email ?? "—"}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      <ProgressiveListControls state={list} label="Clients" href={href} />
    </Card></div>
  );
}
