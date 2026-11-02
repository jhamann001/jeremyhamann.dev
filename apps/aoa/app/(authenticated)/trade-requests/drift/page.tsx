import { notFound } from "next/navigation";
import { DriftView } from "@/components/trade-requests/drift/DriftView";
import { tradeRequestsWorkspaceAccess } from "@/lib/trade-requests/workspace-gate";
import { tradeRequestsWorkspaceSections } from "@/lib/trade-requests/workspace-sections";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function TradeRequestsDriftPage({ searchParams }: { searchParams: SearchParams }) {
  const access = await tradeRequestsWorkspaceAccess();
  if (!access.allowed) return null;
  if (!(await tradeRequestsWorkspaceSections(access.role)).drift) notFound();
  const params = await searchParams;
  const one = (key: string) => (typeof params[key] === "string" ? params[key] : undefined);
  return (
    <DriftView
      canOverride={access.role === "ADMIN" || access.role === "OPERATIONS"}
      initial={{ view: one("view"), days: one("days"), status: one("status"), bucket: one("bucket"), q: one("q") }}
    />
  );
}
