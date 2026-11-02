// Hard-gate module (ticket Slice 3) — PURE: types-only import from
// transfer-types.ts, NO Prisma/next. Consumed by setStage (the flag-gated
// enforcement in actions.ts) and pinned directly by test/transfer-gate.test.ts.
//
// Legacy readiness requirements apply to every forward exit from Decision,
// including a direct move to Funded. Approval and blocking decisions are
// enforced separately by the shared server-action stage contract.
//
// The "ACAT ok" leg keys on `acat_linked` — a caller-supplied boolean meaning a
// GENUINELY-linked ACAT record — NOT on a raw `acat_transfer_id` string (which,
// per #151, is frequently a non-unique placeholder like "N/A" or null on the
// tracker side). The caller (actions.ts S3.2) derives `acat_linked` via
// `acatLinkedFromIds` below (record id primary, legacy UUID fallback — both
// written only by the hardened acat-link.ts path, each backed by its own
// partial-unique index); this module NEVER string-matches or `.trim()`s a raw id.

import { isAcatFunding, STAGE_ORDER } from "@/lib/data/transfer-types";
import type { FundingType, TransferStage } from "@/lib/data/transfer-types";
import { PARTIAL_ACAT_EXECUTION_TASKS } from "./partial-acat-tasks";

export type HardGate = { blocked: boolean; unmet: string[] };

/** Shared read-only rule for a revised route; DRS uses its own canonical gate. */
export function fundingRouteChangeGate(input: {
  transferId: string;
  pending: boolean;
  fundingType: FundingType | null;
  acatLinked: boolean;
  from: TransferStage;
  to: TransferStage;
  tasks: readonly {
    transfer_id: string | null; decision_id: string | null; source_key: string | null;
    task_key: string; owner_team: string; status: string;
  }[];
}): HardGate {
  if (!input.pending || input.fundingType === "DRS" ||
    STAGE_ORDER.indexOf(input.to) <= STAGE_ORDER.indexOf(input.from)) return { blocked: false, unmet: [] };
  if (input.fundingType !== "ACAT_PARTIAL") return {
    blocked: true, unmet: ["Confirm funding was initiated using the revised method before advancing."],
  };
  const required = input.to === "FUNDED" ? PARTIAL_ACAT_EXECUTION_TASKS : PARTIAL_ACAT_EXECUTION_TASKS.slice(0, 2);
  const unmet: string[] = required.filter((definition) => !input.tasks.some((task) =>
    task.transfer_id === input.transferId && task.decision_id === null &&
    task.source_key === `asset-transfer:${input.transferId}:standard-partial-acat:${definition.key}` &&
    task.task_key === definition.key && task.owner_team === definition.owner && task.status === "DONE",
  )).map((task) => task.title);
  if (!input.acatLinked) unmet.push("Link and review the ACAT for the revised partial transfer.");
  return { blocked: unmet.length > 0, unmet };
}

/** The Transfer-Tracker predicate for the S3 gate's `acat_linked` input: a transfer
 *  is linked when it carries the tracker RECORD PK (primary — record-id
 *  linking, covers UUID-less "N/A" tracker records) OR a legacy real-UUID link
 *  (rows linked before record-id linking; both columns are written only by the
 *  hardened acat-link.ts path, each backed by its own partial unique index). */
export function acatLinkedFromIds(
  acatTransferId: string | null,
  acatRecordId: string | null,
): boolean {
  return acatRecordId != null || acatTransferId != null;
}

export function hardGateBlock(
  t: {
    accounts_opened_at_apex: boolean;
    funding_plan_complete: boolean;
    funding_initiated: boolean;
    cash_in_flight: boolean;
    funding_type: FundingType | null;
    acat_linked: boolean /* a REAL linked ACAT record — derive via acatLinkedFromIds, NOT acat_transfer_id.trim() */;
  },
  from: TransferStage,
  to: TransferStage,
): HardGate {
  if (!(from === "DECISION" && STAGE_ORDER.indexOf(to) > STAGE_ORDER.indexOf(from)))
    return { blocked: false, unmet: [] };
  const unmet: string[] = [];
  if (!t.accounts_opened_at_apex) unmet.push("Accounts opened at Apex");
  if (!t.funding_plan_complete) unmet.push("Funding Plan Complete");
  if (!t.funding_initiated) unmet.push("Funding Initiated");
  const acatOk = isAcatFunding(t.funding_type) && t.acat_linked; // a real linked tracker record, not "N/A"
  const cashOk = t.cash_in_flight === true;
  const manualOk = t.funding_type === "MANUAL" && t.funding_initiated;
  if (!acatOk && !cashOk && !manualOk)
    unmet.push(
      t.funding_type === "MANUAL" ? "Manual transfer initiation confirmed" :
        "A real ACAT is linked (Funding Type = ACAT-Full/Partial + a linked tracker record) OR cash is in flight",
    );
  return { blocked: unmet.length > 0, unmet };
}

/**
 * Checklist-as-gate (CHECKLIST_STAGE_GATE). Blocks a FORWARD stage move when any
 * visible, resolved task of the `from` stage is still open. Not forward → never
 * blocks. Zero visible tasks → vacuously satisfied (a transfer with no checklist
 * for its stage — e.g. one that entered the stage before per-stage seeding
 * existed — is never hard-blocked). `unmet` is the incomplete task titles, in
 * order. The caller resolves each task's `done` (stageChecklistTasks +
 * resolveTaskDone) so the gate sees exactly what the checklist UI shows.
 */
export function checklistGateBlock(
  from: TransferStage,
  to: TransferStage,
  visibleResolvedTasks: readonly { title: string; done: boolean }[],
): HardGate {
  const forward = STAGE_ORDER.indexOf(to) > STAGE_ORDER.indexOf(from);
  if (!forward) return { blocked: false, unmet: [] };
  const unmet = visibleResolvedTasks.filter((t) => !t.done).map((t) => t.title);
  return { blocked: unmet.length > 0, unmet };
}
