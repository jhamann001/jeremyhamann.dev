// Opt-in (TRADE_REQUEST_COPY_TEST_DB=1) roster and reconciliation suite on a scratch local Postgres 16 database,
// trb_roster_tgt, migrated with `prisma migrate deploy` and dropped in teardown. Synthetic @example.test identities only.
import { execFileSync, spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const enabled = process.env.TRADE_REQUEST_COPY_TEST_DB === "1";
const suite = enabled ? describe : describe.skip;
const ROOT = join(import.meta.dirname, "..");
const DB = "trb_roster_tgt";
const URL = `postgresql://aoa@localhost:5432/${DB}?schema=app`;
const OWNER_URL = `postgresql://${userInfo().username}@localhost:5432/${DB}`;
const T1 = "00000000-0000-4000-8000-000000000201";
const T_ADMIN = "00000000-0000-4000-8000-000000000202";
const T_DUP = "00000000-0000-4000-8000-000000000203";
const T_PAIR_A = "00000000-0000-4000-8000-000000000204";
const T_PAIR_B = "00000000-0000-4000-8000-000000000205";
const ADMIN1 = { aoaUserId: "usr_admin1", email: "admin@example.test" };
const ADMIN2 = { aoaUserId: "usr_admin2", email: "admin2@example.test" };
const SEEDED_EMAILS = ["admin@example.test", "admin2@example.test", "ops@example.test", "adv@example.test", "dup@example.test", "t1@example.test"];

type RosterModule = typeof import("@/lib/trade-requests/roster");

function psql(sql: string): string {
  return execFileSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", OWNER_URL, "-c", sql], { encoding: "utf8" }).trim();
}

function run(cmd: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
}

function reseed(): void {
  psql(`TRUNCATE trade_request.roster_changes, trade_request.reconciliation_runs, trade_request.users CASCADE;
    DELETE FROM app."User" WHERE email LIKE '%@example.test';
    INSERT INTO app."User" (id, name, email, role) VALUES
      ('usr_admin1', 'Admin One', 'admin@example.test', 'ADMIN'),
      ('usr_admin2', 'Admin Two', 'admin2@example.test', 'ADMIN'),
      ('usr_ops', NULL, 'ops@example.test', 'OPERATIONS'),
      ('usr_adv', 'Advisor One', 'adv@example.test', 'ADVISOR'),
      ('usr_dup1', 'Dup Viewer', 'Dup@example.test', 'VIEWER'),
      ('usr_dup2', 'Dup Ops', 'dup@example.test', 'OPERATIONS');
    INSERT INTO trade_request.users (id, email, name, role, is_active) VALUES
      ('${T1}', 't1@example.test', 'Trader One', 'trader', true),
      ('${T_ADMIN}', 'admin@example.test', 'Admin One', 'trader', true);`);
}

function cli(): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("npx", ["tsx", "scripts/trade-requests/reconcile-access.ts"], {
    cwd: ROOT,
    env: { ...process.env, DIRECT_DATABASE_URL: URL, TRADE_REQUEST_ACCESS_EXCEPTIONS_FILE: "" },
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const snapshot = () =>
  ["app.\"User\"", "app.\"Account\""].map((t) =>
    psql(`SELECT count(*) || ':' || coalesce(md5(string_agg(to_jsonb(t)::text, '' ORDER BY id)), '') FROM ${t} t`),
  );

suite("Trade Request roster and access reconciliation (scratch database)", () => {
  let roster: RosterModule;

  beforeAll(async () => {
    run("dropdb", ["--if-exists", "--force", DB]);
    run("createdb", ["-O", "aoa", DB]);
    run("npx", ["prisma", "migrate", "deploy"], { DIRECT_DATABASE_URL: URL, DATABASE_URL: URL });
    process.env.DATABASE_URL = URL;
    delete (globalThis as { prisma?: unknown }).prisma;
    vi.resetModules();
    roster = await import("@/lib/trade-requests/roster");
  }, 180_000);

  beforeEach(() => reseed());

  afterAll(async () => {
    const { prisma } = await import("@/lib/db");
    await prisma.$disconnect();
    run("dropdb", ["--if-exists", "--force", DB]);
  }, 60_000);

  it("refuses to add an ADVISOR", async () => {
    await expect(roster.changeRoster(ADMIN1, { action: "add", email: "adv@example.test" })).rejects.toMatchObject({ code: "not_eligible" });
  });

  it("refuses to add a person with no AOA account", async () => {
    await expect(roster.changeRoster(ADMIN1, { action: "add", email: "nobody@example.test" })).rejects.toMatchObject({ code: "not_eligible" });
  });

  it("adds an OPERATIONS person named by email and returns them as a recipient on the next read", async () => {
    const after = await roster.changeRoster(ADMIN1, { action: "add", email: "OPS@example.test" });
    const added = after.find((m) => m.email === "ops@example.test");
    expect(added).toMatchObject({ name: "ops@example.test", aoaRole: "OPERATIONS", eligible: true });
    expect(await roster.eligibleRecipientIds()).toContain(added!.id);
  });

  it("treats two AOA accounts differing only in case as ambiguous and lists that member once, ineligible", async () => {
    await expect(roster.changeRoster(ADMIN1, { action: "add", email: "dup@example.test" })).rejects.toMatchObject({ code: "not_eligible" });
    psql(`INSERT INTO trade_request.users (id, email, name, role, is_active) VALUES ('${T_DUP}', 'dup@example.test', 'Dup', 'trader', true)`);
    const dup = (await roster.readRoster()).filter((m) => m.email === "dup@example.test");
    expect(dup).toEqual([expect.objectContaining({ id: T_DUP, aoaRole: null, eligible: false })]);
  });

  it("treats two active trader identities whose emails differ only in case as ambiguous, never two recipients", async () => {
    psql(`INSERT INTO app."User" (id, name, email, role) VALUES ('usr_pair', 'Pair Admin', 'pair@example.test', 'ADMIN');
      INSERT INTO trade_request.users (id, email, name, role, is_active) VALUES
        ('${T_PAIR_A}', 'Pair@example.test', 'Pair A', 'trader', true),
        ('${T_PAIR_B}', 'pair@example.test', 'Pair B', 'trader', true);`);
    const pair = (await roster.readRoster()).filter((m) => m.email.toLowerCase() === "pair@example.test");
    expect(pair).toHaveLength(2);
    expect(pair.every((m) => m.aoaRole === null && !m.eligible)).toBe(true);
    const recipients = await roster.eligibleRecipientIds();
    expect(recipients).not.toContain(T_PAIR_A);
    expect(recipients).not.toContain(T_PAIR_B);
    expect(recipients).toContain(T_ADMIN);
  });

  it("records the acting ADMIN with each add, slack and remove change", async () => {
    await roster.changeRoster(ADMIN1, { action: "add", email: "ops@example.test" });
    await roster.changeRoster(ADMIN1, { action: "slack", memberId: T1, slackUserId: "U0SYNTH1" });
    await roster.changeRoster(ADMIN1, { action: "remove", memberId: T1 });
    expect(psql(`SELECT string_agg(action || ':' || actor_aoa_user_id, ',' ORDER BY at, action) FROM trade_request.roster_changes`)).toBe(
      "add:usr_admin1,slack:usr_admin1,remove:usr_admin1",
    );
    expect(psql(`SELECT after_state->>'slack_user_id' FROM trade_request.roster_changes WHERE action = 'slack'`)).toBe("U0SYNTH1");
  });

  it("refuses self-removal", async () => {
    await expect(roster.changeRoster(ADMIN1, { action: "remove", memberId: T_ADMIN })).rejects.toMatchObject({ code: "self_removal" });
  });

  it("refuses to remove the last active trader", async () => {
    await roster.changeRoster(ADMIN2, { action: "remove", memberId: T1 });
    await expect(roster.changeRoster(ADMIN2, { action: "remove", memberId: T_ADMIN })).rejects.toMatchObject({ code: "last_trader" });
    expect(psql(`SELECT count(*) FROM trade_request.users WHERE role = 'trader' AND is_active`)).toBe("1");
  });

  it("refuses a malformed member id before any query", async () => {
    await expect(roster.changeRoster(ADMIN1, { action: "remove", memberId: "not-a-uuid" })).rejects.toMatchObject({ code: "invalid_member" });
    expect(psql(`SELECT count(*) FROM trade_request.roster_changes`)).toBe("0");
  });

  it("prints one counts-only line from the CLI and records one ledger row", () => {
    const r = cli();
    expect([0, 1]).toContain(r.status);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const out = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["runId", "verdict", "counts"]);
    const text = `${r.stdout}${r.stderr}`.toLowerCase();
    for (const email of SEEDED_EMAILS) expect(text).not.toContain(email);
    expect(psql(`SELECT count(*) FROM trade_request.reconciliation_runs`)).toBe("1");
    expect(psql(`SELECT counts::text FROM trade_request.reconciliation_runs`)).not.toContain("@");
  }, 60_000);

  it("fails the CLI run when trade_request.users is empty", () => {
    psql(`TRUNCATE trade_request.users CASCADE`);
    const r = cli();
    expect(r.status).toBe(1);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const out = JSON.parse(lines[0]) as { verdict: string; counts: Record<string, number> };
    expect(out.verdict).toBe("failed");
    expect(out.counts).toMatchObject({ standaloneActive: 0, noStandaloneIdentities: 1 });
    expect(psql(`SELECT verdict || ':' || (counts->>'noStandaloneIdentities') FROM trade_request.reconciliation_runs`)).toBe("failed:1");
  }, 60_000);

  it("writes nothing to AOA's own user and account tables across roster changes and a reconciliation run", async () => {
    const before = snapshot();
    await roster.changeRoster(ADMIN2, { action: "add", email: "ops@example.test" });
    await roster.changeRoster(ADMIN2, { action: "slack", memberId: T1, slackUserId: "W0SYNTH2" });
    await roster.changeRoster(ADMIN2, { action: "remove", memberId: T1 });
    expect([0, 1]).toContain(cli().status);
    expect(snapshot()).toEqual(before);
  }, 60_000);
});
