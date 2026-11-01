"use server";

/**
 * Held inbound mail — the release path. `"use server"`, node, layer L4 (CONTRACT §3
 * `INTAKE_RELEASED`, "release action (S2 core; UI later)").
 *
 * Releasing is the way BACK IN for a message the intake path refused. Without it every held message
 * is a dead end: the row cannot be deleted, no page shows it, and the client who sent it is waiting.
 *
 * What a release is, exactly:
 *   1. A NEW ticket, created through `createTicketCore` so the routing defaults, the SLA stamping,
 *      the PII pass, the `IngestReceipt` and the `TICKET_INGESTED` row are identical to a message
 *      that was never held. Its body is the stored SNIPPET, not the original message — the raw mail
 *      was never persisted, and the row's `rawRef` is where the full copy lives.
 *   2. `SuspendedIntake.status NEW → RELEASED`, with `ticketId`, `releasedById` and `releasedAt` —
 *      a conditional `updateMany`, so two reviewers clicking at once produce one release.
 *   3. `INTAKE_RELEASED`, in the SAME transaction as that status change, carrying the ticket id.
 *
 * DEVIATION from §3's "same tx as the status change AND the ticket it creates": the ticket is created
 * in its own transaction first, because `createTicketCore` owns its transaction (it is the one
 * implementation of ticket creation and must stay that way) and `SuspendedIntake.ticketId` is a
 * foreign key that needs the ticket to exist. The join is made safe by idempotency rather than by
 * atomicity: the ticket's `externalId` is derived from the suspension id, so a crash between the two
 * steps leaves a ticket that the retry FINDS through its `IngestReceipt` instead of duplicating, and
 * the conditional flip means the second attempt links that same ticket. Recorded in
 * the build record
 *
 * A RELEASE IS A HUMAN ACTION, so none of its rows carry `metadata.via` (§3 rule 1): the ledger
 * partition `metadata->>'via' IS NULL` has to keep meaning "a person did this", and a reviewer
 * deciding that a refused message should become a ticket is exactly the row a compliance extract of
 * human activity is run to find. The channel is still recorded, where it belongs and cannot be
 * mistaken for an actor: `metadata.source = EMAIL_SOURCE`, plus the reason, the mailbox and the
 * Message-ID, and `Ticket.source = EMAIL`.
 *
 * SENDER IDENTITY. An unverified row is one whose sender was never proven — it failed DMARC, arrived
 * with no `Authentication-Results`, or carried a verdict from an authserv-id this desk does not
 * trust. That is NOT the same question as "is the reason `UNAUTHENTICATED`": the intake gates are
 * ordered and the reason enum holds one value, so the same message held for an unmapped mailbox, an
 * auto-reply or spam carries a reason that says nothing about its sender. `heldIntakeSenderVerified`
 * combines the reason with the verdict the hold recorded, fail-closed, and this path charges the
 * price on its answer. Releasing adopts `fromAddress` as `Ticket.requesterEmail`, which is two
 * privileges at once: every PUBLIC reply is delivered there, and the client API treats that value
 * (`X-Requester-Email`) as the authorization subject for the thread. `changeRequesterEmail` charges a
 * confirmation and a recorded reason for exactly that move, so this path charges the same:
 * `confirmUnverifiedSender: true` plus a real note, and `senderVerified: false` recorded on the
 * ticket body and in the audit row so the provenance survives the release.
 *
 * Nothing here transmits anything. Releasing a message does not reply to it.
 */
import { z } from "zod";
import type { ActionResult, AuditEntry, IngestTicketInput, TicketCategory } from "@/types/domain";
import { INGEST_LIMITS, INTAKE_RELEASE_EXTERNAL_ID_PREFIX, QUEUE_KEYS, TICKET_CATEGORIES } from "@/types/domain";
import { actorFromViewer, writeAuditMany } from "@/lib/audit";
import { prisma, withTx } from "@/lib/db";
import { parseFromAddress, parseMailboxMap, routeForMailbox } from "@/lib/email/mailboxes";
import { env } from "@/lib/env";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { sanitizePII } from "@/lib/pii";
import { assertCan } from "@/lib/rbac";
import { runAction } from "@/server/action-utils";
import {
  EMAIL_SOURCE,
  FORWARDED_RELEASE_REFUSAL_MESSAGES,
  forwardedCandidateName,
  resolveForwardedRelease,
} from "@/server/email-intake";
import { createTicketCore } from "@/server/ingest";
import {
  canReleaseHeldIntake,
  canReviewHeldIntake,
  heldIntakeSenderAuthenticated,
  heldIntakeSenderVerified,
} from "@/server/suspended-intake";

