import "server-only";

import { Prisma, type ReviewQueueSource, type ReviewQueueStatus } from "@prisma/client";
import { withUserScope } from "@/lib/rls";
import { getAuthoritativeTradeRequestsForUsers } from "./trade-requests";
import {
  deriveAccountScopedTradeRequestProfileFromSummaries,
  type ConfirmedTradeProfileSource,
  type KnownTradeProfileAccount,
} from "./trade-request-profile";
import { detectTradeProfileReviews } from "./review-queue-detection";
import {
  reviewQueueCrmDetectorKey,
  reviewQueueCrmSubjectKey,
  reviewQueueTradeDetectorKey,
  reviewQueueTradeSubjectKey,
} from "./review-queue-keys";

const SYSTEM_IDENTITY = { role: "ADMIN", email: "review-queue@system" } as const;
export const REVIEW_QUEUE_BATCH_MAX = 50;
export const REVIEW_QUEUE_CRM_BATCH_MAX = 500;
export const REVIEW_QUEUE_MATERIALIZATION_BUSY = "review_queue_materialization_already_running";

type ClientSeed = { sf_id: string; cedar_ridge_user_id: string };
type AccountSeed = {
  client_sf_id: string;
  custodian_account_id: string;
  apex_account_number: string | null;
  account_type: string | null;
  account_status: string | null;
};
type CrmSeed = {
  exception_id: string;
  identity_id: string;
  reason_code: string;
  identity_type: string;
  detected_at: Date;
};

type MaterializedSignal = {
  detectorKey: string;
  subjectKey: string;
  source: ReviewQueueSource;
  type: string;
  sourceRecordRef: string | null;
  href: string;
  summary: string;
  snapshot: Prisma.InputJsonValue;
  detectedAt?: Date;
};

function clamp(value: number | undefined, max: number): number {
  const parsed = Number.isFinite(value) ? Math.floor(value as number) : max;
  return Math.max(1, Math.min(max, parsed));
}

async function readTradeBatch(cursor: string, limit: number): Promise<{
  clients: ClientSeed[];
  accounts: AccountSeed[];
  selections: Array<{
    client_sf_id: string;
    custodian_account_id: string;
    selected_request_id: string;
    reviewed_request_ids: string[];
  }>;
  hasMore: boolean;
}> {
  return withUserScope(SYSTEM_IDENTITY, async (tx) => {
    const rows = await tx.$queryRaw<ClientSeed[]>(Prisma.sql`
      SELECT c.sf_id, c.cedar_ridge_user_id
        FROM mirror.client c
       WHERE c.cedar_ridge_user_id IS NOT NULL
         AND c.cedar_ridge_user_id <> ''
         AND c.sf_id > ${cursor}
         AND (c.household_id IS NULL OR c.sf_id <> c.household_id)
       ORDER BY c.sf_id
       LIMIT ${limit + 1}`);
    const hasMore = rows.length > limit;
    const clients = rows.slice(0, limit);
    if (clients.length === 0) return { clients, accounts: [], selections: [], hasMore };
    const clientIds = clients.map((client) => client.sf_id);
    const accounts = await tx.$queryRaw<AccountSeed[]>(Prisma.sql`
      SELECT client_sf_id, custodian_account_id, apex_account_number,
             account_type, account_status
        FROM mirror.client_account_aum
       WHERE client_sf_id IN (${Prisma.join(clientIds)})
         AND source_present
         AND balance_current`);
    const selections = await tx.tradeProfileSelection.findMany({
      where: { client_sf_id: { in: clientIds } },
      select: {
        client_sf_id: true,
        custodian_account_id: true,
        selected_request_id: true,
        reviewed_request_ids: true,
      },
    });
    return { clients, accounts, selections, hasMore };
  });
}

