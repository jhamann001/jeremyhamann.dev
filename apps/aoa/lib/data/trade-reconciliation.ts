import "server-only";

import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  TRADE_RECONCILIATION_BREAK_REVIEW,
  TRADE_RECONCILIATION_RUN,
  TRADE_RECONCILIATION_RUN_NOTE,
  writeAudit,
} from "@/lib/audit";
import type { Identity } from "@/lib/rls";
import { withUserScope } from "@/lib/rls";
import { reconciliationHistoryPage } from "./reconciliation-history";
import {
  isTradeReconciliationRunId,
} from "@/lib/operations/trade-reconciliation-selection";
import {
  BREAK_CLASSIFICATIONS,
  MAX_TRADE_RECONCILIATION_BULK_REVIEW_ROWS,
  meridianMatchRate,
  reconcileAccountAware,
  summarizeReconciliation,
  type MeridianTradeSourceRow,
  type ApexTradeSourceRow,
  type BreakClassification,
  type ReconciliationRow,
} from "@/lib/operations/trade-reconciliation";

export const TRADE_RECONCILIATION_ALGORITHM = "account-aware-v2";
export const TRADE_RECONCILIATION_SCOPE = "all-trades-v2";
const HASH_RE = /^[0-9a-f]{64}$/;

export type ReconciliationHistoryRow = {
  period: string;
  runId?: string;
  runDate?: string;
  tradeDate?: string;
  completedAt?: string;
  matched: number;
  explained: number;
  unresolved: number;
  rate: string;
};

export type TradeReconciliationRunSummary = {
  apexRecords: number;
  meridianRecords: number;
  matched: number;
  explained: number;
  unresolved: number;
  rawMatchRate: number | null;
  summaryOnly: boolean;
  sourceBreaks: number | null;
  unmatchedApex: number | null;
  unmatchedMeridian: number | null;
};

export type TradeReconciliationPageData = {
  run: null | {
    id: string;
    runDate: string;
    tradeDate: string;
    completedAt: string;
    algorithmVersion: string;
    rows: ReconciliationRow[];
    runNote: string;
    summary: TradeReconciliationRunSummary;
  };
  history: {
    daily: ReconciliationHistoryRow[];
    monthly: ReconciliationHistoryRow[];
    quarterly: ReconciliationHistoryRow[];
  };
  historyLoaded: boolean;
};

export function emptyTradeReconciliationPageData(): TradeReconciliationPageData {
  return {
    run: null,
    history: { daily: [], monthly: [], quarterly: [] },
    historyLoaded: false,
  };
}

type RunSummaryRecord = {
  id: string;
  run_date: Date;
  business_date: Date;
  algorithm_version: string;
  apex_record_count: number;
  meridian_record_count: number;
  raw_match_count: number;
  exception_count: number;
  raw_match_rate: Prisma.Decimal;
  legacy_source: string | null;
  legacy_unmatched_apex: number | null;
  legacy_unmatched_alpha: number | null;
  legacy_match_rate: Prisma.Decimal | null;
  completed_at: Date;
  review_events: Array<{ row_fingerprint: string }>;
};

type RunRecord = Omit<RunSummaryRecord, "review_events"> & {
  payload: Prisma.JsonValue;
  review_events: Array<{
    row_fingerprint: string;
    classification: string;
    explanation: string;
    reviewer_email: string | null;
    created_at: Date;
  }>;
  note_events: Array<{ note: string; created_at: Date }>;
};

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function sourceCommitSha(): string {
  const value = process.env.AOA_SOURCE_COMMIT_SHA ?? "unknown";
  return /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : "unknown";
}

function stableSources(apex: ApexTradeSourceRow[], meridian: MeridianTradeSourceRow[]) {
  return {
    apex: [...apex].sort((a, b) => a.activityId.localeCompare(b.activityId)),
    meridian: [...meridian].sort((a, b) => a.rebalancerOrderId.localeCompare(b.rebalancerOrderId)),
  };
}

function persistedRows(apex: ApexTradeSourceRow[], meridian: MeridianTradeSourceRow[]) {
  return reconcileAccountAware(apex, meridian).map((row) => ({
    ...row,
    // The stable row reference used by reviews is opaque. Source identifiers
    // remain explicit columns for authorized investigation, never log fields.
    id: sha256({ algorithm: TRADE_RECONCILIATION_ALGORITHM, sourceRow: row.id }),
  }));
}

