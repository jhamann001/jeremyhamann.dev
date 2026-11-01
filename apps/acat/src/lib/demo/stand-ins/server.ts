// The outside world, for the demo. The fee store, the warehouse's client-directory question, the
// statement pipeline and Slack's incoming webhook each answer here in their real wire format, on a
// loopback-only port inside the container. The app reaches them through its ordinary clients,
// pointed here by configuration, so every integration's own code runs unchanged. Nothing outside the
// container can connect, and each endpoint still checks the credential the app sends.

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { directoryRows } from "../directory";
import { standInPipelineToken, standInsPort } from "../flags";
import type { OutboxEntry } from "../outbox";
import { pipelineStatements, type PipelineStatement } from "../statements";
import type { Universe } from "../universe";

// ─── Wiring ───────────────────────────────────────────────────────────────────

/** A row as the fee store's REST API spells it. */
export interface FeeStoreRow {
  id: number;
  client_name: string;
  client_user_id: string | null;
  fee_type: string;
  fee_amount: number;
  account_numbers: string;
  waiver_reason: string | null;
  submission_date: string;
  status: string;
  apex_request: string | null;
  user_role: string | null;
}

export interface FeeRowStore {
  list(filter: { client_name?: string; account_numbers?: string }): Promise<FeeStoreRow[]>;
  create(row: Omit<FeeStoreRow, "id">): Promise<FeeStoreRow>;
  remove(id: number): Promise<FeeStoreRow | null>;
}

export interface StandInDeps {
  universe(): Universe;
  now(): Date;
  feeRows: FeeRowStore;
  recordOutbox(entry: OutboxEntry): Promise<void>;
}

// ─── Plumbing ─────────────────────────────────────────────────────────────────

const MAX_BODY = 1024 * 1024;

class HttpError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`stand-in ${status}`);
  }
}

