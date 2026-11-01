import { getPreparationDocument } from "@/lib/transfer-preparation-service";
import { requirePreparationId, withPreparationActor } from "@/lib/transfer-preparation-http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export async function GET(request: Request, context: { params: Promise<{ id: string; documentId: string }> }) {
  return withPreparationActor(request, async () => {
    const params = await context.params;
    const document = await getPreparationDocument(requirePreparationId(params.id), requirePreparationId(params.documentId));
    return new Response(new Uint8Array(document.content), { headers: {
      "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${document.filename}"`,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "X-Transfer-Document-Sha256": document.sha256, "X-Transfer-Document-Id": document.id,
    } });
  });
}
