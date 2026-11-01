"use server";

/**
 * SLA policy and auto-assignment mutations — `"use server"`, node, layer L4
 * (the build record B4 and §3.2 `SLA_POLICY_CHANGED`, #99).
 *
 * Both exports go through `runAction` (authenticate → validate → RBAC → ONE transaction that mutates
 * AND writes its audit rows last). `sla:admin` is `ops_team` only, re-checked here
 * even though middleware and the page already checked: the server is authoritative.
 *
 * ONE AUDIT ROW PER FIELD THAT ACTUALLY MOVED, which is the shape §3.2 asks for and also the shape
 * that answers the question an examiner asks. "Somebody edited the URGENT policy" is not an answer;
 * "first response went from 30 to 60 minutes on 20 Sep, by this person" is. A form submitted with
 * nothing changed writes NOTHING — the ledger records changes, not intentions (I13's spirit, and the
 * same discipline `updateMacro` and `deactivateUser` apply).
 *
 * WHAT AN EDIT DOES AND DOES NOT TOUCH, because this is the part that frightens people:
 *   - `firstResponseMinutes` / `resolutionMinutes` are SNAPSHOTTED per ticket at creation and
 *     re-stamped only on a priority change. Editing them moves nothing that already exists — no
 *     due stamp is rewritten, no breach is un-breached, no closed ticket changes its verdict.
 *   - `warningMinutes` is read LIVE, so editing it re-colours OPEN work on the next
 *     render and still rewrites no history.
 * The page states both in words. This docstring is the second copy on purpose.
 */
import type { ActionResult, AuditEntry, QueueKey, SaveSlaPolicyInput, TicketPriority } from "@/types/domain";
import { DEFAULT_SLA_POLICIES } from "@/types/domain";
import { actorFromViewer, writeAuditMany } from "@/lib/audit";
import { withTx } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { assertCan, canAdminSla } from "@/lib/rbac";
import { DEFAULT_WARNING_MINUTES } from "@/lib/sla";
import { runAction } from "@/server/action-utils";
import {
  saveSlaPolicySchema,
  setQueueAutoAssignSchema,
  type SetQueueAutoAssignInput,
} from "@/server/sla-policies";

// ---------------------------------------------------------------------------
// Module-private helpers (a "use server" module exports async functions only — guardrail G4)
// ---------------------------------------------------------------------------

/** The three editable numbers, in the order the form renders them. */
const POLICY_FIELDS = ["firstResponseMinutes", "resolutionMinutes", "warningMinutes"] as const;
type PolicyField = (typeof POLICY_FIELDS)[number];

type PolicyNumbers = Record<PolicyField, number>;

/**
 * What was in force before this save. For a priority with no row that is the CODE fallback
 * `slaPolicyFor` was silently using, not null — the ledger should say the first-response clock went
 * from 240 to 120, not "from nothing", because 240 is what the desk was actually promising.
 */
function priorBaseline(priority: TicketPriority): PolicyNumbers {
  const fallback = DEFAULT_SLA_POLICIES[priority];
  return {
    firstResponseMinutes: fallback.firstResponseMinutes,
    resolutionMinutes: fallback.resolutionMinutes,
    warningMinutes: DEFAULT_WARNING_MINUTES,
  };
}