// ---------------------------------------------------------------------------
// Module-private helpers (a "use server" module exports async functions only — guardrail G4)
// ---------------------------------------------------------------------------

/**
 * Minimum length of the note that must accompany the release of a message whose sender was never
 * authenticated — the same floor `changeRequesterEmail`'s reason carries, for the same reason: "ok"
 * is not a record of why a reviewer believed an unproven address.
 */
const UNVERIFIED_SENDER_NOTE_MIN = 12;

const releaseSchema = z.object({
  suspendedId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id"),
  /** Where the ticket lands. Defaults to the mailbox map's route, which an UNKNOWN_MAILBOX row has none of. */
  queueKey: z.enum(QUEUE_KEYS).optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  /** The reviewer's own words about why this was released. Stored on the ticket, sanitised. */
  note: z.string().trim().max(2_000).optional(),
  /**
   * The reviewer's acknowledgement that the sender address is UNPROVEN and that releasing adopts it
   * anyway. Required — with a note of at least {@link UNVERIFIED_SENDER_NOTE_MIN} characters —
   * whenever `heldIntakeSenderVerified` says the row's sender was never proven (reason
   * `UNAUTHENTICATED`, OR any reason on a hold whose recorded verdict was a failure); ignored
   * otherwise. Deliberately `boolean` rather
   * than `z.literal(true)`: an explicit `false` deserves the field error below, not a schema error
   * that reads like a bug.
   */
  confirmUnverifiedSender: z.boolean().optional(),
  /**
   * Wave B (integration round 1). Set when releasing a FORWARDED hold against the ORIGINAL sender
   * parsed out of the forwarded block rather than against the forwarder.
   *
   * It is a BOOLEAN, not an address, and that is the control: `resolveForwardedRelease` checks the
   * choice against the stored `candidateRequesterEmail` and refuses anything else. A free-text address
   * field here would be an unaudited way to point a ticket at any address at all — which is exactly
   * what `changeRequesterEmail` exists to gate, with its own confirmation and recorded reason.
   */
  releaseAsCandidate: z.boolean().optional(),
});

export type ReleaseHeldIntakeInput = z.input<typeof releaseSchema>;
export type ReleaseHeldIntakeResult = { ticketId: string; ticketNumber: number; alreadyReleased: boolean };

const SUSPENDED_SELECT = {
  id: true,
  status: true,
  reason: true,
  mailbox: true,
  fromAddress: true,
  subject: true,
  messageId: true,
  rawRef: true,
  snippet: true,
  ticketId: true,
  // the forwarded-mail pair. `candidateRequesterEmail` is the sender parsed out of the
  // forwarded block; `senderVerified` is the stored DMARC verdict `resolveForwardedRelease` requires.
  candidateRequesterEmail: true,
  senderVerified: true,
  // The stored header block, read for ONE value: the original sender's display name on a FORWARDED
  // hold (`forwardedCandidateName`). See the candidate branch of `releaseHeldIntake`.
  headers: true,
} as const;

/**
 * The ticket body a released message gets.
 *
 * The desk never stored the raw message, so the honest body is the stored preview plus the
 * provenance a reader needs to judge it: why it was held, which mailbox it arrived on, its
 * Message-ID and the workflow's pointer to the full copy. Saying that plainly is the point — a
 * released ticket must never read as if the client's mail arrived normally.
 *
 * DESK-COMPOSED, AND THE CLIENT NEVER SEES IT. Everything below the preview is written
 * for colleagues: the hold reason, the internal mailbox, the raw-message pointer, the "verify the
 * sender out of band" instruction, the staff address that forwarded it and the reviewer's note.
 * `sanitizePII` redacts SSN, card and account numbers only, so all of it survives
 * verbatim. The ticket is created with `source: EMAIL`, which is the truth about how the message
 * arrived and would otherwise have put this whole field into the client's thread attributed to them as
 * "You". The client read recognises a released ticket by its `externalId` and contributes no opening
 * entry at all — including on a FORWARDED release, where even the preview is the colleague's forwarding
 * note rather than the requester's words. If this composer is ever split so that `description` holds
 * ONLY the requester's text, revisit that gate rather than assuming it became unnecessary.
 */
