import { requireReviewQueueCronAuth } from "@/lib/cron/review-queue-auth";
import { reviewQueueMaterializationEnabled } from "@/lib/flags";
import { validateTradeReviewMaterialization } from "@/lib/data/review-queue-validation";

export const runtime = "nodejs";

const error = (message: string, status: number) =>
  Response.json({ error: message }, { status });
const methodNotAllowed = () => error("method_not_allowed", 405);
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

const MAX_BODY_BYTES = 4096;

async function readBoundedJson(req: Request): Promise<unknown> {
  if (!req.body) throw new Error("invalid_body");
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error("body_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } finally {
    reader.releaseLock();
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!(await requireReviewQueueCronAuth(req))) return error("unauthorized", 401);
  if (!reviewQueueMaterializationEnabled()) return error("flag_off", 404);
  const length = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return error("invalid_body", 400);

  let body: unknown;
  try {
    body = await readBoundedJson(req);
  } catch {
    return error("invalid_body", 400);
  }
  const clientReference =
    typeof body === "object" && body !== null && "clientReference" in body
      ? (body as { clientReference?: unknown }).clientReference
      : undefined;
  if (
    typeof clientReference !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(clientReference)
  ) {
    return error("invalid_client_reference", 400);
  }

  try {
    return Response.json(await validateTradeReviewMaterialization(clientReference));
  } catch {
    // Never log the request body or any derived subject key.
    console.error("[review-queue] validation_failed");
    return error("internal", 500);
  }
}