function changedFields(before: PolicyNumbers, after: PolicyNumbers): PolicyField[] {
  return POLICY_FIELDS.filter((f) => before[f] !== after[f]);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Creates or edits one priority's policy. Keyed by PRIORITY rather than by row id, because the row is
 * the priority: there is one per `TicketPriority` (`@unique`), and a priority that has never been
 * saved is still a policy the desk is running on.
 */
export async function saveSlaPolicy(
  input: SaveSlaPolicyInput,
): Promise<ActionResult<{ priority: TicketPriority }>> {
  return runAction("saveSlaPolicy", async (viewer, ctx) => {
    const data = saveSlaPolicySchema.parse(input);
    assertCan(canAdminSla(viewer.groups), "sla:admin saveSlaPolicy");
    const actor = actorFromViewer(viewer);

    const after: PolicyNumbers = {
      firstResponseMinutes: data.firstResponseMinutes,
      resolutionMinutes: data.resolutionMinutes,
      warningMinutes: data.warningMinutes,
    };

    return withTx(async (tx) => {
      const existing = await tx.sLA.findUnique({
        where: { priority: data.priority },
        select: {
          id: true,
          firstResponseMinutes: true,
          resolutionMinutes: true,
          warningMinutes: true,
        },
      });

      const before: PolicyNumbers =
        existing === null
          ? priorBaseline(data.priority)
          : {
              firstResponseMinutes: existing.firstResponseMinutes,
              resolutionMinutes: existing.resolutionMinutes,
              warningMinutes: existing.warningMinutes,
            };

      const moved = changedFields(before, after);
      if (existing !== null && moved.length === 0) return { priority: data.priority };

      const row =
        existing === null
          ? await tx.sLA.create({
              data: { priority: data.priority, name: DEFAULT_SLA_POLICIES[data.priority].name, ...after },
              select: { id: true },
            })
          : await tx.sLA.update({ where: { id: existing.id }, data: after, select: { id: true } });

      const entries: AuditEntry[] = moved.map((field) => ({
        action: "SLA_POLICY_CHANGED",
        entityType: "SLA_POLICY",
        entityId: row.id,
        fieldChanged: field,
        oldValue: String(before[field]),
        newValue: String(after[field]),
        metadata: {
          priority: data.priority,
          // True when the row did not exist and the old value is the code fallback that was in force.
          createdRow: existing === null,
          // The reader's shortcut for "does this move existing due stamps?" — only warningMinutes is
          // read live; the other two are snapshotted per ticket.
          liveReading: field === "warningMinutes",
        },
      }));

      // A create with no field different from the code fallback still writes one row: the fact that
      // the policy was pinned into the table, rather than left to a code constant, is itself a change
      // somebody made deliberately and an examiner can date.
      if (entries.length === 0) {
        entries.push({
          action: "SLA_POLICY_CHANGED",
          entityType: "SLA_POLICY",
          entityId: row.id,
          fieldChanged: "priority",
          oldValue: null,
          newValue: data.priority,
          metadata: { priority: data.priority, createdRow: true, liveReading: false },
        });
      }

      await writeAuditMany(tx, actor, ctx, entries);
      return { priority: data.priority };
    });
  });
}

/**
 * Turns auto-assignment on or off for ONE queue.
 *
 * Audited as `SLA_POLICY_CHANGED` against `entityType: QUEUE`. The audit catalog is closed and holds
 * no `QUEUE_UPDATED`; rather than borrow a ticket action or leave the flip unrecorded, it is filed as
 * what it is — a change to the desk's own service policy — with the queue as the entity. The deviation
 * is recorded in the build record.
 *
 * Flipping it OFF never un-assigns anything. Tickets already handed out are somebody's work.
 */
export async function setQueueAutoAssign(
  input: SetQueueAutoAssignInput,
): Promise<ActionResult<{ queueKey: QueueKey; autoAssign: boolean }>> {
  return runAction("setQueueAutoAssign", async (viewer, ctx) => {
    const data = setQueueAutoAssignSchema.parse(input);
    assertCan(canAdminSla(viewer.groups), "sla:admin setQueueAutoAssign");
    const actor = actorFromViewer(viewer);

    return withTx(async (tx) => {
      const queue = await tx.queue.findUnique({
        where: { key: data.queueKey },
        select: { id: true, autoAssign: true },
      });
      if (queue === null) throw new NotFoundError("queue not found");

      // Already in the requested state: the caller asked for a state and the state holds. No row.
      if (queue.autoAssign === data.autoAssign) {
        return { queueKey: data.queueKey, autoAssign: data.autoAssign };
      }

      await tx.queue.update({ where: { id: queue.id }, data: { autoAssign: data.autoAssign } });

      await writeAuditMany(tx, actor, ctx, [
        {
          action: "SLA_POLICY_CHANGED",
          entityType: "QUEUE",
          entityId: queue.id,
          fieldChanged: "autoAssign",
          oldValue: String(queue.autoAssign),
          newValue: String(data.autoAssign),
          metadata: { queueKey: data.queueKey, liveReading: true },
        },
      ]);

      return { queueKey: data.queueKey, autoAssign: data.autoAssign };
    });
  });
}
