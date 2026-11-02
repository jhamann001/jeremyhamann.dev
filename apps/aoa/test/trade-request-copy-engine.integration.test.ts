import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RECORD_KINDS } from "@/lib/trade-requests/records/catalog";
import { runCopy, type CopyMode, type KindResult } from "@/lib/trade-requests/records/copy-engine";
import {
  SRC_DB,
  SRC_URL,
  TGT_DB,
  TGT_URL,
  clients,
  createDatabases,
  dropDatabases,
  enabled,
  psql,
  resetDatabases,
  tableDigests,
} from "./trade-request-copy-db";

const suite = enabled ? describe : describe.skip;
const ROOT = join(import.meta.dirname, "..");
const USER_1 = "00000000-0000-4000-8000-000000000001";
const FIXTURE_COUNTS: Record<string, number> = {
  users: 2,
  clients: 2,
  accounts: 2,
  trade_requests: 3,
  audit_logs: 3,
  notifications: 2,
  client_exclusions: 2,
  account_exclusions: 1,
  digest_runs: 1,
  registry_drift_runs: 1,
  position_drift_accounts: 2,
  drift_alert_sends: 1,
  drift_status_overrides: 1,
};
type Ledger = { mode: string; verdict: string | null; error: string | null; kinds: KindResult[] };

