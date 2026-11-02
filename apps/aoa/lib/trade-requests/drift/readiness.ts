import { Prisma, type PrismaClient } from "@prisma/client";

// Shadow readiness (ticket, epic AC-42 input): the five most recent weekday AOA shadow runs against the
// standalone service's live drift results for the same dates. "Equal" ignores generated ids and run
// timestamps (epic glossary); each side contributes the rows of its latest run for the date. Counts only.
export const REQUIRED_SHADOW_WEEKDAYS = 5;

export type ReadinessDiff = { aoa: number; standalone: number; missing: number; differing: number; extra: number };
export type ReadinessDate = { date: string; household: ReadinessDiff; account: ReadinessDiff };
export type ReadinessResult = { runId: string; verdict: "ready" | "not_ready"; dates: ReadinessDate[] };

type Tables = { schema: string; households: string; accounts: string };
const AOA_SHADOW: Tables = { schema: "trade_request", households: "shadow_registry_drift_runs", accounts: "shadow_position_drift_accounts" };
const STANDALONE_LIVE = (schema: string): Tables => ({ schema, households: "registry_drift_runs", accounts: "position_drift_accounts" });
const IDENT = /^[a-z_][a-z0-9_]*$/;

async function latestRunHashes(tx: Prisma.TransactionClient, rel: string, key: string, date: string): Promise<Map<string, string>> {
  const rows = await tx.$queryRawUnsafe<Array<{ k: string; h: string }>>(
    `SELECT t.${key}::text AS k, md5((to_jsonb(t) - 'id' - 'run_started_at')::text) AS h
       FROM ${rel} t
      WHERE t.run_date_local = $1::date
        AND t.run_started_at = (SELECT max(run_started_at) FROM ${rel} WHERE run_date_local = $1::date)`,
    date,
  );
  return new Map(rows.map((r) => [r.k, r.h]));
}

async function readSide(db: PrismaClient, tables: Tables, date: string) {
  if (![tables.schema, tables.households, tables.accounts].every((n) => IDENT.test(n))) throw new Error("invalid identifier");
  return db.$transaction(
    async (tx) => {
      // Timestamps render in UTC on both sides so equal rows hash equally.
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'UTC'`);
      return {
        households: await latestRunHashes(tx, `${tables.schema}.${tables.households}`, "household_name", date),
        accounts: await latestRunHashes(tx, `${tables.schema}.${tables.accounts}`, "account_id", date),
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000 },
  );
}

export function compareHashes(aoa: Map<string, string>, standalone: Map<string, string>): ReadinessDiff {
  let missing = 0;
  let differing = 0;
  let extra = 0;
  for (const [k, h] of standalone) {
    const mine = aoa.get(k);
    if (mine === undefined) missing++;
    else if (mine !== h) differing++;
  }
  for (const k of aoa.keys()) if (!standalone.has(k)) extra++;
  return { aoa: aoa.size, standalone: standalone.size, missing, differing, extra };
}

const clean = (d: ReadinessDiff) => d.missing + d.differing + d.extra === 0;

export function readinessVerdict(dates: readonly ReadinessDate[]): "ready" | "not_ready" {
  const ok =
    dates.length === REQUIRED_SHADOW_WEEKDAYS &&
    dates.every((d) => clean(d.household) && clean(d.account) && d.household.standalone + d.account.standalone > 0);
  return ok ? "ready" : "not_ready";
}

export async function runDriftReadiness(opts: {
  aoa: PrismaClient;
  standalone: PrismaClient;
  actor: string;
  /** The standalone database keeps its tables in `public`; tests may point at another schema. */
  standaloneSchema?: string;
}): Promise<ReadinessResult> {
  const rows = await opts.aoa.$queryRaw<Array<{ d: string }>>`
    SELECT d FROM (
      SELECT to_char(run_date_local, 'YYYY-MM-DD') AS d FROM trade_request.shadow_position_drift_accounts
      UNION
      SELECT to_char(run_date_local, 'YYYY-MM-DD') AS d FROM trade_request.shadow_registry_drift_runs
    ) s
    WHERE extract(isodow FROM d::date) < 6
    ORDER BY d DESC
    LIMIT ${REQUIRED_SHADOW_WEEKDAYS}`;
  const standaloneTables = STANDALONE_LIVE(opts.standaloneSchema ?? "public");
  const dates: ReadinessDate[] = [];
  for (const { d } of rows) {
    const mine = await readSide(opts.aoa, AOA_SHADOW, d);
    const theirs = await readSide(opts.standalone, standaloneTables, d);
    dates.push({ date: d, household: compareHashes(mine.households, theirs.households), account: compareHashes(mine.accounts, theirs.accounts) });
  }
  const verdict = readinessVerdict(dates);
  const [run] = await opts.aoa.$queryRaw<Array<{ id: string }>>`
    INSERT INTO trade_request.drift_readiness_runs (actor, verdict, dates)
    VALUES (${opts.actor}, ${verdict}, ${JSON.stringify(dates)}::jsonb)
    RETURNING id::text AS id`;
  return { runId: run.id, verdict, dates };
}
