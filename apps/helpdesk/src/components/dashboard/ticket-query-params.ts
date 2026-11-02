import type {
  FollowUpFilter,
  TicketExportScope,
  TicketListQuery,
  TicketSort,
  TicketStatus,
} from "@/types/domain";
import { OPEN_STATUSES } from "@/types/domain";

/**
 * The single URL writer for every ticket-list surface (docs/MOBILE_FIRST.md R7, docs/ARCHITECTURE.md §g
 * shared convention 12). Extracted from `ticket-filters.tsx` in Wave A so the serializer — which now
 * carries eight more filters and feeds the CSV export route as well as the dashboard — can be unit
 * tested in the repo's `node` vitest environment without importing a client component. `ticket-filters.tsx`
 * re-exports everything here, so existing import paths are unchanged.
 *
 * Mirrors the reader defaults in `parseTicketListQuery`: sort "resolutionDueAt", dir "asc", page 1,
 * pageSize 50, status = every status except CLOSED. Values equal to a default are omitted so the URL
 * stays short and a hand-typed URL round-trips unchanged.
 */

export const DEFAULT_SORT: TicketSort = "resolutionDueAt";
export const DEFAULT_DIR = "asc";
export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_STATUS_FILTER: readonly TicketStatus[] = [...OPEN_STATUSES, "RESOLVED"];
export const PAGE_SIZE_OPTIONS: readonly number[] = [25, 50, 100, 200];

/** The staff CSV export route (S6 owns the handler). */
export const TICKET_EXPORT_PATH = "/api/tickets/export";

export function sameSet<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((v) => set.has(v));
}

export type TicketQueryParamOptions = {
  includeQueueKey: boolean;
  /** false drops page/pageSize — the export covers the whole filtered set, not the page on screen. */
  includePagination?: boolean;
};

/**
 * Convention 12: multi-value keys (`status`, `priority`, `slaStatus`, and the Wave A `category` /
 * `brand` / `source`) are written as REPEATED BARE KEYS through `URLSearchParams.append`.
 * `queueKey` is dropped on a queue page (the route pins it).
 */
export function ticketQueryToParams(q: TicketListQuery, opts: TicketQueryParamOptions): URLSearchParams {
  const p = new URLSearchParams();
  if (opts.includeQueueKey && q.queueKey !== undefined) p.set("queueKey", q.queueKey);
  const statuses = q.status ?? [];
  if (statuses.length > 0 && !sameSet(statuses, DEFAULT_STATUS_FILTER)) {
    for (const s of statuses) p.append("status", s);
  }
  for (const v of q.priority ?? []) p.append("priority", v);
  for (const v of q.slaStatus ?? []) p.append("slaStatus", v);
  // --- Wave A filters. Same repeated-bare-key convention; every one is omitted when unset. ---
  for (const v of q.category ?? []) p.append("category", v);
  for (const v of q.brand ?? []) p.append("brand", v);
  for (const v of q.source ?? []) p.append("source", v);
  if (q.isComplaint !== undefined) p.set("isComplaint", q.isComplaint ? "true" : "false");
  if (q.followUp !== undefined) p.set("followUp", q.followUp);
  if (q.createdFrom !== undefined && q.createdFrom.length > 0) p.set("createdFrom", q.createdFrom);
  if (q.createdTo !== undefined && q.createdTo.length > 0) p.set("createdTo", q.createdTo);
  const requesterEmail = q.requesterEmail?.trim() ?? "";
  if (requesterEmail.length > 0) p.set("requesterEmail", requesterEmail.toLowerCase());
  // The opaque form of the same filter, and the one the ticket header prefers: an advisor platform person pointer
  // is safe in a URL, an access log and browser history; a client's address is not.
  const requesterExternalId = q.requesterExternalId?.trim() ?? "";
  if (requesterExternalId.length > 0) p.set("requesterExternalId", requesterExternalId);
  if (q.assigneeId !== undefined && q.assigneeId.length > 0) p.set("assigneeId", q.assigneeId);
  const search = q.search?.trim() ?? "";
  if (search.length > 0) p.set("search", search);
  if (q.sort !== DEFAULT_SORT) p.set("sort", q.sort);
  if (q.dir !== DEFAULT_DIR) p.set("dir", q.dir);
  if (opts.includePagination !== false) {
    if (q.page > 1) p.set("page", String(q.page));
    if (q.pageSize !== DEFAULT_PAGE_SIZE) p.set("pageSize", String(q.pageSize));
  }
  return p;
}

