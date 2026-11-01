import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { verifyDrawerCaller } from "@/lib/machine-auth";
import { redactAcatForMachine } from "@/lib/mcp/redaction";
import { applyAcatDelete, applyAcatPatch } from "@/lib/acat-record-write";
import { relinkAcatClients } from "@/lib/client-identity-relink";
import { directoryErrorResponse } from "@/lib/client-identity-http";
import { drawerContractEnabled, drawerRedactionOptions, parseDrawerRequest } from "@/lib/acat-drawer-contract";
import { deleteAcatSchema, formatZodError } from "@/lib/validators";
import { rateLimit } from "@/lib/rate-limit-redis";

// ticket: trusted transfer-drawer writes. Dark (opaque 404) unless both
// drawer switches are on; the gate runs before authentication or any database
// access. Every response that carries a transfer carries it under `transfer`.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const NOT_FOUND = () => NextResponse.json({ error: "not_found" }, { status: 404 });
const WRITE_LIMIT = { maxTokens: 60, interval: 60_000, failClosed: true };

type Context = { params: Promise<{ id: string }> };

async function storedTransfer(id: string) {
  const record = await prisma.acatRecord.findUnique({
    where: { id, deletedAt: null },
    include: { assets: true },
  });
  return record ? redactAcatForMachine(record, drawerRedactionOptions()) : null;
}

/** An authenticated refusal: the original status and message plus the
 * unchanged stored transfer. A missing transfer is a plain 404; a failed
 * reread is an opaque 500 (never a guessed transfer). */
async function refusal(id: string, status: number, payload: Record<string, unknown>): Promise<NextResponse> {
  try {
    const transfer = await storedTransfer(id);
    if (!transfer) return NOT_FOUND();
    return NextResponse.json({ ...payload, transfer }, { status });
  } catch (err) {
    logger.error({ err, id }, "machine drawer: unchanged transfer reread failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

async function refusalFromResponse(id: string, response: NextResponse): Promise<NextResponse> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const payload = typeof body.error === "string" ? { ...body } : { ...body, error: "refused" };
  return refusal(id, response.status, payload);
}

type Authorization = { ok: true; caller: { email: string } } | { ok: false; response: NextResponse };

async function authorize(request: Request): Promise<Authorization> {
  const caller = await verifyDrawerCaller(request, "write");
  if (!caller) return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const { allowed } = await rateLimit("machine-acat-write", caller.email, WRITE_LIMIT);
  if (!allowed) return { ok: false, response: NextResponse.json({ error: "rate_limited" }, { status: 429 }) };
  return { ok: true, caller };
}

export async function PATCH(request: Request, { params }: Context): Promise<NextResponse> {
  if (!drawerContractEnabled()) return NOT_FOUND();
  const { id } = await params;
  const auth = await authorize(request);
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refusal(id, 400, { error: "Invalid JSON body" });
  }
  const parsed = parseDrawerRequest(body);
  if (!parsed.ok) return refusal(id, 400, { error: parsed.error });

  try {
    const result =
      parsed.request.action === "replaceClient"
        ? await relinkAcatClients({ id, input: parsed.request.relink, performedBy: caller.email })
        : await applyAcatPatch({ id, body: parsed.request.patch, performedBy: caller.email });
    if (result.kind === "response") return refusalFromResponse(id, result.response);
    logger.info({ id, caller: caller.email, action: parsed.request.action, status: 200 }, "machine drawer change applied");
    return NextResponse.json({ transfer: redactAcatForMachine(result.record, drawerRedactionOptions()) });
  } catch (err) {
    const mapped = directoryErrorResponse(err);
    if (mapped) return refusalFromResponse(id, mapped);
    logger.error({ err, id, caller: caller.email }, "machine drawer change failed");
    return refusal(id, 500, { error: "internal_error" });
  }
}

export async function DELETE(request: Request, { params }: Context): Promise<NextResponse> {
  if (!drawerContractEnabled()) return NOT_FOUND();
  const { id } = await params;
  const auth = await authorize(request);
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refusal(id, 400, { error: "Invalid JSON body" });
  }
  const parsed = deleteAcatSchema.safeParse(body);
  if (!parsed.success) return refusal(id, 400, { error: formatZodError(parsed.error) });

  try {
    const result = await applyAcatDelete({ id, reason: parsed.data.reason, performedBy: caller.email });
    if (result.kind === "not_found") return NOT_FOUND();
    return NextResponse.json({ transfer: redactAcatForMachine(result.record, drawerRedactionOptions()), removed: true });
  } catch (err) {
    logger.error({ err, id, caller: caller.email }, "machine drawer delete failed");
    return refusal(id, 500, { error: "internal_error" });
  }
}
