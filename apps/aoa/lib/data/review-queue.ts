import "server-only";

import { Prisma, type ReviewQueueSource, type ReviewQueueStatus } from "@prisma/client";
import { reviewQueueEnabled } from "@/lib/flags";
import { withUserScope, type Identity } from "@/lib/rls";

export const REVIEW_QUEUE_ROLES = new Set(["ADMIN", "OPERATIONS"]);
export const REVIEW_QUEUE_PAGE_SIZE = 50;

export function canManageReviewQueue(role: string | null | undefined): boolean {
  return REVIEW_QUEUE_ROLES.has(role ?? "");
}

export type ReviewQueueQuery = {
  page?: number;
  source?: string;
  type?: string;
  status?: string;
  owner?: string;
  age?: number;
  includeCleared?: boolean;
};

export type ReviewQueueRow = {
  id: string;
  source: ReviewQueueSource;
  type: string;
  summary: string;
  href: string;
  status: ReviewQueueStatus;
  sourceActive: boolean;
  assignedTo: string | null;
  resolutionNote: string;
  snoozedUntil: string | null;
  detectedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  updatedAt: string;
  snapshot: { accountLast4?: string; candidateCount?: number; accountCount?: number; reasonCode?: string; identityType?: string };
  history: Array<{
    id: string;
    action: string;
    actorEmail: string | null;
    fromStatus: ReviewQueueStatus | null;
    toStatus: ReviewQueueStatus | null;
    fromAssignee: string | null;
    toAssignee: string | null;
    at: string;
  }>;
};

export type ReviewQueueFreshness = {
  state: "NOT_RUN" | "RUNNING" | "PROGRESSING" | "FRESH" | "STALE" | "FAILED";
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastFailureAt: string | null;
  lastFailureSource: string | null;
};

export const REVIEW_QUEUE_STALE_AFTER_MS = 2 * 60 * 60_000;
export const REVIEW_QUEUE_PROGRESS_STALE_AFTER_MS = 20 * 60_000;

export function classifyReviewQueueFreshness(
  sweep: {
    last_started_at: Date | null;
    last_completed_at: Date | null;
    last_failure_at: Date | null;
    last_failure_source: string | null;
    lease_expires_at: Date | null;
    trade_cursor: string | null;
    crm_cursor: string | null;
    trade_complete: boolean;
    crm_complete: boolean;
  } | null,
  now = new Date(),
): ReviewQueueFreshness {
  const lastStartedAt = sweep?.last_started_at ?? null;
  const lastCompletedAt = sweep?.last_completed_at ?? null;
  const lastFailureAt = sweep?.last_failure_at ?? null;
  const checkpointInProgress = Boolean(
    sweep && (
      sweep.trade_cursor ||
      sweep.crm_cursor ||
      sweep.trade_complete ||
      sweep.crm_complete
    ),
  );
  const recentProgress = lastStartedAt != null &&
    now.getTime() - lastStartedAt.getTime() <= REVIEW_QUEUE_PROGRESS_STALE_AFTER_MS;
  const latestAttemptFailed = lastFailureAt != null &&
    (!lastStartedAt || lastFailureAt >= lastStartedAt);
  const state = !sweep || (!lastStartedAt && !lastCompletedAt)
    ? "NOT_RUN"
    : sweep.lease_expires_at != null && sweep.lease_expires_at > now
      ? "RUNNING"
      : latestAttemptFailed
        ? "FAILED"
        : checkpointInProgress && recentProgress
          ? "PROGRESSING"
          : !lastCompletedAt || now.getTime() - lastCompletedAt.getTime() > REVIEW_QUEUE_STALE_AFTER_MS
            ? "STALE"
            : "FRESH";
  return {
    state,
    lastStartedAt: lastStartedAt?.toISOString() ?? null,
    lastCompletedAt: lastCompletedAt?.toISOString() ?? null,
    lastFailureAt: lastFailureAt?.toISOString() ?? null,
    lastFailureSource: sweep?.last_failure_source ?? null,
  };
}

const SOURCES = new Set<ReviewQueueSource>(["TRADE_REQUEST", "CRM_IDENTITY"]);
const STATUSES = new Set<ReviewQueueStatus>(["NEW", "IN_REVIEW", "RESOLVED", "SNOOZED"]);

function safeSource(value?: string): ReviewQueueSource | undefined {
  return SOURCES.has(value as ReviewQueueSource) ? value as ReviewQueueSource : undefined;
}
function safeStatus(value?: string): ReviewQueueStatus | undefined {
  return STATUSES.has(value as ReviewQueueStatus) ? value as ReviewQueueStatus : undefined;
}
function safeType(value?: string): string | undefined {
  const trimmed = value?.trim() ?? "";
  return /^[A-Z0-9_]{1,64}$/.test(trimmed) ? trimmed : undefined;
}
function safeOwner(value?: string): string | undefined {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return trimmed === "unassigned" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)
    ? trimmed.slice(0, 320)
    : undefined;
}