function sameSecret(provided: string | null | undefined, expected: string | null | undefined): boolean {
  if (!provided || !expected) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

function bearer(req: IncomingMessage): string | null {
  return req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? null;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, { message: "Payload too large" });
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, { message: "Body is not valid JSON" });
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (typeof body === "string") {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    res.end(body);
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// ─── Fee store (REST rows API) ───────────────────────────────────────────────

async function feeStore(req: IncomingMessage, res: ServerResponse, path: string[], url: URL, deps: StandInDeps): Promise<void> {
  if (!sameSecret(bearer(req), process.env.FEE_STORE_API_KEY)) throw new HttpError(401, { message: "Unauthorized" });
  const [table, rows, id, ...rest] = path;
  if (table !== process.env.FEE_STORE_FEES_TABLE_ID || rows !== "rows" || rest.length > 0) throw new HttpError(404, { message: "Not found" });

  if (req.method === "GET" && id === undefined) {
    let filter: Record<string, unknown> = {};
    const raw = url.searchParams.get("filter");
    if (raw) {
      try {
        filter = JSON.parse(raw);
      } catch {
        throw new HttpError(400, { message: "filter is not valid JSON" });
      }
    }
    const pickText = (key: string) => (typeof filter[key] === "string" ? (filter[key] as string) : undefined);
    send(res, 200, { data: await deps.feeRows.list({ client_name: pickText("client_name"), account_numbers: pickText("account_numbers") }) });
    return;
  }

  if (req.method === "POST" && id === undefined) {
    const body = (await readJson(req)) as Record<string, unknown>;
    const text = (key: string) => (typeof body[key] === "string" && (body[key] as string).trim() ? (body[key] as string) : null);
    const amount = Number(body.fee_amount);
    if (!text("client_name") || !text("account_numbers") || !text("fee_type") || !Number.isFinite(amount)) {
      throw new HttpError(400, { message: "client_name, fee_type, fee_amount and account_numbers are required" });
    }
    const created = await deps.feeRows.create({
      client_name: text("client_name")!,
      client_user_id: text("client_user_id"),
      fee_type: text("fee_type")!,
      fee_amount: amount,
      account_numbers: text("account_numbers")!,
      waiver_reason: text("waiver_reason"),
      submission_date: text("submission_date") ?? deps.now().toISOString(),
      status: text("status") ?? "Pending",
      apex_request: text("apex_request"),
      user_role: text("user_role"),
    });
    send(res, 201, { data: [created] });
    return;
  }

  if (req.method === "DELETE" && id !== undefined) {
    const removed = /^\d+$/.test(id) ? await deps.feeRows.remove(Number(id)) : null;
    if (!removed) throw new HttpError(404, { message: "Row not found" });
    send(res, 200, { data: [removed] });
    return;
  }
  throw new HttpError(405, { message: "Method not allowed" });
}

// ─── Warehouse (the client directory's saved question) ───────────────────────

async function warehouse(req: IncomingMessage, res: ServerResponse, path: string[], deps: StandInDeps): Promise<void> {
  if (!sameSecret(req.headers["x-api-key"] as string | undefined, process.env.CLIENT_DIRECTORY_WAREHOUSE_API_KEY)) {
    throw new HttpError(401, { message: "Unauthenticated" });
  }
  const [api, card, id, query, format] = path;
  if (req.method !== "POST" || api !== "api" || card !== "card" || query !== "query" || format !== "json"
    || id !== process.env.CLIENT_DIRECTORY_WAREHOUSE_CARD_ID) {
    throw new HttpError(404, { message: "Not found." });
  }
  await readJson(req);
  send(res, 200, directoryRows(deps.universe(), deps.now()));
}

// ─── Statement pipeline ──────────────────────────────────────────────────────

const normalizeNumber = (value: string) => value.replace(/[\s-]/g, "").toUpperCase();

function accountSummary(s: PipelineStatement): Record<string, unknown> {
  const { positions, ...rest } = s;
  return { ...rest, position_count: positions.length };
}

async function pipeline(req: IncomingMessage, res: ServerResponse, path: string[], url: URL, deps: StandInDeps): Promise<void> {
  if (!sameSecret(bearer(req), standInPipelineToken())) throw new HttpError(401, { detail: "Unauthorized" });
  if (req.method !== "GET") throw new HttpError(405, { detail: "Method not allowed" });
  const statements = pipelineStatements(deps.universe(), deps.now());

  if (path[0] === "positions") {
    const accountId = url.searchParams.get("account_id");
    const accountNumber = url.searchParams.get("account_number");
    const found = accountId
      ? statements.find((s) => s.id === accountId)
      : accountNumber ? statements.find((s) => normalizeNumber(s.account_number) === normalizeNumber(accountNumber)) : undefined;
    if (!found) throw new HttpError(404, { detail: "Account not found" });
    send(res, 200, found);
    return;
  }

  if (path[0] === "position-accounts") {
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    if (q.length < 2) throw new HttpError(400, { detail: "q must be at least 2 characters" });
    const digits = normalizeNumber(q);
    const matches = statements.filter((s) => s.client_name.toLowerCase().includes(q) || normalizeNumber(s.account_number).includes(digits.toUpperCase()));
    send(res, 200, { accounts: matches.slice(0, 25).map(accountSummary), truncated: matches.length > 25 });
    return;
  }
  throw new HttpError(404, { detail: "Not found" });
}

// ─── Slack incoming webhook ──────────────────────────────────────────────────

async function slack(req: IncomingMessage, res: ServerResponse, url: URL, deps: StandInDeps): Promise<void> {
  // The webhook URL itself is the credential, as with Slack.
  let expected: string | null = null;
  try {
    expected = new URL(process.env.SLACK_WEBHOOK_URL ?? "").pathname;
  } catch {
    expected = null;
  }
  if (req.method !== "POST" || !sameSecret(url.pathname, expected)) throw new HttpError(404, "no_service");
  const body = (await readJson(req)) as { text?: unknown; blocks?: unknown };
  if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "no_text");
  await deps.recordOutbox({
    transport: "slack",
    destination: "#transfers",
    title: body.text,
    payload: { text: body.text, ...(Array.isArray(body.blocks) ? { blocks: body.blocks } : {}) } as OutboxEntry["payload"],
    at: deps.now(),
  });
  send(res, 200, "ok");
}

// ─── Router ──────────────────────────────────────────────────────────────────

export function standInHandler(deps: StandInDeps): RequestListener {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let parts: string[] = [];
    // Parsed inside route(), so a malformed path is a 400 and not an exception in the app's process.
    const route = async () => {
      try {
        parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      } catch {
        throw new HttpError(400, { message: "Malformed path" });
      }
      if (parts[0] === "fee-store") return feeStore(req, res, parts.slice(1), url, deps);
      if (parts[0] === "warehouse") return warehouse(req, res, parts.slice(1), deps);
      if (parts[0] === "api" && parts[1] === "v1") return pipeline(req, res, parts.slice(2), url, deps);
      if (parts[0] === "slack") return slack(req, res, url, deps);
      throw new HttpError(404, { message: "Not found" });
    };
    route().catch((error: unknown) => {
      // A store's own refusal, such as a demo cap (DemoLimitError), answers with its status.
      const refusal = error instanceof Error ? (error as Error & { status?: unknown }).status : undefined;
      if (error instanceof HttpError) send(res, error.status, error.body);
      else if (typeof refusal === "number" && refusal < 500) send(res, refusal, { message: (error as Error).message });
      else {
        // Only the service name: the Slack webhook's path is its credential.
        console.error("[stand-ins] request failed", { service: parts[0] ?? "", error: error instanceof Error ? error.name : "UnknownError" });
        send(res, 500, { message: "Stand-in error" });
      }
    });
  };
}

/** Start the stand-ins on 127.0.0.1. Resolves once they are listening. */
export function startStandIns(deps: StandInDeps, port = standInsPort()): Promise<Server> {
  const server = createServer(standInHandler(deps));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
