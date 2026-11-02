// Fills the demo database with the public demo's data (lib/demo/seed), as the owner login.
//
//   DEMO_SEED=fresh DIRECT_DATABASE_URL=… npm run demo:seed     a freshly migrated database; refuses one holding data
//   DEMO_SEED=reset DIRECT_DATABASE_URL=… npm run demo:reset    the nightly reset: empties the database back to its
//                                                               migrated state (lib/demo/reset), then fills it
// (from apps/aoa). Every date is relative to the run, so a reset brings the demo's week back to the present.
//
// It runs with the demo's own settings (demo-config.json, for any not already set), so the app code it calls answers
// outside services from the stand-ins, and it refuses to run outside demo mode. It writes as production's logins:
// the owner (DIRECT_DATABASE_URL), the app (DATABASE_URL), the ingest login (INGEST_DATABASE_URL) and the CRM
// reconciler (CRM_RECONCILER_DATABASE_URL); any of the three not set comes from the owner URL (lib/demo/logins).
// A fresh seed first gives those logins their passwords, derived from the owner's. A reset sets none: it checks the
// logins sign in as they are, because the running container holds the passwords the last deploy gave it, and only a
// deploy can hand it new ones (lib/demo/logins.ts, demoLoginProblems).
//
// The clear commits before the seed starts, so a reset that failed after it would leave visitors an empty demo. So
// before it empties anything, a reset loads the seed and the universe, builds the plans the seed makes without the
// database, checks the database's migrations are exactly this checkout's and the logins sign in, and puts up the
// Worker's "resetting" page. If any of that fails it exits non-zero and leaves the data alone.
//
// With DEMO_RESET_GATE_URL set (the deploy and the nightly reset set it to the live Worker's gate), the reset's
// "resetting" page (worker/src/gate.js) keeps visitors from seeing the demo half filled; it comes down once the seed
// is in, or by itself after GATE_MINUTES if the reset dies. A gate that refuses (a wrong token answers 404: the
// owner password changed since the last deploy) or can't be reached stops the reset before the clear. If the page
// doesn't come down at the end, the reset is done but the script exits with GATE_STILL_UP, so the run shows red
// and the workflow knows not to reset again. Without DEMO_RESET_GATE_URL (a local reset) there is no page.
//
// Both scripts load scripts/server-only-shim.cjs first, so modules marked server-only load outside Next.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { demoLoginProblems, demoLoginUrls, demoResetGateToken, ensureDemoLogins } from "../lib/demo/logins";
import { clearDemoDatabase, demoMigrationProblems } from "../lib/demo/reset";

const MODES = ["fresh", "reset"] as const;
const SEEDED_LOGINS = ["DATABASE_URL", "INGEST_DATABASE_URL", "CRM_RECONCILER_DATABASE_URL"] as const;
const GATE_MINUTES = 20;
/** The exit code of a reset that finished but couldn't take its "resetting" page down. */
const GATE_STILL_UP = 3;

/**
 * Puts the Worker's "resetting" page up for `minutes`, or takes it down with 0. True when the gate took the change,
 * or when there is no gate to tell (DEMO_RESET_GATE_URL unset). Never throws.
 */