export async function listReviewQueue(identity: Identity, query: ReviewQueueQuery = {}) {
  if (!canManageReviewQueue(identity.role)) return { ok: false as const, reason: "forbidden" as const };
  if (!reviewQueueEnabled()) return { ok: false as const, reason: "disabled" as const };

  const page = Math.max(1, Math.floor(query.page || 1));
  const source = safeSource(query.source);
  const status = safeStatus(query.status);
  const type = safeType(query.type);
  const owner = safeOwner(query.owner);
  const age = [7, 30, 90].includes(query.age ?? 0) ? query.age : undefined;
  const includeCleared = query.includeCleared === true;
  const cutoff = age ? new Date(Date.now() - age * 86_400_000) : undefined;

  const now = new Date();
  const statusWhere: Prisma.ReviewQueueItemWhereInput = status === "NEW"
    ? { OR: [{ status: "NEW" }, { status: "SNOOZED", snoozed_until: { lte: now } }] }
    : status
      ? { status }
      : { OR: [{ status: { not: "SNOOZED" } }, { snoozed_until: { lte: now } }] };
  const where: Prisma.ReviewQueueItemWhereInput = {
    ...(includeCleared ? {} : { source_active: true }),
    ...statusWhere,
    ...(source ? { source } : {}),
    ...(type ? { exception_type: type } : {}),
    ...(owner === "unassigned"
      ? { assigned_to: null }
      : owner
        ? { assigned_to: owner }
        : {}),
    ...(cutoff ? { detected_at: { lte: cutoff } } : {}),
  };

  return withUserScope(identity, async (tx) => {
    const [total, rows, facets, sweep] = await Promise.all([
      tx.reviewQueueItem.count({ where }),
      tx.reviewQueueItem.findMany({
        where,
        orderBy: [{ source_active: "desc" }, { detected_at: "asc" }, { id: "asc" }],
        skip: (page - 1) * REVIEW_QUEUE_PAGE_SIZE,
        take: REVIEW_QUEUE_PAGE_SIZE,
        include: { events: { orderBy: { at: "desc" }, take: 8 } },
      }),
      tx.reviewQueueItem.findMany({
        where: { source_active: true },
        distinct: ["exception_type"],
        select: { exception_type: true },
        orderBy: { exception_type: "asc" },
      }),
      tx.reviewQueueSweepState.findUnique({ where: { id: "default" } }),
    ]);
    const owners = await tx.reviewQueueItem.findMany({
      where: { source_active: true, assigned_to: { not: null } },
      distinct: ["assigned_to"],
      select: { assigned_to: true },
      orderBy: { assigned_to: "asc" },
    });

    return {
      ok: true as const,
      total,
      page,
      pageCount: Math.max(1, Math.ceil(total / REVIEW_QUEUE_PAGE_SIZE)),
      pageSize: REVIEW_QUEUE_PAGE_SIZE,
      filters: { source, status, type, owner, age, includeCleared },
      types: facets.map((row) => row.exception_type),
      owners: owners.flatMap((row) => row.assigned_to ? [row.assigned_to] : []),
      freshness: classifyReviewQueueFreshness(sweep),
      rows: rows.map((row): ReviewQueueRow => ({
        id: row.id,
        source: row.source,
        type: row.exception_type,
        summary: row.summary,
        href: row.resolution_href,
        status:
          row.status === "SNOOZED" &&
          row.snoozed_until != null &&
          row.snoozed_until <= now &&
          status !== "SNOOZED"
            ? "NEW"
            : row.status,
        sourceActive: row.source_active,
        assignedTo: row.assigned_to,
        resolutionNote: row.resolution_note,
        snoozedUntil: row.snoozed_until?.toISOString() ?? null,
        detectedAt: row.detected_at.toISOString(),
        lastSeenAt: row.last_seen_at.toISOString(),
        resolvedAt: row.resolved_at?.toISOString() ?? null,
        updatedAt: row.updated_at.toISOString(),
        snapshot: (row.source_snapshot ?? {}) as ReviewQueueRow["snapshot"],
        history: row.events.map((event) => {
          const detail = event.detail as {
            fromAssignee?: unknown;
            toAssignee?: unknown;
          } | null;
          return {
            id: event.id.toString(),
            action: event.action,
            actorEmail: event.actor_email,
            fromStatus: event.from_status,
            toStatus: event.to_status,
            fromAssignee:
              typeof detail?.fromAssignee === "string" ? detail.fromAssignee : null,
            toAssignee:
              typeof detail?.toAssignee === "string" ? detail.toAssignee : null,
            at: event.at.toISOString(),
          };
        }),
      })),
    };
  });
}