function rowsFromPayload(payload: Prisma.JsonValue): ReconciliationRow[] {
  if (!Array.isArray(payload)) return [];
  return payload.filter((value): value is ReconciliationRow => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const row = value as unknown as ReconciliationRow;
    return HASH_RE.test(row.id) && typeof row.symbol === "string" && typeof row.result === "string";
  });
}

function decorateRows(run: RunRecord): ReconciliationRow[] {
  const latest = new Map<string, RunRecord["review_events"][number]>();
  for (const event of run.review_events) {
    if (!latest.has(event.row_fingerprint)) latest.set(event.row_fingerprint, event);
  }
  return rowsFromPayload(run.payload).map((row) => {
    const review = latest.get(row.id);
    if (!review) return row;
    return {
      ...row,
      classification: review.classification as BreakClassification,
      explanation: review.explanation,
      reviewedBy: review.reviewer_email ?? "Operations user",
      reviewedAt: review.created_at.toISOString(),
    };
  });
}

function summaryForRun(run: RunSummaryRecord): TradeReconciliationRunSummary {
  const summaryOnly = run.legacy_source === "fee_store_daily_reconciliation";
  const reviewed = summaryOnly
    ? 0
    : new Set(run.review_events.map((event) => event.row_fingerprint)).size;
  const legacyUnmatchedApex = run.legacy_unmatched_apex ?? 0;
  const legacyUnmatchedMeridian = run.legacy_unmatched_alpha ?? 0;
  return {
    apexRecords: run.apex_record_count,
    meridianRecords: run.meridian_record_count,
    matched: run.raw_match_count,
    explained: reviewed,
    unresolved: summaryOnly
      ? run.exception_count + legacyUnmatchedApex + legacyUnmatchedMeridian
      : Math.max(0, run.exception_count - reviewed),
    // Recompute old and new runs alike; imported/source rates remain audit facts.
    rawMatchRate: meridianMatchRate(run.raw_match_count, run.meridian_record_count),
    summaryOnly,
    sourceBreaks: summaryOnly ? run.exception_count : null,
    unmatchedApex: summaryOnly ? legacyUnmatchedApex : null,
    unmatchedMeridian: summaryOnly ? legacyUnmatchedMeridian : null,
  };
}

const selectedRunInclude = {
  review_events: { orderBy: { created_at: "desc" as const } },
  note_events: { orderBy: { created_at: "desc" as const } },
};

export async function tradeReconciliationPageData(
  identity: Identity,
  requestedRunId?: string,
): Promise<TradeReconciliationPageData> {
  // The default screen intentionally has no selected reconciliation. Avoid a
  // database round trip just to render that blank state; history is fetched
  // only if the operator opens its tab.
  if (!requestedRunId || !isTradeReconciliationRunId(requestedRunId)) {
    return emptyTradeReconciliationPageData();
  }
  return withUserScope(identity, async (tx) => {
    // Look up the explicit ID under RLS, independently of any history page.
    // Older saved runs must remain reachable after the initial page is full.
    const selected = await tx.tradeReconciliationRun.findUnique({
        where: { id: requestedRunId },
        include: selectedRunInclude,
      }) as unknown as RunRecord | null;
    return {
      run: selected ? {
        id: selected.id,
        runDate: dateOnly(selected.run_date),
        tradeDate: dateOnly(selected.business_date),
        completedAt: selected.completed_at.toISOString(),
        algorithmVersion: selected.algorithm_version,
        rows: decorateRows(selected),
        runNote: selected.note_events[0]?.note ?? "",
        summary: summaryForRun(selected),
      } : null,
      history: { daily: [], monthly: [], quarterly: [] },
      historyLoaded: false,
    };
  });
}

export async function tradeReconciliationHistory(
  identity: Identity,
): Promise<TradeReconciliationPageData["history"]> {
  // Compatibility for older callers. The mounted workspace uses the paged API.
  const daily = await reconciliationHistoryPage(identity, "daily", 1);
  const monthly = await reconciliationHistoryPage(identity, "monthly", 1);
  const quarterly = await reconciliationHistoryPage(identity, "quarterly", 1);
  return { daily: daily.rows, monthly: monthly.rows, quarterly: quarterly.rows };
}