export function ticketQueryHref(pathname: string, q: TicketListQuery, opts: TicketQueryParamOptions): string {
  const qs = ticketQueryToParams(q, opts).toString();
  return qs.length > 0 ? `${pathname}?${qs}` : pathname;
}

/** True when any non-default filter is active (used for the "Clear" affordance). */
export function hasActiveFilters(q: TicketListQuery, opts: { includeQueueKey: boolean }): boolean {
  const p = ticketQueryToParams(
    { ...q, page: 1, pageSize: DEFAULT_PAGE_SIZE, sort: DEFAULT_SORT, dir: DEFAULT_DIR },
    opts,
  );
  return [...p.keys()].length > 0;
}

/**
 * Href for the staff CSV export. The queue key always travels — the export route has no pinned-queue
 * route context to fall back on — and pagination never does, so the file covers the whole filtered set
 * exactly like the audit export does. `scope: "full"` (compliance only) is written; "standard" is the
 * route's default and stays out of the URL.
 */
export function ticketExportHref(q: TicketListQuery, scope: TicketExportScope = "standard"): string {
  const p = ticketQueryToParams(q, { includeQueueKey: true, includePagination: false });
  if (scope === "full") p.set("scope", "full");
  const qs = p.toString();
  return qs.length > 0 ? `${TICKET_EXPORT_PATH}?${qs}` : TICKET_EXPORT_PATH;
}

// ---------------------------------------------------------------------------
// Created-date range: <input type="date"> (local calendar days) ⇄ ISO instants
// ---------------------------------------------------------------------------
//
// `createdFrom` is an INCLUSIVE lower bound and `createdTo` an EXCLUSIVE upper bound (@/types/domain).
// An operator picking "19 Sep" as the end of the range means "include everything that happened on the
// 19th", so the exclusive bound is local midnight of the 20th. These four helpers are the only place
// that arithmetic lives, in both directions, so the control round-trips its own URL.

const DATE_INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function localMidnight(y: number, m1: number, d: number): Date {
  return new Date(y, m1 - 1, d, 0, 0, 0, 0);
}

function parseDateInput(value: string): { y: number; m: number; d: number } | null {
  const m = DATE_INPUT_PATTERN.exec(value.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const probe = localMidnight(y, mo, d);
  // Rejects 2026-02-31 and friends: the Date constructor rolls them over.
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return null;
  return { y, m: mo, d };
}

function toDateInput(at: Date): string {
  const y = String(at.getFullYear()).padStart(4, "0");
  const m = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** "2026-09-19" → local midnight of the 19th, as an ISO instant. Empty/invalid → undefined. */
export function dateInputToIsoStart(value: string): string | undefined {
  const p = parseDateInput(value);
  if (!p) return undefined;
  return localMidnight(p.y, p.m, p.d).toISOString();
}

/** "2026-09-19" → local midnight of the 20th (exclusive upper bound). Empty/invalid → undefined. */
export function dateInputToIsoEndExclusive(value: string): string | undefined {
  const p = parseDateInput(value);
  if (!p) return undefined;
  const at = localMidnight(p.y, p.m, p.d);
  at.setDate(at.getDate() + 1);
  return at.toISOString();
}

/** ISO instant → the local calendar day, for the `from` input. */
export function isoToDateInput(iso: string | undefined): string {
  if (iso === undefined || iso.length === 0) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return toDateInput(new Date(ms));
}

/** Exclusive ISO upper bound → the last INCLUDED local calendar day, for the `to` input. */
export function isoEndExclusiveToDateInput(iso: string | undefined): string {
  if (iso === undefined || iso.length === 0) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const at = new Date(ms);
  at.setDate(at.getDate() - 1);
  return toDateInput(at);
}

// ---------------------------------------------------------------------------
// Labels for the Wave A filter controls
// ---------------------------------------------------------------------------

/**
 * Sort labels. They live here rather than in the client component so the chip builder
 * (`ticket-filter-chips.ts`) and its unit tests can read them without importing a `"use client"` module.
 */
export const SORT_LABELS: Readonly<Record<TicketSort, string>> = {
  resolutionDueAt: "SLA due",
  createdAt: "Created",
  updatedAt: "Updated",
  priority: "Priority",
};

export const FOLLOW_UP_FILTER_LABELS: Readonly<Record<FollowUpFilter, string>> = {
  due: "Due",
  overdue: "Overdue",
  any: "Any date",
};

export const COMPLAINT_FILTER_LABELS: Readonly<Record<"yes" | "no", string>> = {
  yes: "Complaints",
  no: "Not complaints",
};
