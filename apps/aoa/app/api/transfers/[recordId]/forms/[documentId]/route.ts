import { auth } from "@/auth";
import { downloadTrackerTransferForm, TransferFormBridgeError } from "@/lib/data/transfer-form-bridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = {
  "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache", "X-Content-Type-Options": "nosniff",
};

export async function GET(_request: Request, { params }: { params: Promise<{ recordId: string; documentId: string }> }) {
  try {
    const session = await auth();
    const role = (session?.user as { role?: string } | undefined)?.role;
    if (!session?.user?.email || (role !== "ADMIN" && role !== "OPERATIONS")) {
      return Response.json({ error: "forbidden" }, { status: 403, headers });
    }
    const { recordId, documentId } = await params;
    const result = await downloadTrackerTransferForm({ email: session.user.email, role }, recordId, documentId);
    return new Response(new Uint8Array(result.bytes), {
      status: 200, headers: { ...headers, "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${result.filename}"`, "X-Transfer-Document-Sha256": result.sha256 },
    });
  } catch (error) {
    const reason = error instanceof TransferFormBridgeError ? error.reason : "unavailable";
    const status = reason === "forbidden" ? 403 : reason === "invalid" ? 400 : reason === "not_found" ? 404 : 503;
    return Response.json({ error: reason }, { status, headers });
  }
}