export async function persistCompletedTradeReconciliation(
  identity: Identity,
  dates: { runDate: string; tradeDate: string },
  sources: { apex: ApexTradeSourceRow[]; meridian: MeridianTradeSourceRow[] },
): Promise<string> {
  const { runDate, tradeDate } = dates;
  const stable = stableSources(sources.apex, sources.meridian);
  const digest = sha256(stable);
  const rows = persistedRows(stable.apex, stable.meridian);
  const summary = summarizeReconciliation(rows);

  return withUserScope(identity, async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'trade-reconciliation:' + tradeDate})::bigint)::text AS locked`;
    // Idempotency is scoped to the operator-selected run date. The same trade
    // date may be rerun on a later day and must retain that later operational
    // run date instead of reopening an older immutable snapshot.
    const existing = await tx.tradeReconciliationRun.findUnique({
      where: {
        run_date_business_date_algorithm_version_source_digest: {
          run_date: new Date(`${runDate}T00:00:00.000Z`),
          business_date: new Date(`${tradeDate}T00:00:00.000Z`),
          algorithm_version: TRADE_RECONCILIATION_ALGORITHM,
          source_digest: digest,
        },
      },
      select: { id: true },
    });
    if (existing) return existing.id;

    const run = await tx.tradeReconciliationRun.create({
      data: {
        run_date: new Date(`${runDate}T00:00:00.000Z`),
        business_date: new Date(`${tradeDate}T00:00:00.000Z`),
        algorithm_version: TRADE_RECONCILIATION_ALGORITHM,
        source_scope_version: TRADE_RECONCILIATION_SCOPE,
        source_digest: digest,
        source_commit_sha: sourceCommitSha(),
        apex_record_count: summary.apexRecords,
        meridian_record_count: summary.meridianRecords,
        raw_match_count: summary.matched,
        exception_count: summary.explained + summary.unresolved,
        // The immutable storage column predates the N/A display contract.
        // Reads derive the metric from counts, including zero-order runs.
        raw_match_rate: summary.rawMatchRate ?? 0,
        payload: rows as unknown as Prisma.InputJsonValue,
        completed_by: identity.email ?? null,
      },
      select: { id: true },
    });
    await writeAudit(tx, identity, {
      action: TRADE_RECONCILIATION_RUN,
      entityType: "trade_reconciliation_run",
      entityId: run.id,
      detail: {
        runDate,
        tradeDate,
        algorithm: TRADE_RECONCILIATION_ALGORITHM,
        apexRecords: summary.apexRecords,
        meridianRecords: summary.meridianRecords,
        rawMatches: summary.matched,
        exceptions: summary.explained + summary.unresolved,
      },
    });
    return run.id;
  }, { timeout: 20_000 });
}

export async function appendTradeReconciliationReview(
  identity: Identity,
  input: { runId: string; rowFingerprint: string; classification: string; explanation: string },
): Promise<boolean> {
  if (
    !isTradeReconciliationRunId(input.runId) ||
    !HASH_RE.test(input.rowFingerprint) ||
    !BREAK_CLASSIFICATIONS.includes(input.classification as BreakClassification) ||
    !input.explanation.trim() ||
    input.explanation.trim().length > 1000
  ) return false;
  return withUserScope(identity, async (tx) => {
    // Share the run lock with bulk review. A later explicit individual review
    // may still append a new event, but it cannot race the bulk eligibility
    // check and make that bulk action unknowingly review an explained row.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'trade-reconciliation-review:' + input.runId})::bigint)::text AS locked`;
    const run = await tx.tradeReconciliationRun.findUnique({
      where: { id: input.runId },
      select: { payload: true },
    });
    const row = run && rowsFromPayload(run.payload).find((candidate) => candidate.id === input.rowFingerprint);
    if (!row || row.result === "MATCHED") return false;
    const event = await tx.tradeReconciliationReviewEvent.create({
      data: {
        run_id: input.runId,
        row_fingerprint: input.rowFingerprint,
        classification: input.classification,
        explanation: input.explanation.trim(),
        reviewer_email: identity.email ?? null,
      },
      select: { id: true },
    });
    await writeAudit(tx, identity, {
      action: TRADE_RECONCILIATION_BREAK_REVIEW,
      entityType: "trade_reconciliation_review_event",
      entityId: event.id,
      detail: { runId: input.runId, classification: input.classification, explanationPresent: true },
    });
    return true;
  });
}

