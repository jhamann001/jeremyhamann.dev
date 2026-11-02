// The public demo's data: one fill of a freshly migrated database from the shared synthetic universe, with every
// date relative to `now`. Each part writes one area as production's own writers would and hands what later parts
// link to (tracker records, asset-map runs, trade requests) through `ctx.shared`, in this order:
//   people → tracker → deals → transfers → asset maps → trade requests → activity → planning → operations
// First it records its clock (demo.seed_clock), which the sample data dates itself from. The summary it returns has
// each part's counts and, under `parts`, the seconds each part took.
// Every person, household, account and number is invented (synthetic/README.md).

import type { PrismaClient } from "@prisma/client";
import { createSeedContext } from "./context";
import { seedActivity } from "./activity";
import { seedAssetMaps } from "./asset-maps";
import { seedDeals } from "./deals";
import { seedOperations } from "./operations";
import { seedPeople } from "./people";
import { seedPlanning } from "./planning";
import { seedTracker } from "./tracker";
import { seedTradeRequests } from "./trade-requests";
import { seedTransfers } from "./transfers";
import type { Universe } from "./universe";

export type DemoSeedSummary = Record<string, Record<string, number>>;

const PARTS = [
  ["people", seedPeople],
  ["tracker", seedTracker],
  ["deals", seedDeals],
  ["transfers", seedTransfers],
  ["assetMaps", seedAssetMaps],
  ["tradeRequests", seedTradeRequests],
  ["activity", seedActivity],
  ["planning", seedPlanning],
  ["operations", seedOperations],
] as const;

export async function seedDemo(universe: Universe, owner: PrismaClient, ingest: PrismaClient, now = new Date()): Promise<DemoSeedSummary> {
  const ctx = createSeedContext(universe, owner, ingest, now);
  await owner.$executeRaw`
    INSERT INTO demo.seed_clock (seed_now) VALUES (${ctx.now}) ON CONFLICT (id) DO UPDATE SET seed_now = EXCLUDED.seed_now`;
  const summary: DemoSeedSummary = {};
  const parts: Record<string, number> = {};
  for (const [name, part] of PARTS) {
    const started = performance.now();
    summary[name] = await part(ctx);
    parts[name] = Math.round((performance.now() - started) / 100) / 10;
  }
  return { ...summary, parts };
}
