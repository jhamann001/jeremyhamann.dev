import "server-only";
import { prisma } from "@/lib/db";

export type ServingSource = "standalone" | "aoa";
export type ServingState = { servingSource: ServingSource; digestSender: ServingSource; driftSender: ServingSource };

const STANDALONE: ServingState = { servingSource: "standalone", digestSender: "standalone", driftSender: "standalone" };

/** Reads the single serving-state row on every call (no cache). A missing row or a read error reads as standalone. */
export async function readServingState(): Promise<ServingState> {
  try {
    const rows = await prisma.$queryRaw<Array<{ serving_source: ServingSource; digest_sender: ServingSource; drift_sender: ServingSource }>>`
      SELECT serving_source, digest_sender, drift_sender FROM trade_request.serving_state WHERE id`;
    const row = rows[0];
    return row ? { servingSource: row.serving_source, digestSender: row.digest_sender, driftSender: row.drift_sender } : STANDALONE;
  } catch (err) {
    // Only the error code: a database message can echo values.
    console.error(`[trade-requests] serving_state_read_failed code=${String((err as { code?: unknown })?.code ?? "unknown")}`);
    return STANDALONE;
  }
}

export async function isAoaServed(): Promise<boolean> {
  return (await readServingState()).servingSource === "aoa";
}