function releaseDescription(row: {
  reason: string;
  mailbox: string;
  fromAddress: string;
  messageId: string | null;
  rawRef: string | null;
  snippet: string | null;
  createdAtIso: string;
  senderVerified: boolean;
  /** Set when this was released against the address INSIDE a forward; the colleague who forwarded it. */
  forwardedBy?: string | null;
}, note: string | null): string {
  const lines = [
    row.snippet !== null && row.snippet.trim().length > 0
      ? row.snippet
      : "(The held message had no readable body. The full copy is with the mail workflow.)",
    "",
    "--",
    "Released from held inbound mail.",
    `Held because: ${row.reason}. Received ${row.createdAtIso} at ${row.mailbox} from ${row.fromAddress}.`,
    `Message-ID: ${row.messageId ?? "(none)"}. Raw message reference: ${row.rawRef ?? "(none)"}.`,
    "Only the stored preview above survives; it is redacted and may be truncated.",
  ];
  // The provenance that matters most has to be ON the ticket, not only in the ledger: whoever works
  // this thread next decides whether to act on it, and "we never proved who sent this" is the fact
  // that decides a wire instruction or an address change.
  if (!row.senderVerified) {
    lines.push(
      "SENDER NOT VERIFIED: this message failed sender authentication, so the address above is unproven." +
        " Replies are delivered to it and it opens this thread in the client portal." +
        " Verify the sender out of band before acting on anything in it.",
    );
  }
  // Provenance for a forwarded release belongs ON the ticket, not only in the ledger: the requester
  // is not the address the message arrived from, and the next person to work this thread has to be
  // able to see that without opening the audit log.
  if (row.forwardedBy !== null && row.forwardedBy !== undefined && row.forwardedBy.length > 0) {
    lines.push(
      `Forwarded to the desk by ${row.forwardedBy}. The requester below is the sender parsed out of the` +
        " forwarded message, confirmed on release.",
    );
  }
  if (note !== null) lines.push(`Reviewer note: ${note}`);
  return lines.join("\n");
}

/**
 * Refuses the release of an unproven sender that the reviewer has not explicitly acknowledged.
 *
 * Both halves are checked together so the form can show both errors at once, and the note is
 * measured BEFORE `sanitizePII` — a note whose entire content is redacted contact data is not a
 * shorter note, it is a note the reviewer should not have written.
 */
function assertUnverifiedSenderAcknowledged(data: {
  confirmUnverifiedSender?: boolean | undefined;
  note?: string | undefined;
}): void {
  const fieldErrors: Record<string, string[]> = {};
  if (data.confirmUnverifiedSender !== true) {
    fieldErrors.confirmUnverifiedSender = [
      "This message failed sender authentication, so the address it claims to be from is unproven." +
        " Releasing it points the ticket's replies at that address and lets it open the thread in the client portal." +
        " Confirm you have verified the sender another way.",
    ];
  }
  if ((data.note ?? "").length < UNVERIFIED_SENDER_NOTE_MIN) {
    fieldErrors.note = [
      `Say how you verified the sender — at least ${UNVERIFIED_SENDER_NOTE_MIN} characters. It is stored on the ticket.`,
    ];
  }
  if (Object.keys(fieldErrors).length > 0) {
    throw new ValidationError("this message's sender was never authenticated", fieldErrors);
  }
}

/**
 * `requesterName` for a released message: the address's local part, which is all the row carries.
 *
 * Deliberately NOT case-corrected. `fromAddress` is stored lower-cased (an address is
 * case-insensitive), so "marla.whitfield" is all there is and any capitalisation of it would be
 * invented — "Mcdonald", "O'brien", "Jsmith". The one release path that has a real, correctly-cased
 * name available uses it instead: see the candidate branch below.
 */
