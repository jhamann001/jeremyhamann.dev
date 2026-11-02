import { createHmac, randomUUID } from "node:crypto";

// Synthetic requests for the Trading Queue browser check, written through the
// local Trade Request service's delegated API: created as an ADVISOR (and some
// as OPERATIONS, so "Submitted by" differs from "Advisor"), statuses changed as
// ADMIN. Loopback services only.

const CALLER = "aoa-local@delegated.invalid";
export const SEED_MARKER = "TRW-06 synthetic";
export const SEED_TOTAL = 112;

type Actor = { email: string; name: string; role: "ADMIN" | "OPERATIONS" | "ADVISOR" };
const ADVISOR: Actor = { email: "avery@example.com", name: "Avery Stone", role: "ADVISOR" };
const OPERATIONS: Actor = { email: "ops@example.com", name: "Riley Ops", role: "OPERATIONS" };
const ADMIN: Actor = { email: "admin@example.com", name: "Dana Admin", role: "ADMIN" };

const HOUSEHOLDS = [
  { clientIds: ["HH-001"], clientNames: ["The Richardson Family"], accounts: ["NEAX-1399", "ACCT-1002"] },
  { clientIds: ["HH-002"], clientNames: ["Emory & Chaim Aufderhar"], accounts: ["ACCT-2001"] },
  { clientIds: ["HH-003"], clientNames: ["David Park"], accounts: ["ACCT-3001", "ACCT-3002"] },
  { clientIds: ["HH-001", "HH-003"], clientNames: ["The Richardson Family", "David Park"], accounts: ["ACCT-1003", "ACCT-3002"] },
];

// Status path from Pending Review, applied in order by ADMIN.
const PATHS: string[][] = [
  [],
  ["Needs Info"],
  ["Pending Current Asset Liquidation"],
  ["Approved"],
  ["Rejected"],
  ["Completed"],
];

export function seedServiceUrl(): string {
  const raw = process.env.TRW06_SERVICE_URL ?? "http://127.0.0.1:8131";
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) throw new Error("trw06_service_must_be_loopback");
  return url.origin;
}

function seedKey(): string {
  const key = process.env.TRW06_DELEGATED_LOCAL_KEY;
  if (!key) throw new Error("trw06_delegated_local_key_required");
  return key;
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function sign(claims: Record<string, unknown>, key: string): string {
  const input = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`;
  return `${input}.${createHmac("sha256", key).update(input).digest("base64url")}`;
}

async function call<T>(actor: Actor, method: string, path: string, body?: unknown): Promise<T> {
  const origin = seedServiceUrl();
  const key = seedKey();
  const audience = `${origin}/api/aoa`;
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
  if (!response.ok) throw new Error(`trw06_seed_${method}_${path}_${response.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

type Row = { id: string; status: string; updatedAt: string; advisorNotes?: string };

async function seededCount(): Promise<number> {
  let count = 0;
  let before: string | undefined;
  for (;;) {
    const page = await call<{ data: Row[]; nextCursor: string | null }>(ADMIN, "GET", `/requests?limit=200${before ? `&before=${encodeURIComponent(before)}` : ""}`);
    count += page.data.filter((row) => row.advisorNotes?.startsWith(SEED_MARKER)).length;
    if (!page.nextCursor) return count;
    before = page.nextCursor;
  }
}

function payload(index: number) {
  const household = HOUSEHOLDS[index % HOUSEHOLDS.length];
  const base = {
    clientId: household.clientIds[0], clientName: household.clientNames[0],
    clientIds: household.clientIds, clientNames: household.clientNames,
    selectedAccounts: household.accounts, priority: (["Standard", "Urgent", "Low"] as const)[index % 3],
    advisorNotes: `${SEED_MARKER} #${index + 1}`, idempotencyKey: randomUUID(),
    // Distinct per request: the service suppresses identical submissions.
    tradeAmount: String(10_000 + index * 125),
  };
  switch (index % 3) {
    case 0:
      return { ...base, tradeType: "Raise Cash", raiseCashReason: "Synthetic liquidity need" };
    case 1:
      return { ...base, tradeType: "Liquidate", liquidateOption: "Entire Account" };
    default:
      return { ...base, tradeType: "Initial Funding", riskProfile: 1 + (index % 25), residence: "Other", liquidationApproval: "Yes" };
  }
}

/** Tops the synthetic set up to SEED_TOTAL; a later run with the set present does nothing. */
export async function seedTradeRequestsQueue(): Promise<void> {
  for (let index = await seededCount(); index < SEED_TOTAL; index += 1) {
    const actor = index % 5 === 4 ? OPERATIONS : ADVISOR;
    let row = (await call<{ data: Row }>(actor, "POST", "/requests", payload(index))).data;
    for (const status of PATHS[index % PATHS.length]) {
      row = (await call<{ data: Row }>(ADMIN, "PUT", `/requests/${encodeURIComponent(row.id)}/status`, {
        status, note: SEED_MARKER, expectedUpdatedAt: row.updatedAt,
      })).data;
    }
  }
}

if (process.argv[1]?.endsWith("trade-requests-queue-seed.ts")) {
  seedTradeRequestsQueue().then(() => console.log("seeded"), (error) => { console.error(error); process.exit(1); });
}
