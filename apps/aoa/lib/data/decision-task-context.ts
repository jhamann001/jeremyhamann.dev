/**
 * Browser-safe, read-time context for a persisted workflow task (ticket).
 *
 * Everything here is DERIVED from rows the viewer could already read under
 * RLS. Nothing is stored and no task status is ever changed: a task that is no
 * longer active work keeps its stored status; this module only decides how
 * honestly the Tasks page can describe it and whether its linked records can
 * be opened.
 *
 * Keep this module free of database, RLS and other server-only imports. The
 * Tasks page (client) and the task writer (server) both depend on it, so the
 * UI and the server agree on which tasks are no longer active work.
 */

export type DecisionTaskInactiveReason =
  /** A standard partial-ACAT step whose transfer's approved route is no longer partial ACAT. */
  | "ROUTE_CHANGED"
  /** A legacy "resolve excluded positions" task replaced by the standard partial-ACAT steps (2026-09-09). */
  | "REPLACED_LEGACY"
  /**
   * An unfinished task on an archived transfer. Archiving (manual or the
   * transfer sync) never touches tasks and nothing un-archives a transfer, and
   * archived-transfer tasks are read-only, so without this they would sit in
   * the open-work totals for good with no way to clear them.
   */
  | "TRANSFER_ARCHIVED";

export type DecisionTaskContext = {
  /** null when the task is not linked to a transfer. */
  transfer: null | {
    id: string;
    /** false when the task names a transfer the viewer cannot read. */
    visible: boolean;
    archived: boolean;
    /** The transfer's APPROVED funding route (only written at plan approval). */
    fundingType: string | null;
  };
  /** null when the task is not linked to a decision. */
  decision: null | {
    id: string;
    /** false when the task names a decision the viewer cannot read. */
    visible: boolean;
    /** true only when Decision Center actually lists this decision, so a link can select it. */
    listed: boolean;
    status: "OPEN" | "SNOOZED" | "RESOLVED" | null;
    resolutionSummary: string | null;
  };
  /** Why the task is no longer active work, or null when it is active. */
  inactiveReason: DecisionTaskInactiveReason | null;
};

/** Legacy automatic partial-ACAT "decisions" that Decision Center deliberately hides. */
export const EXCLUDED_POSITIONS_SOURCE_SUFFIX = ":excluded-positions";
export const LEGACY_EXCLUDED_POSITIONS_TASK_KEY = "resolve-excluded-positions";
/** Written only by the 2026-09-09 backfill and its 2026-09-24 repair when they replaced a legacy decision. */
export const STANDARD_PARTIAL_ACAT_RESOLUTION = "STANDARD_PARTIAL_ACAT";

export function isHiddenLegacyDecision(sourceKey: string | null | undefined): boolean {
  return typeof sourceKey === "string" && sourceKey.endsWith(EXCLUDED_POSITIONS_SOURCE_SUFFIX);
}

export function isStandardPartialAcatTask(task: {
  decisionId: string | null;
  transferId: string | null;
  sourceKey: string | null;
}): boolean {
  return task.decisionId === null && task.transferId !== null && typeof task.sourceKey === "string"
    && task.sourceKey.startsWith(`asset-transfer:${task.transferId}:standard-partial-acat:`);
}

/**
 * The single rule for "no longer active work". Deliberately conservative:
 * - ROUTE_CHANGED needs a KNOWN approved route that is not partial ACAT. An
 *   unknown (null) route or an unreadable transfer never hides a task.
 * - REPLACED_LEGACY applies only to the legacy resolve-excluded-positions task
 *   itself, not to other work that may hang off the same hidden decision, and
 *   only when the backfill actually replaced that decision (resolution code
 *   STANDARD_PARTIAL_ACAT). A legacy decision a person resolved stays ordinary
 *   done work.
 * - TRANSFER_ARCHIVED needs a READABLE archived transfer and a task that is
 *   not DONE. A task a person finished stays counted as done work.
 */
