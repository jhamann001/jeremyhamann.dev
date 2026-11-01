/**
 * Starts the demo's stand-ins inside the app's server process (src/instrumentation.ts), in demo mode only:
 * the Slack stand-in on its loopback port, and the mail sender, which drains the app's own outbox over
 * loopback. Started once per process; a second call (the dev server reloading) does nothing.
 */
import { appPort } from "@/lib/demo/mode";
import { isDeliveryFiled, recordOutbox } from "@/lib/demo/outbox";
import { configuredSlackUrls, startSlackStandIn } from "@/lib/demo/stand-ins/slack";
import { startSender } from "@/lib/demo/stand-ins/sender";

const STARTED = Symbol.for("helpdesk.demo.stand-ins");

export async function startDemoStandIns(): Promise<void> {
  const flags = globalThis as typeof globalThis & { [STARTED]?: boolean };
  if (flags[STARTED]) return;
  flags[STARTED] = true;
  const { prisma } = await import("@/lib/db");

  try {
    await startSlackStandIn({
      record: (entry) => recordOutbox(prisma, entry),
      now: () => new Date(),
      configuredUrls: () => configuredSlackUrls(),
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "EADDRINUSE") {
      // Another process on this machine already serves the port (a local reset beside a dev server); its
      // stand-in files posts in the same Outbox.
      console.warn("[stand-ins] Slack stand-in not started: the port is in use");
    } else {
      // Anything else means Slack posts will fail until the next start; said plainly, without the error text.
      console.error("[stand-ins] Slack stand-in failed to start", { code: code ?? "unknown" });
    }
  }

  const token = process.env.OUTBOX_API_TOKEN;
  if (!token) {
    console.warn("[stand-ins] OUTBOX_API_TOKEN is unset: the stand-in mail sender is off and replies stay queued");
    return;
  }
  startSender({
    pending: () =>
      prisma.messageDelivery.count({
        where: { OR: [{ status: "QUEUED" }, { status: "LEASED", leaseExpiresAt: { lte: new Date() } }] },
      }),
    alreadyFiled: (deliveryId) => isDeliveryFiled(prisma, deliveryId),
    record: (entry) => recordOutbox(prisma, entry),
    fetch,
    baseUrl: `http://127.0.0.1:${appPort()}`,
    token,
  });
}
