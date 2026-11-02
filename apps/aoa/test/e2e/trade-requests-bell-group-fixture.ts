import { createHmac, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { CLIENT_SERVICE_EMAIL } from "./trade-requests-workspace-fixture";
import { PERSONAS } from "./trade-requests-browser-helpers";

// Synthetic-only fixture for the bell's Trade Request group. AOA runs against
// its own loopback database; the Trade Request service runs on loopback with
// its own local database. Notifications are created by real delegated actions
// (an ADVISOR submits, an ADMIN changes a status); the per-test reset only
// restores read state and removes rows a test added.

const AOA_DATABASE = "aoa_trw16_synthetic";
const SERVICE_DATABASE = "trw_local_tkt_377";
const CALLER = "aoa-local@delegated.invalid";
const SEED_MARKER = "TRW-16 synthetic";

type Actor = { email: string; name: string; role: "ADMIN" | "OPERATIONS" | "ADVISOR" };
const ACTORS: Record<"ADMIN" | "OPERATIONS" | "ADVISOR", Actor> = {
  ADMIN: { email: PERSONAS.ADMIN, name: "Dana Admin", role: "ADMIN" },
  OPERATIONS: { email: PERSONAS.OPERATIONS, name: "Riley Ops", role: "OPERATIONS" },
  ADVISOR: { email: PERSONAS.ADVISOR, name: "Avery Stone", role: "ADVISOR" },
};
const WORKSPACE_EMAILS = Object.values(ACTORS).map((actor) => actor.email);
const TRADER_EMAILS = [ACTORS.ADMIN.email, ACTORS.OPERATIONS.email];

function localUrl(raw: string | undefined, user: string): URL {
  if (!raw) throw new Error("trade_requests_bell_group_database_url_required");
  const url = new URL(raw);
  if (
    !["postgresql:", "postgres:"].includes(url.protocol)
    || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || !url.port
    || url.pathname !== `/${AOA_DATABASE}`
    || url.username !== user
    || ["host", "hostaddr", "service", "servicefile"].some((key) => url.searchParams.has(key))
    || process.env.K_SERVICE
    || process.env.CLOUD_RUN_SERVICE
    || process.env.APP_ENV === "prod"
  ) throw new Error("trade_requests_bell_group_requires_isolated_loopback_database");
  return url;
}

/** Called by the config before any server starts, then again by setup. */
export function validateTradeRequestsBellGroupDatabase(): URL {
  const owner = localUrl(process.env.DIRECT_DATABASE_URL, "aoa");
  const runtime = localUrl(process.env.DATABASE_URL, "app_rw");
  if (owner.host !== runtime.host) throw new Error("trade_requests_bell_group_database_target_mismatch");
  return owner;
}

export function bellGroupServiceUrl(): string {
  const url = new URL(process.env.TRW16_SERVICE_URL ?? "http://127.0.0.1:8161");
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) throw new Error("trw16_service_must_be_loopback");
  return url.origin;
}

