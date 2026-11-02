import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { CLIENT_SERVICE_EMAIL } from "./trade-requests-workspace-fixture";
import { byName } from "./trade-requests-new-synthetic";

// Synthetic requests for the submission, Edit & Resubmit and Clone browser
// check, written through the local Trade Request service's delegated API.
// Loopback only; every value is invented. Each run removes the previous run's
// rows (marked in the advisor notes) so duplicate suppression never returns
// an earlier run's request.

export const TRW15_DATABASE = "aoa_trw15_synthetic";
export const TRW15_PORTS = { on: 3231, off: 3232, service: 8231, warehouse: 9231 } as const;
export const SUBMIT_MARKER = "TRW-15 synthetic";
export const SUBMIT_SEED_FILE = join(tmpdir(), "trw15-submit-seed.json");
const CALLER = "aoa-local@delegated.invalid";

type Actor = { email: string; name: string; role: "ADMIN" | "OPERATIONS" | "ADVISOR" };
const AVERY: Actor = { email: "avery@example.com", name: "Avery Stone", role: "ADVISOR" };
const BLAKE: Actor = { email: "blake@example.com", name: "Bryon Walker", role: "ADVISOR" };
const RILEY: Actor = { email: "ops@example.com", name: "Riley Ops", role: "OPERATIONS" };

export type SubmitSeed = { editId: string; staleId: string; otherId: string; rejectedId: string; pendingId: string; mobileId: string; run: string };

function loopback(raw: string | undefined, user: string): URL {
  if (!raw) throw new Error("trade_requests_submit_browser_database_url_required");
  const url = new URL(raw);
  if (
    !["postgresql:", "postgres:"].includes(url.protocol)
    || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || !url.port
    || url.pathname !== `/${TRW15_DATABASE}`
    || url.username !== user
    || ["host", "hostaddr", "service", "servicefile"].some((key) => url.searchParams.has(key))
    || process.env.K_SERVICE
    || process.env.CLOUD_RUN_SERVICE
    || process.env.APP_ENV === "prod"
  ) throw new Error("trade_requests_submit_browser_requires_isolated_loopback_database");
  return url;
}

export function validateSubmitBrowserDatabase(): URL {
  const owner = loopback(process.env.DIRECT_DATABASE_URL, "aoa");
  const runtime = loopback(process.env.DATABASE_URL, "app_rw");
  if (owner.host !== runtime.host) throw new Error("trade_requests_submit_browser_database_target_mismatch");
  return owner;
}