suite("Trade Request copy engine (scratch databases)", () => {
  let source: PrismaClient;
  let target: PrismaClient;

  const copy = (mode: CopyMode, hooks?: Parameters<typeof runCopy>[0]["hooks"]) => runCopy({ source, target, mode, actor: "vitest", hooks });
  const ledger = (): Ledger[] =>
    JSON.parse(
      psql(TGT_DB, `SELECT coalesce(json_agg(json_build_object('mode', mode, 'verdict', verdict, 'error', error, 'kinds', kinds) ORDER BY started_at), '[]') FROM trade_request.copy_runs`),
    ) as Ledger[];
  const lastRun = () => ledger().at(-1)!;
  const setState = (sql: string) => psql(TGT_DB, `UPDATE trade_request.serving_state SET ${sql}`);
  /** Stands in for the cutover controller (ticket): a cutover to AOA, then a rollback to standalone. */
  const seedCutoverAndRollback = () =>
    psql(
      TGT_DB,
      `INSERT INTO trade_request.serving_state_transitions (at, actor, from_state, to_state, reason) VALUES
         (clock_timestamp(), 'vitest', '{"serving_source":"standalone"}', '{"serving_source":"aoa"}', 'synthetic cutover'),
         (clock_timestamp(), 'vitest', '{"serving_source":"aoa"}', '{"serving_source":"standalone"}', 'synthetic rollback')`,
    );
  const kind = (kinds: KindResult[], table: string) => kinds.find((k) => k.table === table)!;
  const clean = (kinds: KindResult[]) => kinds.every((k) => k.missing + k.differing + k.extra === 0);
  const appDigest = () =>
    psql(
      TGT_DB,
      `SELECT (SELECT count(*) || ':' || md5(coalesce(string_agg(to_jsonb(u)::text, ',' ORDER BY u.id), '')) FROM app."User" u)
        || '/' || (SELECT count(*) || ':' || md5(coalesce(string_agg(to_jsonb(a)::text, ',' ORDER BY a.id), '')) FROM app."Account" a)`,
    );

  beforeAll(async () => {
    await createDatabases();
    ({ source, target } = clients());
  }, 300_000);

  beforeEach(() => resetDatabases());

  afterAll(async () => {
    await source?.$disconnect();
    await target?.$disconnect();
    dropDatabases();
  }, 120_000);

  it("1: refuses full, change and copy_back while serving_source is aoa", async () => {
    setState("serving_source = 'aoa'");
    for (const mode of ["full", "change", "copy_back"] as const) {
      await expect(copy(mode)).rejects.toThrow(/requires serving_source/);
      const run = lastRun();
      expect(run.mode).toBe(mode);
      expect(run.verdict).toBe("refused");
      expect(run.error).toMatch(/requires serving_source/);
    }
    for (const count of Object.values(tableDigests(TGT_DB, "trade_request"))) expect(count.startsWith("0:")).toBe(true);
  });

  it("1b: refuses forward copies while a sender is aoa, but copy_back and report still run", async () => {
    expect((await copy("full")).verdict).toBe("passed");
    seedCutoverAndRollback();
    setState("drift_sender = 'aoa'");
    for (const mode of ["full", "change"] as const) {
      await expect(copy(mode)).rejects.toThrow("requires serving_source, digest_sender and drift_sender=standalone");
      expect(lastRun().verdict).toBe("refused");
    }
    expect((await copy("copy_back")).verdict).toBe("passed");
    expect((await copy("report")).verdict).toBe("report_only");
  });

  it("1c: refuses copy_back when no forward copy has passed into this database", async () => {
    const before = tableDigests(SRC_DB, "public");
    await expect(copy("copy_back")).rejects.toThrow("requires a passed full or change copy");
    expect(lastRun().verdict).toBe("refused");
    const after = tableDigests(SRC_DB, "public");
    for (const t of Object.keys(before)) expect(after[t].split(":")[0]).toBe(before[t].split(":")[0]);
  });

  it("1d: refused and failed forward runs never block the rollback copy_back", async () => {
    expect((await copy("full")).verdict).toBe("passed");
    expect((await copy("change")).verdict).toBe("passed");
    psql(SRC_DB, `INSERT INTO notifications (id, user_id, body) VALUES ('00000000-0000-4000-8000-0000000001d1', '${USER_1}', 'Synthetic extra')`);
    psql(
      TGT_DB,
      `CREATE FUNCTION trade_request.trb_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic' USING ERRCODE = 'P0001'; END $$;
       CREATE TRIGGER trb_fail BEFORE INSERT ON trade_request.notifications FOR EACH ROW EXECUTE FUNCTION trade_request.trb_fail();`,
    );
    try {
      await expect(copy("change")).rejects.toBeDefined();
    } finally {
      psql(TGT_DB, "DROP TRIGGER trb_fail ON trade_request.notifications; DROP FUNCTION trade_request.trb_fail();");
    }
    expect(lastRun()).toMatchObject({ verdict: "failed", error: "failed:P2010" });
    seedCutoverAndRollback();
    setState("drift_sender = 'aoa'");
    await expect(copy("change")).rejects.toThrow(/requires/);
    await expect(copy("full")).rejects.toThrow(/requires/);
    expect((await copy("copy_back")).verdict).toBe("passed");
    expect(ledger().map((r) => r.verdict)).toEqual(["passed", "passed", "failed", "refused", "refused", "passed"]);
  });

  it("1e: refuses copy_back before any cutover, so a stale AOA copy never overwrites the live standalone records", async () => {
    expect((await copy("full")).verdict).toBe("passed");
    psql(SRC_DB, "INSERT INTO trade_requests (id, client_id, trade_type) VALUES ('REQ-LIVE001', 'CLI-SYN-001', 'Rebalance')");
    const before = tableDigests(SRC_DB, "public");
    await expect(copy("copy_back")).rejects.toThrow("copy_back copy requires a serving-state transition after the last full or change copy");
    expect(lastRun()).toMatchObject({ mode: "copy_back", verdict: "refused" });
    expect(tableDigests(SRC_DB, "public")).toEqual(before);
    expect(psql(SRC_DB, "SELECT count(*) FROM trade_requests WHERE id = 'REQ-LIVE001'")).toBe("1");
  });

  it("1f: refuses forward copies after a rollback until copy_back has passed, so AOA-native records are never overwritten", async () => {
    expect((await copy("full")).verdict).toBe("passed");
    seedCutoverAndRollback();
    psql(TGT_DB, "INSERT INTO trade_request.trade_requests (id, client_id, trade_type) VALUES ('REQ-Eqzgiq3oD2914', 'CLI-SYN-001', 'Rebalance')");
    const before = tableDigests(TGT_DB, "trade_request");
    for (const mode of ["full", "change"] as const) {
      await expect(copy(mode)).rejects.toThrow(`${mode} copy requires a passed copy_back after the last serving-state transition`);
      expect(lastRun()).toMatchObject({ mode, verdict: "refused" });
    }
    expect(tableDigests(TGT_DB, "trade_request")).toEqual(before);
    expect((await copy("copy_back")).verdict).toBe("passed");
    expect(psql(SRC_DB, "SELECT count(*) FROM trade_requests WHERE id = 'REQ-Eqzgiq3oD2914'")).toBe("1");
    expect((await copy("full")).verdict).toBe("passed");
  });

  it("1g: only a transition that changes servingSource refuses a forward copy; malformed rows still refuse", async () => {
    const transition = (from: object, to: object) =>
      psql(
        TGT_DB,
        `INSERT INTO trade_request.serving_state_transitions (at, actor, from_state, to_state, reason)
           VALUES (clock_timestamp(), 'vitest', '${JSON.stringify(from)}', '${JSON.stringify(to)}', 'synthetic')`,
      );
    const record = (servingSource: string, digestSender: string, driftSender: string) => ({ servingSource, digestSender, driftSender });
    expect((await copy("full")).verdict).toBe("passed");
    seedCutoverAndRollback();
    expect((await copy("copy_back")).verdict).toBe("passed");
    // A sender return after the passed copy-back (ticket rollback) admits forward copies.
    transition(record("standalone", "aoa", "standalone"), record("standalone", "standalone", "standalone"));
    transition(record("standalone", "standalone", "aoa"), record("standalone", "standalone", "standalone"));
    for (const mode of ["full", "change"] as const) expect((await copy(mode)).verdict).toBe("passed");
    // A change of the serving source refuses.
    transition(record("standalone", "standalone", "standalone"), record("aoa", "standalone", "standalone"));
    await expect(copy("change")).rejects.toThrow("change copy requires a passed copy_back after the last serving-state transition");
    transition(record("aoa", "standalone", "standalone"), record("standalone", "standalone", "standalone"));
    expect((await copy("copy_back")).verdict).toBe("passed");
    expect((await copy("change")).verdict).toBe("passed");
    // snake_case keys, or servingSource on one side only, fail closed even with equal values.
    transition({ serving_source: "standalone" }, { serving_source: "standalone" });
    await expect(copy("full")).rejects.toThrow("full copy requires a passed copy_back after the last serving-state transition");
    expect((await copy("copy_back")).verdict).toBe("passed");
    transition(record("standalone", "aoa", "standalone"), { digestSender: "standalone" });
    await expect(copy("change")).rejects.toThrow("change copy requires a passed copy_back after the last serving-state transition");
  });

  it("2: full copy replaces stale copied rows and keeps a non-catalog table", async () => {
    psql(
      TGT_DB,
      `INSERT INTO trade_request.trade_requests (id, client_id, trade_type) VALUES ('REQ-STALE01', 'CLI-STALE', 'Rebalance');
       CREATE TABLE trade_request.shadow_probe (id int PRIMARY KEY); INSERT INTO trade_request.shadow_probe VALUES (1);`,
    );
    expect((await copy("full")).verdict).toBe("passed");
    expect(psql(TGT_DB, "SELECT count(*) FROM trade_request.trade_requests WHERE id = 'REQ-STALE01'")).toBe("0");
    expect(psql(TGT_DB, "SELECT count(*) FROM trade_request.shadow_probe")).toBe("1");
  });

  it("3: full copy brings every kind across with identical content", async () => {
    const sectors = Number(psql(SRC_DB, "SELECT count(*) FROM security_sector"));
    expect(Object.keys(FIXTURE_COUNTS).sort()).toEqual(RECORD_KINDS.map((k) => k.table).filter((t) => t !== "security_sector").sort());
    const result = await copy("full");
    expect(result.verdict).toBe("passed");
    expect(result.kinds).toHaveLength(14);
    for (const k of result.kinds) {
      expect({ table: k.table, missing: k.missing, differing: k.differing, extra: k.extra }).toEqual({ table: k.table, missing: 0, differing: 0, extra: 0 });
      const expected = k.table === "security_sector" ? sectors : FIXTURE_COUNTS[k.table];
      expect(expected).toBeGreaterThanOrEqual(1);
      expect(k.toCount).toBe(expected);
    }
    expect(lastRun().verdict).toBe("passed");
  });

  it("3b: full and change copies read rows in pages and still bring every row across", async () => {
    const full = await copy("full", { readPage: 1 });
    expect(full.verdict).toBe("passed");
    expect(clean(full.kinds)).toBe(true);
    for (const k of full.kinds) expect(k.toCount).toBe(k.fromCount);
    psql(SRC_DB, "UPDATE trade_requests SET priority = 'Low' WHERE id = 'REQ-SYN0002'");
    const change = await copy("change", { readPage: 1 });
    expect(change.verdict).toBe("passed");
    expect(kind(change.kinds, "trade_requests")).toMatchObject({ missing: 0, differing: 0, extra: 0 });
  });

  it("4: report records counts and changes nothing on either side", async () => {
    const srcBefore = tableDigests(SRC_DB, "public");
    const tgtBefore = tableDigests(TGT_DB, "trade_request");
    const result = await copy("report");
    expect(result.verdict).toBe("report_only");
    const run = lastRun();
    expect(run.verdict).toBe("report_only");
    expect(kind(run.kinds, "trade_requests")).toMatchObject({ fromCount: 3, toCount: 0, missing: 3 });
    expect(tableDigests(SRC_DB, "public")).toEqual(srcBefore);
    expect(tableDigests(TGT_DB, "trade_request")).toEqual(tgtBefore);
  });

  it("5: change copy brings additions, changes, removals and a re-added exclusion tuple", async () => {
    await copy("full");
    psql(
      SRC_DB,
      `INSERT INTO trade_requests (id, client_id, trade_type) VALUES ('REQ-SYN0004', 'CLI-SYN-002', 'Liquidate');
       UPDATE notifications SET read_at = '2026-10-06 10:00:00+00' WHERE id = '00000000-0000-4000-8000-0000000000d1';
       DELETE FROM trade_requests WHERE id = 'REQ-SYN0003';
       DELETE FROM client_exclusions WHERE id = '00000000-0000-4000-8000-0000000000e1';
       INSERT INTO client_exclusions (id, client_id, ticker, kind, reason, created_by_name) VALUES ('00000000-0000-4000-8000-0000000000e9', 'CLI-SYN-001', 'XOM', 'client', 'Re-added', 'Advisor Two');`,
    );
    const result = await copy("change");
    expect(result.verdict).toBe("passed");
    expect(psql(TGT_DB, "SELECT string_agg(id, ',' ORDER BY id) FROM trade_request.trade_requests")).toBe("REQ-SYN0001,REQ-SYN0002,REQ-SYN0004");
    expect(psql(TGT_DB, "SELECT id FROM trade_request.client_exclusions WHERE client_id = 'CLI-SYN-001' AND ticker = 'XOM'")).toBe("00000000-0000-4000-8000-0000000000e9");
    expect(tableDigests(TGT_DB, "trade_request")).toEqual(tableDigests(SRC_DB, "public"));
  });

  it("6: report finds a changed target row and a change copy repairs it", async () => {
    await copy("full");
    psql(TGT_DB, "UPDATE trade_request.trade_requests SET priority = 'Low' WHERE id = 'REQ-SYN0002'");
    const report = await copy("report");
    for (const k of report.kinds) expect(k.differing).toBe(k.table === "trade_requests" ? 1 : 0);
    expect((await copy("change")).verdict).toBe("passed");
    expect(psql(TGT_DB, "SELECT priority FROM trade_request.trade_requests WHERE id = 'REQ-SYN0002'")).toBe("Urgent");
  });

  it("7: a row lost before insert blocks the change copy", async () => {
    await copy("full");
    psql(SRC_DB, "INSERT INTO trade_requests (id, client_id, trade_type) VALUES ('REQ-BLOCK001', 'CLI-SYN-001', 'Rebalance')");
    const result = await copy("change", {
      beforeInsert: (table, rows) => (table === "trade_requests" ? rows.filter((r) => (JSON.parse(r) as { id: string }).id !== "REQ-BLOCK001") : rows),
    });
    expect(result.verdict).toBe("blocked");
    const run = lastRun();
    expect(run.verdict).toBe("blocked");
    for (const k of run.kinds) {
      expect({ table: k.table, missing: k.missing, differing: k.differing, extra: k.extra }).toEqual({
        table: k.table,
        missing: k.table === "trade_requests" ? 1 : 0,
        differing: 0,
        extra: 0,
      });
    }
  });

  it("8: a copy-back mismatch is recorded per kind", async () => {
    await copy("full");
    seedCutoverAndRollback();
    psql(TGT_DB, `INSERT INTO trade_request.audit_logs (id, request_id, user_name, action, user_id, channel) VALUES ('00000000-0000-4000-8000-0000000000b8', 'REQ-SYN0001', 'Trader One', 'Noted', '${USER_1}', 'aoa')`);
    const result = await copy("copy_back", { beforeInsert: (table, rows) => (table === "audit_logs" ? rows.slice(1) : rows) });
    expect(result.verdict).toBe("blocked");
    const run = lastRun();
    expect(run).toMatchObject({ mode: "copy_back", verdict: "blocked" });
    expect(kind(run.kinds, "audit_logs").missing).toBe(1);
  });

  it("9: copy-back writes AOA-created records and keeps the audit actor and channel", async () => {
    await copy("full");
    seedCutoverAndRollback();
    psql(
      TGT_DB,
      `INSERT INTO trade_request.trade_requests (id, client_id, advisor_id, trade_type) VALUES ('REQ-Xucjmj7nS3761', 'CLI-SYN-001', '${USER_1}', 'Rebalance');
       INSERT INTO trade_request.audit_logs (id, request_id, user_name, action, user_id, channel) VALUES ('00000000-0000-4000-8000-0000000000b9', 'REQ-Xucjmj7nS3761', 'Trader One', 'Created', '${USER_1}', 'aoa');
       DELETE FROM trade_request.client_exclusions WHERE id = '00000000-0000-4000-8000-0000000000e1';
       INSERT INTO trade_request.client_exclusions (id, client_id, ticker, kind, reason, created_by_name) VALUES ('00000000-0000-4000-8000-0000000000ea', 'CLI-SYN-001', 'XOM', 'client', 'Re-added in AOA', 'Trader One');`,
    );
    expect((await copy("copy_back")).verdict).toBe("passed");
    expect(psql(SRC_DB, "SELECT user_id || '|' || user_name || '|' || channel FROM audit_logs WHERE id = '00000000-0000-4000-8000-0000000000b9'")).toBe(
      `${USER_1}|Trader One|aoa`,
    );
    expect(psql(SRC_DB, "SELECT count(*) FROM trade_requests WHERE id = 'REQ-Xucjmj7nS3761'")).toBe("1");
    expect(psql(SRC_DB, "SELECT id FROM client_exclusions WHERE client_id = 'CLI-SYN-001' AND ticker = 'XOM'")).toBe("00000000-0000-4000-8000-0000000000ea");
  });

  it("10: copy-back keeps the standalone sign-in columns but copies theme_preference", async () => {
    await copy("full");
    seedCutoverAndRollback();
    psql(TGT_DB, `UPDATE trade_request.users SET last_login = '2020-01-01 00:00:00+00', theme_preference = 'light' WHERE id = '${USER_1}'`);
    expect((await copy("copy_back")).verdict).toBe("passed");
    expect(psql(SRC_DB, `SET TIME ZONE 'UTC'; SELECT last_login || '|' || theme_preference FROM users WHERE id = '${USER_1}'`)).toBe("2026-10-01 14:00:00+00|light");
  });

  it("11: copy-back never deletes a standalone user absent from AOA", async () => {
    await copy("full");
    seedCutoverAndRollback();
    psql(SRC_DB, "INSERT INTO users (id, email, name) VALUES ('00000000-0000-4000-8000-000000000003', 'new.signin@example.com', 'New Signin')");
    expect((await copy("copy_back")).verdict).toBe("passed");
    expect(psql(SRC_DB, "SELECT count(*) FROM users WHERE id = '00000000-0000-4000-8000-000000000003'")).toBe("1");
  });

  it("12: never writes AOA's own users or accounts", async () => {
    const before = appDigest();
    expect((await copy("full")).verdict).toBe("passed");
    expect((await copy("change")).verdict).toBe("passed");
    seedCutoverAndRollback();
    expect((await copy("copy_back")).verdict).toBe("passed");
    expect(appDigest()).toBe(before);
  });

  it("13: the MCP login reads only what MCP needs and maps roles", async () => {
    const password = randomBytes(18).toString("hex");
    psql("postgres", `ALTER ROLE trade_request_mcp_ro PASSWORD '${password}'`);
    psql(
      TGT_DB,
      `INSERT INTO app."User" (id, email, role) VALUES
         ('trb-mcp-admin', 'MCP.Admin@Example.com ', 'ADMIN'),
         ('trb-mcp-advisor', 'mcp.advisor@example.com', 'ADVISOR'),
         ('trb-mcp-viewer', 'mcp.viewer@example.com', 'VIEWER')`,
    );
    const mcp = new PrismaClient({ datasourceUrl: `postgresql://trade_request_mcp_ro:${password}@localhost:5432/${TGT_DB}` });
    try {
      await expect(mcp.$executeRawUnsafe("INSERT INTO trade_request.trade_requests (id, client_id, trade_type) VALUES ('REQ-MCP0001', 'C', 'Rebalance')")).rejects.toThrow(
        /permission denied/,
      );
      await expect(mcp.$executeRawUnsafe("UPDATE trade_request.trade_requests SET priority = 'Low'")).rejects.toThrow(/permission denied/);
      await expect(mcp.$executeRawUnsafe("DELETE FROM trade_request.trade_requests")).rejects.toThrow(/permission denied/);
      await expect(mcp.$queryRawUnsafe("SELECT count(*) FROM trade_request.notifications")).rejects.toThrow(/permission denied/);
      await expect(mcp.$queryRawUnsafe("SELECT count(*)::int AS n FROM trade_request.client_exclusions")).resolves.toEqual([{ n: 0 }]);
      await expect(mcp.$queryRawUnsafe("SELECT count(*)::int AS n FROM trade_request.account_exclusions")).resolves.toEqual([{ n: 0 }]);
      const access = await mcp.$queryRawUnsafe<Array<{ email: string; has_access: boolean; trader_role: boolean }>>(
        "SELECT email, has_access, trader_role FROM trade_request.mcp_access WHERE email LIKE 'mcp.%' ORDER BY email",
      );
      expect(access).toEqual([
        { email: "mcp.admin@example.com", has_access: true, trader_role: true },
        { email: "mcp.advisor@example.com", has_access: true, trader_role: false },
        { email: "mcp.viewer@example.com", has_access: false, trader_role: false },
      ]);
    } finally {
      await mcp.$disconnect();
      psql(TGT_DB, `DELETE FROM app."User" WHERE id LIKE 'trb-mcp-%'`);
    }
  });

  it("14: refuses writes while a non-catalog table holds a foreign key to a catalog table", async () => {
    await copy("full");
    psql(SRC_DB, "UPDATE trade_requests SET priority = 'Low' WHERE id = 'REQ-SYN0002'");
    psql(TGT_DB, "CREATE TABLE trade_request.fk_probe (user_id uuid REFERENCES trade_request.users(id))");
    const before = tableDigests(TGT_DB, "trade_request");
    for (const mode of ["full", "change"] as const) {
      await expect(copy(mode)).rejects.toThrow("non-catalog foreign key");
      expect(lastRun().verdict).toBe("refused");
    }
    expect(tableDigests(TGT_DB, "trade_request")).toEqual(before);
  });

  it("14b: a write failure inside the transaction writes nothing and records only an error code", async () => {
    await copy("full");
    psql(SRC_DB, `INSERT INTO notifications (id, user_id, body) VALUES ('00000000-0000-4000-8000-0000000001d2', '${USER_1}', 'Synthetic secret body')`);
    psql(SRC_DB, "UPDATE trade_requests SET priority = 'Low' WHERE id = 'REQ-SYN0002'");
    psql(
      TGT_DB,
      `CREATE FUNCTION trade_request.trb_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic' USING ERRCODE = 'P0001'; END $$;
       CREATE TRIGGER trb_fail BEFORE INSERT ON trade_request.notifications FOR EACH ROW EXECUTE FUNCTION trade_request.trb_fail();`,
    );
    try {
      const before = tableDigests(TGT_DB, "trade_request");
      await expect(copy("change")).rejects.toBeDefined();
      expect(tableDigests(TGT_DB, "trade_request")).toEqual(before);
      const run = lastRun();
      expect(run).toMatchObject({ mode: "change", verdict: "failed", error: "failed:P2010", kinds: [] });
      const cli = (() => {
        try {
          execFileSync("npx", ["tsx", "scripts/trade-requests/copy.ts", "--mode=change"], {
            cwd: ROOT,
            env: { ...process.env, TRADE_REQUEST_SOURCE_DATABASE_URL: SRC_URL, DIRECT_DATABASE_URL: TGT_URL },
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf8",
          });
          return { status: 0, stdout: "", stderr: "" };
        } catch (err) {
          const e = err as { status: number; stdout: string; stderr: string };
          return { status: e.status, stdout: e.stdout, stderr: e.stderr };
        }
      })();
      expect(cli).toEqual({ status: 1, stdout: "", stderr: "copy failed: P2010\n" });
      expect(tableDigests(TGT_DB, "trade_request")).toEqual(before);
    } finally {
      psql(TGT_DB, "DROP TRIGGER trb_fail ON trade_request.notifications; DROP FUNCTION trade_request.trb_fail();");
    }
  }, 60_000);

  it("15: copies JSON numbers without precision loss", async () => {
    expect((await copy("full")).verdict).toBe("passed");
    const sql = "SELECT execution_plan::text FROM %s WHERE id = 'REQ-SYN0001'";
    const fromSource = psql(SRC_DB, sql.replace("%s", "trade_requests"));
    expect(fromSource).toContain("12345678901234567890");
    expect(psql(TGT_DB, sql.replace("%s", "trade_request.trade_requests"))).toBe(fromSource);
  });

  it("16: verifies identically when the target database's time zone differs", async () => {
    psql("postgres", `ALTER DATABASE ${TGT_DB} SET timezone = 'America/New_York'`);
    await target.$disconnect();
    await source.$disconnect();
    ({ source, target } = clients());
    try {
      const result = await copy("full");
      expect(result.verdict).toBe("passed");
      expect(clean(result.kinds)).toBe(true);
    } finally {
      psql("postgres", `ALTER DATABASE ${TGT_DB} RESET timezone`);
    }
  });
});
