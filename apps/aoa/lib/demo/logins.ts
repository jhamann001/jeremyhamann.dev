// The demo database's logins. The owner (`aoa`, which runs the migrations, the seed and the nightly reset) is the
// one login with a password of its own. Each runtime login gets a password derived from the owner's: an HMAC of the
// owner password and the login's name. Whoever holds the owner password can already set any login's password, so
// deriving them exposes nothing new, and the deploy holds one database secret instead of four. The container gets
// only the derived logins; the owner password never reaches it. Every deploy sets the same passwords, so a container
// still running on the previous deploy's settings keeps connecting. Only the deploy and a fresh seed set them
// (ensureDemoLogins); the nightly reset only checks them (demoLoginProblems), because a reset can't hand the
// container new ones.
//
// Runtime URLs use Neon's direct endpoint, not its pooler: AoA's code relies on session state a transaction-mode
// pooler drops (lib/db.ts, ADR-3), and production connects to Postgres directly too.
// Server only (node:crypto).

import { createHmac } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export type DemoLoginRole = "app_rw" | "ingest_rw" | "identity_reconciler";

/** The logins that get a password. statement_pipeline_rw and trade_request_mcp_ro serve outside services the demo
 * answers in-app (lib/demo/stand-ins), so they keep none and cannot sign in. */
export const DEMO_LOGIN_ROLES: readonly DemoLoginRole[] = ["app_rw", "ingest_rw", "identity_reconciler"];

/** The web service's four database settings, as production sets them (its direct URL is the app login too). */
export const DEMO_RUNTIME_LOGINS = {
  DATABASE_URL: { role: "app_rw", schema: "app" },
  DIRECT_DATABASE_URL: { role: "app_rw", schema: "app" },
  INGEST_DATABASE_URL: { role: "ingest_rw", schema: "mirror" },
  CRM_RECONCILER_DATABASE_URL: { role: "identity_reconciler", schema: "app" },
} as const satisfies Record<string, { role: DemoLoginRole; schema: string }>;

export type DemoRuntimeLogins = Record<keyof typeof DEMO_RUNTIME_LOGINS, string>;

const OWNER = "aoa";
const PASSWORD = /^[A-Za-z0-9_-]{43}$/;

/**
 * The owner URL as the deploy and the reset use it, from the connection string Neon gives (often its pooler's):
 * the direct host (migrations and the seed's role switches need a session, not a pooled transaction), the app
 * schema (Prisma creates and targets it; without it the first migration lands in public), a connect timeout long
 * enough for a database waking from sleep, and no channel_binding (Prisma's engine doesn't take it).
 */
export function demoOwnerDirectUrl(raw: string): string {
  const url = ownerUrl(raw);
  url.hostname = url.hostname.replace(/-pooler\./, ".");
  url.searchParams.delete("channel_binding");
  url.searchParams.set("schema", "app");
  if (!url.searchParams.has("connect_timeout")) url.searchParams.set("connect_timeout", "20");
  return url.toString();
}

/**
 * The token the nightly reset shows the Worker's "resetting" page with (worker/src/gate.js): derived from the owner's
 * password like the logins, so the reset job and the deploy, which both hold the owner URL, agree on it without a
 * secret of its own. Only the Worker gets the token itself.
 */
export function demoResetGateToken(ownerRaw: string): string {
  const ownerPassword = decodeURIComponent(ownerUrl(ownerRaw).password);
  if (ownerPassword.length < 16) throw new Error("demo_owner_password_too_short");
  return createHmac("sha256", ownerPassword).update("aoa-demo-reset-gate").digest("base64url");
}

/** The password of `role`, derived from the owner's. base64url, so it needs no quoting in a URL or in SQL. */
export function demoLoginPassword(ownerPassword: string, role: DemoLoginRole): string {
  if (ownerPassword.length < 16) throw new Error("demo_owner_password_too_short");
  for (let round = 0; ; round++) {
    const candidate = createHmac("sha256", ownerPassword).update(`aoa-demo-login:${role}:${round}`).digest("base64url");
    // Neon refuses a password with one character three times in a row.
    if (!/(.)\1\1/.test(candidate)) return candidate;
  }
}

function ownerUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") throw new Error("demo_owner_url_not_postgres");
  if (decodeURIComponent(url.username) !== OWNER) throw new Error("demo_owner_login_required");
  return url;
}

/**
 * The runtime URLs for the database `ownerRaw` points at: same host, database and settings, each login's user name,
 * its derived password (none when the owner has none, as on a local loopback database) and its schema. A Neon
 * pooler host becomes the direct host.
 */
export function demoLoginUrls(ownerRaw: string): DemoRuntimeLogins {
  const owner = ownerUrl(ownerRaw);
  const ownerPassword = decodeURIComponent(owner.password);
  const urls = {} as DemoRuntimeLogins;
  for (const [key, { role, schema }] of Object.entries(DEMO_RUNTIME_LOGINS) as Array<
    [keyof typeof DEMO_RUNTIME_LOGINS, { role: DemoLoginRole; schema: string }]
  >) {
    const url = new URL(owner.href);
    url.hostname = url.hostname.replace(/-pooler\./, ".");
    url.username = role;
    url.password = ownerPassword ? demoLoginPassword(ownerPassword, role) : "";
    url.searchParams.set("schema", schema);
    urls[key] = url.toString();
  }
  return urls;
}

/**
 * Run as the owner: gives each runtime login its derived password, and lets the owner act as the app login (the
 * seed writes the transfer workspace's app-only tables under SET LOCAL ROLE app_rw). The migrations create the
 * logins; on Postgres 16 a role that creates another holds it with ADMIN but may not act as it until granted SET.
 * Idempotent. Without an owner password (a local loopback database) the logins keep the passwords they have.
 */
export async function ensureDemoLogins(owner: PrismaClient, ownerRaw: string): Promise<void> {
  const ownerPassword = decodeURIComponent(ownerUrl(ownerRaw).password);
  await owner.$executeRawUnsafe(`GRANT app_rw TO ${OWNER} WITH INHERIT FALSE, SET TRUE`);
  if (!ownerPassword) return;
  for (const role of DEMO_LOGIN_ROLES) {
    const password = demoLoginPassword(ownerPassword, role);
    if (!PASSWORD.test(password)) throw new Error("demo_login_password_shape");
    await owner.$executeRawUnsafe(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${password}'`);
  }
}

/**
 * The nightly reset's check of the logins, in place of ensureDemoLogins: each runtime login exists and may sign in,
 * and the owner may act as the app login. It sets no password. The running container signs in with the passwords
 * the last deploy handed it; if the owner password has changed since, a reset that set the passwords derived from
 * the new one would lock the container out of its database until the next deploy. So only the deploy, which hands
 * the container the same passwords in the same run, and a fresh seed set them. One line per problem, none when
 * the logins are ready.
 */
export async function demoLoginProblems(owner: PrismaClient): Promise<string[]> {
  const roles = await owner.$queryRaw<Array<{ role: string; found: boolean; login: boolean }>>`
    SELECT wanted.role, r.rolname IS NOT NULL AS found, coalesce(r.rolcanlogin, false) AS login
      FROM unnest(${[...DEMO_LOGIN_ROLES]}::text[]) AS wanted(role)
      LEFT JOIN pg_roles r ON r.rolname = wanted.role
     ORDER BY wanted.role`;
  const problems = roles.flatMap(({ role, found, login }) =>
    !found ? [`${role}: no such login`] : !login ? [`${role}: may not sign in`] : [],
  );
  if (roles.some((r) => r.role === "app_rw" && r.found)) {
    const [{ canSet }] = await owner.$queryRaw<Array<{ canSet: boolean }>>`
      SELECT pg_has_role(current_user, 'app_rw', 'SET') AS "canSet"`;
    if (!canSet) problems.push(`${OWNER}: may not act as app_rw (a fresh seed or the deploy grants it)`);
  }
  return problems;
}
