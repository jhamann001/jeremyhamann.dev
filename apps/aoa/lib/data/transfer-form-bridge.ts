import "server-only";
import { createHash } from "node:crypto";
import { ServiceAuth } from "@/lib/demo/service-auth";
import { z } from "zod";
import {
  confirmReceivingTitleSchema, updateTransferScopeSchema, generateTransferFormSchema, transferFormIdSchema,
  transferFormPreparationSchema, type ConfirmReceivingTitle, type GenerateTransferForm,
  type TransferFormFailureReason, type UpdateTransferScope,
} from "@/lib/transfers/transfer-form-contract";

const auth = new ServiceAuth();
const MAX_PDF_BYTES = 10 * 1024 * 1024;
export type TransferFormActor = { email: string; role: string };
const actorSchema = z.object({ email: z.string().trim().email().max(254), role: z.enum(["ADMIN", "OPERATIONS"]) });
const generatedSchema = z.object({ documentId: transferFormIdSchema });

export class TransferFormBridgeError extends Error {
  constructor(readonly reason: TransferFormFailureReason) {
    super("Transfer form operation unavailable");
    this.name = "TransferFormBridgeError";
  }
}

function check(actor: TransferFormActor, recordId: string) {
  const identity = actorSchema.safeParse(actor);
  if (!identity.success) throw new TransferFormBridgeError("forbidden");
  if (process.env.AOA_TRANSFER_FORMS_ENABLED !== "true") throw new TransferFormBridgeError("disabled");
  if (!transferFormIdSchema.safeParse(recordId).success) throw new TransferFormBridgeError("invalid");
  return { ...identity.data, email: identity.data.email.toLowerCase() };
}

function origin() {
  // This write-capable bridge has no implicit production destination.
  if (!process.env.TRANSFER_TRACKER_URL) {
    console.error("[transfer-form-bridge] tracker_origin_unset");
    throw new TransferFormBridgeError("unavailable");
  }
  try {
    const base = new URL(process.env.TRANSFER_TRACKER_URL ?? "");
    if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash) throw new Error();
    return base.origin;
  } catch { throw new TransferFormBridgeError("unavailable"); }
}

function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new TransferFormBridgeError("unavailable"));
    if (signal.aborted) { operation.catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function responseFailure(status: number, data: unknown): TransferFormFailureReason {
  const code = typeof data === "object" && data !== null && "error" in data ? (data as { error: unknown }).error : null;
  if (status === 503 && code === "disabled") return "disabled";
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 400 && code === "invalid") return "invalid";
  if (status === 409 && code === "stale") return "stale";
  if (status === 409 && code === "review_required") return "review_required";
  return "unavailable";
}

async function request(actor: TransferFormActor, recordId: string, method: "GET" | "PUT" | "POST" | "PATCH", data?: unknown, documentId?: string) {
  const identity = check(actor, recordId);
  if (documentId && !transferFormIdSchema.safeParse(documentId).success) throw new TransferFormBridgeError("invalid");
  const base = origin();
  const timeout = method === "POST" ? 30_000 : 10_000;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeout);
  try {
    const client = await bounded(auth.getIdTokenClient(base), controller.signal);
    if (controller.signal.aborted) throw new TransferFormBridgeError("unavailable");
    const response = await bounded(client.request({
      url: `${base}/api/machine/acats/by-record/${encodeURIComponent(recordId)}/preparation${documentId ? `/documents/${encodeURIComponent(documentId)}` : ""}`,
      method, ...(data === undefined ? {} : { data }),
      responseType: documentId ? "arraybuffer" : "json",
      timeout, retry: false, maxRedirects: 0, maxContentLength: documentId ? MAX_PDF_BYTES : 2 * 1024 * 1024,
      signal: controller.signal, validateStatus: () => true,
      headers: { "Cache-Control": "no-store", "X-Aoa-Actor-Email": identity.email },
    }), controller.signal);
    if (response.status !== 200) throw new TransferFormBridgeError(responseFailure(response.status, response.data));
    return response;
  } catch (error) {
    if (error instanceof TransferFormBridgeError) throw error;
    // Transport exceptions may include Authorization, human identity or fields.
    throw new TransferFormBridgeError("unavailable");
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
}

function preparation(data: unknown, recordId: string) {
  const parsed = transferFormPreparationSchema.safeParse(data);
  if (!parsed.success || parsed.data.recordId !== recordId) throw new TransferFormBridgeError("unavailable");
  return parsed.data;
}

export async function loadTrackerTransferForm(actor: TransferFormActor, recordId: string) {
  return preparation((await request(actor, recordId, "GET")).data, recordId);
}

export async function confirmTrackerReceivingTitle(actor: TransferFormActor, recordId: string, input: ConfirmReceivingTitle) {
  check(actor, recordId);
  const parsed = confirmReceivingTitleSchema.safeParse(input);
  if (!parsed.success) throw new TransferFormBridgeError("invalid");
  return preparation((await request(actor, recordId, "PUT", parsed.data)).data, recordId);
}

export async function generateTrackerTransferForm(actor: TransferFormActor, recordId: string, input: GenerateTransferForm) {
  check(actor, recordId);
  const parsed = generateTransferFormSchema.safeParse(input);
  if (!parsed.success) throw new TransferFormBridgeError("invalid");
  const result = generatedSchema.safeParse((await request(actor, recordId, "POST", parsed.data)).data);
  if (!result.success) throw new TransferFormBridgeError("unavailable");
  return result.data;
}

export async function updateTrackerTransferScope(actor: TransferFormActor, recordId: string, input: UpdateTransferScope) {
  check(actor, recordId);
  const parsed = updateTransferScopeSchema.safeParse(input);
  if (!parsed.success) throw new TransferFormBridgeError("invalid");
  return preparation((await request(actor, recordId, "PATCH", parsed.data)).data, recordId);
}

export async function downloadTrackerTransferForm(actor: TransferFormActor, recordId: string, documentId: string) {
  const result = await request(actor, recordId, "GET", undefined, documentId);
  const bytes = Buffer.isBuffer(result.data) ? result.data
    : result.data instanceof ArrayBuffer ? Buffer.from(result.data)
    : result.data instanceof Uint8Array ? Buffer.from(result.data) : null;
  const headers = result.headers as Headers | Record<string, unknown>;
  const header = (key: string) => typeof headers.get === "function" ? headers.get(key) : (headers as Record<string, unknown>)[key.toLowerCase()];
  const digest = header("x-transfer-document-sha256");
  if (!bytes || bytes.length > MAX_PDF_BYTES || bytes.length < 5 || bytes.subarray(0, 5).toString() !== "%PDF-" ||
      String(header("content-type")).split(";")[0].trim() !== "application/pdf" ||
      header("x-transfer-document-id") !== documentId || typeof digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(digest) || createHash("sha256").update(bytes).digest("hex") !== digest) {
    throw new TransferFormBridgeError("unavailable");
  }
  return { bytes, sha256: digest, filename: `transfer-${documentId}.pdf` };
}
