import "server-only";
import { revalidatePath } from "next/cache";
import { ServiceAuth } from "@/lib/demo/service-auth";
import { z } from "zod";
import { auth } from "@/auth";
import { canSeeUnlinkedAcats } from "@/lib/data/acat-lane";
import { canReadCustodianLibrary } from "@/lib/data/custodian-library-contract";
import { markAcatBookStale } from "@/lib/data/acat-workspace";
import { ACAT_EDITS_OFF, ACAT_EDIT_FORBIDDEN } from "@/lib/data/acat-book-edit";
import { acatOpsEditsEnabled, acatSecurityReconEnabled } from "@/lib/flags";
import {
  RECON_ACCOUNTS_FAILURE,
  RECON_INVALID,
  RECON_LOAD_FAILURE,
  RECON_STATUSES,
  mapReconSnapshot,
  parseReconAccounts,
  reconResultFromUpstream,
  type ReconAccountsResult,
  type ReconActionBody,
  type ReconFailure,
  type ReconResult,
} from "@/lib/data/acat-security-recon-contract";

// Security reconciliation, server side (ticket). AoA reads and writes the
// tracker through its trusted machine boundary; it stores nothing. This module
// owns its own machine call (instead of readAcatMachine / writeAcatBookRecord)
// because the tracker's refusal message travels in the x-recon-refusal
// response header, which those helpers drop.
//
// KEYLESS, NO-LOG discipline as lib/data/acat-status.ts: the ID token comes
// from the ambient identity, and only static markers reach a log.

const TRANSFER_TRACKER_URL = (
  process.env.TRANSFER_TRACKER_URL ?? "https://transfers.jeremyhamann.dev"
).replace(/\/+$/, "");
const LOG_TAG = "acat-security-recon";
const googleAuth = new ServiceAuth();

const RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const isReconRecordId = (id: string): boolean => RECORD_ID.test(id);

function fixtureMode(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.ACAT_FIXTURE === "1";
}

function headerValue(headers: unknown, name: string): string | null {
  if (!headers) return null;
  const maybe = headers as { get?: unknown };
  if (typeof maybe.get === "function") {
    const value = (headers as Headers).get(name);
    return typeof value === "string" ? value : null;
  }
  const record = headers as Record<string, unknown>;
  const raw = record[name] ?? record[name.toLowerCase()];
  if (typeof raw === "string") return raw;
  return Array.isArray(raw) && typeof raw[0] === "string" ? raw[0] : null;
}

export type ReconMachineResponse = { status: number | null; data: unknown; refusal: string | null };

export async function callReconMachine(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<ReconMachineResponse> {
  if (fixtureMode()) return { status: null, data: null, refusal: null };
  try {
    const client = await googleAuth.getIdTokenClient(TRANSFER_TRACKER_URL);
    const res = await client.request({
      url: `${TRANSFER_TRACKER_URL}${path}`,
      method,
      ...(method === "POST" ? { data: body } : {}),
      validateStatus: () => true,
      retry: false,
      timeout: timeoutMs,
      headers: { "Cache-Control": "no-store" },
    });
    return { status: res.status, data: res.data, refusal: headerValue(res.headers, "x-recon-refusal") };
  } catch {
    console.error(`[${LOG_TAG}] transport_failed`);
    return { status: null, data: null, refusal: null };
  }
}

export type ReconGate =
  | { ok: true; role: string }
  | { ok: false; status: 401 | 403 | 404; reason: string };

/** Flag first (dark means 404 before any other work), then session, role, and,
 *  for a write or an account search, the edits switch. */
export async function reconGate(kind: "read" | "write"): Promise<ReconGate> {
  if (!acatSecurityReconEnabled()) return { ok: false, status: 404, reason: "not_found" };
  const session = await auth();
  if (!session?.user) return { ok: false, status: 401, reason: ACAT_EDIT_FORBIDDEN };
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!canSeeUnlinkedAcats(role) || !canReadCustodianLibrary(role)) {
    return { ok: false, status: 403, reason: ACAT_EDIT_FORBIDDEN };
  }
  if (kind === "write" && !acatOpsEditsEnabled()) return { ok: false, status: 403, reason: ACAT_EDITS_OFF };
  return { ok: true, role };
}

const reconPath = (id: string) => `/api/machine/acats/by-record/${encodeURIComponent(id)}/security-recon`;

function failure(reason: string, retryable: boolean): ReconFailure {
  return { ok: false, refused: false, reason, retryable };
}

export async function loadRecon(recordId: string): Promise<ReconResult> {
  const res = await callReconMachine("GET", reconPath(recordId), undefined, 12_000);
  if (res.status === 200) {
    const snapshot = mapReconSnapshot(res.data);
    if (snapshot) return { ok: true, snapshot, preview: null };
  }
  if (res.status === 404) return failure("This transfer was not found.", false);
  return failure(RECON_LOAD_FAILURE, true);
}

const ACCOUNT_QUERY_SHORT = "Enter a client name or account number (2–100 characters).";

