import { ASSET_MAP_DOCUMENTS_DRIVE_SAVE } from "@/lib/audit";
import { assetMapBaseUrl } from "@/lib/data/asset-map";
import { saveAssetMapHouseholdToDrive } from "@/lib/data/asset-map-documents";
import { auditDocuments, documentsJson, documentsRouteIdentity } from "@/lib/data/asset-map-documents-gate";
import { isPipelineId } from "@/components/asset-mapping/workspace/edits/edit-model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ householdId: string }> }) {
  const identity = await documentsRouteIdentity(request, "operate");
  if (identity instanceof Response) return identity;
  const { householdId } = await params;
  if (!isPipelineId(householdId)) return documentsJson(400, { error: "invalid" });
  const base = assetMapBaseUrl();
  if (!base) return documentsJson(502, { error: "failed", status: null });
  const res = await saveAssetMapHouseholdToDrive(base, householdId);
  if (!res.ok) return documentsJson(502, { error: "failed", status: res.status });
  await auditDocuments(identity, {
    action: ASSET_MAP_DOCUMENTS_DRIVE_SAVE, entityType: "asset_map_household", entityId: householdId,
    detail: { reviewedAt: res.data.reviewedAt },
  });
  return documentsJson(200, { ...res.data, reviewer: identity.email });
}
