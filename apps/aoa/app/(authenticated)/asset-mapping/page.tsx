import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { assetMappingClientLinkingEnabled, assetMappingDestinationsEnabled, assetMappingDocumentsEnabled, assetMappingEditsEnabled, assetMappingOnDemandImportEnabled, assetMappingReadEnabled } from "@/lib/flags";
import { canReviewAssetMapLinks, canViewAssetMapping } from "@/lib/data/asset-map-review-authz";
import { AssetMappingWorkspace } from "@/components/asset-mapping/workspace/AssetMappingWorkspace";

export default async function AssetMappingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/");
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!assetMappingReadEnabled() || !canViewAssetMapping(role)) notFound();
  // Advisor and Client Service are read-only (ticket); the actions enforce it too.
  const operate = canReviewAssetMapLinks(role);

  const run = (await searchParams).run;
  const initialRunId = typeof run === "string" && run !== "" ? run : null;

  return (
    <AssetMappingWorkspace
      initialRunId={initialRunId}
      canOperate={operate}
      canEdit={operate && assetMappingEditsEnabled()}
      canLink={assetMappingClientLinkingEnabled()}
      canEditDestinations={operate && assetMappingDestinationsEnabled()}
      documents={{ enabled: assetMappingDocumentsEnabled(), canOperate: operate }}
      onDemandImport={operate && assetMappingOnDemandImportEnabled()}
    />
  );
}