export type TradeReconciliationBulkReviewResult =
  | "saved"
  | "invalid"
  | "already-reviewed";

/**
 * Append one review event per unresolved break as a single atomic operation.
 * The selected run payload remains immutable. A run-scoped advisory lock makes
 * the existing-review check authoritative when two bulk saves race.
 */
export async function appendTradeReconciliationBulkReview(
  identity: Identity,
  input: {
    runId: string;
    rowFingerprints: string[];
    classification: string;
    explanation: string;
  },
): Promise<TradeReconciliationBulkReviewResult> {
  const explanation = input.explanation.trim();
  const rowFingerprints = Array.isArray(input.rowFingerprints)
    ? input.rowFingerprints
    : [];
  if (
    !isTradeReconciliationRunId(input.runId) ||
    rowFingerprints.length === 0 ||
    rowFingerprints.length > MAX_TRADE_RECONCILIATION_BULK_REVIEW_ROWS ||
    new Set(rowFingerprints).size !== rowFingerprints.length ||
    rowFingerprints.some((fingerprint) => !HASH_RE.test(fingerprint)) ||
    !BREAK_CLASSIFICATIONS.includes(input.classification as BreakClassification) ||
    !explanation ||
    explanation.length > 1000
  ) return "invalid";

  return withUserScope(identity, async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'trade-reconciliation-review:' + input.runId})::bigint)::text AS locked`;
    const run = await tx.tradeReconciliationRun.findUnique({
      where: { id: input.runId },
      select: {
        payload: true,
        review_events: {
          where: { row_fingerprint: { in: rowFingerprints } },
          select: { row_fingerprint: true },
          take: 1,
        },
      },
    });
    if (!run) return "invalid";
    if (run.review_events.length > 0) return "already-reviewed";

    const eligibleIds = new Set(
      rowsFromPayload(run.payload)
        .filter((row) => row.result !== "MATCHED")
        .map((row) => row.id),
    );
    if (rowFingerprints.some((fingerprint) => !eligibleIds.has(fingerprint))) return "invalid";

    const batchId = crypto.randomUUID();
    const created = await tx.tradeReconciliationReviewEvent.createMany({
      data: rowFingerprints.map((rowFingerprint) => ({
        run_id: input.runId,
        row_fingerprint: rowFingerprint,
        classification: input.classification,
        explanation,
        reviewer_email: identity.email ?? null,
      })),
    });
    if (created.count !== rowFingerprints.length) {
      throw new Error("trade_reconciliation_bulk_review_incomplete");
    }
    await writeAudit(tx, identity, {
      action: TRADE_RECONCILIATION_BREAK_REVIEW,
      entityType: "trade_reconciliation_review_batch",
      entityId: batchId,
      detail: {
        runId: input.runId,
        classification: input.classification,
        explanationPresent: true,
        reviewCount: rowFingerprints.length,
      },
    });
    return "saved";
  }, { timeout: 20_000 });
}

export async function appendTradeReconciliationNote(
  identity: Identity,
  runId: string,
  note: string,
): Promise<boolean> {
  const trimmed = note.trim();
  if (!isTradeReconciliationRunId(runId) || !trimmed || trimmed.length > 1000) return false;
  return withUserScope(identity, async (tx) => {
    const run = await tx.tradeReconciliationRun.findUnique({ where: { id: runId }, select: { id: true } });
    if (!run) return false;
    const event = await tx.tradeReconciliationNoteEvent.create({
      data: { run_id: runId, note: trimmed, author_email: identity.email ?? null },
      select: { id: true },
    });
    await writeAudit(tx, identity, {
      action: TRADE_RECONCILIATION_RUN_NOTE,
      entityType: "trade_reconciliation_note_event",
      entityId: event.id,
      detail: { runId, notePresent: true },
    });
    return true;
  });
}
