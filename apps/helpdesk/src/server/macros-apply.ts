/**
 * Macro actions applier — node, layer L4.
 *
 * A macro used to be wording and nothing else. `Macro.actions` makes it wording PLUS the side effects
 * that always accompanied it — "reply with the wire-verification notice and set the ticket to Pending
 * client" is one act in an operator's head and was two clicks with a gap in the middle, which is where
 * the second one gets forgotten. This module closes that gap.
 *
 * Four rules, all of them load-bearing:
 *
 *  1. **Atomic with the comment.** `addInternalNote` and `addPublicReply` call this INSIDE their
 *     transaction, after the comment row exists and before `writeAuditMany`. A reply that lands with
 *     its status change missing is worse than no macro actions at all, because the operator saw the
 *     macro apply and will not check.
 *  2. **A macro is a shortcut through the UI, never a way around the policy.** Every field is
 *     re-checked against exactly the rule the manual path checks — the status state machine
 *     (`canTransition`), the money-movement identity gate on RESOLVED, `canMoveTicket`
 *     for a queue hand-off, and §b.4 assignee eligibility (active user holding WRITE on the queue the
 *     ticket will be in). The groups used for those checks are re-read from the database inside the
 *     transaction rather than taken from the session, because this runs behind a call site that hands
 *     it an id and nothing else.
 *  3. **Ordinary audit rows, plus one that names the macro.** A status change from a macro is a
 *     `TICKET_STATUS_CHANGED` row identical to a manual one — so every existing reader, report and
 *     export keeps working without learning about macros — and a single `MACRO_ACTIONS_APPLIED` row
 *     records which fields the macro moved and which macro did it. Entries are RETURNED, never
 *     written, so `writeAuditMany` stays the caller's last statement (§3 rule 2).
 *  4. **No version bump of its own.** The caller's guarded `updateMany` already incremented
 *     `Ticket.version` exactly once for this submit. A second increment here would make one
 *     operator action look like two and would invalidate the version token the caller just returned.
 *
 * A field whose requested value the ticket already holds is SKIPPED silently: it is not a change, so
 * it is not an event, and `applied` names only what actually moved.
 *
 * A field the policy refuses is a `ValidationError`, which rolls the whole transaction back — comment
 * included. That is the deliberate reading of "atomic": a macro that cannot do its half must not get
 * to do the half that reaches the client. The message names the macro and the field, because the fix
 * is an admin edit in `/admin/macros`, not something the operator can work around at the keyboard.
 */
import { z } from "zod";
import type {
  AuditEntry,
  MacroActions,
  QueueKey,
  TicketPriority,
  TicketResolution,
  TicketStatus,
} from "@/types/domain";
import {
  ESCALATION_TARGETS,
  OPERATOR_RESOLUTIONS,
  QUEUE_KEYS,
  RESOLUTION_BEARING_STATUSES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
} from "@/types/domain";
import type { DbTx } from "@/lib/db";
import { diffFields } from "@/lib/audit";
import { ValidationError } from "@/lib/errors";
import { firmInstant, firmWallClock } from "@/lib/firm-time";
import { canMoveTicket, canWriteQueue } from "@/lib/rbac";
import { computeDueDates, slaPolicyFor } from "@/lib/sla";
import { canTransition } from "@/lib/ticket-policy";
import { assertIdentityGate } from "@/server/identity-gate";
import { maybeSendResolvedNotice } from "@/server/system-messages";

// ---------------------------------------------------------------------------
// The stored shape
// ---------------------------------------------------------------------------

/**
 * `Macro.actions`, validated.
 *
 * `prisma/schema.prisma` says this schema lives in `src/types/domain.ts`; it does not exist there, and
 * that file is foundation-owned, so it lives here beside the only code that applies it.
 * The TYPE it produces is `MacroActions` from `@/types/domain`, unchanged — the parity assertion below
 * fails at compile time if the two ever drift. Deviation recorded in
 * the build record.
 *
 * `.strict()` matters: an unknown key in a stored blob is a macro somebody hand-edited or a field from
 * a future version of this app, and applying the keys we recognise while silently dropping the rest is
 * how a macro quietly stops doing half of what its author believes it does.
 *
 * `VOIDED` is excluded from `status` at the schema, not merely refused at apply time. Decision #96
 * keeps voiding off the state machine precisely so it cannot be reached by anything holding
 * `queue:write`; a macro is exactly the "one click that makes a ticket disappear from every counter"
 * that decision exists to prevent.
 */
