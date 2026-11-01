/**
 * SLA policy reads and validation — node, layer L4 (the build record B4, Decisions #98
 * and #99; docs/ARCHITECTURE.md §d, §g S3, I5).
 *
 * WHY THIS FILE EXISTS BESIDE `sla-policies.actions.ts`. A `"use server"` module may export nothing
 * but `runAction`-wrapped actions (guardrail G4), and the contract declares `listSlaPolicies` with a
 * plain `Promise<SlaPolicyDTO[]>` return — a read, not an action result. Wave A settled the same
 * tension the same way (`src/server/users.ts` beside `users.actions.ts`, `macros.ts` beside
 * `macros.actions.ts`): the reads and the shared zod schemas live in a plain module, the mutations
 * live in the `"use server"` one. Recorded in the build record.
 *
 * TWO THINGS THIS SCREEN EDITS, AND THEY ARE NOT THE SAME KIND OF THING.
 *
 *  - **`SLA.warningMinutes`, `firstResponseMinutes`, `resolutionMinutes`** — one row per priority.
 *    The two due-date minutes are SNAPSHOTTED onto each ticket at creation (`slaFirstResponseMinutes`
 *    / `slaResolutionMinutes`, I10), so editing them changes what the NEXT ticket promises and
 *    rewrites nothing that already exists. `warningMinutes` is read LIVE, so editing
 *    it re-colours open work on the next render and still rewrites nothing. Both facts are printed on
 *    the page, because "did I just move four hundred due dates?" is the first thing an administrator
 *    will want to know and it should not require reading a contract.
 *  - **`Queue.autoAssign`** — one boolean per queue. Auto-assignment is a property of the QUEUE (who
 *    works it), never of the priority, and it is off on every queue until somebody
 *    turns it on deliberately.
 */
import { z } from "zod";
import type { QueueKey, RequestContext, SlaPolicyDTO, TicketPriority, Viewer } from "@/types/domain";
import { DEFAULT_SLA_POLICIES, QUEUE_KEYS, TICKET_PRIORITIES } from "@/types/domain";
import { actorFromViewer, recordDenied } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { ForbiddenError } from "@/lib/errors";
import { canAdminSla } from "@/lib/rbac";
import { DEFAULT_WARNING_MINUTES } from "@/lib/sla";
import { eligibleAssigneeCounts } from "@/server/auto-assign";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * The editable range, in calendar minutes (the clocks are 24x7 — §d).
 *
 * The ceilings are deliberately generous rather than opinionated: a desk that wants a 30-day
 * resolution clock on LOW is making a policy choice, not a mistake, and this screen is not the place
 * to argue with it. The FLOOR of 1 is the part that matters — a zero-minute first-response clock
 * would make every ticket breached at the instant it was raised, which is not a policy anybody means.
 * `warningMinutes` floors at 0 because 0 is the documented way to switch the amber band off.
 */
export const SLA_POLICY_LIMITS = {
  firstResponseMinutesMin: 1,
  /** 7 days. */
  firstResponseMinutesMax: 10_080,
  resolutionMinutesMin: 1,
  /** 90 days. */
  resolutionMinutesMax: 129_600,
  warningMinutesMin: 0,
  /** 7 days. */
  warningMinutesMax: 10_080,
} as const;

const minutes = (min: number, max: number, label: string) =>
  z
    .number({ error: `${label} must be a whole number of minutes` })
    .int(`${label} must be a whole number of minutes`)
    .min(min, `${label} must be at least ${min}`)
    .max(max, `${label} must be at most ${max}`);

/**
 * `SaveSlaPolicyInput`. The cross-field rule is the only one worth refusing: a resolution clock that
 * expires BEFORE the first-response clock cannot be met by any sequence of events, so the ticket would
 * be born breached on a clock nobody could beat.
 *
 * A warning band longer than the first-response clock is NOT refused — URGENT ships that way today
 * (30-minute first response, 30-minute band), which means an urgent ticket is amber from the moment it
 * arrives, and that is the intended reading of "urgent". The form says so in words instead.
 */
export const saveSlaPolicySchema = z
  .object({
    priority: z.enum(TICKET_PRIORITIES as unknown as [TicketPriority, ...TicketPriority[]]),
    firstResponseMinutes: minutes(
      SLA_POLICY_LIMITS.firstResponseMinutesMin,
      SLA_POLICY_LIMITS.firstResponseMinutesMax,
      "First response",
    ),
    resolutionMinutes: minutes(
      SLA_POLICY_LIMITS.resolutionMinutesMin,
      SLA_POLICY_LIMITS.resolutionMinutesMax,
      "Resolution",
    ),
    warningMinutes: minutes(
      SLA_POLICY_LIMITS.warningMinutesMin,
      SLA_POLICY_LIMITS.warningMinutesMax,
      "Warning",
    ),
  })
  .refine((v) => v.resolutionMinutes >= v.firstResponseMinutes, {
    path: ["resolutionMinutes"],
    error: "The resolution clock cannot expire before the first-response clock.",
  });

export const setQueueAutoAssignSchema = z.object({
  queueKey: z.enum(QUEUE_KEYS as unknown as [QueueKey, ...QueueKey[]]),
  autoAssign: z.boolean(),
});

