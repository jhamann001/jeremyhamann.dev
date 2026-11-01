"use server";

/**
 * `logCall` — the new-ticket form's intake variant.
 *
 * One export, `runAction`-wrapped, and the whole of it is: authenticate → zod → RBAC → the SAME
 * `createTicketCore` every other channel uses. It exists because the staff `createTicket` demands
 * an email address and knows nothing about `Ticket.source`, and a call from a client who has never
 * given the desk an address is exactly the ticket the desk most needs to be able to raise.
 *
 * Three things it deliberately does NOT do.
 *
 *  - **It does not re-implement ticket creation.** The routing defaults, the SLA stamping, the PII
 *    pass, the requester-domain guard and the audit shape live in `createTicketCore`, and a second
 *    implementation of any of them is a second thing to keep correct. `via: null` is passed because a
 *    named human is doing this, so the rows carry no `via` and the ledger's "a person did this" /
 *    "a system did this" partition keeps working (CONTRACT §3 rule 1).
 *  - **It does not take an assignee.** `createTicketCore` routes and, where the queue opts in, auto-
 *    assigns. An associate on the phone is doing intake, not triage — the board is where work is
 *    picked up. Recommended default, pending confirmation; the form says so on screen rather than
 *    silently dropping a control.
 *  - **It does not record the client contact.** "The client was reached on this call" is a separate,
 *    separately-audited act (`recordClientContact`) that stamps `firstRespondedAt`, and
 *    folding it in here would make one action credit an SLA response on the strength of a checkbox in
 *    the same submit that created the clock. The form calls it second, with the new ticket's version.
 */
import { z } from "zod";
import type { ActionResult } from "@/types/domain";
import { QUEUE_KEYS, TICKET_CATEGORIES, TICKET_PRIORITIES } from "@/types/domain";
import { actorFromViewer } from "@/lib/audit";
import { prisma } from "@/lib/db";
import {
  LOG_CALL_CHANNELS,
  LOG_CALL_DESCRIPTION_MAX,
  LOG_CALL_NAME_MAX,
  LOG_CALL_REFERENCE_MAX,
  LOG_CALL_SUBJECT_MAX,
  contactErrorsFor,
  requiresEmail,
  sourceForChannel,
  type LogCallInput,
} from "@/lib/log-call";
import { assertCan, canCreateTicket } from "@/lib/rbac";
import { routeCategory } from "@/lib/routing";
import { createTicketCore } from "@/server/ingest";
import { runAction } from "@/server/action-utils";

const emailSchema = z.preprocess(
  (v) => {
    if (typeof v !== "string") return v;
    const trimmed = v.trim();
    return trimmed === "" ? null : trimmed;
  },
  z.union([z.email().toLowerCase(), z.null()]),
);

const phoneSchema = z.preprocess(
  (v) => {
    if (typeof v !== "string") return v;
    // The formatting a person types is stripped; the country code is never inferred.
    const compact = v.replace(/[\s().-]/g, "");
    return compact === "" ? null : compact;
  },
  z.union([z.string().regex(/^\+[1-9]\d{7,14}$/, "Enter the number in E.164 format, e.g. +14155550123"), z.null()]),
);

/**
 * The wire schema. Not exported: G4 requires a `"use server"` file to export nothing but
 * `runAction`-wrapped actions. The two channel refinements delegate to `contactErrorsFor`
 * (`src/lib/log-call.ts`), which is what the FORM calls too — so the browser and the server refuse the
 * same inputs with the same words, and the policy is unit-tested in one place.
 */
const logCallSchema: z.ZodType<LogCallInput, unknown> = z
  .object({
    channel: z.enum(LOG_CALL_CHANNELS),
    subject: z.string().trim().min(3).max(LOG_CALL_SUBJECT_MAX),
    description: z.string().min(1).max(LOG_CALL_DESCRIPTION_MAX),
    category: z.enum(TICKET_CATEGORIES),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    queueKey: z.enum(QUEUE_KEYS).optional(),
    requesterName: z.string().trim().min(1).max(LOG_CALL_NAME_MAX),
    requesterEmail: emailSchema.optional(),
    requesterPhone: phoneSchema.optional(),
    clientReference: z.string().trim().max(LOG_CALL_REFERENCE_MAX).nullable().optional(),
    requestId: z.string().trim().min(8).max(128),
  })
  .refine((v) => !requiresEmail(v.channel) || (v.requesterEmail ?? null) !== null, {
    message: "A web-form ticket needs the requester's email address",
    path: ["requesterEmail"],
  })
  .refine((v) => Object.keys(contactErrorsFor(v.channel, v.requesterEmail, v.requesterPhone)).length === 0, {
    message: "Record at least one way to reach this person: an email address or a phone number",
    path: ["requesterPhone"],
  });

export type LogCallResult = {
  id: string;
  number: number;
  /** 1 for a new ticket; the form hands it straight to `recordClientContact`. */
  version: number;
  /** False when the `requestId` had already been used — a double submit, replayed, not duplicated. */
  created: boolean;
  piiRedacted: boolean;
  piiRedactionCount: number;
};

export async function logCall(input: LogCallInput): Promise<ActionResult<LogCallResult>> {
  return runAction("logCall", async (viewer, ctx) => {
    const data = logCallSchema.parse(input);
    const routed = routeCategory(data.category);
    const queueKey = data.queueKey ?? routed.queueKey;
    const priority = data.priority ?? routed.priority;
    assertCan(canCreateTicket(viewer.groups, queueKey), "ticket:create");

    const result = await createTicketCore(
      {
        source: sourceForChannel(data.channel),
        // The form's own request id, namespaced by channel so two channels cannot collide on one.
        externalId: `call:${data.channel.toLowerCase()}:${data.requestId}`,
        subject: data.subject,
        description: data.description,
        category: data.category,
        priority,
        queueKey,
        requesterName: data.requesterName,
        requesterEmail: data.requesterEmail ?? null,
        requesterPhone: data.requesterPhone ?? null,
        clientReference: data.clientReference ?? null,
      },
      // A named human raised this ticket, so `via` is null and the audit rows carry no `via` key.
      { actor: actorFromViewer(viewer), ctx, via: null },
    );

    // Read back the version rather than assuming 1: a replayed `requestId` returns a ticket that may
    // already have moved, and the form hands this straight to `recordClientContact`, which refuses a
    // stale token. One extra indexed read on a path that just wrote a row.
    const row = await prisma.ticket.findUnique({ where: { id: result.ticketId }, select: { version: true } });

    return {
      id: result.ticketId,
      number: result.ticketNumber,
      version: row?.version ?? 1,
      created: result.created,
      piiRedacted: result.piiRedacted,
      piiRedactionCount: result.piiRedactionCount,
    };
  });
}