export const macroActionsSchema = z
  .object({
    status: z.enum(TICKET_STATUSES).refine((s) => s !== "VOIDED", {
      message: "A macro cannot void a ticket — voiding is deliberately not a status transition",
    }),
    priority: z.enum(TICKET_PRIORITIES),
    queueKey: z.enum(QUEUE_KEYS),
    assignee: z.union([z.literal("me"), z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id"), z.null()]),
    /**
     * How the ticket ENDED, applied only when this macro's `status` also ends it. Only
     * the four operator outcomes: a macro that could set DUPLICATE or ENTERED_IN_ERROR would claim a
     * merge or a void that never happened, which is the same refusal `changeTicketStatus` makes.
     */
    resolution: z.enum(OPERATOR_RESOLUTIONS),
    /** Days from submission, in firm time. 0 clears the follow-up; the ceiling is one year. */
    followUpInDays: z.number().int().min(0).max(365),
    escalationTarget: z.enum(ESCALATION_TARGETS),
  })
  .partial()
  .strict()
  /**
   * Fix round 2. An outcome is only ever WRITTEN on a transition that ends the ticket, so a macro
   * carrying `resolution` without an ending `status` is statically dead: it would save happily and
   * then do nothing, for every ticket, forever, with no error anywhere to explain the empty
   * `resolution-mix`. Refused here rather than in the action so the SAVE path and the parse of the
   * STORED column agree — the alternative is a row that saves through one schema and is dropped by
   * the other.
   *
   * This is the one coherence rule in this schema, and it is a rule about the CONFIGURATION, not
   * about any particular ticket. `setMacroActions` deliberately does not check reachability
   * (`OPEN → CLOSED` is legal to configure and illegal from `NEW`); "this key can never apply under
   * any circumstances" is a different statement, and it is a typo caught at the only moment anyone
   * is looking.
   */
  .refine(
    (a) =>
      a.resolution === undefined ||
      (a.status !== undefined && (RESOLUTION_BEARING_STATUSES as readonly string[]).includes(a.status)),
    {
      path: ["resolution"],
      message: "An outcome only applies when the macro also resolves or closes the ticket",
    },
  );

/**
 * Compile-time parity: what the schema produces is a `MacroActions`.
 *
 * ONE direction, deliberately. The reverse does not hold and must not: `MacroActions["status"]` is the
 * whole `TicketStatus` enum, including `VOIDED`, while this schema refuses `VOIDED` for the reason
 * above. A macro that voided a ticket would be Decision #96 undone by a JSON column. The assertion
 * that matters is that nothing the schema accepts is outside the domain type, and that is this one —
 * adding a key here without adding it to `MacroActions` fails the build.
 */
type SchemaOutput = z.infer<typeof macroActionsSchema>;
type AssertAssignable<A extends B, B> = A;
export type MacroActionsParity = AssertAssignable<SchemaOutput, MacroActions>;

/** The action keys, in the order a preview and an audit row list them. */
export const MACRO_ACTION_KEYS = [
  "status",
  "resolution",
  "priority",
  "queueKey",
  "assignee",
  "followUpInDays",
  "escalationTarget",
] as const satisfies readonly (keyof MacroActions)[];

/** True when the parsed object asks for nothing at all — the same as a null column. */
export function isEmptyMacroActions(actions: MacroActions | null): boolean {
  return actions === null || MACRO_ACTION_KEYS.every((k) => actions[k] === undefined);
}

/**
 * Reads `Macro.actions` off a row. `null`/absent → null. Anything else is parsed, and a blob that
 * fails the schema THROWS rather than degrading to "no actions": a macro whose stored actions cannot
 * be understood must not quietly become a plain body insert, because the operator picked it for what
 * it does and would never see that half of it went missing.
 */
export function parseMacroActions(raw: unknown, macroKey: string): MacroActions | null {
  if (raw === null || raw === undefined) return null;
  const parsed = macroActionsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(`macro "${macroKey}" has invalid stored actions`, {
      macroId: [
        `The macro "${macroKey}" carries actions this desk cannot apply. An administrator must fix it ` +
          "under Admin → Macros before it can be used.",
      ],
    });
  }
  return isEmptyMacroActions(parsed.data) ? null : parsed.data;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export type MacroApplyContext = {
  ticketId: string;
  macroId: string;
  /** The submitting viewer, for `assignee: "me"` and for the eligibility re-checks. */
  viewerId: string;
};

export type MacroApplyResult = { applied: (keyof MacroActions)[]; auditEntries: AuditEntry[] };

const TICKET_SELECT = {
  id: true,
  number: true,
  status: true,
  // Read so the status branch can tell "no outcome yet" from "already ended as X", and so
  // `diffFields` has an OLD value for the outcome row.
  resolution: true,
  priority: true,
  category: true,
  queueId: true,
  assigneeId: true,
  followUpAt: true,
  escalationTarget: true,
  createdAt: true,
  resolvedAt: true,
  closedAt: true,
  slaFirstResponseMinutes: true,
  slaResolutionMinutes: true,
  firstResponseDueAt: true,
  resolutionDueAt: true,
  queue: { select: { key: true } },
  assignee: { select: { id: true, email: true, groups: true, isActive: true } },
} as const;

function ticketEntry(ticketId: string, entry: Omit<AuditEntry, "entityType" | "entityId" | "ticketId">): AuditEntry {
  return { entityType: "TICKET", entityId: ticketId, ticketId, ...entry };
}

function refuse(macroKey: string, field: keyof MacroActions, detail: string): never {
  throw new ValidationError(`macro "${macroKey}" cannot set ${field}: ${detail}`, {
    macroId: [`This macro also sets ${field}, and that is not allowed here: ${detail}`],
  });
}

/**
 * `followUpInDays` → an instant, or null for 0.
 *
 * Counted in FIRM days and landed at 09:00 ET, not "now plus N × 24 h". "Follow up in three days"
 * means a working morning three days out, wherever the operator and the server happen to be; an
 * offset in milliseconds drifts by an hour twice a year and lands follow-ups at whatever time the
 * original reply happened to be sent. `firmInstant` resolves the two DST edges explicitly
 * (`src/lib/firm-time.ts`).
 */
export const MACRO_FOLLOW_UP_HOUR = 9;

export function followUpInstant(days: number, now: Date = new Date()): Date | null {
  if (days <= 0) return null;
  const wc = firmWallClock(now);
  if (wc === null) return null;
  // Add the days to the firm-local calendar date; `firmInstant` normalises an overflowing day number
  // (Sep 31 → Oct 1) through Date.UTC, so month ends need no special case.
  return firmInstant(wc.year, wc.month, wc.day + days, MACRO_FOLLOW_UP_HOUR, 0, 0);
}

/**
 * Applies `Macro.actions` for `ctx.macroId` to `ctx.ticketId`, inside the caller's transaction.
 *
 * Returns the fields that actually moved and the audit entries the caller must append to its own
 * list. Writes nothing to `AuditLog` itself.
 */
export async function applyMacroActions(tx: DbTx, ctx: MacroApplyContext): Promise<MacroApplyResult> {
  const macro = await tx.macro.findUnique({
    where: { id: ctx.macroId },
    select: { id: true, key: true, actions: true },
  });
  // The caller has already resolved the macro (`resolveMacro`), so a miss here means it was retired
  // between the two reads. Nothing to apply, and the comment itself is unaffected.
  if (!macro) return { applied: [], auditEntries: [] };

  const actions = parseMacroActions(macro.actions, macro.key);
  if (actions === null) return { applied: [], auditEntries: [] };

  const t = await tx.ticket.findUnique({ where: { id: ctx.ticketId }, select: TICKET_SELECT });
  if (!t) return { applied: [], auditEntries: [] };

  // §b: the capability re-check reads the SUBMITTER's groups from the database inside this
  // transaction. The call site hands us an id, and a group list carried in a session token is a
  // snapshot up to eight hours old — not the basis for a queue hand-off.
  const submitter = await tx.user.findUnique({
    where: { id: ctx.viewerId },
    select: { id: true, email: true, groups: true, isActive: true },
  });
  if (!submitter || !submitter.isActive) {
    refuse(macro.key, "assignee", "the submitting user is no longer active");
  }

  // Every action is a ticket edit, so it needs what a manual edit needs: WRITE on the ticket's queue, and a
  // ticket that is neither closed nor voided (`assertTicketNotClosed`). An internal note needs only READ and is
  // allowed on a closed ticket, so without this a read-only viewer could edit any ticket through a macro.
  const firstField = MACRO_ACTION_KEYS.find((k) => actions[k] !== undefined) ?? "status";
  if (!canWriteQueue(submitter.groups, t.queue.key)) {
    refuse(macro.key, firstField, `your groups cannot change tickets in ${t.queue.key}`);
  }
  if (t.status === "CLOSED" || t.status === "VOIDED") {
    refuse(macro.key, firstField, `the ticket is ${t.status === "CLOSED" ? "closed" : "voided"}`);
  }

  const applied: (keyof MacroActions)[] = [];
  const entries: AuditEntry[] = [];
  const now = new Date();

  // Everything below accumulates into ONE update. A macro is one act, so it takes one row lock and
  // leaves one consistent row, rather than four partial states another reader could observe.
  const after: {
    status?: TicketStatus;
    resolution?: TicketResolution;
    resolvedAt?: Date | null;
    closedAt?: Date | null;
    priority?: TicketPriority;
    slaFirstResponseMinutes?: number;
    slaResolutionMinutes?: number;
    firstResponseDueAt?: Date;
    resolutionDueAt?: Date;
    queueId?: string;
    assigneeId?: string | null;
    followUpAt?: Date | null;
    escalationTarget?: MacroActions["escalationTarget"];
  } = {};

  // --- queue -------------------------------------------------------------
  //
  // First, because the assignee's eligibility is judged against the queue the ticket ENDS UP in.
  let effectiveQueueKey: QueueKey = t.queue.key;
  if (actions.queueKey !== undefined && actions.queueKey !== t.queue.key) {
    const to = actions.queueKey;
    if (!canMoveTicket(submitter.groups, t.queue.key, to)) {
      refuse(macro.key, "queueKey", `your groups cannot hand a ticket from ${t.queue.key} to ${to}`);
    }
    const destination = await tx.queue.findUnique({ where: { key: to }, select: { id: true } });
    if (!destination) refuse(macro.key, "queueKey", `the queue ${to} is not provisioned`);
    after.queueId = destination.id;
    effectiveQueueKey = to;
    applied.push("queueKey");
    entries.push(
      ticketEntry(t.id, {
        action: "TICKET_QUEUE_CHANGED",
        fieldChanged: "queueKey",
        oldValue: t.queue.key,
        newValue: to,
      }),
    );
    // §b.5: a move clears an assignee who cannot write the destination. Mirrored from
    // `moveTicketQueue` rather than reasoned about again, so the two paths cannot diverge.
    if (t.assignee !== null && !canWriteQueue(t.assignee.groups, to)) {
      after.assigneeId = null;
      entries.push(
        ticketEntry(t.id, {
          action: "TICKET_ASSIGNED",
          fieldChanged: "assigneeId",
          oldValue: t.assignee.id,
          newValue: null,
          metadata: { oldEmail: t.assignee.email, newEmail: null, reason: "queue-move" },
        }),
      );
    }
  }

  // --- assignee ----------------------------------------------------------
  if (actions.assignee !== undefined) {
    const wantedId = actions.assignee === "me" ? submitter.id : actions.assignee;
    const currentId = after.assigneeId !== undefined ? after.assigneeId : t.assigneeId;
    if (wantedId !== currentId) {
      let nextEmail: string | null = null;
      if (wantedId !== null) {
        const candidate =
          wantedId === submitter.id
            ? submitter
            : await tx.user.findUnique({
                where: { id: wantedId },
                select: { id: true, email: true, groups: true, isActive: true },
              });
        // §b.4, unchanged: an assignee must be an ACTIVE user holding WRITE on the ticket's queue.
        if (!candidate || !candidate.isActive || !canWriteQueue(candidate.groups, effectiveQueueKey)) {
          refuse(macro.key, "assignee", "that user is not an active member who can work this queue");
        }
        nextEmail = candidate.email;
      }
      after.assigneeId = wantedId;
      applied.push("assignee");
      entries.push(
        ticketEntry(t.id, {
          action: "TICKET_ASSIGNED",
          fieldChanged: "assigneeId",
          oldValue: currentId,
          newValue: wantedId,
          metadata: { oldEmail: t.assignee?.email ?? null, newEmail: nextEmail, reason: "macro" },
        }),
      );
    }
  }

  // --- priority ----------------------------------------------------------
  //
  // §d: a priority change re-stamps BOTH due dates from the ticket's original `createdAt` and
  // snapshots the policy that applied, exactly as `changeTicketPriority` does. Changing the priority
  // without re-stamping would leave a ticket labelled Urgent while its SLA clock still ran at Low —
  // which is the reading every report and the whole SLA sweep would then take.
  if (actions.priority !== undefined && actions.priority !== t.priority) {
    const policy = slaPolicyFor(actions.priority, await tx.sLA.findUnique({ where: { priority: actions.priority } }));
    const due = computeDueDates(t.createdAt, policy);
    after.priority = actions.priority;
    after.slaFirstResponseMinutes = policy.firstResponseMinutes;
    after.slaResolutionMinutes = policy.resolutionMinutes;
    after.firstResponseDueAt = due.firstResponseDueAt;
    after.resolutionDueAt = due.resolutionDueAt;
    applied.push("priority");
    entries.push(
      ticketEntry(t.id, {
        action: "TICKET_PRIORITY_CHANGED",
        fieldChanged: "priority",
        oldValue: t.priority,
        newValue: actions.priority,
      }),
      ...diffFields(
        t,
        {
          slaFirstResponseMinutes: after.slaFirstResponseMinutes,
          slaResolutionMinutes: after.slaResolutionMinutes,
          firstResponseDueAt: after.firstResponseDueAt,
          resolutionDueAt: after.resolutionDueAt,
        },
        ["slaFirstResponseMinutes", "slaResolutionMinutes", "firstResponseDueAt", "resolutionDueAt"],
      ).map((d) => ticketEntry(t.id, { action: "TICKET_FIELD_CHANGED", ...d })),
    );
  }

  // --- status ------------------------------------------------------------
  //
  // Read from the row INSIDE this transaction, so the state machine is checked against the status the
  // caller's own guard may just have set (NEW → OPEN on a reply, or → PENDING_CLIENT on the pending
  // variant) rather than against the snapshot it loaded before the transaction opened.
  if (actions.status !== undefined && actions.status !== t.status) {
    if (!canTransition(t.status, actions.status)) {
      refuse(macro.key, "status", `${t.status} → ${actions.status} is not an allowed transition`);
    }
    // the money-movement identity gate applies to the transition INTO RESOLVED
    // whoever asks for it. A macro is a shortcut through the UI, not around the gate.
    if (actions.status === "RESOLVED") {
      await assertIdentityGate(tx, { ticketId: t.id, category: t.category });
    }
    after.status = actions.status;
    if (actions.status === "RESOLVED") after.resolvedAt = now;
    if (t.status === "RESOLVED" && actions.status === "CLOSED") after.closedAt = now;
    if (t.status === "RESOLVED" && actions.status === "OPEN") {
      after.resolvedAt = null;
      // A reopened ticket has not ended, so it carries no outcome — the same clear the single-ticket
      // and bulk paths perform, for the same reason.
      after.resolution = "NONE";
    }
    // Fix round 2. The macro's stored outcome, applied only on a transition that actually ends the
    // ticket and only when the ticket does not already carry one — the same write-once rule
    // `assertResolutionAllowed` enforces on the single-ticket path. A macro whose `resolution` never
    // fires because its `status` does not end the ticket is refused at SAVE time (`macro-form-support`),
    // so an outcome silently going nowhere is not a state an admin can reach through the form.
    if (
      actions.resolution !== undefined &&
      t.resolution === "NONE" &&
      (RESOLUTION_BEARING_STATUSES as readonly TicketStatus[]).includes(actions.status)
    ) {
      after.resolution = actions.resolution;
      applied.push("resolution");
    }
    applied.push("status");
    entries.push(
      ticketEntry(t.id, {
        action: "TICKET_STATUS_CHANGED",
        fieldChanged: "status",
        oldValue: t.status,
        newValue: actions.status,
      }),
      ...diffFields(
        t,
        { resolvedAt: after.resolvedAt, closedAt: after.closedAt, resolution: after.resolution },
        ["resolvedAt", "closedAt", "resolution"],
      ).map((d) => ticketEntry(t.id, { action: "TICKET_FIELD_CHANGED", ...d })),
    );
    // Fix round 2. The RESOLVED side-effects belong to the TRANSITION, not to the control that caused
    // it. `changeTicketStatus` and the bulk status change both send the client's resolved notice;
    // leaving it out here made a macro the ONE path that moved a ticket to RESOLVED and told the
    // client nothing, so two tickets resolved on the same day carried different correspondence
    // histories for no reason a reader could see. Runs inside this transaction and its entries join
    // the array the caller writes last (CONTRACT §3 rule 2). A no-op — nothing written, nothing
    // transmitted — while `RESOLVED_NOTICE_ENABLED` is unset, which it is everywhere today.
    if (actions.status === "RESOLVED") {
      const notice = await maybeSendResolvedNotice(tx, { ticketId: t.id, ticketNumber: t.number });
      if (notice) entries.push(...notice.auditEntries);
    }
  }

  // --- followUpAt --------------------------------------------------------
  if (actions.followUpInDays !== undefined) {
    const next = followUpInstant(actions.followUpInDays, now);
    const changed = (t.followUpAt?.getTime() ?? null) !== (next?.getTime() ?? null);
    if (changed) {
      after.followUpAt = next;
      applied.push("followUpInDays");
      entries.push(
        ticketEntry(t.id, {
          action: "TICKET_FIELD_CHANGED",
          fieldChanged: "followUpAt",
          oldValue: t.followUpAt?.toISOString() ?? null,
          newValue: next?.toISOString() ?? null,
        }),
      );
    }
  }

  // --- escalationTarget --------------------------------------------------
  if (actions.escalationTarget !== undefined && actions.escalationTarget !== t.escalationTarget) {
    after.escalationTarget = actions.escalationTarget;
    applied.push("escalationTarget");
    entries.push(
      ticketEntry(t.id, {
        action: "TICKET_FIELD_CHANGED",
        fieldChanged: "escalationTarget",
        oldValue: t.escalationTarget,
        newValue: actions.escalationTarget,
      }),
    );
  }

  if (applied.length === 0 && entries.length === 0) return { applied: [], auditEntries: [] };

  // One update, no version increment: the caller's guard already made this submit's single bump.
  await tx.ticket.update({ where: { id: t.id }, data: after, select: { id: true } });

  entries.push(
    ticketEntry(t.id, {
      action: "MACRO_ACTIONS_APPLIED",
      fieldChanged: "macroActions",
      oldValue: null,
      // The field names, not their values: each value already has its own ordinary audit row above,
      // and repeating them here would give a reader two places to disagree.
      newValue: applied.join(","),
      metadata: { macroKey: macro.key, macroId: macro.id },
    }),
  );

  return { applied, auditEntries: entries };
}

// ---------------------------------------------------------------------------
// Administration support (the editor in /admin/macros)
// ---------------------------------------------------------------------------

/**
 * The one input the actions editor submits. Deliberately NOT folded into `MacroAdminInput` /
 * `UpdateMacroInput`: those types and their schemas live in `src/types/domain.ts` and
 * `src/server/validation.ts`, both foundation-owned, and CONTRACT §10 B3 says
 * `src/server/macros*.ts` keep their Wave A behaviour. A separate action also keeps the ledger honest
 * — editing what a macro DOES is a different act from editing what it SAYS, and it gets its own row.
 */
export type SetMacroActionsInput = { macroId: string; actions: MacroActions | null };

export const setMacroActionsSchema: z.ZodType<SetMacroActionsInput, unknown> = z.object({
  macroId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id"),
  actions: z.union([macroActionsSchema, z.null()]),
});

/**
 * The canonical stored form: keys in `MACRO_ACTION_KEYS` order, absent keys omitted, `{}` normalised
 * to null. Stable ordering is what makes "did this change?" a string comparison and what keeps an
 * audit row's old/new values diffable by eye.
 */
export function canonicalMacroActions(actions: MacroActions | null): MacroActions | null {
  if (isEmptyMacroActions(actions)) return null;
  const out: MacroActions = {};
  for (const key of MACRO_ACTION_KEYS) {
    const value = actions?.[key];
    if (value === undefined) continue;
    // A per-key assignment keeps each property's own type; a spread would widen them to a union.
    switch (key) {
      case "status":
        out.status = actions?.status;
        break;
      case "priority":
        out.priority = actions?.priority;
        break;
      case "queueKey":
        out.queueKey = actions?.queueKey;
        break;
      case "assignee":
        out.assignee = actions?.assignee;
        break;
      case "followUpInDays":
        out.followUpInDays = actions?.followUpInDays;
        break;
      case "escalationTarget":
        out.escalationTarget = actions?.escalationTarget;
        break;
    }
  }
  return out;
}

/** Stable JSON for comparison and for the audit row's value columns. `null` → the literal "none". */
export function macroActionsAuditValue(actions: MacroActions | null): string {
  const canonical = canonicalMacroActions(actions);
  return canonical === null ? "none" : JSON.stringify(canonical);
}
