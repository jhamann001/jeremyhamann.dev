import { createHmac, randomUUID } from "node:crypto";

// Synthetic requests for the reviewer status action browser check, written
// through the local Trade Request service's delegated API. Loopback services
// only; every value is invented. Each run creates fresh requests so the specs'
// status changes never meet an earlier run's.

const CALLER = "aoa-local@delegated.invalid";
export const STATUS_SEED_MARKER = "TRW-09 synthetic";

type Actor = { email: string; name: string; role: "ADMIN" | "OPERATIONS" | "ADVISOR" };
const ADVISOR: Actor = { email: "avery@example.com", name: "Avery Stone", role: "ADVISOR" };
const OPERATIONS: Actor = { email: "ops@example.com", name: "Riley Ops", role: "OPERATIONS" };

export type StatusSeed = {
  approveId: string;
  needsInfoId: string;
  staleId: string;
  failId: string;
  mobileId: string;
  advisorId: string;
  approvedId: string;
};

export function statusServiceUrl(): string {
  const raw = process.env.TRW09_SERVICE_URL ?? "http://127.0.0.1:8221";
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) throw new Error("trw09_service_must_be_loopback");
  return url.origin;
}

function serviceKey(): string {
  const key = process.env.TRW09_DELEGATED_LOCAL_KEY;
  if (!key) throw new Error("trw09_delegated_local_key_required");
  return key;
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function sign(claims: Record<string, unknown>, key: string): string {
  const input = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`;
  return `${input}.${createHmac("sha256", key).update(input).digest("base64url")}`;
}

async function call<T>(actor: Actor, method: string, path: string, body?: unknown): Promise<T> {
  const audience = `${statusServiceUrl()}/api/aoa`;
  const key = serviceKey();
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
  if (!response.ok) throw new Error(`trw09_seed_${method}_${path}_${response.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

type Row = { id: string; status: string; updatedAt: string };

// The service returns a recent request with the same advisor, client, trade
// type, amount and accounts instead of creating one, so the amount is unique.
async function createRequest(label: string): Promise<Row> {
  const run = `${label} ${randomUUID()}`;
  return (await call<{ data: Row }>(ADVISOR, "POST", "/requests", {
    clientId: "HH-001", clientName: "The Richardson Family", clientIds: ["HH-001"], clientNames: ["The Richardson Family"],
    tradeType: "Liquidate", tradeAmount: `Synthetic ${run}`, selectedAccounts: ["NEAX-1399"], priority: "Standard",
    liquidateOption: "Specific Positions", liquidatePositions: "SYNZ 10 shares",
    advisorNotes: `${STATUS_SEED_MARKER} ${run}`, idempotencyKey: randomUUID(),
  })).data;
}

async function check(id: string, key: string) {
  await call(OPERATIONS, "PUT", `/requests/${encodeURIComponent(id)}/checklist`, { key, checked: true, value: "" });
}

export async function readRequest(id: string): Promise<Row> {
  return (await call<{ data: Row }>(OPERATIONS, "GET", `/requests/${encodeURIComponent(id)}`)).data;
}

/** A change made elsewhere (by Riley Ops through the API), so a screen still holding the old stamp is stale. */
export async function changeStatusElsewhere(id: string, status: string): Promise<void> {
  const current = await readRequest(id);
  await call(OPERATIONS, "PUT", `/requests/${encodeURIComponent(id)}/status`, {
    status, note: `${STATUS_SEED_MARKER} elsewhere`, expectedUpdatedAt: current.updatedAt,
  });
}

export async function seedTradeRequestStatus(): Promise<StatusSeed> {
  const labels = ["approve", "needs info", "stale", "fail", "mobile", "advisor", "approved"] as const;
  const rows: Row[] = [];
  for (const label of labels) rows.push(await createRequest(label));
  if (new Set(rows.map((row) => row.id)).size !== labels.length) throw new Error("trw09_seed_requests_not_distinct");
  const [approve, needsInfo, stale, fail, mobile, advisor, approved] = rows;
  for (const id of [approve.id, mobile.id]) {
    await check(id, "exclusions");
    await check(id, "asset_location");
  }
  await changeStatusElsewhere(approved.id, "Approved");
  return {
    approveId: approve.id, needsInfoId: needsInfo.id, staleId: stale.id, failId: fail.id, mobileId: mobile.id,
    advisorId: advisor.id, approvedId: approved.id,
  };
}
