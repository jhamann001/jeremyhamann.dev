import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { demoMode } from "@/lib/demo/mode";
import { listOutboxFor } from "@/lib/demo/outbox";
import { canReadQueue } from "@/lib/rbac";
import { requireUser } from "@/lib/session";
import { OutboxView } from "@/components/demo/outbox-view";

export const dynamic = "force-dynamic";

/** How many messages the screen lists, newest first. */
const OUTBOX_LIMIT = 100;

/**
 * The demo's Outbox: every client email and Slack message the app would have sent, as the stand-ins for
 * the firm's mail sender and Slack received them. Demo mode only; anywhere else the page does not exist.
 * Every signed-in persona may open it, and sees the messages about tickets in queues it can read.
 */
export default async function OutboxPage(): Promise<React.JSX.Element> {
  const viewer = await requireUser();
  if (!demoMode()) notFound();
  const messages = await listOutboxFor(prisma, (queue) => canReadQueue(viewer.groups, queue), OUTBOX_LIMIT);
  return <OutboxView messages={messages} />;
}
