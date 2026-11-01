"use server";

/**
 * Identity verification records and the gate override — `"use server"`, node, layer L4
 *.
 *
 * Two writes, and they are deliberately separate actions rather than one with a flag:
 *
 *  - `recordIdentityVerification` is the ordinary path. Whoever is working the ticket made the
 *    callback, so whoever is working the ticket records it: the capability is queue WRITE
 *    (`identity:verify`), not a compliance-only bar. A narrower gate would push the
 *    record into a free-text note, which is the prose the structured record exists to replace.
 *  - `overrideIdentityGate` is the exception path, and it costs more to use: `ops_team` **and** queue
 *    WRITE, an explicit confirmation, and a recorded reason of at least
 *    `WAVE_B_LIMITS.reasonMinChars` characters. It writes an `IdentityVerification` row with result
 *    `OVERRIDDEN` alongside `IDENTITY_GATE_OVERRIDDEN`, so the override is a POSITIVE fact a reviewer
 *    can filter and count, not an absence they would have to notice.
 *
 * `IdentityVerification` is append-only at the database: a row is a statement about a
 * moment, and a correction is a new row, never an edit. Neither action updates or deletes one.
 *
 * Nothing here transmits anything.
 */
import { z } from "zod";
import type {
  ActionResult,
  AuditEntry,
  IdentityVerificationMethod,
  IdentityVerificationResult,
} from "@/types/domain";
import { CATEGORY_LABELS, IDENTITY_VERIFICATION_METHODS, WAVE_B_LIMITS } from "@/types/domain";
import { actorFromViewer, writeAuditMany } from "@/lib/audit";
import { withTx } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { sanitizePII } from "@/lib/pii";
import { assertCan, canVerifyIdentity } from "@/lib/rbac";
import { runAction } from "@/server/action-utils";
import { isIdentityGateRequired, isIdentityGateSatisfied } from "@/server/identity-gate";
import { assertTicketNotClosed } from "@/server/tickets";

/** The note is the whole record of HOW identity was established, so it is required, not optional. */
const NOTE_MIN = 8;
const NOTE_MAX = WAVE_B_LIMITS.reasonMaxChars;

const TICKET_ID = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid ticket id");

/**
 * `OVERRIDDEN` is **not** accepted here. It is the result the override path writes, with an
 * `ops_team` check and a recorded reason behind it; letting the ordinary recording action write the
 * same value would give every queue writer a one-field way to satisfy the gate without either.
 */
const RECORDABLE_RESULTS = ["VERIFIED", "FAILED"] as const satisfies readonly IdentityVerificationResult[];

const recordSchema = z.object({
  ticketId: TICKET_ID,
  method: z.enum(IDENTITY_VERIFICATION_METHODS as unknown as [IdentityVerificationMethod, ...IdentityVerificationMethod[]]),
  result: z.enum(RECORDABLE_RESULTS),
  note: z
    .string()
    .trim()
    .min(NOTE_MIN, "Say how you established who you were speaking to")
    .max(NOTE_MAX),
});

const overrideSchema = z.object({
  ticketId: TICKET_ID,
  reason: z
    .string()
    .trim()
    .min(
      WAVE_B_LIMITS.reasonMinChars,
      `Say why this ticket may resolve without a verification (at least ${WAVE_B_LIMITS.reasonMinChars} characters)`,
    )
    .max(WAVE_B_LIMITS.reasonMaxChars),
  confirm: z.literal(true, { message: "Confirm the override before it is recorded" }),
});

export type RecordIdentityVerificationActionInput = z.input<typeof recordSchema>;
export type OverrideIdentityGateActionInput = z.input<typeof overrideSchema>;

/**
 * Records one identity check on a ticket.
 *
 * Any category, not only the gated five: recording a callback on a ticket that did not require one is
 * useful evidence, and a control that only appears on the tickets where it is mandatory teaches people
 * that verification is paperwork rather than practice.
 *
 * The note goes through `sanitizePII` before it is persisted, which catches an SSN, a payment
 * card or an account number typed into it.
 *
 * It does NOT catch a date of birth, a passport number or a driver's licence. Wave B added rules for
 * those three and Decision #116 withdrew them: a date of birth is working data on this desk, and the
 * three were never in the original spec. This is still the single most likely place in the app for
 * one of them to be typed, so the control here is the composer's hint — record WHAT you checked, not
 * the identifier itself — rather than a redaction rule. `src/lib/pii.ts` carries the reasoning.
 */
