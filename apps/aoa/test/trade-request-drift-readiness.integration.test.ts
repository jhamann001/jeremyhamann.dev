import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runDriftReadiness } from "@/lib/trade-requests/drift/readiness";

// ticket (WO-AC-9): the readiness comparison on a scratch AOA database. The "standalone" side is the same
// database's live tables (schema trade_request), which ticket's parity test proves column-identical to the
// standalone tables. Opt-in: TRADE_REQUEST_COPY_TEST_DB=1.
const suite = process.env.TRADE_REQUEST_COPY_TEST_DB === "1" ? describe : describe.skip;
const DB = "trb_drift_ready";
const URL = `postgresql://aoa@localhost:5432/${DB}?schema=app`;
const WEEKDAYS = ["2026-05-18", "2026-05-15", "2026-05-14", "2026-05-13", "2026-05-12"];

suite("drift shadow readiness", () => {
  let db: PrismaClient;
  const seed = async (table: string, date: string, account: string, delta = 6.25, startedAt = "2026-05-12T13:15:00Z") => {
    await db.$executeRawUnsafe(
      `INSERT INTO trade_request.${table} (run_date_local, run_started_at, account_id, account_title, household_name, coverage, status, max_bucket_delta_pct, schema_version, snapshot_source, snapshot_as_of, details)
       VALUES ($1::date, $2::timestamptz, $3, 'Sample', 'Sample Household', 'both', 'out', $4, 1, 's3', '2026-05-12T00:00:00Z', '{"tax":{"taxable":true}}'::jsonb)`,
      date, startedAt, account, delta,
    );
  };
  const seedHousehold = async (table: string, date: string) => {
    await db.$executeRawUnsafe(
      `INSERT INTO trade_request.${table} (run_date_local, household_name, account_count, max_delta_pct, breach, coverage_status, schema_version, snapshot_source, details)
       VALUES ($1::date, 'Sample Household', 1, 6.25, true, 'full', 1, 's3', '{}'::jsonb)`,
      date,
    );
  };
  const both = async (date: string) => {
    for (const t of ["position_drift_accounts", "shadow_position_drift_accounts"]) await seed(t, date, "ACCT-1");
    for (const t of ["registry_drift_runs", "shadow_registry_drift_runs"]) await seedHousehold(t, date);
  };
  const run = () => runDriftReadiness({ aoa: db, standalone: db, actor: "test", standaloneSchema: "trade_request" });

  beforeAll(async () => {
    execFileSync("dropdb", ["--if-exists", DB]);
    execFileSync("createdb", ["-O", "aoa", DB]);
    execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DIRECT_DATABASE_URL: URL, DATABASE_URL: URL }, stdio: "ignore" });
    db = new PrismaClient({ datasourceUrl: URL });
  }, 120_000);
  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE trade_request.position_drift_accounts, trade_request.shadow_position_drift_accounts, trade_request.registry_drift_runs,
      trade_request.shadow_registry_drift_runs, trade_request.drift_readiness_runs`);
  });
  afterAll(async () => {
    await db?.$disconnect();
    execFileSync("dropdb", ["--if-exists", DB]);
  });

  it("is ready when the five most recent weekday shadow runs equal the live results, and records counts only", async () => {
    for (const d of WEEKDAYS) await both(d);
    const result = await run();
    expect(result.verdict).toBe("ready");
    expect(result.dates.map((d) => d.date)).toEqual(WEEKDAYS);
    expect(JSON.stringify(result)).not.toContain("ACCT-1");
    const [row] = await db.$queryRawUnsafe<Array<{ verdict: string; n: number }>>(`SELECT verdict, jsonb_array_length(dates) AS n FROM trade_request.drift_readiness_runs`);
    expect(row).toEqual({ verdict: "ready", n: 5 });
  });

  it("is not ready with only four weekday shadow runs", async () => {
    for (const d of WEEKDAYS.slice(0, 4)) await both(d);
    expect((await run()).verdict).toBe("not_ready");
  });

  it("is not ready when one account row differs, and says where", async () => {
    for (const d of WEEKDAYS) await both(d);
    await db.$executeRawUnsafe(`UPDATE trade_request.shadow_position_drift_accounts SET max_bucket_delta_pct = 7 WHERE run_date_local = '2026-05-13'`);
    const result = await run();
    expect(result.verdict).toBe("not_ready");
    expect(result.dates.find((d) => d.date === "2026-05-13")?.account).toEqual({ aoa: 1, standalone: 1, missing: 0, differing: 1, extra: 0 });
  });

  it("ignores weekend shadow runs when choosing the five dates", async () => {
    for (const d of WEEKDAYS) await both(d);
    await seed("shadow_position_drift_accounts", "2026-05-16", "ACCT-1");
    const result = await run();
    expect(result.dates.map((d) => d.date)).toEqual(WEEKDAYS);
    expect(result.verdict).toBe("ready");
  });

  it("is not ready when the standalone service has no results for a shadow date", async () => {
    for (const d of WEEKDAYS.slice(1)) await both(d);
    await seed("shadow_position_drift_accounts", WEEKDAYS[0], "ACCT-1");
    await seedHousehold("shadow_registry_drift_runs", WEEKDAYS[0]);
    const first = (await run()).dates[0];
    expect(first.account).toMatchObject({ standalone: 0, extra: 1 });
  });

  it("compares only the latest run of a date and ignores generated ids and run times", async () => {
    for (const d of WEEKDAYS) await both(d);
    await seed("shadow_position_drift_accounts", "2026-05-12", "ACCT-OLD", 9, "2026-05-12T09:00:00Z");
    await db.$executeRawUnsafe(`UPDATE trade_request.shadow_position_drift_accounts SET run_started_at = run_started_at + interval '1 minute' WHERE account_id = 'ACCT-1'`);
    expect((await run()).verdict).toBe("ready");
  });
});
