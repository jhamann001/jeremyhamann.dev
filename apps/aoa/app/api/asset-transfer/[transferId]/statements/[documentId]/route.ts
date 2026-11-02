import { auth } from "@/auth";
import { assetTransferWorkspaceEnabled } from "@/lib/flags";
import { canWriteTransfers } from "@/lib/data/transfer-write";
import { readStatementDownload } from "@/lib/data/transfer-statement-documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache", "X-Content-Type-Options": "nosniff" };
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function asciiFilename(filename: string): string {
  return filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
}

/** Downloads a stored statement file for a role that can work transfers. */
export async function GET(_request: Request, { params }: { params: Promise<{ transferId: string; documentId: string }> }) {
  if (!assetTransferWorkspaceEnabled()) return Response.json({ error: "not_found" }, { status: 404, headers });
  const session = await auth();
  const email = session?.user?.email;
  const role = (session?.user as { role?: string } | undefined)?.role ?? null;
  if (!email) return Response.json({ error: "unauthorized" }, { status: 401, headers });
  if (!canWriteTransfers(role)) return Response.json({ error: "forbidden" }, { status: 403, headers });
  const { transferId, documentId } = await params;
  if (!ID.test(transferId ?? "") || !ID.test(documentId ?? "")) {
    return Response.json({ error: "not_found" }, { status: 404, headers });
  }
  try {
    const file = await readStatementDownload({ role, email }, transferId, documentId);
    if (!file) return Response.json({ error: "not_found" }, { status: 404, headers });
    return new Response(new Uint8Array(file.content), {
      status: 200,
      headers: {
        ...headers,
        "Content-Type": file.contentType,
        "Content-Disposition": `attachment; filename="${asciiFilename(file.filename)}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "X-Statement-Sha256": file.sha256,
      },
    });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers });
  }
}
