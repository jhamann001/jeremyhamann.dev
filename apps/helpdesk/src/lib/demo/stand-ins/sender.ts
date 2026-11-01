/**
 * The firm's mail sender, for the demo. In production a workflow leases queued client mail from
 * GET /api/integrations/outbox, sends it through Gmail and reports each message back with
 * POST /api/integrations/outbox/:id. This does the same, over loopback with the same kind of key, and files
 * each message in the Outbox instead of sending it. The ticket shows the real lifecycle — queued, leased,
 * sent — with the ledger rows the routes write.
 *
 * It asks the table, not the route, whether anything is waiting, so an idle desk adds no ledger rows.
 */
import type { OutboxLease } from "@/server/outbox";
import type { OutboxEmailPayload, OutboxEntry } from "@/lib/demo/outbox";

export type SenderDeps = {
  /** Deliveries a lease would pick up now: QUEUED, or LEASED with the lease run out. */
  pending(): Promise<number>;
  alreadyFiled(deliveryId: string): Promise<boolean>;
  record(entry: OutboxEntry): Promise<void>;
  fetch: typeof fetch;
  /** The app's own origin over loopback, e.g. http://127.0.0.1:3000. */
  baseUrl: string;
  /** OUTBOX_API_TOKEN: the key the outbox routes check. */
  token: string;
};

export const SENDER_INTERVAL_MS = 4_000;
const LEASE_LIMIT = 25;

/** The Message-ID the stand-in reports as the provider's, so the ticket's delivery shows a sent id. */
export const standInProviderId = (deliveryId: string): string => `<demo-sent.${deliveryId}@mail.example.com>`;

export async function drainOnce(deps: SenderDeps): Promise<{ sent: number; failed: number }> {
  if ((await deps.pending()) === 0) return { sent: 0, failed: 0 };
  const auth = { authorization: `Bearer ${deps.token}` };
  const leased = await deps.fetch(`${deps.baseUrl}/api/integrations/outbox?status=QUEUED&limit=${LEASE_LIMIT}`, {
    headers: auth,
  });
  if (!leased.ok) throw new Error(`outbox lease answered ${leased.status}`);
  const { deliveries } = (await leased.json()) as { deliveries: OutboxLease[] };
  let sent = 0;
  let failed = 0;
  for (const d of deliveries) {
    if (!(await deps.alreadyFiled(d.id))) {
      const payload: OutboxEmailPayload = {
        ticketNumber: d.ticketNumber,
        from: d.from,
        fromName: d.fromName,
        replyTo: d.replyTo,
        to: d.to,
        subject: d.subject,
        textBody: d.textBody,
        messageId: d.messageId,
        inReplyTo: d.inReplyTo,
        references: d.references,
      };
      await deps.record({ transport: "email", destination: d.to, title: d.subject, payload, deliveryId: d.id });
    }
    const reported = await deps.fetch(`${deps.baseUrl}/api/integrations/outbox/${encodeURIComponent(d.id)}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ outcome: "SENT", providerMessageId: standInProviderId(d.id) }),
    });
    if (reported.ok) sent++;
    else failed++;
  }
  return { sent, failed };
}

/** Drains the outbox every few seconds until stopped. One drain at a time; a failure waits for the next tick. */
export function startSender(deps: SenderDeps, intervalMs = SENDER_INTERVAL_MS): { stop(): void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    drainOnce(deps)
      .catch((error: unknown) => {
        console.error("[stand-ins] mail sender failed", { error: error instanceof Error ? error.message.slice(0, 120) : "UnknownError" });
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
