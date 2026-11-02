import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { withUserScope } from "@/lib/rls";
import { assetTransferWorkspaceEnabled } from "@/lib/flags";
import { canRecordClientServiceTransferFact } from "@/lib/data/transfer-write";
import {
  buildStatementDocument,
  recordStatementSubmission,
  StatementUploadError,
  type BuiltStatementDocument,
} from "@/lib/data/transfer-statement-documents";
import { STATEMENT_MAX_BYTES, STATEMENT_MAX_REQUEST_BYTES, STATEMENT_MESSAGES } from "@/lib/transfers/statement-document";
import { demoMode } from "@/lib/demo/mode";
import { demoSampleStatement } from "@/lib/demo/sample-statement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache", "X-Content-Type-Options": "nosniff" };
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The public demo takes no files, so its form is a few short fields: anything larger is an upload. */
const DEMO_MAX_REQUEST_BYTES = 16 * 1024;

function reply(status: number, body: { ok: boolean; message: string }) {
  return Response.json(body, { status, headers });
}

/** Browsers send Origin on a cross-site POST; it must name this host. */
function crossSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

/** Adds a statement file with its date and review, or re-reviews the pending file. */
export async function POST(request: Request, { params }: { params: Promise<{ transferId: string }> }) {
  if (!assetTransferWorkspaceEnabled()) return reply(404, { ok: false, message: "Not found." });
  const session = await auth();
  const email = session?.user?.email;
  const role = (session?.user as { role?: string } | undefined)?.role ?? null;
  if (!email) return reply(401, { ok: false, message: "Sign in again to continue." });
  if (!canRecordClientServiceTransferFact(role)) return reply(403, { ok: false, message: STATEMENT_MESSAGES.role });
  if (crossSite(request)) return reply(403, { ok: false, message: STATEMENT_MESSAGES.unavailable });
  const { transferId } = await params;
  if (!ID.test(transferId ?? "")) return reply(404, { ok: false, message: STATEMENT_MESSAGES.unavailable });

  const declared = Number(request.headers.get("content-length") ?? "0");
  // The public demo stores no visitor files: every other visitor could download them, and nothing bounds how many.
  if (demoMode() && Number.isFinite(declared) && declared > DEMO_MAX_REQUEST_BYTES) {
    return reply(413, { ok: false, message: STATEMENT_MESSAGES.demoUploadsOff });
  }
  if (Number.isFinite(declared) && declared > STATEMENT_MAX_REQUEST_BYTES) {
    return reply(413, { ok: false, message: STATEMENT_MESSAGES.tooLarge });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reply(400, { ok: false, message: STATEMENT_MESSAGES.unavailable });
  }

  let file: BuiltStatementDocument | undefined;
  const upload = form.get("file");
  if (demoMode()) {
    if (upload instanceof File && upload.size > 0) return reply(403, { ok: false, message: STATEMENT_MESSAGES.demoUploadsOff });
    if (text(form, "sample") === "1") {
      try {
        file = await demoSampleStatement();
      } catch {
        return reply(503, { ok: false, message: STATEMENT_MESSAGES.unavailable });
      }
    }
  } else if (upload instanceof File && upload.size > 0) {
    if (upload.size > STATEMENT_MAX_BYTES) return reply(413, { ok: false, message: STATEMENT_MESSAGES.tooLarge });
    try {
      file = buildStatementDocument({
        filename: upload.name,
        contentType: upload.type,
        content: new Uint8Array(await upload.arrayBuffer()),
      });
    } catch (error) {
      if (error instanceof StatementUploadError) return reply(error.status, { ok: false, message: error.message });
      throw error;
    }
  }
  const documentId = text(form, "documentId");
  if (documentId && !ID.test(documentId)) return reply(400, { ok: false, message: STATEMENT_MESSAGES.noFile });

  const identity = { role, email };
  try {
    const result = await withUserScope(identity, (tx) => recordStatementSubmission(tx, identity, transferId, {
      version: text(form, "version"),
      statementDate: text(form, "statementDate"),
      review: text(form, "review"),
      file,
      documentId: file ? undefined : documentId || undefined,
      reuseStoredCopy: demoMode() && file !== undefined,
    }));
    if (!result.ok) return reply(result.status, { ok: false, message: result.message });
    revalidatePath(`/asset-transfer/${transferId}`);
    return reply(200, { ok: true, message: result.message });
  } catch {
    return reply(503, { ok: false, message: STATEMENT_MESSAGES.unavailable });
  }
}
