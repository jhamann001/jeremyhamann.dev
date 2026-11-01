"use server";

/**
 * The outbound suppression list — `"use server"`, node, layer L4
 * (§3.2 `SUPPRESSION_*`, §5 `suppression:admin`).
 *
 * A suppression is the desk deciding to STOP WRITING to an address. That is a bigger decision than it
 * looks, which is why every part of this module is built around making it deliberate and reversible:
 *
 *  - **It stops OUTBOUND mail only.** Inbound from the same address still arrives, still becomes a
 *    ticket and still reaches the queue. A client whose address bounces has not stopped being a client,
 *    and a suppression that also silenced their incoming mail would be the desk refusing to hear them.
 *  - **Nothing adds a row automatically.** A hard bounce produces a CANDIDATE that an administrator
 *    confirms here. One DSN is a mail server's opinion on one attempt; an address the
 *    desk stops answering without anybody deciding is how a client goes unanswered for months.
 *  - **Removal is a soft remove.** `removedAt` and `removedById` are set and the row stays, because the
 *    question six months later is "who stopped writing to this person, when, and who started again" —
 *    and a deleted row answers none of it. The database enforces it (`requester_suppression_no_delete`).
 *  - **Re-adding a removed address is an UPDATE of the same row**, not a second row. `email` is unique,
 *    so there is exactly one live decision per address at any time and the ledger carries the sequence.
 *
 * Every action is ONE transaction whose LAST statement is a single `writeAuditMany` (§3 rule 2).
 *
 * CONTRACT-GAP: §10 B9 types `listSuppressions(viewer): Promise<SuppressionDTO[]>`, which a
 * `"use server"` module cannot export — guardrail G4 requires every exported async function in a
 * `*.actions.ts` file to be `runAction`-wrapped, and B9 owns no sibling read module. It is
 * therefore `listSuppressions(): Promise<ActionResult<SuppressionDTO[]>>`, taking its viewer from the
 * session exactly as `runAction` does. This is the same deviation B8 recorded for `listApiTokens`, and
 * it is recorded again in the build record
 */
import { z } from "zod";
import type {
  ActionResult,
  AddSuppressionInput,
  RemoveSuppressionInput,
  SuppressionDTO,
} from "@/types/domain";
import { SUPPRESSION_REASONS, WAVE_B_LIMITS } from "@/types/domain";
import { actorFromViewer, writeAuditMany } from "@/lib/audit";
import { prisma, withTx } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { sanitizePII } from "@/lib/pii";
import { assertCan, canAdminSuppression } from "@/lib/rbac";
import { runAction } from "@/server/action-utils";
import { isDeliverableAddress } from "@/server/outbox";

// ---------------------------------------------------------------------------
// Module-private helpers ("use server" files export async functions only — guardrail G4)
// ---------------------------------------------------------------------------

/** How many rows one page of the list carries. The list is an inventory of tens, not of thousands. */
const SUPPRESSION_PAGE_SIZE = 200;
/** How many hard-bounce candidates are offered at once, newest first. */
const CANDIDATE_LIMIT = 50;

const SUPPRESSION_SELECT = {
  id: true,
  email: true,
  reason: true,
  note: true,
  createdAt: true,
  removedAt: true,
  createdBy: { select: { id: true, name: true, email: true, image: true } },
} as const;

type SuppressionRow = {
  id: string;
  email: string;
  reason: (typeof SUPPRESSION_REASONS)[number];
  note: string | null;
  createdAt: Date;
  removedAt: Date | null;
  createdBy: { id: string; name: string | null; email: string; image: string | null } | null;
};

function toSuppressionDTO(row: SuppressionRow): SuppressionDTO {
  return {
    id: row.id,
    email: row.email,
    reason: row.reason,
    note: row.note,
    createdBy:
      row.createdBy === null
        ? null
        : {
            id: row.createdBy.id,
            name: row.createdBy.name,
            email: row.createdBy.email,
            image: row.createdBy.image,
          },
    createdAt: row.createdAt.toISOString(),
    removedAt: row.removedAt === null ? null : row.removedAt.toISOString(),
  };
}

