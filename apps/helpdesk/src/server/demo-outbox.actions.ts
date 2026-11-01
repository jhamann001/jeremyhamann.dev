"use server";

/**
 * The demo Outbox's two buttons (plan decision D3). Each builds an inbound message and posts it to the
 * app's real intake route, /api/ingest/email, over loopback with the intake key, exactly as the firm's
 * mail workflow would. The key never reaches the browser. Demo mode only.
 *
 * Every visitor shares the one intake key, whose rate limit is per key, so the buttons have a small limit of
 * their own per visitor, and the call carries the visitor's address so the intake's rows and allowance are
 * theirs (src/lib/demo/limits.ts).
 */
import type { ActionResult, RequestContext } from "@/types/domain";
import { prisma } from "@/lib/db";
import { takeDemoQuota } from "@/lib/demo/limits";
import { appPort, demoMode } from "@/lib/demo/mode";
import { findOutboxMessage, visibleOutbox, type OutboxEmailPayload } from "@/lib/demo/outbox";
import { clientReplyTo, sampleClientEmail } from "@/lib/demo/sample-mail";
import { loadUniverse, type Universe } from "@/lib/demo/universe";
import { AppError, NotFoundError, ValidationError } from "@/lib/errors";
import { canReadQueue } from "@/lib/rbac";
import { runAction } from "@/server/action-utils";
import type { InboundEmail, IntakeOutcome } from "@/server/email-intake";

let universe: Universe | null = null;
const demoUniverse = (): Universe => (universe ??= loadUniverse());

export type IntakeSummary = { outcome: IntakeOutcome["outcome"]; ticketNumber: number | null };

/** Sample emails one visitor may send a minute, both buttons together. */
const BUTTON_PRESSES_PER_MINUTE = 6;

async function postToIntake(email: InboundEmail, ctx: RequestContext): Promise<IntakeSummary> {
  const token = process.env.INGEST_API_TOKEN;
  if (!token) throw new AppError("INTERNAL", "The demo's intake key is not configured", 500);
  if (!takeDemoQuota(`outbox:${ctx.ipAddress}`, BUTTON_PRESSES_PER_MINUTE, 60_000)) {
    throw new ValidationError("That's a lot of sample mail at once. Please wait a minute and try again.");
  }
  const response = await fetch(`http://127.0.0.1:${appPort()}/api/ingest/email`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(ctx.ipAddress && ctx.ipAddress !== "unknown" ? { "x-forwarded-for": ctx.ipAddress } : {}),
    },
    body: JSON.stringify(email),
    cache: "no-store",
  });
  if (response.status !== 202) {
    // The intake's own refusal (a demo limit, say) is written for people, so it is passed on as it is.
    const refusal = (await response.json().catch(() => null)) as { message?: unknown } | null;
    if (response.status === 422 && typeof refusal?.message === "string") throw new ValidationError(refusal.message);
    if (response.status === 429) throw new ValidationError("The demo's mail intake is busy. Please try again in a minute.");
    throw new AppError("INTERNAL", `Intake answered ${response.status}`, 502);
  }
  const outcome = (await response.json()) as IntakeOutcome;
  let ticketNumber: number | null = null;
  if (outcome.outcome !== "suspended") {
    const ticket = await prisma.ticket.findUnique({ where: { id: outcome.ticketId }, select: { number: true } });
    ticketNumber = ticket?.number ?? null;
  }
  return { outcome: outcome.outcome, ticketNumber };
}

function assertDemo(): void {
  if (!demoMode()) throw new NotFoundError("Not found");
}

/** "Send a sample client email": a new message from a universe client to the service mailbox. */
export async function sendSampleClientEmail(): Promise<ActionResult<IntakeSummary>> {
  return runAction("sendSampleClientEmail", async (_viewer, ctx) => {
    assertDemo();
    return postToIntake(sampleClientEmail(demoUniverse()), ctx);
  });
}

/** "Reply as the client": the recipient of an email in the Outbox answers it, if the viewer can see that email. */
export async function replyAsClient(input: { outboxId: string }): Promise<ActionResult<IntakeSummary>> {
  return runAction("replyAsClient", async (viewer, ctx) => {
    assertDemo();
    const message = await findOutboxMessage(prisma, String(input.outboxId).slice(0, 64));
    const visible =
      message !== null &&
      message.transport === "email" &&
      (await visibleOutbox(prisma, [message], (queue) => canReadQueue(viewer.groups, queue))).length === 1;
    if (!visible) throw new NotFoundError("That email is not in the Outbox");
    const email = message.payload as OutboxEmailPayload;
    const ticket = await prisma.ticket.findUnique({ where: { number: email.ticketNumber }, select: { requesterName: true } });
    return postToIntake(clientReplyTo(email, ticket?.requesterName ?? null), ctx);
  });
}
