import { createHmac, randomUUID } from "node:crypto";

// Synthetic requests and checklist states for the pre-approval checklist
// browser check, written through the local Trade Request service's delegated
// API. Loopback services only; every value is invented. Each run creates
// fresh requests so the specs' checklist changes never meet an earlier run's.

const CALLER = "aoa-local@delegated.invalid";
export const CHECKLIST_SEED_MARKER = "TRW-08 synthetic";

type Actor = { email: string; name: string; role: "ADMIN" | "OPERATIONS" | "ADVISOR" };
const ADVISOR: Actor = { email: "avery@example.com", name: "Avery Stone", role: "ADVISOR" };
const OPERATIONS: Actor = { email: "ops@example.com", name: "Riley Ops", role: "OPERATIONS" };

export type ChecklistSeed = {
  editable: { ADMIN: string; OPERATIONS: string };
  saveFailId: string;
  stampedId: string;
  approvedId: string;
};

export function checklistServiceUrl(): string {
  const raw = process.env.TRW08_SERVICE_URL ?? "http://127.0.0.1:8171";
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) throw new Error("trw08_service_must_be_loopback");
  return url.origin;
}

function serviceKey(): string {
  const key = process.env.TRW08_DELEGATED_LOCAL_KEY;
  if (!key) throw new Error("trw08_delegated_local_key_required");
  return key;
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function sign(claims: Record<string, unknown>, key: string): string {
  const input = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`;
  return `${input}.${createHmac("sha256", key).update(input).digest("base64url")}`;
}

async function call<T>(actor: Actor, method: string, path: string, body?: unknown): Promise<T> {
  const audience = `${checklistServiceUrl()}/api/aoa`;
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
  if (!response.ok) throw new Error(`trw08_seed_${method}_${path}_${response.status}: ${text.slice(0, 300)}`);
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
    advisorNotes: `${CHECKLIST_SEED_MARKER} ${run}`, idempotencyKey: randomUUID(),
  })).data;
}

async function setItem(id: string, key: string, checked: boolean, value = "") {
  await call(OPERATIONS, "PUT", `/requests/${encodeURIComponent(id)}/checklist`, { key, checked, value });
}

export async function seedTradeRequestChecklist(): Promise<ChecklistSeed> {
  const admin = await createRequest("editable ADMIN");
  const operations = await createRequest("editable OPERATIONS");
  const saveFail = await createRequest("save failure");
  const stamped = await createRequest("stamped");
  const approved = await createRequest("approved");
  const ids = new Set([admin, operations, saveFail, stamped, approved].map((row) => row.id));
  if (ids.size !== 5) throw new Error("trw08_seed_requests_not_distinct");
  for (const id of [stamped.id, approved.id]) {
    await setItem(id, "exclusions", true);
    await setItem(id, "templates", true, "Synthetic Template A");
    await setItem(id, "residual_cash", true);
    await setItem(id, "residual_cash", false);
  }
  await call(OPERATIONS, "PUT", `/requests/${encodeURIComponent(approved.id)}/status`, {
    status: "Approved", note: `${CHECKLIST_SEED_MARKER} approve`, expectedUpdatedAt: approved.updatedAt,
  });
  return {
    editable: { ADMIN: admin.id, OPERATIONS: operations.id },
    saveFailId: saveFail.id, stampedId: stamped.id, approvedId: approved.id,
  };
}
