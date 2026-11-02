import "server-only";

import {
  CRM_IDENTITY_RECONCILE,
  FEED_HEALTH,
  INGEST_ACCOUNT_AUM,
  INGEST_ZENDESK_TICKETS,
} from "@/lib/audit";
import {
  checkExternalFundingAvailability,
  getExternalFundingSourceDate,
} from "@/lib/data/account-funding";
import { checkAumFreshness } from "@/lib/data/feed-health";
import { classifyReviewQueueFreshness } from "@/lib/data/review-queue";
import {
  dataHealthEnabled,
  crmIdentityReadsEnabled,
  reviewQueueEnabled,
  reviewQueueSchedulerActive,
} from "@/lib/flags";
import { withUserScope, type Identity } from "@/lib/rls";
import { previousTradingDay, toDateStr } from "@/lib/market-calendar";
import {
  evaluateAumCompletion,
  evaluateHourlyWeekdayCompletion,
  evaluateScheduledSource,
  evaluateUnverifiedSchedule,
  isWeekdayRunDue,
  type SourceHealthStatus,
} from "./source-health-evaluation";

export const SOURCE_HEALTH_ROLES: ReadonlySet<string> = new Set([
  "ADMIN",
  "OPERATIONS",
]);

const CRM_HOURLY_GRACE_MINUTES = 15;

export function canViewSourceHealth(role: string | null | undefined): boolean {
  return SOURCE_HEALTH_ROLES.has(role ?? "");
}

export type SourceHealthRow = {
  key: "ACCOUNT_AUM" | "CRM_IDENTITY" | "TRADE_REQUEST" | "EXTERNAL_FUNDING" | "ZENDESK";
  label: string;
  source: string;
  status: SourceHealthStatus;
  statusReason: string;
  coverage: string;
  businessAsOf: string | null;
  expectedBusinessAsOf: string | null;
  latestSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastFailureAt: string | null;
  availabilityCheckedAt: string | null;
  latestSuccessLabel?: string;
  lastAttemptLabel?: string;
  attemptEvidence: string;
  detail: string;
  actionHref: string | null;
  actionLabel: string | null;
  reviewQueueSource: "TRADE_REQUEST" | "CRM_IDENTITY" | null;
  metrics?: Array<{ label: string; value: string; tone?: "green" | "amber" | "red" }>;
};

export type SourceHealthResult =
  | {
      ok: true;
      generatedAt: string;
      rows: SourceHealthRow[];
      warnings: string[];
    }
  | { ok: false; reason: "forbidden" | "disabled" };

type AuditEvidence = {
  action: string;
  at: Date;
  detail: string | null;
};

type LocalOperationalEvidence = {
  aumAudits: AuditEvidence[];
  aumWarning: AuditEvidence | null;
  crmSuccess: AuditEvidence | null;
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
  } | null;
};

type ZendeskOperationalEvidence = {
  audits: AuditEvidence[];
  aggregate: {
    ticket_count: number;
    comment_count: number;
    linked_count: number;
    unmatched_count: number;
    ambiguous_count: number;
    truncated_count: number;
    latest_source_update: Date | null;
    latest_mirror_write: Date | null;
  } | null;
};

const iso = (value: Date | null | undefined): string | null =>
  value?.toISOString() ?? null;

function positiveAumCommit(row: AuditEvidence): boolean {
  if (!row.detail) return false;
  try {
    const detail: unknown = JSON.parse(row.detail);
    if (!detail || typeof detail !== "object") return false;
    const upserted = (detail as Record<string, unknown>).upserted;
    return typeof upserted === "number" && Number.isInteger(upserted) && upserted > 0;
  } catch {
    return false;
  }
}

function zendeskAuditDetail(row: AuditEvidence): {
  dryRun: boolean;
  rejected: number;
} | null {
  if (!row.detail) return null;
  try {
    const detail: unknown = JSON.parse(row.detail);
    if (!detail || typeof detail !== "object") return null;
    const record = detail as Record<string, unknown>;
    const rejected = record.rejected;
    if (typeof rejected !== "number" || !Number.isInteger(rejected) || rejected < 0) {
      return null;
    }
    return { dryRun: record.dry_run === true, rejected };
  } catch {
    return null;
  }
}

