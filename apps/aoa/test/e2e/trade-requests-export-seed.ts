import { createHmac, randomUUID } from "node:crypto";

// Synthetic requests and standing exclusions for the queue export browser
// check, written through the local Trade Request service's delegated API
// against the service's own synthetic seed clients (HH-001 to HH-003).
// Loopback services only; no real client data.

const CALLER = "aoa-local@delegated.invalid";
export const TRW10_PORTS = { on: 3191, off: 3192, service: 8191 } as const;
export const SEED_MARKER = "TRW-10 synthetic";
export const BULK_CLIENT = "HH-TRW10-BULK";

type Actor = { email: string; name: string; role: "ADMIN" | "OPERATIONS" | "ADVISOR" };
export const ADVISOR: Actor = { email: "avery@example.com", name: "Avery Stone", role: "ADVISOR" };
export const OPERATIONS: Actor = { email: "ops@example.com", name: "Riley Ops", role: "OPERATIONS" };
export const ADMIN: Actor = { email: "admin@example.com", name: "Dana Admin", role: "ADMIN" };

/** In creation order (oldest first); the export lists them newest first. */
export const SEEDED = [
  { actor: ADVISOR, clientIds: ["HH-001"], clientNames: ["The Richardson Family"], accounts: ["NEAX-1399", "ACCT-1002"], trade: "Raise Cash", path: ["Approved"] },
  { actor: ADVISOR, clientIds: ["HH-002"], clientNames: ["Emory & Chaim Aufderhar"], accounts: ["ACCT-2001"], trade: "Liquidate", path: ["Needs Info"] },
  { actor: OPERATIONS, clientIds: ["HH-003"], clientNames: ["David Park"], accounts: ["IGIO-2095"], trade: "Raise Cash", path: [], unresolved: true },
  { actor: ADVISOR, clientIds: ["HH-001", "HH-003"], clientNames: ["The Richardson Family", "David Park"], accounts: ["ACCT-1003", "ACCT-3001"], trade: "Initial Funding", path: ["Pending Current Asset Liquidation"] },
  { actor: ADVISOR, clientIds: ["HH-002"], clientNames: ["Emory & Chaim Aufderhar"], accounts: ["ACCT-2002"], trade: "Raise Cash", path: ["Rejected"] },
  { actor: ADVISOR, clientIds: ["HH-001"], clientNames: ["The Richardson Family"], accounts: ["NEAX-1399"], trade: "Liquidate", path: ["Completed"] },
] as const;
export const SEED_TOTAL = SEEDED.length;
export const CLIENT_EXCLUSIONS = [
  { clientId: "HH-001", ticker: "SYNA", kind: "advisor", reason: "Synthetic concentrated position", noBuy: true, noSell: false },
  { clientId: "HH-001", ticker: "SYNC", kind: "client", reason: "", noBuy: true, noSell: true },
] as const;
export const ACCOUNT_EXCLUSION = { accountNumber: "NEAX-1399", ticker: "SYND", kind: "advisor", reason: "", noBuy: false, noSell: true } as const;

export function serviceUrl(): string {
  return `http://127.0.0.1:${TRW10_PORTS.service}`;
}

function seedKey(): string {
  const key = process.env.TRW10_LOCAL_KEY;
  if (!key) throw new Error("trw10_local_key_required");
  return key;
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function sign(claims: Record<string, unknown>, key: string): string {
  const input = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`;
  return `${input}.${createHmac("sha256", key).update(input).digest("base64url")}`;
}

async function call<T>(actor: Actor, method: string, path: string, body?: unknown): Promise<T> {
  const key = seedKey();
  const audience = `${serviceUrl()}/api/aoa`;
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
  if (!response.ok) throw new Error(`trw10_seed_${method}_${path}_${response.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

type Row = { id: string; status: string; updatedAt: string; advisorNotes?: string };
type Client = { id: string; accounts: Array<{ id: string; accountNumber: string }> };

function payload(index: number) {
  const seed = SEEDED[index];
  const base = {
    clientId: seed.clientIds[0], clientName: seed.clientNames[0], clientIds: [...seed.clientIds], clientNames: [...seed.clientNames],
    selectedAccounts: [...seed.accounts], priority: "Standard", advisorNotes: `${SEED_MARKER} #${index + 1}`,
    idempotencyKey: randomUUID(), tradeAmount: String(20_000 + index * 250),
    ...("unresolved" in seed ? { accountsData: [{ accountNumber: "IGIO-2095", accountType: "Taxable", balance: 75_000 }] } : {}),
  };
  if (seed.trade === "Raise Cash") return { ...base, tradeType: seed.trade, raiseCashReason: "Synthetic liquidity need" };
  if (seed.trade === "Liquidate") return { ...base, tradeType: seed.trade, liquidateOption: "Entire Account" };
  return { ...base, tradeType: seed.trade, riskProfile: 12, residence: "Other", liquidationApproval: "Yes" };
}

async function seededCount(): Promise<number> {
  const all = await call<{ data: Row[] }>(ADMIN, "GET", "/requests?all=true");
  return all.data.filter((row) => row.advisorNotes?.startsWith(SEED_MARKER)).length;
}

/** Creates the synthetic set once; a later run with the set present only re-checks the exclusions. */
export async function seedTradeRequestsExport(): Promise<void> {
  for (let index = await seededCount(); index < SEED_TOTAL; index += 1) {
    let row = (await call<{ data: Row }>(SEEDED[index].actor, "POST", "/requests", payload(index))).data;
    for (const status of SEEDED[index].path) {
      row = (await call<{ data: Row }>(ADMIN, "PUT", `/requests/${encodeURIComponent(row.id)}/status`, {
        status, note: SEED_MARKER, expectedUpdatedAt: row.updatedAt,
      })).data;
    }
  }
  const standing = await call<{ data: Record<string, Array<{ ticker: string; kind: string }>> }>(ADMIN, "POST", "/clients/exclusions/bulk", { clientIds: ["HH-001"] });
  for (const exclusion of CLIENT_EXCLUSIONS) {
    if ((standing.data["HH-001"] ?? []).some((row) => row.ticker === exclusion.ticker && row.kind === exclusion.kind)) continue;
    const { clientId, ...body } = exclusion;
    await call(ADMIN, "POST", `/clients/${clientId}/exclusions`, body);
  }
  const clients = (await call<{ data: Client[] }>(ADMIN, "GET", "/clients")).data;
  const accountId = clients.flatMap((client) => client.accounts).find((account) => account.accountNumber === ACCOUNT_EXCLUSION.accountNumber)?.id;
  if (!accountId) throw new Error("trw10_seed_account_missing");
  const existing = await call<{ data: Record<string, Array<{ ticker: string }>> }>(ADMIN, "POST", "/clients/account-exclusions/bulk", { accountIds: [accountId] });
  if (!(existing.data[accountId] ?? []).some((row) => row.ticker === ACCOUNT_EXCLUSION.ticker)) {
    const { accountNumber: _accountNumber, ...body } = ACCOUNT_EXCLUSION;
    await call(ADMIN, "POST", `/clients/account-exclusions/${encodeURIComponent(accountId)}/batch`, { add: [body] });
  }
}
