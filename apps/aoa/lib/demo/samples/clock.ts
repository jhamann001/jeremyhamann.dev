// The seed's clock as the running app reads it (demo.seed_clock, which lib/demo/seed writes first). The sample data
// dates itself from it, so a sample's "3 business days ago" is the day the database's records say: between New York
// midnight and the nightly reset the wall clock has already moved on to a day the database doesn't have, and after a
// reset that failed it stays there. Without a recorded clock (no seed yet, or a database from before it existed) the
// wall clock stands in. Read at most once a minute: it changes once a night. Server only.

import "server-only";
import { prisma } from "@/lib/db";

const FRESH_MS = 60_000;

let last: { readAt: number; seedNow: Date | null } | null = null;

/** The clock the demo database was seeded with, or the wall clock when none is recorded. */
export async function demoSampleNow(): Promise<Date> {
  if (!last || Date.now() - last.readAt > FRESH_MS) {
    const rows = await prisma.$queryRaw<Array<{ seed_now: Date }>>`SELECT seed_now FROM demo.seed_clock`.catch(() => []);
    last = { readAt: Date.now(), seedNow: rows[0]?.seed_now ?? null };
  }
  return last.seedNow ?? new Date();
}

/** The seed's clock as demoSampleNow last read it, for a caller that has just awaited it (the Dual-View page reads
 *  the portrait first); the wall clock before any read. */
export function lastDemoSampleNow(): Date {
  return last?.seedNow ?? new Date();
}