async function materializeSignals(
  signals: MaterializedSignal[],
  scannedTradeSubjects: Map<string, Set<string>>,
): Promise<{ opened: number; refreshed: number; reopened: number; autoResolved: number; awakened: number }> {
  const counts = { opened: 0, refreshed: 0, reopened: 0, autoResolved: 0, awakened: 0 };
  const now = new Date();
  await withUserScope(SYSTEM_IDENTITY, async (tx) => {
    const [guard] = await tx.$queryRaw<Array<{ acquired: boolean }>>(Prisma.sql`
      SELECT pg_try_advisory_xact_lock(
        hashtextextended('app.review_queue.materialize.v1', 0)
      ) AS acquired`);
    if (!guard?.acquired) throw new Error(REVIEW_QUEUE_MATERIALIZATION_BUSY);
    const expiredSnoozes = await tx.reviewQueueItem.findMany({
      where: {
        source_active: true,
        status: "SNOOZED",
        snoozed_until: { lte: now },
      },
      orderBy: { snoozed_until: "asc" },
      take: REVIEW_QUEUE_CRM_BATCH_MAX,
    });
    for (const row of expiredSnoozes) {
      const awakened = await tx.reviewQueueItem.updateMany({
        where: {
          id: row.id,
          source_active: true,
          status: "SNOOZED",
          updated_at: row.updated_at,
        },
        data: {
          status: "NEW",
          snoozed_until: null,
          updated_by: SYSTEM_IDENTITY.email,
        },
      });
      if (awakened.count !== 1) continue;
      await tx.reviewQueueEvent.create({
        data: {
          item_id: row.id,
          action: "SNOOZE_EXPIRED",
          actor_email: SYSTEM_IDENTITY.email,
          actor_role: SYSTEM_IDENTITY.role,
          from_status: "SNOOZED",
          to_status: "NEW",
          detail: { source: row.source, type: row.exception_type },
        },
      });
      counts.awakened += 1;
    }
    const existing = signals.length
      ? await tx.reviewQueueItem.findMany({
          where: { detector_key: { in: signals.map((signal) => signal.detectorKey) } },
        })
      : [];
    const byKey = new Map(existing.map((row) => [row.detector_key, row]));

    for (const signal of signals) {
      const row = byKey.get(signal.detectorKey);
      if (!row) {
        const created = await tx.reviewQueueItem.create({
          data: {
            detector_key: signal.detectorKey,
            subject_key: signal.subjectKey,
            source: signal.source,
            exception_type: signal.type,
            source_record_ref: signal.sourceRecordRef,
            resolution_href: signal.href,
            summary: signal.summary,
            source_snapshot: signal.snapshot,
            detected_at: signal.detectedAt,
            updated_by: SYSTEM_IDENTITY.email,
          },
        });
        await tx.reviewQueueEvent.create({
          data: {
            item_id: created.id,
            action: "DETECTED",
            actor_email: SYSTEM_IDENTITY.email,
            actor_role: SYSTEM_IDENTITY.role,
            to_status: "NEW",
            detail: { source: signal.source, type: signal.type },
          },
        });
        counts.opened += 1;
      } else {
        const reopen = !row.source_active;
        await tx.reviewQueueItem.update({
          where: { id: row.id },
          data: {
            source_active: true,
            source_resolved_at: null,
            last_seen_at: now,
            source_snapshot: signal.snapshot,
            resolution_href: signal.href,
            summary: signal.summary,
            ...(reopen
              ? {
                  status: "NEW" as ReviewQueueStatus,
                  resolved_at: null,
                  resolved_by: null,
                  snoozed_until: null,
                }
              : {}),
            updated_by: SYSTEM_IDENTITY.email,
          },
        });
        if (reopen) {
          await tx.reviewQueueEvent.create({
            data: {
              item_id: row.id,
              action: "SOURCE_REOPENED",
              actor_email: SYSTEM_IDENTITY.email,
              actor_role: SYSTEM_IDENTITY.role,
              from_status: row.status,
              to_status: "NEW",
              detail: { source: signal.source, type: signal.type },
            },
          });
          counts.reopened += 1;
        } else {
          counts.refreshed += 1;
        }
      }
    }

    // Only deactivate Trade Request rows for subjects successfully included in
    // this external batch. A failed API call never clears existing work.
    for (const [subjectKey, currentKeys] of scannedTradeSubjects) {
      const prior = await tx.reviewQueueItem.findMany({
        where: { source: "TRADE_REQUEST", subject_key: subjectKey, source_active: true },
      });
      for (const row of prior) {
        if (currentKeys.has(row.detector_key)) continue;
        const cleared = await tx.reviewQueueItem.updateMany({
          where: { id: row.id, source_active: true, updated_at: row.updated_at },
          data: {
            source_active: false,
            status: "RESOLVED",
            source_resolved_at: now,
            resolved_at: now,
            resolved_by: SYSTEM_IDENTITY.email,
            snoozed_until: null,
            updated_by: SYSTEM_IDENTITY.email,
          },
        });
        if (cleared.count !== 1) continue;
        await tx.reviewQueueEvent.create({
          data: {
            item_id: row.id,
            action: "SOURCE_CLEARED",
            actor_email: SYSTEM_IDENTITY.email,
            actor_role: SYSTEM_IDENTITY.role,
            from_status: row.status,
            to_status: "RESOLVED",
            detail: { source: "TRADE_REQUEST", type: row.exception_type },
          },
        });
        counts.autoResolved += 1;
      }
    }

    // Closed CRM exceptions are reconciled separately from the paged OPEN read,
    // so closure cannot be missed just because an open-exception page is full.
    const closedCrm = await tx.$queryRaw<Array<{
      item_id: string;
      status: ReviewQueueStatus;
      exception_type: string;
      updated_at: Date;
    }>>(Prisma.sql`
      SELECT q.id AS item_id, q.status, q.exception_type, q.updated_at
        FROM app.review_queue_item q
        JOIN app.crm_identity_exception e ON e.id = q.source_record_ref
       WHERE q.source = 'CRM_IDENTITY'::app."ReviewQueueSource"
         AND q.source_active = true
         AND e.exception_state <> 'OPEN'
       ORDER BY q.last_seen_at
       LIMIT ${REVIEW_QUEUE_CRM_BATCH_MAX}`);
    for (const row of closedCrm) {
      const cleared = await tx.reviewQueueItem.updateMany({
        where: {
          id: row.item_id,
          source_active: true,
          updated_at: row.updated_at,
        },
        data: {
          source_active: false,
          status: "RESOLVED",
          source_resolved_at: now,
          resolved_at: now,
          resolved_by: SYSTEM_IDENTITY.email,
          snoozed_until: null,
          updated_by: SYSTEM_IDENTITY.email,
        },
      });
      if (cleared.count !== 1) continue;
      await tx.reviewQueueEvent.create({
        data: {
          item_id: row.item_id,
          action: "SOURCE_CLEARED",
          actor_email: SYSTEM_IDENTITY.email,
          actor_role: SYSTEM_IDENTITY.role,
          from_status: row.status,
          to_status: "RESOLVED",
          detail: { source: "CRM_IDENTITY", type: row.exception_type },
        },
      });
      counts.autoResolved += 1;
    }
  }, { timeout: 30_000, maxWait: 5_000 });
  return counts;
}

