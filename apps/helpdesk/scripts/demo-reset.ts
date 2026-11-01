/**
 * Resets the demo from the command line: the daily workflow and each deploy run this, as the database
 * owner (prisma/demo-reset.ts). It empties every table before filling it, so it asks for a second word:
 *
 *   DEMO_SEED=reset npm run demo:reset
 *
 * Needs DATABASE_URL (the owner). After the reset commits, it runs seven of the scheduled jobs once (the
 * demo schedules none), so SLA alerts, nudges and notifications look current. In demo mode
 * (NEXT_PUBLIC_DEMO_MODE=on) it starts its own Slack stand-in on loopback, with fresh webhook addresses, so
 * the alerts land in the Outbox. With no ATTACHMENTS_BUCKET it also writes the seeded attachment files into
 * the local store, so a local dev server can open them; the image has them baked in.
 */
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { OutboxEntry } from "../src/lib/demo/outbox";

/** The jobs the reset runs. Webhook dispatch and the duplicate copy stay off: no endpoints, no bucket. */
const RESET_JOBS = [
  "auto-close",
  "sla-sweep",
  "event-alerts",
  "follow-up-nudges",
  "out-of-office",
  "digest",
  "notification-dispatch",
] as const;

const fresh = (): string => randomBytes(24).toString("hex");

async function main(): Promise<number> {
  if (process.env.DEMO_SEED !== "reset") {
    process.stderr.write("The demo reset empties every table before filling it. Set DEMO_SEED=reset to run it.\n");
    return 1;
  }
  if (process.env.APP_ENV === "production") {
    process.stderr.write("The demo reset never runs where APP_ENV=production.\n");
    return 2;
  }
  // Before anything reads the settings: this run's own Slack stand-in (src/lib/demo/stand-ins/slack.ts), on a
  // free loopback port so it never collides with an app's stand-in on the same machine, with fresh addresses.
  const { demoMode } = await import("../src/lib/demo/mode");
  let slack: Server | null = null;
  let record: ((entry: OutboxEntry) => Promise<void>) | null = null;
  if (demoMode()) {
    const { startSlackStandIn, configuredSlackUrls } = await import("../src/lib/demo/stand-ins/slack");
    slack = await startSlackStandIn(
      {
        record: (entry) => (record ? record(entry) : Promise.reject(new Error("the Outbox is not ready yet"))),
        now: () => new Date(),
        configuredUrls: () => configuredSlackUrls(),
      },
      0,
    );
    const port = (slack.address() as AddressInfo).port;
    process.env.STAND_INS_PORT = String(port);
    const base = `http://127.0.0.1:${port}/slack`;
    process.env.SLA_ALERT_SLACK_WEBHOOK_URL = `${base}/sla-alerts/${fresh()}`;
    process.env.SLACK_QUEUE_WEBHOOKS = JSON.stringify({
      OPERATIONS: `${base}/ops-desk/${fresh()}`,
      CLIENT_SERVICE: `${base}/client-service/${fresh()}`,
      ADVICE: `${base}/advice-desk/${fresh()}`,
    });
  }

  const [{ prisma }, { runDemoReset }, { loadUniverse }, { writeDemoAttachments }, { LOCAL_ATTACHMENTS_DIR }, { runJobs }] =
    await Promise.all([
      import("../src/lib/db"),
      import("../prisma/demo-reset"),
      import("../src/lib/demo/universe"),
      import("../src/lib/demo/attachments"),
      import("../src/lib/storage"),
      import("../src/jobs/run"),
    ]);
  try {
    const universe = loadUniverse();
    const result = await runDemoReset(prisma, { universe });
    console.log(JSON.stringify(result, null, 2));
    if (!process.env.ATTACHMENTS_BUCKET) {
      const written = await writeDemoAttachments(LOCAL_ATTACHMENTS_DIR, universe);
      console.log(`seeded attachment files written to ${LOCAL_ATTACHMENTS_DIR}/: ${written}`);
    }

    const { recordOutbox } = await import("../src/lib/demo/outbox");
    record = (entry) => recordOutbox(prisma, entry);
    const jobs = await runJobs([...RESET_JOBS]);
    for (const j of jobs) console.log(`job ${j.name}: ${j.ok ? "ok" : "FAILED"} (processed ${j.processed}, posted ${j.posted})`);
    if (jobs.some((j) => !j.ok)) {
      process.stderr.write("The desk was reset, but a job failed (see above).\n");
      return 1;
    }
    return 0;
  } finally {
    if (slack) await new Promise((resolve) => slack!.close(resolve));
    await prisma.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  async (err: unknown) => {
    // The class name only, as prisma/seed.ts prints it: a Prisma error's message can quote the row it
    // refused. The seed's own assertions are the exception; their messages name a fixture, never a row.
    const { errorLabel } = await import("../src/lib/logger");
    const own = err instanceof Error && err.name === "SeedAssertionError";
    process.stderr.write(`demo reset failed: ${own ? err.message : errorLabel(err)}\n`);
    process.exit(1);
  },
);
