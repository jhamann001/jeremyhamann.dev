import { ASSET_MAP_DOCUMENTS_HOUSEHOLD_PDF } from "@/lib/audit";
import { assetMapBaseUrl } from "@/lib/data/asset-map";
import { fetchAssetMapHouseholdPdf } from "@/lib/data/asset-map-documents";
import { auditDocuments, documentsJson, documentsRouteIdentity, DOCUMENTS_NO_STORE } from "@/lib/data/asset-map-documents-gate";
import { isPipelineId } from "@/components/asset-mapping/workspace/edits/edit-model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ householdId: string }> }) {
  const identity = await documentsRouteIdentity(request, "view");
  if (identity instanceof Response) return identity;
  const { householdId } = await params;
  if (!isPipelineId(householdId)) return documentsJson(400, { error: "invalid" });
  const base = assetMapBaseUrl();
  if (!base) return documentsJson(502, { error: "failed", status: null });
  const res = await fetchAssetMapHouseholdPdf(base, householdId);
  if (!res.ok) return documentsJson(502, { error: "failed", status: res.status });
  await auditDocuments(identity, {
    action: ASSET_MAP_DOCUMENTS_HOUSEHOLD_PDF, entityType: "asset_map_household", entityId: householdId, detail: {},
  });
  return new Response(res.data.bytes, {
    status: 200,
    headers: { ...DOCUMENTS_NO_STORE, "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${res.data.filename}"` },
  });
}
