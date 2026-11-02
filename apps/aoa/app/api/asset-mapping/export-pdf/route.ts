import { ASSET_MAP_DOCUMENTS_ALL_CLIENTS_PDF } from "@/lib/audit";
import { assetMapBaseUrl } from "@/lib/data/asset-map";
import { fetchAssetMapAllClientsPdf } from "@/lib/data/asset-map-documents";
import { auditDocuments, documentsJson, documentsRouteIdentity, DOCUMENTS_NO_STORE } from "@/lib/data/asset-map-documents-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = await documentsRouteIdentity(request, "view");
  if (identity instanceof Response) return identity;
  const base = assetMapBaseUrl();
  if (!base) return documentsJson(502, { error: "failed", status: null });
  const res = await fetchAssetMapAllClientsPdf(base);
  if (!res.ok) return documentsJson(502, { error: "failed", status: res.status });
  await auditDocuments(identity, {
    action: ASSET_MAP_DOCUMENTS_ALL_CLIENTS_PDF, entityType: "asset_map_export", entityId: null, detail: {},
  });
  return new Response(res.data.bytes, {
    status: 200,
    headers: { ...DOCUMENTS_NO_STORE, "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${res.data.filename}"` },
  });
}