export async function recordIdentityVerification(
  input: RecordIdentityVerificationActionInput,
): Promise<ActionResult<{ id: string }>> {
  return runAction("recordIdentityVerification", async (viewer, ctx) => {
    const data = recordSchema.parse(input);
    const actor = actorFromViewer(viewer);

    return withTx(async (tx) => {
      const ticket = await tx.ticket.findUnique({
        where: { id: data.ticketId },
        select: { id: true, status: true, category: true, queue: { select: { key: true } } },
      });
      if (ticket === null) throw new NotFoundError("ticket not found");

      assertCan(canVerifyIdentity(viewer.groups, ticket.queue.key), "identity:verify", ticket.id);
      assertTicketNotClosed(ticket);

      const note = sanitizePII(data.note).text;

      const row = await tx.identityVerification.create({
        data: {
          ticketId: ticket.id,
          verifiedById: viewer.id,
          method: data.method,
          result: data.result,
          note,
        },
        select: { id: true },
      });

      const entries: AuditEntry[] = [
        {
          action: "IDENTITY_VERIFIED",
          entityType: "IDENTITY_VERIFICATION",
          entityId: row.id,
          ticketId: ticket.id,
          fieldChanged: "result",
          oldValue: null,
          newValue: data.result,
          // PII-light: the METHOD and the category, never the note's text — the note
          // is already on the row, and repeating free text in the ledger doubles the surface that has
          // to be redacted correctly.
          metadata: { method: data.method, category: ticket.category },
        },
      ];
      await writeAuditMany(tx, actor, ctx, entries);

      return { id: row.id };
    });
  });
}

/**
 * Lets a gated ticket resolve without a verification, with a name and a reason attached.
 *
 * Refused when the category is not one of the five (there is nothing to override) and when the gate is
 * already satisfied (the override would be a second, misleading record of an exception that was never
 * made). Both refusals are `ValidationError`, because both mean "this control does not apply here",
 * not "you may not do this".
 */
export async function overrideIdentityGate(
  input: OverrideIdentityGateActionInput,
): Promise<ActionResult<{ id: string }>> {
  return runAction("overrideIdentityGate", async (viewer, ctx) => {
    const data = overrideSchema.parse(input);
    const actor = actorFromViewer(viewer);

    return withTx(async (tx) => {
      const ticket = await tx.ticket.findUnique({
        where: { id: data.ticketId },
        select: { id: true, status: true, category: true, queue: { select: { key: true } } },
      });
      if (ticket === null) throw new NotFoundError("ticket not found");

      // BOTH halves, for the same reason `ticket:void` needs both: queue WRITE keeps it inside the
      // queue the ticket lives in, and ops_team is the extra bar, because an override is the one
      // control in this file that removes a requirement rather than satisfying it.
      assertCan(canVerifyIdentity(viewer.groups, ticket.queue.key), "identity:verify override", ticket.id);
      assertCan(viewer.groups.includes("ops_team"), "identity:verify override requires ops_team", ticket.id);
      assertTicketNotClosed(ticket);

      if (!isIdentityGateRequired(ticket.category)) {
        throw new ValidationError(
          `${CATEGORY_LABELS[ticket.category]} tickets are not gated on an identity verification, so there is nothing to override.`,
        );
      }
      if (await isIdentityGateSatisfied(tx, { ticketId: ticket.id, category: ticket.category })) {
        throw new ValidationError("This ticket already has an identity verification on file.");
      }

      const reason = sanitizePII(data.reason).text;

      const row = await tx.identityVerification.create({
        data: {
          ticketId: ticket.id,
          verifiedById: viewer.id,
          method: "OTHER",
          result: "OVERRIDDEN",
          note: reason,
        },
        select: { id: true },
      });

      const entries: AuditEntry[] = [
        {
          action: "IDENTITY_VERIFIED",
          entityType: "IDENTITY_VERIFICATION",
          entityId: row.id,
          ticketId: ticket.id,
          fieldChanged: "result",
          oldValue: null,
          newValue: "OVERRIDDEN",
          metadata: { method: "OTHER", category: ticket.category },
        },
        {
          action: "IDENTITY_GATE_OVERRIDDEN",
          entityType: "TICKET",
          entityId: ticket.id,
          ticketId: ticket.id,
          fieldChanged: "identityGate",
          oldValue: null,
          newValue: "OVERRIDDEN",
          metadata: { reason, category: ticket.category, verificationId: row.id },
        },
      ];
      await writeAuditMany(tx, actor, ctx, entries);

      return { id: row.id };
    });
  });
}