export function serviceSql(sql: string): string {
  const db = process.env.TRW15_SERVICE_DB ?? "";
  if (!/^trw_local_[a-z0-9_]+$/.test(db)) throw new Error("trade_requests_submit_browser_requires_local_service_database");
  return execFileSync("psql", ["-h", "/tmp", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-At", "-c", sql], { stdio: "pipe" }).toString().trim();
}

const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** One row of the service's trade_requests table, by its advisor-notes marker. */
export function requestRow(notes: string): { id: string; status: string; tradeAmount: string; depositAccount: string; householdId: string; householdName: string } | null {
  const line = serviceSql(
    `SELECT id, status, coalesce(trade_amount, ''), coalesce(deposit_account, ''), coalesce(household_id::text, ''), coalesce(household_name, '')
     FROM trade_requests WHERE advisor_notes = ${lit(notes)} ORDER BY created_at DESC LIMIT 1`,
  );
  if (!line) return null;
  const [id, status, tradeAmount, depositAccount, householdId, householdName] = line.split("|");
  return { id, status, tradeAmount, depositAccount, householdId, householdName };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function sign(claims: Record<string, unknown>, key: string): string {
  const input = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`;
  return `${input}.${createHmac("sha256", key).update(input).digest("base64url")}`;
}

async function call<T>(actor: Actor, method: string, path: string, body?: unknown): Promise<T> {
  const audience = `http://127.0.0.1:${TRW15_PORTS.service}/api/aoa`;
  const key = process.env.TRW15_LOCAL_KEY;
  if (!key) throw new Error("trw15_local_key_required");
  const iat = Math.floor(Date.now() / 1000);
  const bearer = sign({ iss: CALLER, email: CALLER, aud: audience, iat, exp: iat + 120 }, key);
  const assertion = sign({ iss: CALLER, sub: actor.email, aud: audience, iat, exp: iat + 120, jti: randomUUID(), aoa_role: actor.role, name: actor.name }, key);
  const response = await fetch(`${audience}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`, "x-aoa-actor-assertion": assertion, accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`trw15_seed_${method}_${path}_${response.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

type Row = { id: string; status: string; updatedAt: string };

/** A change made elsewhere (by Riley Ops through the API): the request keeps its status but gets a new version. */
export async function changeStatusElsewhere(id: string, status: string): Promise<void> {
  const current = (await call<{ data: Row }>(RILEY, "GET", `/requests/${encodeURIComponent(id)}`)).data;
  await call(RILEY, "PUT", `/requests/${encodeURIComponent(id)}/status`, { status, note: `${SUBMIT_MARKER} elsewhere`, expectedUpdatedAt: current.updatedAt });
}

const ALEX = byName("Maeve Brennan (synthetic)");
const BLAIR = byName("Lucille Howell (synthetic)");
const MORGAN = byName("Esta Barrows (synthetic)");
const ABDULLAH = byName("Abdullah Beatty (synthetic)");
const ESG_NONE = { fossilFuels: false, tobacco: false, weapons: false, alcohol: false, gambling: false, other: false, otherDescription: "", none: true };

async function create(actor: Actor, body: Record<string, unknown>): Promise<Row> {
  return (await call<{ data: Row }>(actor, "POST", "/requests", { idempotencyKey: randomUUID(), ...body })).data;
}

function raiseCash(client: typeof ALEX, accounts: string[], label: string, run: string) {
  return {
    clientId: client.id, clientName: client.name, tradeType: "Raise Cash", tradeAmount: `$${label.length}${run.slice(0, 4)}`,
    selectedAccounts: accounts, priority: "Standard", raiseCashReason: `Synthetic ${label}`, advisorNotes: `${SUBMIT_MARKER} ${label} ${run}`,
  };
}

export async function seedSubmitRequests(): Promise<SubmitSeed> {
  const run = String(Date.now()).slice(-6);
  const edit = await create(AVERY, {
    clientId: ALEX.id, clientName: ALEX.name, tradeType: "Rebalance", selectedAccounts: [ALEX.accounts[0].number], priority: "Urgent",
    residence: "NY", liquidationApproval: "Yes", riskProfile: 12, esgFilters: { ...ESG_NONE, none: false, fossilFuels: true },
    equityStrategies: [{ id: 1, benchmark: "SPY", allocation: 100, rationale: "Synthetic recorded rationale" }],
    advisorExclusions: "NVDA (DNB - recorded on request)", clientExclusions: "META (DNS - recorded on request)",
    advisorNotes: `${SUBMIT_MARKER} edit ${run}`,
  });
  const stale = await create(AVERY, raiseCash(MORGAN, [MORGAN.accounts[0].number], "stale", run));
  const other = await create(BLAKE, raiseCash(ABDULLAH, [ABDULLAH.accounts[0].number], "other advisor", run));
  const mobile = await create(AVERY, raiseCash(ALEX, [ALEX.accounts[1].number], "mobile", run));
  const rejected = await create(AVERY, {
    clientId: ALEX.id, clientName: `${ALEX.name} & ${BLAIR.name}`, clientIds: [ALEX.id, BLAIR.id], clientNames: [ALEX.name, BLAIR.name],
    tradeType: "Initial Funding", selectedAccounts: [ALEX.accounts[0].number, BLAIR.accounts[0].number], priority: "Low", rebalanceAll: true,
    residence: "CA", liquidationApproval: "No", riskProfile: 20, esgFilters: { ...ESG_NONE, none: false, other: true, otherDescription: "Synthetic palm oil" },
    equityStrategies: [
      { id: 1, benchmark: "SPY", allocation: 70, rationale: "Synthetic core" },
      { id: 2, benchmark: "EFA", allocation: 30, rationale: "Synthetic international" }],
    advisorExclusions: "AMZN (DNB - recorded on rejected request)", clientExclusions: "",
    advisorNotes: `${SUBMIT_MARKER} rejected ${run}`, householdId: 7101, householdName: "Brennan Family Household (synthetic)",
  });
  const pending = await create(AVERY, {
    clientId: MORGAN.id, clientName: MORGAN.name, tradeType: "Liquidate", selectedAccounts: [MORGAN.accounts[0].number], priority: "Standard",
    liquidateOption: "Entire Account", advisorNotes: `${SUBMIT_MARKER} pending ${run}`,
  });
  for (const row of [edit, stale, other, mobile]) await changeStatusElsewhere(row.id, "Needs Info");
  await changeStatusElsewhere(rejected.id, "Rejected");
  const ids = [edit, stale, other, mobile, rejected, pending].map((row) => row.id);
  if (new Set(ids).size !== ids.length) throw new Error("trw15_seed_requests_not_distinct");
  return { editId: edit.id, staleId: stale.id, otherId: other.id, rejectedId: rejected.id, pendingId: pending.id, mobileId: mobile.id, run };
}

const CLEANUP = [
  `DELETE FROM trade_requests WHERE advisor_notes LIKE ${lit(`${SUBMIT_MARKER}%`)}`,
  "DELETE FROM client_exclusions WHERE client_id LIKE 'trw11-%'",
];

/** Adds the synthetic CLIENT_SERVICE user, a standing list for Maeve Brennan (so edit and clone visibly keep the recorded text), and the requests. */
export default async function tradeRequestsSubmitFixture() {
  const owner = new PrismaClient({ datasourceUrl: validateSubmitBrowserDatabase().toString(), log: [] });
  try {
    const [{ database }] = await owner.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`;
    if (database !== TRW15_DATABASE) throw new Error("trade_requests_submit_browser_actual_database_mismatch");
    await owner.user.upsert({
      where: { email: CLIENT_SERVICE_EMAIL },
      create: { email: CLIENT_SERVICE_EMAIL, name: "Casey Service (synthetic)", role: "CLIENT_SERVICE" },
      update: { name: "Casey Service (synthetic)", role: "CLIENT_SERVICE" },
    });
    serviceSql([
      ...CLEANUP,
      `INSERT INTO client_exclusions (client_id, ticker, kind, reason, no_buy, no_sell, created_by_name, created_at) VALUES
        (${lit(ALEX.id)}, 'TSLA', 'advisor', 'Standing list (synthetic)', true, false, 'Seed Operator (synthetic)', '2026-10-01T15:00:00Z'),
        (${lit(ALEX.id)}, 'AAPL', 'client', 'Standing list (synthetic)', true, true, 'Seed Operator (synthetic)', '2026-10-01T15:00:00Z')`,
    ].join(";\n"));
    writeFileSync(SUBMIT_SEED_FILE, JSON.stringify(await seedSubmitRequests()));
  } catch (error) {
    await owner.$disconnect();
    throw error;
  }
  return async () => {
    try {
      serviceSql(CLEANUP.join(";\n"));
      await owner.user.deleteMany({ where: { email: CLIENT_SERVICE_EMAIL } });
    } finally {
      await owner.$disconnect();
    }
  };
}