/** The local service database, over the /tmp socket or loopback only. */
function serviceDatabaseUrl(): string {
  const raw = process.env.TRW16_SERVICE_DATABASE_URL ?? `postgresql://${process.env.USER ?? "postgres"}@localhost/${SERVICE_DATABASE}?host=/tmp`;
  const url = new URL(raw);
  const host = url.searchParams.get("host");
  if (
    url.pathname !== `/${SERVICE_DATABASE}`
    || !["localhost", "127.0.0.1"].includes(url.hostname)
    || (host !== null && host !== "/tmp")
  ) throw new Error("trw16_service_database_must_be_local");
  return url.toString();
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function sign(claims: Record<string, unknown>, key: string): string {
  const input = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`;
  return `${input}.${createHmac("sha256", key).update(input).digest("base64url")}`;
}

async function call<T>(actor: Actor, method: string, path: string, body?: unknown): Promise<T> {
  const key = process.env.TRW16_DELEGATED_LOCAL_KEY;
  if (!key) throw new Error("trw16_delegated_local_key_required");
  const audience = `${bellGroupServiceUrl()}/api/aoa`;
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
  if (!response.ok) throw new Error(`trw16_seed_${method}_${path}_${response.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

let service: PrismaClient | null = null;
function serviceDb(): PrismaClient {
  service ??= new PrismaClient({ datasourceUrl: serviceDatabaseUrl(), log: [] });
  return service;
}

type Seeded = { id: string; email: string; created_at: Date };

async function personaNotifications(): Promise<Seeded[]> {
  return serviceDb().$queryRaw<Seeded[]>`
    SELECT n.id::text AS id, lower(u.email) AS email, n.created_at
    FROM notifications n JOIN users u ON u.id = n.user_id
    WHERE lower(u.email) = ANY(${WORKSPACE_EMAILS}) AND n.body NOT LIKE ${"%" + SEED_MARKER + " extra%"}
    ORDER BY n.created_at ASC`;
}

/**
 * Today's starting point for every test: ADMIN and OPERATIONS each have two
 * new-request notifications (the older one read), ADVISOR one unread status
 * notification; rows added by a test are removed.
 */
export async function resetBellNotifications(): Promise<void> {
  const db = serviceDb();
  for (const role of Object.keys(ACTORS) as Array<keyof typeof ACTORS>) await restoreParked(role);
  await db.$executeRaw`
    DELETE FROM notifications n USING users u
    WHERE u.id = n.user_id AND lower(u.email) = ANY(${WORKSPACE_EMAILS}) AND n.body LIKE ${"%" + SEED_MARKER + " extra%"}`;
  await db.$executeRaw`
    UPDATE notifications n SET read_at = NULL FROM users u
    WHERE u.id = n.user_id AND lower(u.email) = ANY(${WORKSPACE_EMAILS})`;
  const rows = await personaNotifications();
  for (const email of TRADER_EMAILS) {
    const oldest = rows.find((row) => row.email === email);
    if (oldest) await db.$executeRaw`UPDATE notifications SET read_at = date_trunc('milliseconds', NOW()) WHERE id = ${oldest.id}::uuid`;
  }
}

/** Inserts a notification the way the service's notificationInserts does. */
export async function insertBellNotification(role: keyof typeof ACTORS, message: string): Promise<void> {
  const body = `${message} (${SEED_MARKER} extra)`;
  const inserted = await serviceDb().$executeRaw`
    INSERT INTO notifications (user_id, body, request_id)
    SELECT id, ${body}, NULL FROM users WHERE lower(email) = ${ACTORS[role].email}`;
  if (inserted !== 1) throw new Error("trw16_insert_notification_failed");
}

/** Hides every notification of one persona until the next reset (for the empty state). */
export async function withoutNotifications(role: keyof typeof ACTORS): Promise<void> {
  await serviceDb().$executeRaw`
    UPDATE notifications n SET user_id = (SELECT id FROM users WHERE lower(email) = ${"parked." + ACTORS[role].email})
    FROM users u WHERE u.id = n.user_id AND lower(u.email) = ${ACTORS[role].email}`;
}

async function restoreParked(role: keyof typeof ACTORS): Promise<void> {
  await serviceDb().$executeRaw`
    UPDATE notifications n SET user_id = (SELECT id FROM users WHERE lower(email) = ${ACTORS[role].email})
    FROM users u WHERE u.id = n.user_id AND lower(u.email) = ${"parked." + ACTORS[role].email}`;
}

export async function readState(role: keyof typeof ACTORS): Promise<Array<{ body: string; read: boolean }>> {
  return serviceDb().$queryRaw<Array<{ body: string; read: boolean }>>`
    SELECT n.body, n.read_at IS NOT NULL AS read FROM notifications n JOIN users u ON u.id = n.user_id
    WHERE lower(u.email) = ${ACTORS[role].email} ORDER BY n.created_at DESC`;
}

/** True when the service has never seen a delegated call for this email. */
export async function serviceNeverSaw(email: string): Promise<boolean> {
  const rows = await serviceDb().$queryRaw<Array<{ c: number }>>`SELECT count(*)::int AS c FROM users WHERE lower(email) = ${email.toLowerCase()}`;
  return rows[0].c === 0;
}

export async function disconnectServiceDb(): Promise<void> {
  await service?.$disconnect();
  service = null;
}

async function waitForRows(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await personaNotifications()).length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("trw16_seed_notifications_missing");
}

/** Idempotent: a later run with the seeded notifications present does nothing beyond the reset. */
async function seedServiceNotifications(): Promise<void> {
  const db = serviceDb();
  const [{ database }] = await db.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`;
  if (database !== SERVICE_DATABASE) throw new Error("trw16_service_actual_database_mismatch");
  for (const actor of Object.values(ACTORS)) await call(actor, "GET", "/notifications?limit=1");
  // Ruling D5: Operations aligns the service's active trader roster with AOA's
  // reviewers before pilot; the local roster is aligned the same way here.
  await db.$executeRaw`UPDATE users SET role = 'trader', is_active = true WHERE lower(email) = ANY(${TRADER_EMAILS})`;
  for (const email of WORKSPACE_EMAILS) {
    await db.$executeRaw`
      INSERT INTO users (email, name, role, is_active) VALUES (${"parked." + email}, 'Parked (synthetic)', 'advisor', false)
      ON CONFLICT (email) DO NOTHING`;
  }
  if ((await personaNotifications()).length >= 5) return;
  await db.$executeRaw`
    DELETE FROM notifications n USING users u WHERE u.id = n.user_id AND lower(u.email) = ANY(${WORKSPACE_EMAILS})`;
  const created: Array<{ id: string; updatedAt: string }> = [];
  for (const [index, account] of [["NEAX-1399", "HH-001", "The Richardson Family"], ["ACCT-2001", "HH-002", "Emory & Chaim Aufderhar"]].entries()) {
    const [accountNumber, clientId, clientName] = account;
    const { data } = await call<{ data: { id: string; updatedAt: string } }>(ACTORS.ADVISOR, "POST", "/requests", {
      clientId, clientName, clientIds: [clientId], clientNames: [clientName], selectedAccounts: [accountNumber],
      priority: "Standard", tradeType: "Raise Cash", raiseCashReason: "Synthetic liquidity need",
      tradeAmount: String(20_000 + index * 250), advisorNotes: `${SEED_MARKER} #${index + 1}`, idempotencyKey: randomUUID(),
    });
    created.push(data);
    await waitForRows(2 * (index + 1));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await call(ACTORS.ADMIN, "PUT", `/requests/${encodeURIComponent(created[0].id)}/status`, {
    status: "Needs Info", note: SEED_MARKER, expectedUpdatedAt: created[0].updatedAt,
  });
  await waitForRows(5);
}

/** Adds the synthetic CLIENT_SERVICE user, seeds the service and removes the user afterwards. */
export default async function tradeRequestsBellGroupFixture() {
  const owner = new PrismaClient({ datasourceUrl: validateTradeRequestsBellGroupDatabase().toString(), log: [] });
  try {
    const [{ database }] = await owner.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`;
    if (database !== AOA_DATABASE) throw new Error("trade_requests_bell_group_actual_database_mismatch");
    await owner.user.upsert({
      where: { email: CLIENT_SERVICE_EMAIL },
      create: { email: CLIENT_SERVICE_EMAIL, name: "Casey Service (synthetic)", role: "CLIENT_SERVICE" },
      update: { name: "Casey Service (synthetic)", role: "CLIENT_SERVICE" },
    });
    await seedServiceNotifications();
    await resetBellNotifications();
  } catch (error) {
    await owner.$disconnect();
    await disconnectServiceDb();
    throw error;
  }
  return async () => {
    try {
      await owner.user.deleteMany({ where: { email: CLIENT_SERVICE_EMAIL } });
    } finally {
      await owner.$disconnect();
      await disconnectServiceDb();
    }
  };
}