export function decisionTaskInactiveReason(task: {
  decisionId: string | null;
  transferId: string | null;
  sourceKey: string | null;
  taskKey: string;
  /** The stored status (TODO, IN_PROGRESS, BLOCKED or DONE). */
  status: string;
  /** undefined = the transfer could not be read. */
  transferFundingType: string | null | undefined;
  /** undefined = the transfer could not be read. */
  transferArchived: boolean | undefined;
  /** undefined = the decision could not be read. */
  decisionSourceKey: string | null | undefined;
  /** undefined = the decision could not be read. */
  decisionResolutionCode: string | null | undefined;
}): DecisionTaskInactiveReason | null {
  if (task.decisionId !== null && task.taskKey === LEGACY_EXCLUDED_POSITIONS_TASK_KEY
    && isHiddenLegacyDecision(task.decisionSourceKey)
    && task.decisionResolutionCode === STANDARD_PARTIAL_ACAT_RESOLUTION) return "REPLACED_LEGACY";
  if (isStandardPartialAcatTask(task) && typeof task.transferFundingType === "string"
    && task.transferFundingType !== "ACAT_PARTIAL") return "ROUTE_CHANGED";
  if (task.transferId !== null && task.transferArchived === true && task.status !== "DONE") {
    return "TRANSFER_ARCHIVED";
  }
  return null;
}

export function buildDecisionTaskContext(task: {
  decisionId: string | null;
  transferId: string | null;
  sourceKey: string | null;
  taskKey: string;
  status: string;
  transfer: { archived_at: Date | null; funding_type: string | null } | null | undefined;
  decision: {
    source_key: string | null;
    status: string;
    resolution_code: string | null;
    resolution_summary: string | null;
  } | null | undefined;
}): DecisionTaskContext {
  const transfer = task.transferId === null ? null : task.transfer
    ? { id: task.transferId, visible: true, archived: task.transfer.archived_at !== null,
      fundingType: task.transfer.funding_type ?? null }
    : { id: task.transferId, visible: false, archived: false, fundingType: null };
  const decision = task.decisionId === null ? null : task.decision
    ? {
      id: task.decisionId,
      visible: true,
      listed: !isHiddenLegacyDecision(task.decision.source_key),
      status: task.decision.status as "OPEN" | "SNOOZED" | "RESOLVED",
      resolutionSummary: task.decision.resolution_summary,
    }
    : { id: task.decisionId, visible: false, listed: false, status: null, resolutionSummary: null };
  return {
    transfer,
    decision,
    inactiveReason: decisionTaskInactiveReason({
      decisionId: task.decisionId,
      transferId: task.transferId,
      sourceKey: task.sourceKey,
      taskKey: task.taskKey,
      status: task.status,
      transferFundingType: task.transfer ? task.transfer.funding_type ?? null : undefined,
      transferArchived: task.transfer ? task.transfer.archived_at !== null : undefined,
      decisionSourceKey: task.decision ? task.decision.source_key : undefined,
      decisionResolutionCode: task.decision ? task.decision.resolution_code : undefined,
    }),
  };
}

/** Plain-language labels for Operations staff. Neutral about WHO closed a task. */
export const INACTIVE_REASON_LABEL: Record<DecisionTaskInactiveReason, { title: string; detail: string }> = {
  ROUTE_CHANGED: {
    title: "No longer on the approved plan",
    detail: "The transfer's approved funding plan changed, so this partial-ACAT step no longer applies.",
  },
  REPLACED_LEGACY: {
    title: "Replaced by the standard partial-ACAT steps",
    detail: "An older automatic record. Its work moved to the standard partial-ACAT steps.",
  },
  TRANSFER_ARCHIVED: {
    title: "Transfer archived",
    detail: "The transfer was archived before this step was finished, so it is no longer open work.",
  },
};

/** Server-side refusal copy for a write to a task that is no longer active work. */
export const INACTIVE_REASON_WRITE_ERROR: Record<DecisionTaskInactiveReason, string> = {
  ROUTE_CHANGED: "This step is no longer on the transfer's approved plan, so it can't be changed. Refresh the page.",
  REPLACED_LEGACY: "This is an older record that was replaced by the standard partial-ACAT steps, so it can't be changed.",
  TRANSFER_ARCHIVED: "This transfer is archived, so its tasks can no longer be changed.",
};
