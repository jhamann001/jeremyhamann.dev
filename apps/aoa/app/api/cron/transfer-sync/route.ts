import crypto from "crypto";
import type { Prisma, Transfer } from "@prisma/client";
import { INGEST_TRANSFER_SYNC, writeAudit } from "@/lib/audit";
import { requireIngestToken } from "@/lib/ingest/auth";
import { withIngestScope } from "@/lib/ingest/scope";
import { transferDealSourcedRedesignEnabled } from "@/lib/flags";
import { listDeals } from "@/lib/data/deals";
import type { DealRow } from "@/lib/data/deal-types";
import {
  DEFAULT_TASKS,
  missingStageChecklistRows,
} from "@/lib/data/transfer-types";
import {
  orphanAction,
  reconcileAction,
  type ExistingTransfer,
  type ReconcileAction,
} from "@/lib/data/transfer-sync";
import { scheduleCrmIdentityReconciliation } from "@/lib/crm/post-commit-signal";
import { lockTransferPlan } from "@/lib/data/transfer-plan-lock";

// Node runtime: crypto (run id) + Prisma. The deal→transfer sync (ticket
// Slice 4) — a SCHEDULED cron reconciler that PULLS all live app.deal rows and
// LEFT-maps them to the transfers it owns (by deal_id), mirroring
// app/api/cron/account-aum: same 405 posture, same `requireIngestToken` gate,
// same `?dryRun=1`, same single-`withIngestScope` transaction with a same-tx
// audit row. Auth REUSES the ingest bearer token; no new secret. §1.5f: this is
// a PULL scan-and-reconcile job (like account-AUM), deliberately NOT folded into
// the per-item /api/ingest/deals push.
//
// FLAG-GATED (`transferDealSourcedRedesignEnabled`, §1.5 / §2): this is the
// highest-risk writer (a new auto-materialization path), dark-deployed OFF. With
// the flag OFF (prod default) it writes NOTHING — not even the audit row — and
// never reads deals. It stays inert until the owner flips
// TRANSFER_DEAL_SOURCED_REDESIGN after Slices 1+2 are merged & migrated.
//
// §4.3 CONCURRENCY (accepted, documented): the sync reads a PRE-WRITE snapshot
// (listDeals, a separate app_rw read) and on `update` writes the DEAL-OWNED
// fields PLUS a FORWARD-ONLY `stage` advance (ticket sync-stage-mapping — the
// deal pipeline is the source of truth for a deal-sourced transfer's stage). It
// never writes any OTHER workflow column (checklist/funding/owner/acat) and
// never REGRESSES stage, so an advisor who has pushed a transfer ahead of its
// deal is never pulled back — the sync cannot clobber ops' forward progress.
// Scheduled off-hours; contention is negligible (the withIngestScope 120s budget
// rationale carries). ingest_rw is the sole writer here; app_rw only reads.
export const runtime = "nodejs";

const SOURCE = "app.deal";
// The deal stages the reconciler acts on (blueprint §4.2, ticket sync-stage-
// mapping): COMMITTED/FUNDING/WON create-or-advance the transfer at the deal-
// mapped stage (DECISION/IN_TRANSFER/FUNDED, forward-only), LOST archives it,
// and POTENTIAL runs the §1.5b uncommitted progressed-guard. listDeals already
// excludes archived deals; we filter to these stages defensively (robust to
// future deal-stage additions).
const SYNC_STAGES: readonly string[] = [
  "COMMITTED",
  "WON",
  "LOST",
  "POTENTIAL",
  "FUNDING",
];

// System identity for the READ seam ONLY. listDeals runs under app_rw RLS, whose
// deal_read_all_roles policy admits every app role for reads (the locked ADR-4
// posture — "reads all rows for every app role"); OPERATIONS therefore sees the
// whole pipeline. This identity NEVER writes: the write path is ingest_rw via
// withIngestScope. No PII/session — a fixed role, null email.
const SYSTEM_READ_IDENTITY = { role: "OPERATIONS", email: null } as const;

type ErrorBody = { error: string };
const err = (error: string, status: number) =>
  Response.json({ error } satisfies ErrorBody, { status });

// Shared 405 (NOT exported — Next rejects non-Route exports); each verb below
// returns it, guaranteeing our body over Next's default.
function methodNotAllowed(): Response {
  return err("method_not_allowed", 405);
}
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

