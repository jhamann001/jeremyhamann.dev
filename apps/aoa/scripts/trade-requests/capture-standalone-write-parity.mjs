// Captures the standalone Trade Request service's answers and saved fields for the write-parity cases (ticket).
// Run from "$TRADE_REQUEST_SERVICE_DIR/server" with `npx tsx`, against a scratch database that has the standalone
// migrations and test/fixtures/trade-request-write-parity-seed.sql applied (PARITY_SOURCE_DB). Drives the real
// /api/aoa stack (operation allowlist, delegated caller in local HS256 mode, route modules, error handler) over
// HTTP on an ephemeral port. Slack and Warehouse are unconfigured. Prints JSON to stdout; no values are logged.
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ACTORS, CASES, changedTables, normalize, normalizeSnapshot, snapshotQueries, usersByIdFromRaw } from "./write-parity-cases.mjs";

const dir = process.env.TRADE_REQUEST_SERVICE_DIR;
const database = process.env.PARITY_SOURCE_DB;
if (!dir || !database) throw new Error("set TRADE_REQUEST_SERVICE_DIR and PARITY_SOURCE_DB");

const KEY = "ticket-parity-local-key";
const AUDIENCE = "http://trade-request.parity.test/api/aoa";
const CALLER = "aoa-local@delegated.invalid";
for (const name of ["SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID", "WAREHOUSE_URL", "WAREHOUSE_API_KEY", "DATABASE_URL", "DB_SOCKET_PATH"]) {
  delete process.env[name];
}
Object.assign(process.env, {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  GOOGLE_CLIENT_ID: "parity-client",
  GOOGLE_CLIENT_SECRET: "parity-secret",
  SESSION_SECRET: "parity-session",
  AOA_DELEGATED_LOCAL_KEY: KEY,
  AOA_DELEGATED_AUDIENCE: AUDIENCE,
  AOA_DELEGATED_CALLER_SA: CALLER,
  ALLOWED_EMAIL_DOMAIN: "example.test",
  DB_HOST: "localhost",
  DB_PORT: "5432",
  DB_NAME: database,
  DB_USER: process.env.PARITY_DB_USER ?? process.env.USER ?? "postgres",
});

const server = join(dir, "server");
const express = createRequire(join(server, "package.json"))("express");
const load = (rel) => import(pathToFileURL(join(server, "src", rel)).href);
const { requireDelegatedCaller } = await load("middleware/delegatedAuth.ts");
const { default: delegatedRoutes, requireDelegatedOperation } = await load("routes/delegated.ts");
const { errorHandler } = await load("middleware/errorHandler.ts");
const { default: pool } = await load("db/pool.ts");

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function sign(claims) {
  const input = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`;
  return `${input}.${createHmac("sha256", KEY).update(input).digest("base64url")}`;
}
function headers(actor) {
  const iat = Math.floor(Date.now() / 1000);
  const common = { iss: CALLER, aud: AUDIENCE, iat, exp: iat + 120 };
  return {
    authorization: `Bearer ${sign({ ...common, email: CALLER })}`,
    "x-aoa-actor-assertion": sign({ ...common, sub: actor.email, jti: randomUUID(), aoa_role: actor.aoaRole, name: actor.aoaName }),
    accept: "application/json",
    "content-type": "application/json",
  };
}

async function snapshot() {
  const raw = {};
  for (const [table, sql] of Object.entries(snapshotQueries("public"))) {
    raw[table] = (await pool.query(sql)).rows.map((row) => row.j);
  }
  return raw;
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/api/aoa", requireDelegatedOperation, requireDelegatedCaller, delegatedRoutes);
app.use(errorHandler);
const listener = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const origin = `http://127.0.0.1:${listener.address().port}/api/aoa`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

const out = { seed: normalizeSnapshot(await snapshot()), cases: [] };
let previous = out.seed;
for (const c of CASES) {
  const response = await fetch(`${origin}${c.path}`, {
    method: c.method,
    headers: headers(ACTORS[c.actor]),
    body: c.body === undefined ? undefined : JSON.stringify(c.body),
  });
  const text = await response.text();
  await settle();
  const raw = await snapshot();
  const saved = normalizeSnapshot(raw);
  out.cases.push({
    name: c.name,
    status: response.status,
    body: text ? normalize(JSON.parse(text), usersByIdFromRaw(raw)) : null,
    changed: changedTables(previous, saved),
  });
  previous = saved;
}
await new Promise((resolve) => listener.close(resolve));
await settle();
await pool.end();
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
