import { z } from "zod";
import { verifyMachineCaller } from "@/lib/machine-auth";
import { transferPreparationPrisma as prisma } from "@/lib/transfer-preparation-prisma";
import { rateLimit } from "@/lib/rate-limit-redis";
import { logger } from "@/lib/logger";
import { TransferPreparationError, type PreparationActor } from "@/lib/transfer-preparation-service";
import { transferFormIdSchema, type TransferFormFailureReason } from "@/lib/transfer-form-contract";

const emailSchema = z.string().trim().toLowerCase().email().max(254);
// 5,000 instruction rows with 128-character IDs plus schema-bounded metadata
// fit below 1 MiB. Only generation opts in; small mutation bodies stay at 16 KiB.
export const TRANSFER_GENERATION_MAX_BODY_BYTES = 1024 * 1024;
const statuses: Record<TransferFormFailureReason, number> = {
  disabled: 503, forbidden: 403, invalid: 400, not_found: 404, stale: 409, unavailable: 503, review_required: 409,
};
export function preparationJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
export function requirePreparationId(id: string): string {
  const result = transferFormIdSchema.safeParse(id);
  if (!result.success) throw new TransferPreparationError("invalid");
  return result.data;
}

// The feature gate, explicit write grant, OIDC identity, and current human role
// apply to every read/write/download. An ordinary Tracker read grant is not enough.
export async function withPreparationActor(request: Request, operation: (actor: PreparationActor) => Promise<Response>): Promise<Response> {
  try {
    if (process.env.OPS_PORTAL_TRANSFER_FORMS_ENABLED !== "true") throw new TransferPreparationError("disabled");
    const caller = await verifyMachineCaller(request);
    const allowed = new Set((process.env.OPS_PORTAL_TRANSFER_FORMS_ALLOWED_SAS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
    if (!caller || !allowed.has(caller.email)) throw new TransferPreparationError("forbidden");
    const email = emailSchema.safeParse(request.headers.get("X-OpsPortal-Actor-Email"));
    if (!email.success) throw new TransferPreparationError("forbidden");
    // Rate limiting uses authenticated identities only and precedes any source read.
    const limit = await rateLimit("ops-portal-transfer-preparation", `${caller.email}:${email.data}`, {
      maxTokens: request.method === "GET" ? 60 : 20, interval: 60_000, failClosed: true,
    });
    if (!limit.allowed) throw new TransferPreparationError("unavailable");
    const user = await prisma.allowedUser.findUnique({ where: { email: email.data }, select: { active: true, role: true } });
    if (!user?.active || (user.role !== "USER" && user.role !== "ADMIN")) throw new TransferPreparationError("forbidden");
    return await operation({ email: email.data, serviceAccount: caller.email });
  } catch (error) {
    const reason = error instanceof TransferPreparationError ? error.reason : "unavailable";
    // Never log request bodies, accounts, tokens, titles, or raw database errors.
    logger.warn({ reason, status: statuses[reason] }, "The advisor platform transfer preparation request failed");
    return preparationJson({ error: reason }, statuses[reason]);
  }
}

export async function preparationBody<T>(request: Request, schema: z.ZodType<T>, maxBytes = 16 * 1024): Promise<T> {
  const reader = request.body?.getReader();
  if (!reader) throw new TransferPreparationError("invalid");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new TransferPreparationError("invalid"); }
      chunks.push(value);
    }
    const parsed = schema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!parsed.success) throw new TransferPreparationError("invalid");
    return parsed.data;
  } catch { throw new TransferPreparationError("invalid"); }
}