function committedZendeskBatch(row: AuditEvidence): boolean {
  const detail = zendeskAuditDetail(row);
  return detail != null && !detail.dryRun && detail.rejected === 0;
}

function attemptedZendeskBatch(row: AuditEvidence): boolean {
  const detail = zendeskAuditDetail(row);
  return detail != null && !detail.dryRun;
}

async function readLocalOperationalEvidence(
  identity: Identity,
): Promise<LocalOperationalEvidence> {
  return withUserScope(identity, async (tx) => {
    // One bounded lookup per action prevents a noisy warning action from
    // crowding a quieter source's latest success out of a shared LIMIT.
    const [aumAudits, aumWarning, crmSuccess, sweep] = await Promise.all([
      tx.auditLog.findMany({
        where: { action: INGEST_ACCOUNT_AUM },
        orderBy: [{ at: "desc" }, { id: "desc" }],
        take: 32,
        select: { action: true, at: true, detail: true },
      }),
      tx.auditLog.findFirst({
        where: {
          action: FEED_HEALTH,
          entityType: "feed_health",
          entityId: "account-aum",
        },
        orderBy: [{ at: "desc" }, { id: "desc" }],
        select: { action: true, at: true, detail: true },
      }),
      tx.auditLog.findFirst({
        where: { action: CRM_IDENTITY_RECONCILE },
        orderBy: [{ at: "desc" }, { id: "desc" }],
        select: { action: true, at: true, detail: true },
      }),
      tx.reviewQueueSweepState.findUnique({
        where: { id: "default" },
        select: {
          last_started_at: true,
          last_completed_at: true,
          last_failure_at: true,
          last_failure_source: true,
          lease_expires_at: true,
          trade_cursor: true,
          crm_cursor: true,
          trade_complete: true,
          crm_complete: true,
        },
      }),
    ]);
    return {
      aumAudits,
      aumWarning,
      crmSuccess,
      sweep,
    };
  });
}

async function readZendeskOperationalEvidence(
  identity: Identity,
): Promise<ZendeskOperationalEvidence> {
  return withUserScope(identity, async (tx) => {
    const [audits, aggregates] = await Promise.all([
      tx.auditLog.findMany({
        where: { action: INGEST_ZENDESK_TICKETS },
        orderBy: [{ at: "desc" }, { id: "desc" }],
        take: 64,
        select: { action: true, at: true, detail: true },
      }),
      tx.$queryRaw<Array<NonNullable<ZendeskOperationalEvidence["aggregate"]>>>`
        SELECT count(*)::integer AS ticket_count,
               (SELECT count(*)::integer FROM mirror.zendesk_ticket_comment) AS comment_count,
               count(*) FILTER (
                 WHERE match_method IN ('CEDAR_RIDGE_USER_ID', 'EMAIL')
               )::integer AS linked_count,
               count(*) FILTER (WHERE match_method = 'UNMATCHED')::integer AS unmatched_count,
               count(*) FILTER (WHERE match_method = 'AMBIGUOUS')::integer AS ambiguous_count,
               count(*) FILTER (WHERE comments_truncated)::integer AS truncated_count,
               max(source_updated_at) AS latest_source_update,
               max(synced_at) AS latest_mirror_write
          FROM mirror.zendesk_ticket
      `,
    ]);
    return { audits, aggregate: aggregates[0] ?? null };
  });
}

/**
 * Bounded, PII-free operations read. Each displayed timestamp has a named
 * provenance; unavailable attempt/business-date metadata remains unavailable.
 */
