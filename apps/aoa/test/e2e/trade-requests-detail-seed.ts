import { createHmac, randomUUID } from "node:crypto";

// Synthetic requests and account restrictions for the request-detail browser
// check, written through the local Trade Request service's delegated API.
// Loopback services only; every value is invented.

const CALLER = "aoa-local@delegated.invalid";
export const DETAIL_SEED_MARKER = "TRW-07 synthetic";

type Actor = { email: string; name: string; role: "ADMIN" | "OPERATIONS" | "ADVISOR" };
const ADVISOR: Actor = { email: "avery@example.com", name: "Avery Stone", role: "ADVISOR" };
const OPERATIONS: Actor = { email: "ops@example.com", name: "Riley Ops", role: "OPERATIONS" };

export type DetailSeed = { householdId: string; rejectedId: string; restrictedAccounts: string[] };

export function detailServiceUrl(): string {
  const raw = process.env.TRW07_SERVICE_URL ?? "http://127.0.0.1:8141";
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) throw new Error("trw07_service_must_be_loopback");
  return url.origin;
}

export function detailServiceKey(): string {
  const key = process.env.TRW07_DELEGATED_LOCAL_KEY;
  if (!key) throw new Error("trw07_delegated_local_key_required");
  return key;
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function sign(claims: Record<string, unknown>, key: string): string {
  const input = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`;
  return `${input}.${createHmac("sha256", key).update(input).digest("base64url")}`;
}

async function call<T>(actor: Actor, method: string, path: string, body?: unknown): Promise<T> {
  const audience = `${detailServiceUrl()}/api/aoa`;
  const key = detailServiceKey();
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
  if (!response.ok) throw new Error(`trw07_seed_${method}_${path}_${response.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

type Row = { id: string; status: string; updatedAt: string; advisorNotes?: string };
type Client = { id: string; accounts: Array<{ id: string; accountNumber: string }> };

async function findSeeded(note: string): Promise<Row | null> {
  let before: string | undefined;
  for (;;) {
    const page = await call<{ data: Row[]; nextCursor: string | null }>(OPERATIONS, "GET", `/requests?limit=200${before ? `&before=${encodeURIComponent(before)}` : ""}`);
    const match = page.data.find((row) => row.advisorNotes === note);
    if (match) return match;
    if (!page.nextCursor) return null;
    before = page.nextCursor;
  }
}

async function ensureRequest(note: string, body: Record<string, unknown>, statuses: string[]): Promise<string> {
  const existing = await findSeeded(note);
  if (existing) return existing.id;
  let row = (await call<{ data: Row }>(ADVISOR, "POST", "/requests", { ...body, advisorNotes: note, idempotencyKey: randomUUID() })).data;
  for (const [index, status] of statuses.entries()) {
    row = (await call<{ data: Row }>(OPERATIONS, "PUT", `/requests/${encodeURIComponent(row.id)}/status`, {
      status, note: `${DETAIL_SEED_MARKER} step ${index + 1}`, expectedUpdatedAt: row.updatedAt,
    })).data;
  }
  return row.id;
}

async function ensureAccountRestriction(accountId: string, kind: "advisor" | "client", ticker: string, reason: string, noSell: boolean) {
  const existing = await call<{ data: Record<string, Array<{ ticker: string; kind: string }>> }>(
    OPERATIONS, "POST", "/clients/account-exclusions/bulk", { accountIds: [accountId] },
  );
  if ((existing.data[accountId] ?? []).some((row) => row.ticker === ticker && row.kind === kind)) return;
  await call(OPERATIONS, "POST", `/clients/account-exclusions/${encodeURIComponent(accountId)}/batch`, {
    add: [{ ticker, kind, reason, noBuy: true, noSell }],
  });
}

/** Idempotent: a later run reuses the requests and restrictions already present. */
export async function seedTradeRequestDetail(): Promise<DetailSeed> {
  const clients = (await call<{ data: Client[] }>(OPERATIONS, "GET", "/clients")).data;
  const account = (number: string) => {
    const found = clients.flatMap((client) => client.accounts).find((row) => row.accountNumber === number);
    if (!found) throw new Error(`trw07_seed_missing_account_${number}`);
    return found.id;
  };
  await ensureAccountRestriction(account("NEAX-1399"), "advisor", "SYNA", "Synthetic concentrated position", false);
  await ensureAccountRestriction(account("ACCT-3002"), "client", "SYNB", "", true);

  const householdId = await ensureRequest(`${DETAIL_SEED_MARKER} household`, {
    clientId: "HH-001", clientName: "The Richardson Family",
    clientIds: ["HH-001", "HH-003"], clientNames: ["The Richardson Family", "David Park"],
    tradeType: "Initial Funding", tradeAmount: "250000", selectedAccounts: ["NEAX-1399", "ACCT-3002"],
    priority: "Urgent", residence: "NY", liquidationApproval: "Yes",
    advisorExclusions: "SYNX", clientExclusions: "SYNY",
    esgFilters: { fossilFuels: true, tobacco: false, weapons: true, alcohol: false, gambling: false, other: true, otherDescription: "Synthetic screen", none: false },
    riskProfile: 14,
    equityStrategies: [
      { id: 1, benchmark: "Synthetic Core Equity", allocation: 60, rationale: "Synthetic rationale for the core sleeve." },
      { id: 2, benchmark: "Synthetic Dividend", allocation: 40, rationale: "Synthetic rationale for income." },
    ],
  }, ["Needs Info"]);

  const rejectedId = await ensureRequest(`${DETAIL_SEED_MARKER} rejected`, {
    clientId: "HH-002", clientName: "Emory & Chaim Aufderhar", clientIds: ["HH-002"], clientNames: ["Emory & Chaim Aufderhar"],
    tradeType: "Liquidate", selectedAccounts: ["ACCT-2001"], priority: "Low",
    liquidateOption: "Specific Positions", liquidatePositions: "SYNZ 100 shares",
  }, ["Rejected"]);

  return { householdId, rejectedId, restrictedAccounts: ["NEAX-1399", "ACCT-3002"] };
}

if (process.argv[1]?.endsWith("trade-requests-detail-seed.ts")) {
  seedTradeRequestDetail().then((seed) => console.log(JSON.stringify(seed)), (error) => { console.error(error); process.exit(1); });
}