export async function searchReconAccounts(recordId: string, query: string): Promise<ReconAccountsResult> {
  const q = (query ?? "").trim();
  if (q.length < 2 || q.length > 100) return { ok: false, reason: ACCOUNT_QUERY_SHORT, retryable: false };
  const res = await callReconMachine(
    "GET",
    `${reconPath(recordId)}/accounts?q=${encodeURIComponent(q)}`,
    undefined,
    15_000,
  );
  if (res.status === 200) {
    const parsed = parseReconAccounts(res.data);
    if (parsed) return { ok: true, ...parsed };
  }
  const error = (res.data as { error?: unknown } | null)?.error;
  if ((res.status === 400 || res.status === 502 || res.status === 503) && typeof error === "string" && error.trim() !== "") {
    return { ok: false, reason: error.trim().slice(0, 300), retryable: res.status !== 400 };
  }
  return { ok: false, reason: RECON_ACCOUNTS_FAILURE, retryable: true };
}

const rowSchema = z.object({
  id: z.string().min(1).max(100),
  symbol: z.string().max(100),
  description: z.string().max(500),
  cusip: z.string().max(20).nullish(),
  actualQty: z.number().finite(),
  amount: z.number().finite().nullish(),
  assetClass: z.string().max(100).nullish(),
  status: z.enum(RECON_STATUSES),
  issue: z.string().max(2000).nullish(),
  notes: z.string().max(5000).nullish(),
});

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("refresh"), sourceAccountId: z.string().uuid().optional() }),
  z.object({
    action: z.literal("upload"),
    kind: z.enum(["apex", "mapping"]),
    filename: z.string().min(1).max(255),
    text: z.string().max(5_000_000),
  }),
  z.object({
    action: z.literal("save"),
    rows: z.array(rowSchema).max(500),
    apexUploaded: z.boolean(),
    overriddenIds: z.array(z.string().max(100)).max(500),
  }),
]);

export function parseReconActionBody(raw: unknown): { ok: true; body: ReconActionBody } | { ok: false; reason: string } {
  const parsed = actionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: RECON_INVALID };
  return { ok: true, body: parsed.data as ReconActionBody };
}

const ACTION_TIMEOUT_MS: Record<ReconActionBody["action"], number> = {
  refresh: 55_000,
  upload: 40_000,
  save: 40_000,
};

export async function runReconAction(recordId: string, body: ReconActionBody): Promise<ReconResult> {
  const res = await callReconMachine("POST", reconPath(recordId), body, ACTION_TIMEOUT_MS[body.action]);
  const result = reconResultFromUpstream(res);
  // An Apex upload previews and writes nothing; every other success changed
  // the stored positions, so the book must not keep serving its old counts.
  const writes = !(body.action === "upload" && body.kind === "apex");
  if (result.ok && writes) {
    markAcatBookStale();
    revalidatePath("/acat-tracking");
  }
  return result;
}

// ---------------------------------------------------------------------------
// HTTP helpers shared by the two route handlers
// ---------------------------------------------------------------------------

export const RECON_HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie" } as const;
export const RECON_BODY_LIMIT_BYTES = 6_000_000;

export function reconFailureResponse(status: number, reason: string, retryable: boolean): Response {
  return Response.json({ ok: false, refused: false, reason, retryable }, { status, headers: RECON_HEADERS });
}

/** The route envelope the browser parses (parseReconEnvelope). */
export function reconEnvelopeResponse(result: ReconResult): Response {
  if (result.ok) {
    const body = result.preview
      ? { ok: true, snapshot: result.snapshot, preview: result.preview }
      : { ok: true, snapshot: result.snapshot };
    return Response.json(body, { headers: RECON_HEADERS });
  }
  if (result.refused) return Response.json(result, { headers: RECON_HEADERS });
  return reconFailureResponse(result.retryable ? 502 : 422, result.reason, result.retryable);
}

export function reconAccountsResponse(result: ReconAccountsResult): Response {
  if (result.ok) {
    return Response.json({ ok: true, accounts: result.accounts, truncated: result.truncated }, { headers: RECON_HEADERS });
  }
  return Response.json(
    { ok: false, reason: result.reason, retryable: result.retryable },
    { status: result.retryable ? 502 : 400, headers: RECON_HEADERS },
  );
}

/** Reads a request body without trusting Content-Length: a declared length
 *  over the limit is refused before reading, and the stream is counted and
 *  cancelled once it passes the limit. */
export async function readBoundedBody(
  request: Request,
  limit: number = RECON_BODY_LIMIT_BYTES,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return { ok: false };
  if (!request.body) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}

/** Everything every request needs before it touches the tracker. Returns the
 *  refusal response, or the gated role. */
export async function reconPrelude(
  request: Request,
  kind: "read" | "write",
  recordId: string,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const gate = await reconGate(kind);
  if (!gate.ok) {
    if (gate.status === 404) return { ok: false, response: Response.json({ error: "not_found" }, { status: 404 }) };
    return { ok: false, response: reconFailureResponse(gate.status, gate.reason, false) };
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return { ok: false, response: reconFailureResponse(403, ACAT_EDIT_FORBIDDEN, false) };
  }
  if (request.method === "POST" && !(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return { ok: false, response: reconFailureResponse(415, RECON_INVALID, false) };
  }
  if (!isReconRecordId(recordId)) {
    return { ok: false, response: reconFailureResponse(404, "This transfer was not found.", false) };
  }
  return { ok: true };
}