type Counts = {
  received: number;
  created: number;
  updated: number;
  archived: number;
  flagged: number;
  noop: number;
  // ticket sync-stage-mapping: how many `update` actions included a forward-
  // only `stage` advance (subset of `updated` — an update may advance stage,
  // change deal-owned fields, or both). Audit-only insight into stage churn.
  stage_advanced: number;
  // §4.1 orphan sweep (second pass): transfers whose deal was directly archived/
  // deleted so the per-deal pass never saw them. archived = pristine → deal_gone;
  // flagged = progressed → orphan_review (human review, never auto-teardown).
  orphan_archived: number;
  orphan_flagged: number;
};

// Prisma row → the reconciler's minimal ExistingTransfer projection. `value` is
// a Decimal at runtime → Number() at this seam (the transfers-seam Decimal-trap
// idiom). `stage` narrows the DB enum (5 physical values incl. inert DISCOVERY/
// ACCOUNTS_OPEN) to the 3-value TS union; a physically-inert stage simply reads
// as non-DECISION → non-pristine, which is the safe (flag-not-archive) branch.
function toExisting(t: Transfer): ExistingTransfer {
  return {
    id: t.id,
    deal_id: t.deal_id,
    stage: t.stage as ExistingTransfer["stage"],
    funding_type: t.funding_type as ExistingTransfer["funding_type"],
    client_first_name: t.client_first_name,
    client_last_name: t.client_last_name,
    client_sf_id: t.client_sf_id,
    household_name: t.household_name,
    household_sf_id: t.household_sf_id,
    value: Number(t.value),
    transferring_firm: t.transferring_firm,
    deal_sf_id: t.deal_sf_id,
    accounts_opened_at_apex: t.accounts_opened_at_apex,
    funding_plan_complete: t.funding_plan_complete,
    funding_plan_version: t.funding_plan_version,
    funding_route_change_pending: t.funding_route_change_pending,
    funding_initiated: t.funding_initiated,
    cash_in_flight: t.cash_in_flight,
    acat_transfer_id: t.acat_transfer_id,
    acat_record_id: t.acat_record_id,
    archived_at: t.archived_at,
    sync_flag: t.sync_flag,
  };
}

// Execute ONE reconcile action inside the ingest tx (live runs only — dryRun
// skips this). `create` seeds the CREATED STAGE's DEFAULT_TASKS (input.stage is
// the deal-mapped stage — DECISION/IN_TRANSFER/FUNDED — so a deal materialized
// mid-pipeline gets that stage's task template, like the app's createTransfer
// per-stage seed); `update` writes the deal-owned field diffs AND, when present,
// the forward-only `stage` advance (ticket sync-stage-mapping — the ONLY
// workflow column the sync writes; existing-record Funded advancement requires
// current funding approval). `archive` stamps archived_at/by/reason; `flag` sets
// sync_flag. The ingest actor carries no user email (created_by/updated_by null
// — the canonical trail is the audit row).
async function applyAction(
  tx: Prisma.TransactionClient,
  action: ReconcileAction,
  existing: ExistingTransfer | null,
): Promise<void> {
  switch (action.kind) {
    case "create": {
      const input = action.input;
      await tx.transfer.create({
        data: {
          source: input.source,
          client_first_name: input.client_first_name,
          client_last_name: input.client_last_name,
          client_sf_id: input.client_sf_id ?? null,
          household_name: input.household_name ?? null,
          household_sf_id: input.household_sf_id ?? null,
          value: input.value,
          stage: input.stage,
          owner_kind: input.owner_kind,
          deal_id: input.deal_id ?? null,
          deal_sf_id: input.deal_sf_id ?? null,
          transferring_firm: input.transferring_firm ?? null,
          created_by: null,
          updated_by: null,
          tasks: {
            create: DEFAULT_TASKS[input.stage].map((title, i) => ({
              title,
              sort_order: i,
            })),
          },
        },
      });
      return;
    }
    case "update": {
      if (!existing) return;
      // The deal pipeline can advance a transfer without using the manual
      // setStage action. Seed the destination stage in the SAME transaction so
      // a synced FUNDED card can never land at 0/0. This is deliberately tied
      // to an actual stage change; ordinary deal-field refreshes do not touch
      // checklist rows.
      const tasks = action.changes.stage
        ? await tx.transferTask.findMany({
            where: { transfer_id: existing.id },
            select: { title: true, sort_order: true },
          })
        : [];
      await tx.transfer.update({
        where: {
          id: existing.id,
          ...(action.changes.stage ? { funding_route_change_pending: false } : {}),
          // Recheck completion eligibility at the write as well as after the
          // transfer lock. A competing non-cooperating writer must not make the
          // approved snapshot stale between the read and this stage mutation.
          ...(action.changes.stage === "FUNDED" ? {
            stage: existing.stage,
            archived_at: null,
            funding_plan_complete: true,
            funding_plan_version: existing.funding_plan_version,
          } : {}),
        },
        data: { ...action.changes, updated_by: null },
      });
      if (action.changes.stage) {
        const toSeed = missingStageChecklistRows(
          existing.id,
          action.changes.stage,
          tasks,
        );
        if (toSeed.length > 0) {
          await tx.transferTask.createMany({ data: toSeed });
        }
      }
      return;
    }
    case "archive": {
      if (!existing) return;
      await tx.transfer.update({
        where: { id: existing.id },
        data: {
          archived_at: new Date(),
          archived_by: null,
          archived_reason: action.reason,
          updated_by: null,
        },
      });
      return;
    }
    case "flag": {
      if (!existing) return;
      await tx.transfer.update({
        where: { id: existing.id },
        data: { sync_flag: action.sync_flag, updated_by: null },
      });
      return;
    }
    case "noop":
      return;
  }
}

