import type { AssigneeOption, TicketListQuery } from "@/types/domain";
import {
  BRAND_LABELS,
  CATEGORY_LABELS,
  QUEUE_LABELS,
  SOURCE_LABELS,
} from "@/types/domain";
import { PRIORITY_LABELS, SLA_LABELS, STATUS_LABELS } from "@/lib/format";
import {
  COMPLAINT_FILTER_LABELS,
  DEFAULT_DIR,
  DEFAULT_SORT,
  DEFAULT_STATUS_FILTER,
  FOLLOW_UP_FILTER_LABELS,
  SORT_LABELS,
  isoEndExclusiveToDateInput,
  isoToDateInput,
  sameSet,
} from "@/components/dashboard/ticket-query-params";

/**
 * The active-filter chip set for a ticket list query — pure, so the one rule that matters can be
 * unit tested in the repo's `node` environment: **every predicate `ticketQueryToParams` serializes
 * has a chip here.** A serialized filter with no chip is invisible on a phone (no chip row, no count
 * on the Filters trigger, and `FilterSheet` hides "Clear all" at `activeCount === 0`), which leaves an
 * operator looking at a short list with no control anywhere that can remove the filter — the exact
 * failure `brand` and `source` had before this module existed.
 *
 * `next` is the query to write when the chip's × is tapped. The caller's `write()` resets `page`, so
 * these specs never carry pagination.
 */
export type TicketFilterChipSpec = {
  key: string;
  label: string;
  /** The query that remains after removing this chip. */
  next: TicketListQuery;
};

export type TicketFilterChipOptions = {
  /** False on a pinned-queue route: the queue is route context, not a removable filter. */
  showQueue: boolean;
  assignees: readonly AssigneeOption[];
  /**
   * Display name for an active `requesterExternalId` filter. The id itself is opaque and means nothing
   * to a reader, and the whole point of filtering by it is that the client's ADDRESS stays out of the
   * URL — so the chip shows the name the caller resolved from the rows, never the id and never the
   * address. Absent → the same neutral wording `assigneeFilterLabel` falls back to.
   */
  requesterName?: string;
};

/** Drop a key when the remaining list is empty, so the URL matches a never-set filter exactly. */
function withList<K extends "status" | "priority" | "slaStatus" | "category" | "brand" | "source">(
  query: TicketListQuery,
  key: K,
  next: NonNullable<TicketListQuery[K]>,
): TicketListQuery {
  const q: TicketListQuery = { ...query };
  if (next.length > 0) q[key] = next;
  else delete q[key];
  return q;
}

function withoutKey(query: TicketListQuery, key: keyof TicketListQuery): TicketListQuery {
  const q: TicketListQuery = { ...query };
  delete q[key];
  return q;
}

/** Never the id, never the address — see `TicketFilterChipOptions.requesterName`. */
export function requesterFilterLabel(name: string | undefined): string {
  const trimmed = name?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "Selected client";
}

export function assigneeFilterLabel(id: string, assignees: readonly AssigneeOption[]): string {
  if (id === "me") return "Assigned to me";
  if (id === "unassigned") return "Unassigned";
  const who = assignees.find((a) => a.id === id);
  if (!who) return "Selected user";
  return who.name?.trim() || who.email;
}

export function buildTicketFilterChips(
  query: TicketListQuery,
  opts: TicketFilterChipOptions,
): TicketFilterChipSpec[] {
  const chips: TicketFilterChipSpec[] = [];
  const statuses = query.status ?? DEFAULT_STATUS_FILTER;
  const priorities = query.priority ?? [];
  const slaStatuses = query.slaStatus ?? [];
  const categories = query.category ?? [];
  const brands = query.brand ?? [];
  const sources = query.source ?? [];

  if (!sameSet(statuses, DEFAULT_STATUS_FILTER)) {
    for (const s of statuses) {
      chips.push({
        key: `status:${s}`,
        label: STATUS_LABELS[s],
        next: withList(query, "status", statuses.filter((v) => v !== s)),
      });
    }
  }
  for (const p of priorities) {
    chips.push({
      key: `priority:${p}`,
      label: PRIORITY_LABELS[p],
      next: withList(query, "priority", priorities.filter((v) => v !== p)),
    });
  }
  for (const s of slaStatuses) {
    chips.push({
      key: `sla:${s}`,
      label: `SLA ${SLA_LABELS[s]}`,
      next: withList(query, "slaStatus", slaStatuses.filter((v) => v !== s)),
    });
  }
  if (query.assigneeId !== undefined && query.assigneeId.length > 0) {
    chips.push({
      key: "assignee",
      label: assigneeFilterLabel(query.assigneeId, opts.assignees),
      next: withoutKey(query, "assigneeId"),
    });
  }
  if (opts.showQueue && query.queueKey !== undefined) {
    chips.push({ key: "queue", label: QUEUE_LABELS[query.queueKey], next: withoutKey(query, "queueKey") });
  }
  for (const c of categories) {
    chips.push({
      key: `category:${c}`,
      label: CATEGORY_LABELS[c],
      next: withList(query, "category", categories.filter((v) => v !== c)),
    });
  }
  for (const b of brands) {
    chips.push({
      key: `brand:${b}`,
      label: BRAND_LABELS[b],
      next: withList(query, "brand", brands.filter((v) => v !== b)),
    });
  }
  for (const s of sources) {
    chips.push({
      key: `source:${s}`,
      label: `Source: ${SOURCE_LABELS[s]}`,
      next: withList(query, "source", sources.filter((v) => v !== s)),
    });
  }
  if (query.isComplaint !== undefined) {
    chips.push({
      key: "complaint",
      label: query.isComplaint ? COMPLAINT_FILTER_LABELS.yes : COMPLAINT_FILTER_LABELS.no,
      next: withoutKey(query, "isComplaint"),
    });
  }
  if (query.followUp !== undefined) {
    chips.push({
      key: "followUp",
      label: `Follow-up ${FOLLOW_UP_FILTER_LABELS[query.followUp].toLowerCase()}`,
      next: withoutKey(query, "followUp"),
    });
  }
  if (query.createdFrom !== undefined) {
    chips.push({
      key: "createdFrom",
      label: `Created from ${isoToDateInput(query.createdFrom)}`,
      next: withoutKey(query, "createdFrom"),
    });
  }
  if (query.createdTo !== undefined) {
    chips.push({
      key: "createdTo",
      label: `Created to ${isoEndExclusiveToDateInput(query.createdTo)}`,
      next: withoutKey(query, "createdTo"),
    });
  }
  if (query.requesterEmail !== undefined && query.requesterEmail.length > 0) {
    chips.push({
      key: "requesterEmail",
      label: `Requester ${query.requesterEmail}`,
      next: withoutKey(query, "requesterEmail"),
    });
  }
  if (query.requesterExternalId !== undefined && query.requesterExternalId.length > 0) {
    chips.push({
      key: "requesterExternalId",
      label: `Requester ${requesterFilterLabel(opts.requesterName)}`,
      next: withoutKey(query, "requesterExternalId"),
    });
  }
  if (query.sort !== DEFAULT_SORT || query.dir !== DEFAULT_DIR) {
    chips.push({
      key: "sort",
      label: `Sort: ${SORT_LABELS[query.sort]} ${query.dir === "asc" ? "↑" : "↓"}`,
      next: { ...query, sort: DEFAULT_SORT, dir: DEFAULT_DIR },
    });
  }
  return chips;
}