/**
 * The address shape a suppression may hold: the same strictness `enqueueDelivery` applies before it
 * queues anything. An address the outbox could never have queued to cannot be suppressed — the row
 * would never match anything and would sit in a permanent table saying nothing.
 *
 * It asks `isDeliverableAddress` rather than carrying its own copy of the pattern, and that is now
 * the only way to ask. The copy this replaced was
 * `/^[^\s@<>,;"]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/`, byte for byte the constant Wave A deleted
 * from `src/server/outbox.ts`: its `(?:…+)+` is the nested quantifier security scanner reports under CWE-1333, and
 * the finding it raised against the outbox line applies here identically — the rule is about the
 * pattern, not about which file holds it. `src/server/system-messages.ts` had the same duplicate and
 * calls the function too, so all three call sites now give the SAME answer and `enqueueDelivery`
 * cannot accept an address this schema rejects. **Do not restore a local regex**, here or anywhere.
 *
 * `isDeliverableAddress` trims and lower-cases internally, which the chain below has already done,
 * and accepts exactly the strings the constant matched — see its own docstring for why the linear
 * rewrite is the same acceptance test.
 */
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(320)
  .refine(isDeliverableAddress, "That is not an email address the desk could ever have written to.");

const addSchema = z.object({
  email: emailSchema,
  reason: z.enum(SUPPRESSION_REASONS),
  note: z.string().trim().max(WAVE_B_LIMITS.reasonMaxChars).optional(),
});

const removeSchema = z.object({
  suppressionId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id"),
  reason: z
    .string()
    .trim()
    .min(
      WAVE_B_LIMITS.reasonMinChars,
      `Say why writing to this address is safe again — at least ${WAVE_B_LIMITS.reasonMinChars} characters.`,
    )
    .max(WAVE_B_LIMITS.reasonMaxChars),
});

/**
 * Sanitises the free text on a suppression row.
 *
 * Unlike a macro title or a webhook name, a redacted value here is KEPT rather than refused. The note
 * on a hard bounce is frequently pasted straight out of a DSN — "550 5.1.1 <...> User unknown" — and a
 * diagnostic string that happens to contain a long digit run is still the most useful thing an operator
 * can record. Storing it redacted is right; refusing it would push the operator into writing nothing.
 */
