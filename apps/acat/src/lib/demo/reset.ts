// The demo reset, shared by the reset route (the Worker's nightly cron) and scripts/demo-reset.ts (the
// deploy): put the database back to its starting state, then do what the firm's scheduled jobs would
// have done. The jobs are not scheduled in the demo, so the reset runs the client-directory sync and the
// daily digest once, against the stand-ins: the directory always looks freshly synced and the digest
// lands in the Outbox.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { resetDemoData } from "@/lib/demo/seed";
import { loadUniverse } from "@/lib/demo/universe";
import { syncClientDirectory } from "@/lib/client-directory/sync";
import { DirectorySourceError } from "@/lib/client-directory/source";
import { buildDigestSnapshot, formatDigestMessage } from "@/lib/daily-digest";
import { postToSlack } from "@/lib/slack-webhook";
import type { AcatRecord } from "@/lib/types";

export async function runDemoReset(now = new Date()) {
  const summary = await resetDemoData(prisma, loadUniverse(), now);

  let directory: string;
  try {
    directory = (await syncClientDirectory()).status;
  } catch (error) {
    directory = error instanceof DirectorySourceError ? error.code : "DIRECTORY_SYNC_FAILED";
    logger.error({ code: directory }, "demo reset: directory sync failed");
  }

  let digestSent = false;
  try {
    const records = (await prisma.acatRecord.findMany({ where: { deletedAt: null }, include: { assets: true } })) as unknown as AcatRecord[];
    await postToSlack(formatDigestMessage(buildDigestSnapshot(records, now.getTime()), now.getTime()));
    digestSent = true;
  } catch (error) {
    logger.error({ errorType: error instanceof Error ? error.name : "UnknownError" }, "demo reset: digest failed");
  }

  logger.info({ event: "demo_reset_complete", transfers: summary.transfers, directory, digestSent }, "demo reset complete");
  return { ...summary, directory, digestSent };
}