async function setGate(ownerUrl: string, minutes: number): Promise<boolean> {
  const url = process.env.DEMO_RESET_GATE_URL;
  if (!url) return true;
  const change = minutes > 0 ? "put up" : "taken down";
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${demoResetGateToken(ownerUrl)}`, "content-type": "application/json" },
      body: JSON.stringify({ minutes }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) {
      console.log(`Resetting page ${minutes > 0 ? "up" : "down"}: the gate answered ${response.status}.`);
      return true;
    }
    console.error(`The resetting page could not be ${change}: the gate answered ${response.status}.`);
  } catch (error) {
    console.error(`The resetting page could not be ${change}: ${error instanceof Error ? error.message : error}`);
  }
  return false;
}

/**
 * Loads the seed and builds what it plans without the database, so a seed that can't load or plan stops a reset
 * before the clear, not after it. Returns the seed.
 */
async function loadSeed(owner: PrismaClient, ingest: PrismaClient) {
  // The app's modules read their settings when they load, so they load only now.
  const { seedDemo } = await import("../lib/demo/seed");
  const { createSeedContext } = await import("../lib/demo/seed/context");
  const { loadUniverse } = await import("../lib/demo/seed/universe");
  const { planDemoTransfers } = await import("../lib/demo/seed/tracker-plan");
  const { trackerSeed } = await import("../lib/demo/seed/tracker-records");
  const { planFundingWork } = await import("../lib/demo/seed/transfers-plan");
  const { planTradeRequests } = await import("../lib/demo/seed/trade-requests-plan");
  const { withOwnTradeRecords } = await import("../lib/demo/seed/trade-requests-own");
  const { planStatementRuns } = await import("../lib/demo/seed/asset-maps-snapshot");

  const universe = loadUniverse();
  const ctx = createSeedContext(universe, owner, ingest);
  trackerSeed(universe, planDemoTransfers(universe, ctx.now), ctx.now, ctx.at);
  planFundingWork(ctx);
  withOwnTradeRecords(planTradeRequests(universe), universe);
  planStatementRuns(universe, ctx.now);
  return () => seedDemo(universe, owner, ingest);
}

const list = (lines: string[]): string => lines.map((line) => `\n  ${line}`).join("");

/** Signs in as each login the seed writes as, so a password that no longer matches stops a reset before the clear. */
async function loginSignInProblems(): Promise<string[]> {
  const problems: string[] = [];
  for (const key of SEEDED_LOGINS) {
    const db = new PrismaClient({ datasourceUrl: process.env[key] });
    try {
      await db.$queryRaw`SELECT 1`;
    } catch {
      // Only the setting's name: the error can quote the URL.
      problems.push(`${key}: could not sign in`);
    } finally {
      await db.$disconnect();
    }
  }
  return problems;
}

async function main() {
  const mode = process.env.DEMO_SEED as (typeof MODES)[number] | undefined;
  if (!mode || !MODES.includes(mode)) {
    console.error("Set DEMO_SEED=fresh to fill a freshly migrated database, or DEMO_SEED=reset to empty and refill one.");
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(join(process.cwd(), "demo-config.json"), "utf8")) as Record<string, string>;
  for (const [key, value] of Object.entries(config)) process.env[key] ??= value;
  if (process.env.NEXT_PUBLIC_DEMO_MODE !== "on") throw new Error("The demo seed runs only in demo mode.");

  const directUrl = process.env.DIRECT_DATABASE_URL;
  if (!directUrl) throw new Error("DIRECT_DATABASE_URL (the owner login) is required to seed.");
  const logins = demoLoginUrls(directUrl);
  for (const key of SEEDED_LOGINS) process.env[key] ??= logins[key];

  const ownerDb = new PrismaClient({ datasourceUrl: directUrl });
  const ingestDb = new PrismaClient({ datasourceUrl: process.env.INGEST_DATABASE_URL });
  try {
    const seed = await loadSeed(ownerDb, ingestDb);
    const migrations = await demoMigrationProblems(ownerDb, join(process.cwd(), "prisma", "migrations"));
    if (migrations.length > 0) {
      throw new Error(`The database's migrations don't match this checkout's, so nothing was changed:${list(migrations)}`);
    }
    if (mode === "fresh") {
      await ensureDemoLogins(ownerDb, directUrl);
    } else {
      const problems = [...(await demoLoginProblems(ownerDb)), ...(await loginSignInProblems())];
      if (problems.length > 0) {
        throw new Error(`The logins aren't ready (a deploy sets them), so nothing was changed:${list(problems)}`);
      }
    }

    const started = Date.now();
    if (mode === "reset" && !(await setGate(directUrl, GATE_MINUTES))) {
      throw new Error("The resetting page didn't go up, so nothing was changed.");
    }
    const cleared = mode === "reset" ? await clearDemoDatabase(ownerDb) : null;
    const [{ held }] = await ownerDb.$queryRaw<Array<{ held: bigint }>>`
      SELECT (SELECT count(*) FROM app.transfer) + (SELECT count(*) FROM demo.stand_in_record) AS held`;
    if (held > 0n) throw new Error("This database already holds demo data. Seed a freshly migrated one, or reset it.");

    const summary = await seed();
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    console.log(JSON.stringify({ mode, ...(cleared ? { clearedTables: cleared.tables } : {}), ...summary, seconds }, null, 2));
    if (mode === "reset" && !(await setGate(directUrl, 0))) {
      console.error(`The demo is reset, but its resetting page is still up until it times out (${GATE_MINUTES} minutes).`);
      process.exitCode = GATE_STILL_UP;
    }
  } finally {
    await ownerDb.$disconnect();
    await ingestDb.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