export type ReviewQueueMaterializationResult = {
  trade: {
    processed: number;
    failed: boolean;
    hasMore: boolean;
    nextCursor: string | null;
  };
  crm: { processed: number; failed: boolean; hasMore: boolean; nextCursor: string | null };
  changes: { opened: number; refreshed: number; reopened: number; autoResolved: number; awakened: number };
};

/** Bounded, idempotent materialization. The normal queue page never calls it. */
export async function runReviewQueueMaterialization(options: {
  cursor?: string;
  limit?: number;
  crmCursor?: string;
  crmLimit?: number;
  skipTrade?: boolean;
  skipCrm?: boolean;
} = {}): Promise<ReviewQueueMaterializationResult> {
  const limit = clamp(options.limit, REVIEW_QUEUE_BATCH_MAX);
  const crmLimit = clamp(options.crmLimit, REVIEW_QUEUE_CRM_BATCH_MAX);
  const batch = options.skipTrade
    ? { clients: [], accounts: [], selections: [], hasMore: false }
    : await readTradeBatch(options.cursor?.trim() ?? "", limit);
  const signals: MaterializedSignal[] = [];
  const scannedTradeSubjects = new Map<string, Set<string>>();
  let tradeFailed = false;

  if (batch.clients.length > 0) {
    try {
      const requests = await getAuthoritativeTradeRequestsForUsers(
        batch.clients.map((client) => client.cedar_ridge_user_id),
      );
      for (const client of batch.clients) {
        const subjectKey = reviewQueueTradeSubjectKey(client.sf_id);
        const knownAccounts: KnownTradeProfileAccount[] = batch.accounts
          .filter((account) => account.client_sf_id === client.sf_id)
          .map((account) => ({
            accountId: account.custodian_account_id,
            accountNumber: account.apex_account_number ?? account.custodian_account_id,
            accountType: account.account_type,
            status: account.account_status,
          }));
        const confirmed: Record<string, ConfirmedTradeProfileSource> = Object.fromEntries(
          batch.selections
            .filter((selection) => selection.client_sf_id === client.sf_id)
            .map((selection) => [selection.custodian_account_id, {
              requestId: selection.selected_request_id,
              reviewedRequestIds: selection.reviewed_request_ids,
            }]),
        );
        const profile = deriveAccountScopedTradeRequestProfileFromSummaries(
          client.cedar_ridge_user_id,
          requests,
          knownAccounts,
          confirmed,
        );
        const current = new Set<string>();
        for (const issue of detectTradeProfileReviews(profile)) {
          const detectorKey = reviewQueueTradeDetectorKey(client.sf_id, issue.type, issue.discriminator);
          current.add(detectorKey);
          signals.push({
            detectorKey,
            subjectKey,
            source: "TRADE_REQUEST",
            type: issue.type,
            sourceRecordRef: null,
            href: `/client-portrait/${encodeURIComponent(client.sf_id)}?section=trade-profile-review`,
            summary: issue.summary,
            snapshot: issue.snapshot,
          });
        }
        scannedTradeSubjects.set(subjectKey, current);
      }
    } catch {
      tradeFailed = true;
      // Static marker only: no cursor, client id, user id, endpoint or body.
      console.error("[review-queue] trade_batch_failed");
    }
  }

  const crmCursor = options.crmCursor?.trim() ?? "";
  let crmRows: CrmSeed[] = [];
  let crmFailed = false;
  if (!options.skipCrm) {
    try {
      crmRows = await withUserScope(SYSTEM_IDENTITY, (tx) => tx.$queryRaw<CrmSeed[]>(Prisma.sql`
        SELECT e.id AS exception_id, m.identity_id, e.reason_code, i.identity_type,
               e.detected_at
          FROM app.crm_identity_exception e
          JOIN app.crm_source_mapping m ON m.id = e.source_mapping_id
          JOIN app.crm_identity i ON i.id = m.identity_id
         WHERE e.exception_state = 'OPEN' AND e.id > ${crmCursor}
         ORDER BY e.id
         LIMIT ${crmLimit + 1}`));
    } catch {
      crmFailed = true;
      console.error("[review-queue] crm_batch_failed");
    }
  }
  const crmHasMore = crmRows.length > crmLimit;
  const crmPage = crmRows.slice(0, crmLimit);
  for (const exception of crmPage) {
    signals.push({
      detectorKey: reviewQueueCrmDetectorKey(exception.exception_id),
      subjectKey: reviewQueueCrmSubjectKey(exception.identity_id),
      source: "CRM_IDENTITY",
      type: `CRM_${exception.reason_code}`.slice(0, 64),
      sourceRecordRef: exception.exception_id,
      href: `/crm/${encodeURIComponent(exception.identity_id)}?resolutionException=${encodeURIComponent(exception.exception_id)}#resolve-parent-mapping`,
      summary: "A CRM identity mapping needs review",
      snapshot: {
        reasonCode: exception.reason_code.slice(0, 48),
        identityType: exception.identity_type.slice(0, 32),
      },
      detectedAt: exception.detected_at,
    });
  }

  const changes = await materializeSignals(signals, scannedTradeSubjects);
  const lastClient = batch.clients.at(-1)?.sf_id ?? null;
  const lastCrm = crmPage.at(-1)?.exception_id ?? null;
  return {
    trade: {
      processed: tradeFailed ? 0 : batch.clients.length,
      failed: tradeFailed,
      hasMore: batch.hasMore,
      nextCursor: batch.hasMore ? lastClient : null,
    },
    crm: {
      processed: crmFailed ? 0 : crmPage.length,
      failed: crmFailed,
      hasMore: crmHasMore,
      nextCursor: crmHasMore ? lastCrm : null,
    },
    changes,
  };
}