export async function getSourceHealth(
  identity: Identity,
  now: Date = new Date(),
): Promise<SourceHealthResult> {
  if (!canViewSourceHealth(identity.role)) {
    return { ok: false, reason: "forbidden" };
  }
  if (!dataHealthEnabled()) return { ok: false, reason: "disabled" };
  // This controls only whether the optional navigation CTA is usable. Health
  // evidence and classification remain independent from the queue UI rollout.
  const reviewQueueAvailable = reviewQueueEnabled();
  const crmExplorerAvailable = crmIdentityReadsEnabled();

  const [
    localResult,
    zendeskResult,
    aumResult,
    fundingAvailabilityResult,
    fundingSourceDateResult,
  ] = await Promise.allSettled([
    readLocalOperationalEvidence(identity),
    readZendeskOperationalEvidence(identity),
    checkAumFreshness(now),
    checkExternalFundingAvailability(),
    getExternalFundingSourceDate(),
  ]);
  const local = localResult.status === "fulfilled" ? localResult.value : null;
  const zendesk = zendeskResult.status === "fulfilled" ? zendeskResult.value : null;
  const aum = aumResult.status === "fulfilled" ? aumResult.value : null;
  const warnings: string[] = [];
  if (!local) warnings.push("Committed-run and review-sweep metadata is temporarily unavailable.");
  if (!zendesk) warnings.push("Zendesk sync and aggregate linkage evidence is temporarily unavailable.");
  if (!aum) warnings.push("The Account AUM source-date check is temporarily unavailable.");

  const aumLatestAttempt = local?.aumAudits[0] ?? null;
  const aumSuccessAudit = local?.aumAudits.find(positiveAumCommit) ?? null;
  const aumNoDataIssue =
    aumLatestAttempt && !positiveAumCommit(aumLatestAttempt)
      ? aumLatestAttempt
      : null;
  const aumSuccess = iso(aumSuccessAudit?.at);
  const aumWarning = iso(local?.aumWarning?.at);
  const aumNoDataAt = iso(aumNoDataIssue?.at);
  const aumLatestIssue = [aumWarning, aumNoDataAt]
    .filter((value): value is string => value != null)
    .sort()
    .at(-1) ?? null;
  const aumDecision = evaluateAumCompletion(
    {
      latestSuccessAt: aumSuccess,
      lastAttemptAt: iso(aumLatestAttempt?.at),
      lastFailureAt:
        aumLatestIssue && (!aumSuccess || aumLatestIssue > aumSuccess)
          ? aumLatestIssue
          : null,
    },
    now,
  );
  // checkAumFreshness's 30-hour stale-sync rule is correct for its scheduled
  // weekday probe, but this page can be opened on weekends or Monday pre-run.
  // Completion age is therefore classified by evaluateAumCompletion's weekday
  // ET schedule. A stale sync is suppressed only while no weekday run is due;
  // after 11 ET, an old maxSyncedAt remains authoritative even if a no-op audit
  // was just written.
  const aumFreshnessFailed =
    aum != null &&
    !aum.ok &&
    (aum.reason !== "stale_sync" || isWeekdayRunDue(now, 11));
  const aumStatus: SourceHealthStatus =
    !aum
      ? "UNKNOWN"
      : aumFreshnessFailed
      ? "ATTENTION"
      : aumDecision.status;
  const aumFailedCheck = aum?.reason === "stale_sync"
    ? "Mirror sync check"
    : aum?.reason === "incomplete_coverage" ||
        aum?.reason === "reconciliation_failed" ||
        aum?.reason === "close_date_missing"
      ? "Snapshot integrity check"
      : "Source-date check";
  const aumReason =
    !aum
      ? "Source-date check unavailable"
      : aumFreshnessFailed
      ? `${aumFailedCheck}: ${aum.reason.replaceAll("_", " ")}`
      : aumDecision.reason.replaceAll("_", " ");

  const crmSuccess = iso(local?.crmSuccess?.at);
  const crmDecision = evaluateHourlyWeekdayCompletion(
    {
      latestSuccessAt: crmSuccess,
      lastAttemptAt: null,
      lastFailureAt: null,
    },
    now,
    CRM_HOURLY_GRACE_MINUTES,
  );

  const zendeskAggregate = zendesk?.aggregate ?? null;
  const zendeskLatestAttempt =
    zendesk?.audits.find(attemptedZendeskBatch) ?? null;
  const zendeskSuccessAudit =
    zendesk?.audits.find(committedZendeskBatch) ?? null;
  const zendeskIssueAudit =
    zendesk?.audits.find((row) => {
      const detail = zendeskAuditDetail(row);
      return detail != null && !detail.dryRun && detail.rejected > 0;
    }) ?? null;
  const zendeskDecision = evaluateScheduledSource(
    {
      latestSuccessAt: iso(zendeskSuccessAudit?.at),
      lastAttemptAt: iso(zendeskLatestAttempt?.at),
      lastFailureAt: iso(zendeskIssueAudit?.at),
    },
    now,
  );
  const zendeskStatus: SourceHealthStatus = !zendesk || !zendeskAggregate
    ? "UNKNOWN"
    : zendeskAggregate.ticket_count === 0
      ? "UNKNOWN"
      : zendeskAggregate.ambiguous_count > 0 || zendeskAggregate.linked_count === 0
        ? "ATTENTION"
        : zendeskDecision.status;
  const zendeskReason = !zendesk || !zendeskAggregate
    ? "Aggregate sync evidence unavailable"
    : zendeskAggregate.ticket_count === 0
      ? "No mirrored tickets recorded"
      : zendeskAggregate.ambiguous_count > 0
        ? "Ambiguous requester matches need attention"
        : zendeskAggregate.linked_count === 0
          ? "No tickets are linked to AOA records"
          : zendeskDecision.reason.replaceAll("_", " ");

  const sweep = local?.sweep ?? null;
  const sweepCompleted = iso(sweep?.last_completed_at);
  const sweepStarted = iso(sweep?.last_started_at);
  const schedulerActive = reviewQueueSchedulerActive();
  const sweepFreshness = schedulerActive
    ? classifyReviewQueueFreshness(sweep, now)
    : null;
  const unverifiedTradeDecision = evaluateUnverifiedSchedule({
    latestSuccessAt: sweepCompleted,
    lastAttemptAt: sweepStarted,
    lastFailureAt: iso(sweep?.last_failure_at),
  });
  const tradeStatus: SourceHealthStatus = !schedulerActive
    ? unverifiedTradeDecision.status
    : sweepFreshness?.state === "NOT_RUN"
      ? "UNKNOWN"
      : sweepFreshness?.state === "STALE" || sweepFreshness?.state === "FAILED"
        ? "ATTENTION"
        : "HEALTHY";
  const tradeReason = !schedulerActive
    ? unverifiedTradeDecision.reason.replaceAll("_", " ")
    : sweepFreshness?.state === "RUNNING"
      ? "Scheduled sweep page running"
      : sweepFreshness?.state === "PROGRESSING"
        ? "Scheduled sweep progressing"
        : sweepFreshness?.state === "FRESH"
          ? "Complete sweep within two-hour target"
          : sweepFreshness?.state === "STALE"
            ? "Complete sweep older than two-hour target"
            : sweepFreshness?.state === "FAILED"
              ? `Latest combined sweep failed${sweepFreshness.lastFailureSource ? ` in ${sweepFreshness.lastFailureSource.toLowerCase().replaceAll("_", " ")}` : ""}`
              : "Scheduler active; no completed sweep recorded";
  const fundingCheckedAt = now.toISOString();
  const fundingAvailable = fundingAvailabilityResult.status === "fulfilled";
  const fundingBusinessAsOf = fundingSourceDateResult.status === "fulfilled"
    ? fundingSourceDateResult.value
    : null;
  let fundingExpectedAsOf: string | null = null;
  try {
    fundingExpectedAsOf = previousTradingDay(toDateStr(now));
  } catch {
    warnings.push("The External Funding business-date expectation is temporarily unavailable.");
  }
  const fundingSourceDateCurrent =
    fundingBusinessAsOf != null &&
    fundingExpectedAsOf != null &&
    fundingBusinessAsOf >= fundingExpectedAsOf;
  const fundingStatus: SourceHealthStatus = !fundingAvailable
    ? "ATTENTION"
    : fundingBusinessAsOf == null || fundingExpectedAsOf == null
      ? "AVAILABLE"
      : fundingSourceDateCurrent
        ? "HEALTHY"
        : "ATTENTION";
  const fundingReason = !fundingAvailable
    ? "Live card query failed"
    : fundingBusinessAsOf == null || fundingExpectedAsOf == null
      ? "Live card query available; freshness check unavailable"
      : fundingSourceDateCurrent
        ? "Source date current; live card query available"
        : "Source-date check stale";

  return {
    ok: true,
    generatedAt: now.toISOString(),
    warnings,
    rows: [
      {
        key: "ACCOUNT_AUM",
        label: "Account AUM",
        source: "Warehouse card 6601 → mirror.client_account_aum",
        status: aumStatus,
        statusReason: aumReason,
        coverage: "Source date and scheduled completion",
        businessAsOf: aum?.maxAsOf ?? null,
        expectedBusinessAsOf: aum?.expectedMinAsOf ?? null,
        latestSuccessAt: aumSuccess,
        lastAttemptAt: iso(aumLatestAttempt?.at),
        lastFailureAt:
          aumLatestIssue && (!aumSuccess || aumLatestIssue > aumSuccess)
            ? aumLatestIssue
            : null,
        availabilityCheckedAt: null,
        attemptEvidence: "An ingest audit counts as a completed data load only when it records at least one upsert. Zero-row, malformed, or no-op audits remain attempts/issues; import failures before audit commit are unavailable.",
        detail: aum
          ? `${aum.rowCount.toLocaleString()}/${aum.expectedRowCount?.toLocaleString() ?? "unknown"} expected rows; ${aum.currentOpenAccountCount ?? 0}/${aum.openAccountCount ?? 0} open accounts current; ${aum.corporateCurrentCount ?? 0}/4 corporate accounts current; latest mirror write ${iso(aum.maxSyncedAt) ?? "not recorded"}.`
          : "The source aggregate could not be read. No date or row count was inferred.",
        actionHref: "/audit-log?action=ingest.account_aum",
        actionLabel: "Inspect AUM audit history",
        reviewQueueSource: null,
      },
      {
        key: "CRM_IDENTITY",
        label: "CRM identity reconciliation",
        source: "Approved CRM namespaces → app CRM identity layer",
        status: crmDecision.status,
        statusReason: crmDecision.reason.replaceAll("_", " "),
        coverage: "Scheduled completion only",
        businessAsOf: null,
        expectedBusinessAsOf: null,
        latestSuccessAt: crmSuccess,
        lastAttemptAt: null,
        lastFailureAt: null,
        availabilityCheckedAt: null,
        attemptEvidence: "The reconciler persists committed successes only; failed attempts are not yet durable metadata.",
        detail: "CRM source records do not publish one authoritative business as-of date, so this row reports reconciliation completion only.",
        actionHref: crmExplorerAvailable
          ? "/crm?exceptions=open"
          : null,
        actionLabel: crmExplorerAvailable ? "Open CRM exceptions" : null,
        reviewQueueSource: "CRM_IDENTITY",
      },
      {
        key: "ZENDESK",
        label: "Zendesk support history",
        source: "Zendesk OAuth via n8n → mirror.zendesk_ticket",
        status: zendeskStatus,
        statusReason: zendeskReason,
        coverage: "Accepted ingest batches, mirror freshness, and aggregate requester linkage",
        businessAsOf: null,
        expectedBusinessAsOf: null,
        latestSuccessAt: iso(zendeskSuccessAudit?.at),
        lastAttemptAt: iso(zendeskLatestAttempt?.at),
        lastFailureAt: iso(zendeskIssueAudit?.at),
        availabilityCheckedAt: null,
        latestSuccessLabel: "Latest accepted batch",
        lastAttemptLabel: "Latest observed batch",
        attemptEvidence: "Each audit proves that one batch reached AOA and committed. It does not prove that the entire n8n execution completed; failures before the AOA endpoint are not visible here.",
        detail: zendeskAggregate
          ? `Latest Zendesk ticket update ${iso(zendeskAggregate.latest_source_update) ?? "not recorded"}; latest mirror write ${iso(zendeskAggregate.latest_mirror_write) ?? "not recorded"}. Unmatched tickets can include non-client requesters and do not alone make the source unhealthy.`
          : "The aggregate mirror could not be read. No ticket, comment, linkage, or freshness value was inferred.",
        actionHref: "/audit-log?action=ingest.zendesk_tickets",
        actionLabel: "Inspect Zendesk ingest history",
        reviewQueueSource: null,
        metrics: zendeskAggregate
          ? [
              { label: "Tickets", value: zendeskAggregate.ticket_count.toLocaleString() },
              { label: "Public comments", value: zendeskAggregate.comment_count.toLocaleString() },
              { label: "Linked", value: zendeskAggregate.linked_count.toLocaleString(), tone: "green" },
              {
                label: "Unmatched",
                value: zendeskAggregate.unmatched_count.toLocaleString(),
                tone: zendeskAggregate.unmatched_count > 0 ? "amber" : undefined,
              },
              {
                label: "Ambiguous",
                value: zendeskAggregate.ambiguous_count.toLocaleString(),
                tone: zendeskAggregate.ambiguous_count > 0 ? "red" : undefined,
              },
              {
                label: "Comment history capped",
                value: zendeskAggregate.truncated_count.toLocaleString(),
                tone: zendeskAggregate.truncated_count > 0 ? "amber" : undefined,
              },
            ]
          : undefined,
      },
      {
        key: "TRADE_REQUEST",
        label: "Trade Requests",
        source: "Trade Request API → bounded review-queue sweep",
        status: tradeStatus,
        statusReason: tradeReason,
        coverage: schedulerActive
          ? "Recurring complete-sweep freshness"
          : "Completion evidence only",
        businessAsOf: null,
        expectedBusinessAsOf: null,
        latestSuccessAt: sweepCompleted,
        lastAttemptAt: sweepStarted,
        lastFailureAt: iso(sweep?.last_failure_at),
        availabilityCheckedAt: null,
        attemptEvidence: schedulerActive
          ? "Terraform explicitly marks the five-minute OIDC scheduler active. The checkpoint covers the complete combined Trade Request and CRM sweep; running and progressing pages remain healthy while their heartbeat is current."
          : "The checkpoint proves a combined paged sweep completed, but the recurring scheduler is not configured as active in this environment. Freshness therefore stays unknown unless a newer failure needs attention.",
        detail: "Trade Request records remain authoritative in the Trade Request service and are not copied into AOA.",
        actionHref: reviewQueueAvailable
          ? "/review-queue?source=TRADE_REQUEST"
          : null,
        actionLabel: reviewQueueAvailable
          ? "Open Trade Request review items"
          : null,
        reviewQueueSource: "TRADE_REQUEST",
      },
      {
        key: "EXTERNAL_FUNDING",
        label: "External cash funding",
        source: "Warehouse card 6700 source date + card 6634 client queries",
        status: fundingStatus,
        statusReason: fundingReason,
        coverage: fundingBusinessAsOf
          ? "Source date and live query availability"
          : "Live query availability only",
        businessAsOf: fundingBusinessAsOf,
        expectedBusinessAsOf: fundingBusinessAsOf ? fundingExpectedAsOf : null,
        latestSuccessAt: null,
        lastAttemptAt: null,
        lastFailureAt: null,
        availabilityCheckedAt: fundingCheckedAt,
        attemptEvidence: "Card 6700 returns one aggregate process date from the source table. The separate card-6634 probe submits a fixed impossible account ID and proves current query availability only. Neither live read is retained as a scheduled completed-success record.",
        detail: !fundingAvailable
          ? "The live PII-free card probe did not complete. Client Portrait funding reads may also be unavailable until the Warehouse path recovers."
          : fundingBusinessAsOf
            ? "Card 6700 publishes only the activity feed's maximum process date. Card 6634 also responded successfully using a fixed impossible account ID, without selecting a client's transactions."
            : "Card 6634 responded successfully using a fixed impossible account ID, but the PII-free source-date aggregate was unavailable. No date was inferred from client transactions.",
        actionHref: null,
        actionLabel: null,
        reviewQueueSource: null,
      },
    ],
  };
}