function requesterNameFor(address: string): string {
  const local = address.includes("@") ? address.slice(0, address.lastIndexOf("@")) : address;
  const cleaned = local.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
  return (cleaned.length > 0 ? cleaned : address).slice(0, 120);
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

/**
 * Releases one held message into a new ticket.
 *
 * Idempotent: a row already RELEASED returns its existing ticket with `alreadyReleased: true` rather
 * than creating a second one, and a DISCARDED row is refused. The `externalId` is
 * `intake-release.<suspendedId>`, so even a retry that races itself resolves through
 * `createTicketCore`'s `(source, externalId)` unique index.
 */
export async function releaseHeldIntake(
  input: ReleaseHeldIntakeInput,
): Promise<ActionResult<ReleaseHeldIntakeResult>> {
  return runAction("releaseHeldIntake", async (viewer, ctx) => {
    const data = releaseSchema.parse(input);
    // The coarse gate first, so a viewer with no business here is refused before any row is read.
    assertCan(canReviewHeldIntake(viewer.groups), "intake:review release");

    const row = await prisma.suspendedIntake.findUnique({
      where: { id: data.suspendedId },
      select: { ...SUSPENDED_SELECT, createdAt: true, ticket: { select: { id: true, number: true } } },
    });
    if (row === null) throw new NotFoundError("held message not found");

    if (row.status === "RELEASED" && row.ticket !== null) {
      return { ticketId: row.ticket.id, ticketNumber: row.ticket.number, alreadyReleased: true };
    }
    if (row.status === "DISCARDED") {
      throw new ConflictError("this held message was discarded; it cannot be released");
    }

    const route = routeForMailbox(row.mailbox, parseMailboxMap(env.MAILBOX_MAP));
    const queueKey = data.queueKey ?? route?.queueKey;
    if (queueKey === undefined) {
      throw new ValidationError("this message arrived on an unmapped mailbox, so a queue must be chosen", {
        queueKey: [`${row.mailbox} is not in the mailbox map. Pick the queue this belongs in.`],
      });
    }
    // The destination queue is the authorization boundary, not the reviewer's seniority.
    assertCan(canReleaseHeldIntake(viewer.groups, queueKey), `intake:release queue:${queueKey}`);

    // `parseFromAddress`, NOT `normalizeMailboxAddress`: the released row's `fromAddress` is the raw
    // `From` the message carried, and it becomes `Ticket.requesterEmail` — the address every later
    // staff reply is delivered to. A display name may legally contain `<...>`, so the FIRST
    // angle-bracketed group is sender-chosen text; only the last one is the addr-spec. A `From`
    // naming several mailboxes is refused here rather than resolved to its first.
    let requesterEmail = parseFromAddress(row.fromAddress);
    if (requesterEmail === null) {
      throw new ValidationError("this held message carries no usable sender address", {
        suspendedId: [`"${row.fromAddress}" is not an address a ticket can be answered at.`],
      });
    }

    // Wave B (integration round 1): "release as the person inside the forward".
    //
    // The ordinary path above adopts the `From` — for a forward, that is the COLLEAGUE who sent it on,
    // and every later reply would go to them instead of to the client. `resolveForwardedRelease` is
    // the narrow exception, and it is narrow in three ways that are each the thing that would
    // otherwise go wrong: the forward must have passed sender authentication, the forwarder must be
    // an ACTIVE member of staff (vouching for the provenance is what the release rests on), and the
    // address must equal the stored candidate.
    let forwardedBy: string | null = null;
    /**
     * The client's own name, as their mail client wrote it in the forwarded block, when this release
     * is against the candidate. Everywhere else the row carries no name at all and `requesterNameFor`
     * derives one from the lower-cased address — which on THIS path would put "marla whitfield" on a
     * client-facing ticket while "Marla Whitfield" sat in the block the candidate itself was parsed
     * from. The address still comes from `resolveForwardedRelease`, never from here.
     */
    let candidateName: string | null = null;
    if (data.releaseAsCandidate === true) {
      const decision = await resolveForwardedRelease({
        suspendedId: row.id,
        requestedRequesterEmail: row.candidateRequesterEmail ?? "",
      });
      if (!decision.allowed) {
        throw new ValidationError("this message cannot be released against the address inside it", {
          releaseAsCandidate: [FORWARDED_RELEASE_REFUSAL_MESSAGES[decision.refusal]],
        });
      }
      requesterEmail = decision.requesterEmail;
      forwardedBy = decision.forwardedBy;
      candidateName = forwardedCandidateName(row.headers);
    }

    // A row whose sender the desk could not prove. Adopting that address is the privileged half of
    // this action, so it costs an explicit acknowledgement and a note — the same price
    // `changeRequesterEmail` charges for re-pointing an address.
    //
    // The reason ALONE is not that question, and reading it as though it were is what this gate got
    // wrong: `ingestInboundEmail`'s gates are ordered and `SuspendedIntakeReason` holds one value,
    // so a message that failed sender authentication AND arrived on an unmapped address is held as
    // `UNKNOWN_MAILBOX` — and was released here as though its sender had been proven, with no
    // acknowledgement, no note, and no "SENDER NOT VERIFIED" line on the ticket that later decides
    // a wire or an address change. The hold now records the verdict beside the reason and
    // `heldIntakeSenderVerified` combines the two, fail-closed, for this gate and for the review
    // card alike.
    const senderVerified = heldIntakeSenderVerified(row.reason, await heldIntakeSenderAuthenticated(row.id));
    if (!senderVerified) assertUnverifiedSenderAcknowledged(data);

    const note = data.note === undefined || data.note.length === 0 ? null : sanitizePII(data.note).text;
    const category = (data.category ?? route?.category) as TicketCategory | undefined;

    const ticketInput: IngestTicketInput = {
      source: EMAIL_SOURCE,
      // Decision #117 reads this prefix back: it is how the client API recognises a ticket whose
      // EMAIL-sourced description the DESK composed (below) and withholds it from the client's thread.
      // Keep it in step with INTAKE_RELEASE_EXTERNAL_ID_PREFIX — the constant IS the shared spelling.
      externalId: `${INTAKE_RELEASE_EXTERNAL_ID_PREFIX}${row.id}`,
      subject: row.subject,
      description: releaseDescription(
        {
          reason: row.reason,
          mailbox: row.mailbox,
          fromAddress: row.fromAddress,
          messageId: row.messageId,
          rawRef: row.rawRef,
          snippet: row.snippet === null ? null : row.snippet.slice(0, INGEST_LIMITS.snippetMaxChars),
          createdAtIso: row.createdAt.toISOString(),
          senderVerified,
          forwardedBy,
        },
        note,
      ),
      category,
      queueKey,
      brand: route?.brand,
      requesterName: candidateName ?? requesterNameFor(requesterEmail),
      requesterEmail,
    };

    // Step 1: the ticket. `via: null` — a named human released this, so none of the rows the core
    // writes may carry the machine marker (§3 rule 1). The channel is still on every one of them as
    // `metadata.source = EMAIL_SOURCE`, and on the ticket itself as `source = EMAIL`.
    const actor = actorFromViewer(viewer);
    const created = await createTicketCore(ticketInput, { actor, ctx, via: null });

    // Step 2: the claim and its audit row, in one transaction. count 0 means somebody else released
    // this row between the read and here; their ticket is the one that counts.
    const linked = await withTx(async (tx) => {
      const claimed = await tx.suspendedIntake.updateMany({
        where: { id: row.id, status: "NEW" },
        data: { status: "RELEASED", ticketId: created.ticketId, releasedById: viewer.id, releasedAt: new Date() },
      });
      if (claimed.count === 0) return false;

      const entries: AuditEntry[] = [
        {
          action: "INTAKE_RELEASED",
          entityType: "SUSPENDED_INTAKE",
          entityId: row.id,
          ticketId: created.ticketId,
          fieldChanged: "status",
          oldValue: "NEW",
          newValue: "RELEASED",
          // No `via`: a human did this (§3 rule 1). `source` carries the channel.
          metadata: {
            source: EMAIL_SOURCE,
            reason: row.reason,
            mailbox: row.mailbox,
            messageId: row.messageId,
            queueKey,
            ticketNumber: created.ticketNumber,
            // What this release granted, spelled out the way `changeRequesterEmail` spells it out:
            // the ticket answers to an address, and on an unverified row that address is one nobody
            // proved. Recorded as the computed verdict, not the reason, so the ledger says what the
            // gate actually charged.
            senderVerified,
            ...(senderVerified
              ? {}
              : { unverifiedSenderConfirmed: true, grantsClientApiAccess: true, redirectsOutboundMail: true }),
            // What the release actually did with the address, when it was not the `From`.
            ...(forwardedBy === null ? {} : { releasedAsCandidate: true, forwardedBy }),
          },
        },
      ];
      await writeAuditMany(tx, actor, ctx, entries);
      return true;
    });

    if (!linked) {
      const winner = await prisma.suspendedIntake.findUnique({
        where: { id: row.id },
        select: { ticket: { select: { id: true, number: true } } },
      });
      if (winner?.ticket != null) {
        return { ticketId: winner.ticket.id, ticketNumber: winner.ticket.number, alreadyReleased: true };
      }
      throw new ConflictError("this held message is no longer releasable");
    }

    return { ticketId: created.ticketId, ticketNumber: created.ticketNumber, alreadyReleased: false };
  });
}