export type SetQueueAutoAssignInput = z.output<typeof setQueueAutoAssignSchema>;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * One priority as `/admin/sla` renders it, INCLUDING a priority with no row.
 *
 * `SlaPolicyDTO` cannot describe an unconfigured priority — it requires an id — but the screen must,
 * because a missing row is not "no policy": `slaPolicyFor` silently falls back to
 * `DEFAULT_SLA_POLICIES`, so the desk is running on a number nobody can see. The board shows that
 * number, marks it as the code fallback, and saving it writes the row.
 */
export type SlaPolicyBoardRow = {
  priority: TicketPriority;
  /** Null until the row exists. Saving an unconfigured priority creates it. */
  id: string | null;
  name: string;
  firstResponseMinutes: number;
  resolutionMinutes: number;
  warningMinutes: number;
  /** ISO-8601, or null for a priority that has never been saved. */
  updatedAt: string | null;
  /** False when these numbers come from `DEFAULT_SLA_POLICIES` rather than from the table. */
  configured: boolean;
};

/** One queue's auto-assignment switch. */
export type QueueAutoAssignRow = {
  id: string;
  key: QueueKey;
  name: string;
  autoAssign: boolean;
  /** Active staff who hold WRITE on this queue and are not out of office — the rota this would use. */
  eligibleAssignees: number;
};

async function assertSlaAdmin(viewer: Viewer, ctx: RequestContext | undefined, what: string): Promise<void> {
  if (canAdminSla(viewer.groups)) return;
  // I3/I5: the denial is evidence. A read this viewer may not perform is recorded before it is refused.
  if (ctx !== undefined) await recordDenied(actorFromViewer(viewer), ctx, what);
  throw new ForbiddenError(`Forbidden: ${what}`);
}

/**
 * Every priority, in `TICKET_PRIORITIES` order (URGENT first — the order the desk reads a board in),
 * whether or not the row exists.
 */
export async function slaPolicyBoard(viewer: Viewer, ctx?: RequestContext): Promise<SlaPolicyBoardRow[]> {
  await assertSlaAdmin(viewer, ctx, "sla:admin list policies");

  const rows = await prisma.sLA.findMany({
    select: {
      id: true,
      priority: true,
      name: true,
      firstResponseMinutes: true,
      resolutionMinutes: true,
      warningMinutes: true,
      updatedAt: true,
    },
  });
  const byPriority = new Map(rows.map((r) => [r.priority, r] as const));

  return TICKET_PRIORITIES.map((priority) => {
    const row = byPriority.get(priority);
    if (row === undefined) {
      const fallback = DEFAULT_SLA_POLICIES[priority];
      return {
        priority,
        id: null,
        name: fallback.name,
        firstResponseMinutes: fallback.firstResponseMinutes,
        resolutionMinutes: fallback.resolutionMinutes,
        warningMinutes: DEFAULT_WARNING_MINUTES,
        updatedAt: null,
        configured: false,
      };
    }
    return {
      priority,
      id: row.id,
      name: row.name,
      firstResponseMinutes: row.firstResponseMinutes,
      resolutionMinutes: row.resolutionMinutes,
      warningMinutes: row.warningMinutes,
      updatedAt: row.updatedAt.toISOString(),
      configured: true,
    };
  });
}

/**
 * The contract's read: the policy rows that EXIST, as `SlaPolicyDTO`.
 *
 * Built on the board so the two can never disagree about a number; an unconfigured priority is absent
 * here by construction, because a DTO with a fabricated id would be a lie other slices could store.
 */
export async function listSlaPolicies(viewer: Viewer, ctx?: RequestContext): Promise<SlaPolicyDTO[]> {
  const board = await slaPolicyBoard(viewer, ctx);
  const out: SlaPolicyDTO[] = [];
  for (const row of board) {
    if (row.id === null || row.updatedAt === null) continue;
    out.push({
      id: row.id,
      priority: row.priority,
      name: row.name,
      firstResponseMinutes: row.firstResponseMinutes,
      resolutionMinutes: row.resolutionMinutes,
      warningMinutes: row.warningMinutes,
      updatedAt: row.updatedAt,
    });
  }
  return out;
}

/**
 * Every queue with its auto-assignment switch and the size of the rota behind it.
 *
 * The count is the point of showing it: turning auto-assignment on for a queue nobody holds WRITE on
 * is a switch that will never do anything, and an administrator should see that before they flip it,
 * not discover it from a week of unassigned tickets.
 */
export async function listQueueAutoAssign(viewer: Viewer, ctx?: RequestContext): Promise<QueueAutoAssignRow[]> {
  await assertSlaAdmin(viewer, ctx, "sla:admin list queue auto-assignment");

  const [queues, counts] = await Promise.all([
    prisma.queue.findMany({
      select: { id: true, key: true, name: true, autoAssign: true },
      orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
    }),
    eligibleAssigneeCounts(new Date()),
  ]);

  return queues.map((q) => ({
    id: q.id,
    key: q.key,
    name: q.name,
    autoAssign: q.autoAssign,
    eligibleAssignees: counts[q.key] ?? 0,
  }));
}