function sanitizedNote(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const text = sanitizePII(raw).text.trim();
  return text.length === 0 ? null : text;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Every suppression, live rows first and then removed ones, newest first within each group.
 *
 * Removed rows are listed deliberately. They are the evidence that the desk stopped writing to somebody
 * and then started again, and a list that showed only live rows would make that history invisible on
 * the one screen that exists to explain it.
 */
export async function listSuppressions(): Promise<ActionResult<SuppressionDTO[]>> {
  return runAction("listSuppressions", async (viewer) => {
    assertCan(canAdminSuppression(viewer.groups), "suppression:admin list");
    const rows = (await prisma.requesterSuppression.findMany({
      select: SUPPRESSION_SELECT,
      orderBy: [{ removedAt: "asc" }, { createdAt: "desc" }],
      take: SUPPRESSION_PAGE_SIZE,
    })) as SuppressionRow[];
    return rows.map(toSuppressionDTO);
  });
}

/** One hard-bounced address the desk has not decided about yet. */
export type SuppressionCandidate = {
  email: string;
  /** How many deliveries to this address are recorded as hard-bounced. */
  bounces: number;
  /** The most recent bounce, ISO-8601. */
  lastBouncedAt: string;
  /** The WM number of the most recently bounced ticket, so the operator can go and look. */
  lastTicketNumber: number | null;
};

/**
 * Addresses a hard bounce has been recorded against that carry no live suppression.
 *
 * This is the whole of "a hard bounce is a suppression CANDIDATE, never an automatic suppression"
 *. `recordBounce` sets `bounceType: "hard"` on the delivery and stops; this
 * read is what puts the address in front of an administrator, and `addSuppression` is what an
 * administrator does about it. Nothing in between is automated.
 *
 * Soft bounces are excluded: a full mailbox or a throttled server is a reason to retry, not a reason to
 * stop. An address that already has a live suppression is excluded too — there is nothing to decide.
 */
export async function listSuppressionCandidates(): Promise<ActionResult<SuppressionCandidate[]>> {
  return runAction("listSuppressionCandidates", async (viewer) => {
    assertCan(canAdminSuppression(viewer.groups), "suppression:admin candidates");

    const grouped = await prisma.messageDelivery.groupBy({
      by: ["toAddress"],
      where: { status: "BOUNCED", bounceType: "hard" },
      _count: { _all: true },
      _max: { bouncedAt: true },
      orderBy: { _max: { bouncedAt: "desc" } },
      take: CANDIDATE_LIMIT,
    });
    if (grouped.length === 0) return [];

    const addresses = grouped.map((g) => g.toAddress);
    const live = await prisma.requesterSuppression.findMany({
      where: { email: { in: addresses }, removedAt: null },
      select: { email: true },
    });
    const suppressed = new Set(live.map((r) => r.email));

    // The most recent bounced ticket per address, for the deep link on the card. One query for the
    // page rather than one per address.
    const recent = await prisma.messageDelivery.findMany({
      where: { status: "BOUNCED", bounceType: "hard", toAddress: { in: addresses } },
      select: { toAddress: true, bouncedAt: true, ticket: { select: { number: true } } },
      orderBy: { bouncedAt: "desc" },
      take: CANDIDATE_LIMIT * 4,
    });
    const ticketByAddress = new Map<string, number>();
    for (const row of recent) {
      if (!ticketByAddress.has(row.toAddress)) ticketByAddress.set(row.toAddress, row.ticket.number);
    }

    return grouped
      .filter((g) => !suppressed.has(g.toAddress))
      .map((g) => ({
        email: g.toAddress,
        bounces: g._count._all,
        lastBouncedAt: (g._max.bouncedAt ?? new Date(0)).toISOString(),
        lastTicketNumber: ticketByAddress.get(g.toAddress) ?? null,
      }));
  });
}

/**
 * Stops outbound mail to one address.
 *
 * An address that already carries a LIVE suppression is a no-op returning the existing row: adding the
 * same decision twice is not a second decision, and a second ledger row would say the desk decided
 * again when it did not. An address whose suppression was REMOVED is re-suppressed by updating that
 * same row — `email` is unique, so there is one row per address and the ledger carries the sequence of
 * decisions about it.
 *
 * Queued deliveries to the address are NOT cancelled here, and that is deliberate. A `MessageDelivery`
 * row is a record of a reply the desk wrote; the suppression stops it from being handed out
 * (`leaseQueuedDeliveries` re-checks and transitions it to `FAILED_SUPPRESSED` with its own audit row),
 * and doing it there rather than here means one code path decides, with the lease as its evidence.
 */
export async function addSuppression(input: AddSuppressionInput): Promise<ActionResult<{ id: string }>> {
  return runAction("addSuppression", async (viewer, ctx) => {
    assertCan(canAdminSuppression(viewer.groups), "suppression:admin add");
    const data = addSchema.parse(input);
    const note = sanitizedNote(data.note);
    const actor = actorFromViewer(viewer);

    return withTx(async (tx) => {
      const current = await tx.requesterSuppression.findUnique({
        where: { email: data.email },
        select: { id: true, reason: true, removedAt: true },
      });

      if (current !== null && current.removedAt === null) return { id: current.id };

      const row =
        current === null
          ? await tx.requesterSuppression.create({
              data: {
                email: data.email,
                reason: data.reason,
                note,
                createdById: viewer.id,
              },
              select: { id: true },
            })
          : await tx.requesterSuppression.update({
              where: { id: current.id },
              data: {
                reason: data.reason,
                note,
                createdById: viewer.id,
                createdAt: new Date(),
                removedAt: null,
                removedById: null,
              },
              select: { id: true },
            });

      await writeAuditMany(tx, actor, ctx, [
        {
          action: "SUPPRESSION_ADDED",
          entityType: "SUPPRESSION",
          entityId: row.id,
          fieldChanged: "email",
          oldValue: null,
          newValue: data.email,
          metadata: {
            reason: data.reason,
            note,
            // True when this address was suppressed before and the suppression had been lifted. The
            // ledger already holds the sequence; this saves a reader reconstructing it.
            resuppressed: current !== null,
          },
        },
      ]);

      return { id: row.id };
    });
  });
}

/**
 * Starts writing to an address again.
 *
 * A soft remove — `removedAt` and `removedById` — because the row is the record of a decision, and the
 * decision to stop is as much a part of the history as the decision to start again. The reason floor is
 * twelve characters, the same as every other recorded reason in this wave: "why is it safe to write to
 * this address again" is a question somebody asks, and the answer needs to be on the row.
 *
 * Removing a suppression does NOT resend anything. Deliveries that were refused are terminal
 * (`FAILED_SUPPRESSED`), and a comment is immutable, so answering the client again is a new reply — a
 * new comment and a new delivery. Resurrecting an old one would send a message written weeks ago as
 * though it were today's.
 */
export async function removeSuppression(
  input: RemoveSuppressionInput,
): Promise<ActionResult<{ id: string }>> {
  return runAction("removeSuppression", async (viewer, ctx) => {
    assertCan(canAdminSuppression(viewer.groups), "suppression:admin remove");
    const data = removeSchema.parse(input);
    const reason = sanitizePII(data.reason).text;
    const actor = actorFromViewer(viewer);

    return withTx(async (tx) => {
      const current = await tx.requesterSuppression.findUnique({
        where: { id: data.suppressionId },
        select: { id: true, email: true, reason: true, removedAt: true },
      });
      if (current === null) throw new NotFoundError("That suppression no longer exists");
      if (current.removedAt !== null) return { id: current.id };

      const now = new Date();
      const lifted = await tx.requesterSuppression.updateMany({
        // Pinned to "still live": two administrators lifting at once produce one transition and
        // one ledger row, not two.
        where: { id: current.id, removedAt: null },
        data: { removedAt: now, removedById: viewer.id },
      });
      if (lifted.count === 0) return { id: current.id };

      await writeAuditMany(tx, actor, ctx, [
        {
          action: "SUPPRESSION_REMOVED",
          entityType: "SUPPRESSION",
          entityId: current.id,
          fieldChanged: "email",
          oldValue: current.email,
          newValue: null,
          metadata: { reason, priorReason: current.reason },
        },
      ]);

      return { id: current.id };
    });
  });
}

/**
 * Suppresses an address straight from a bounce candidate.
 *
 * A thin wrapper over `addSuppression` that fixes the reason to `HARD_BOUNCE` and writes the bounce
 * count into the note, so the ledger records WHAT the administrator was looking at when they decided.
 * It exists because the alternative — the UI passing `reason: "HARD_BOUNCE"` and composing the note
 * itself — would let a client component decide what a compliance record says.
 *
 * It re-derives the bounce count from the deliveries rather than trusting the number the page rendered;
 * a stale page must not be able to record a figure that was never true.
 */
export async function confirmBounceSuppression(input: { email: string }): Promise<ActionResult<{ id: string }>> {
  return runAction("confirmBounceSuppression", async (viewer) => {
    assertCan(canAdminSuppression(viewer.groups), "suppression:admin confirm-bounce");
    const email = emailSchema.parse(input.email);

    const bounces = await prisma.messageDelivery.count({
      where: { toAddress: email, status: "BOUNCED", bounceType: "hard" },
    });
    if (bounces === 0) {
      throw new ValidationError("no hard bounce is recorded for that address", {
        email: [
          "There is no hard bounce on record for this address, so there is nothing to confirm. " +
            "Add it manually if you mean to stop writing to it anyway.",
        ],
      });
    }

    const result = await addSuppression({
      email,
      reason: "HARD_BOUNCE",
      note: `Confirmed from ${bounces} recorded hard bounce${bounces === 1 ? "" : "s"}.`,
    });
    // `addSuppression` is itself a `runAction`, so it has already written its own denial row for a
    // FORBIDDEN and its own field errors for a VALIDATION. Re-throwing its message would lose the
    // shape, so the failure is surfaced as a form error naming what happened.
    if (!result.ok) {
      throw new ValidationError("the address could not be suppressed", { _form: [result.message] });
    }
    return result.data;
  });
}