function tally(counts: Counts, action: ReconcileAction): void {
  switch (action.kind) {
    case "create":
      counts.created += 1;
      break;
    case "update":
      counts.updated += 1;
      if (action.changes.stage) counts.stage_advanced += 1;
      break;
    case "archive":
      counts.archived += 1;
      break;
    case "flag":
      counts.flagged += 1;
      break;
    case "noop":
      counts.noop += 1;
      break;
  }
}

export async function POST(req: Request): Promise<Response> {
  // 1. Auth — the same bearer gate the push ingest routes use.
  if (!requireIngestToken(req).ok) return err("unauthorized", 401);

  // 2. Flag gate (dark-deploy). OFF ⇒ no writes AT ALL (not even the audit row),
  //    and no deals read. This is the whole point of the slice: ship the
  //    highest-risk writer inert.
  if (!transferDealSourcedRedesignEnabled()) {
    return Response.json({ synced: 0, skipped: "flag_off" });
  }

  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const runId = crypto.randomUUID();
  // Log-injection-safe run id (security scanner CWE-117 convention — encodeURIComponent is
  // the recognized sanitizer). run id is app-generated, but keep the idiom; no
  // PII/token/raw id ever reaches a log line.
  const safeRunId = encodeURIComponent(runId).slice(0, 256);

  // 3. Pre-write snapshot (§4.3): read every non-archived deal via the deals
  //    seam (reuse listDeals — no redundant SELECT), then keep the reconcilable
  //    stages. A read failure is a clean 500 with a counts-free log.
  let deals: DealRow[];
  // §4.1: the ids of ALL non-archived deals read this run (the FULL listDeals
  // result, BEFORE the SYNC_STAGES filter) — the orphan sweep's "still active"
  // set. Basing it on `all` (not `deals`) means a transfer whose deal is merely
  // in a non-synced stage is NOT swept; only a deal that is truly gone
  // (archived/deleted, so absent from listDeals entirely) orphans its transfer.
  let activeDealIds: Set<string>;
  try {
    const all = await listDeals(SYSTEM_READ_IDENTITY);
    activeDealIds = new Set(all.map((d) => d.id));
    deals = all.filter((d) => SYNC_STAGES.includes(d.stage));
  } catch {
    console.error(`[cron:transfer-sync] deals_read_failed run_id=${safeRunId}`);
    return err("internal", 500);
  }

  const counts: Counts = {
    received: deals.length,
    created: 0,
    updated: 0,
    archived: 0,
    flagged: 0,
    noop: 0,
    stage_advanced: 0,
    orphan_archived: 0,
    orphan_flagged: 0,
  };

  // 4. Reconcile + persist in ONE ingest_rw transaction (ADR-8): the per-deal
  //    writes and the run's audit row commit together. dryRun computes the
  //    actions (and their counts) but skips every reconcile write — ONLY the
  //    audit row is written, so a dry run is a real, auditable no-op preview.
  try {
    await withIngestScope(async (tx) => {
      const dealIds = deals.map((d) => d.id);
      const existingRows =
        dealIds.length === 0
          ? []
          : await tx.transfer.findMany({ where: { deal_id: { in: dealIds } } });
      const byDealId = new Map<string, ExistingTransfer>();
      for (const t of existingRows) {
        if (t.deal_id) byDealId.set(t.deal_id, toExisting(t));
      }

      for (const deal of deals) {
        let existing = byDealId.get(deal.id) ?? null;
        let action = reconcileAction(deal, existing);
        // Plan approval can select DRS or be invalidated after the batch read. Serialize only
        // automated stage/archive writes with manual plan approval, then decide
        // again from the locked row so a stale non-DRS plan cannot move/hide it.
        if (!dryRun && existing && (action.kind === "archive" ||
          (action.kind === "update" && action.changes.stage))) {
          await lockTransferPlan(tx, existing.id);
          const current = await tx.transfer.findUnique({ where: { id: existing.id } });
          if (!current) throw new Error("Transfer unavailable");
          existing = toExisting(current);
          action = reconcileAction(deal, existing);
        }
        if (!dryRun) await applyAction(tx, action, existing);
        tally(counts, action);
      }

      // §4.1 ORPHAN sweep (second pass, SAME tx): every still-active, deal-linked
      // transfer whose deal is NO LONGER in the active set (directly archived or
      // deleted) — rows the per-deal pass above can never reach. Pristine ⇒
      // archive("deal_gone"); progressed ⇒ flag("orphan_review"). already-archived
      // rows are excluded by archived_at:null, so a re-run is a no-op (idempotent).
      // dryRun computes the actions/counts but writes nothing (audit row only).
      const orphanCandidates = await tx.transfer.findMany({
        where: { deal_id: { not: null }, archived_at: null },
      });
      for (const t of orphanCandidates) {
        let existing = toExisting(t);
        let action = orphanAction(existing, activeDealIds);
        if (!dryRun && action.kind === "archive") {
          await lockTransferPlan(tx, existing.id);
          const current = await tx.transfer.findUnique({ where: { id: existing.id } });
          if (!current) throw new Error("Transfer unavailable");
          existing = toExisting(current);
          action = existing.archived_at == null
            ? orphanAction(existing, activeDealIds)
            : { kind: "noop" };
        }
        if (!dryRun) await applyAction(tx, action, existing);
        if (action.kind === "archive") counts.orphan_archived += 1;
        else if (action.kind === "flag") counts.orphan_flagged += 1;
      }

      await writeAudit(
        tx,
        { role: "INGEST", email: null },
        {
          action: INGEST_TRANSFER_SYNC,
          entityType: "ingest_run",
          entityId: runId,
          detail: {
            received: counts.received,
            created: counts.created,
            updated: counts.updated,
            archived: counts.archived,
            flagged: counts.flagged,
            noop: counts.noop,
            stage_advanced: counts.stage_advanced,
            orphan_archived: counts.orphan_archived,
            orphan_flagged: counts.orphan_flagged,
            dry_run: dryRun,
          },
        },
      );
    });
  } catch {
    console.error(`[cron:transfer-sync] run_id=${safeRunId} tx_failed`);
    return err("internal", 500);
  }

  // Only a committed live run that materialized at least one app.transfer needs
  // the fast path. Dry-run counts and updates cannot introduce an unmapped row.
  if (!dryRun && counts.created > 0) {
    scheduleCrmIdentityReconciliation("transfer_sync");
  }

  // 5. Response — the run's counts (+ dry_run marker). source names the pull.
  return Response.json({
    received: counts.received,
    created: counts.created,
    updated: counts.updated,
    archived: counts.archived,
    flagged: counts.flagged,
    noop: counts.noop,
    stage_advanced: counts.stage_advanced,
    orphan_archived: counts.orphan_archived,
    orphan_flagged: counts.orphan_flagged,
    dry_run: dryRun,
    source: SOURCE,
  });
}
