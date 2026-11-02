import { ASSET_MAP_DOCUMENTS_SCAN } from "@/lib/audit";
import { assetMapBaseUrl } from "@/lib/data/asset-map";
import { runAssetMapScan } from "@/lib/data/asset-map-documents";
import { auditDocuments, documentsJson, documentsRouteIdentity } from "@/lib/data/asset-map-documents-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const identity = await documentsRouteIdentity(request, "operate");
  if (identity instanceof Response) return identity;
  const base = assetMapBaseUrl();
  if (!base) return documentsJson(502, { error: "failed", status: null, detail: null });
  const res = await runAssetMapScan(base);
  if (!res.ok && res.reason === "busy") return documentsJson(409, { error: "busy" });
  await auditDocuments(identity, {
    action: ASSET_MAP_DOCUMENTS_SCAN, entityType: "asset_map_scan", entityId: null,
    detail: res.ok ? { outcome: "finished", clientsProcessed: res.clientsProcessed } : { outcome: "failed", clientsProcessed: null },
  });
  return res.ok
    ? documentsJson(200, { clientsProcessed: res.clientsProcessed })
    : documentsJson(502, { error: "failed", status: res.status, detail: res.detail });
}
