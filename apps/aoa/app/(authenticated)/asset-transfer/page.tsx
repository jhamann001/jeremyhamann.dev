import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getTransferDirectory } from "@/lib/data/transfer-directory";
import { getAssetTransferWorkspace } from "@/lib/data/asset-transfer-workspace";
import { parseTransferBoardQuery, type TransferBoardQuery, type WorkspaceView } from "@/lib/navigation/transfer-query";
import { listPageHref } from "@/lib/navigation/list-routes";
import { canWriteTransfers } from "@/lib/data/transfer-write";
import { canReviewAssetMapLinks } from "@/lib/data/asset-map-review-authz";
import { assetTransferWorkspaceEnabled } from "@/lib/flags";
import { Button, SectionLabel } from "@/components/ui";
import { ProgressiveTransferBoard } from "@/components/transfers/ProgressiveTransferBoard";
import { TransfersView } from "@/components/asset-transfer/views/TransfersView";
import { viewHref } from "@/components/asset-transfer/views/view-helpers";
import { NewTransferDialog } from "@/components/asset-transfer/views/NewTransferDialog";
import { WorkingAs } from "@/components/asset-transfer/workspace/ui";
import { WorkspaceShell } from "@/components/asset-transfer/workspace/WorkspaceShell";

export default async function AssetTransferPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await auth(); if (!session?.user) redirect("/");
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  const identity = { role, email: session.user.email ?? null };
  const workspace = assetTransferWorkspaceEnabled();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (Array.isArray(value)) for (const item of value) params.append(key, item);
    else if (value !== undefined && (!workspace || value !== "")) params.set(key, value);
  }
  let query;
  try { query = parseTransferBoardQuery(params); } catch { redirect("/asset-transfer"); }
  const actions = <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
    {canReviewAssetMapLinks(role) ? <Link href="/asset-mapping-review" className="btn" prefetch={false}>Review asset mapping</Link> : null}
    {canWriteTransfers(role) ? <Link href="/asset-transfer/new" prefetch={false}><Button variant="primary">+ New transfer</Button></Link> : null}
  </div>;
  if (workspace) return <AssetTransferWorkspace identity={identity} query={query} params={params} scope={session.navigationScope ?? ""} />;
  const page = await getTransferDirectory(identity, query);
  if (page.page > page.pageCount) redirect(listPageHref(query.href, page.pageCount));
  return <>
    <SectionLabel>Operations · The ownership gap</SectionLabel>
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <h1 style={{ marginTop: 4 }}>Asset Transfer</h1>
      {actions}
    </div>
    <p style={{ color: "var(--muted)", marginTop: 6, fontSize: 13 }}>One stateful surface for every in-flight transfer — lifecycle lanes with gates, so nothing bounces back to the advisor unseen.</p>
    <ProgressiveTransferBoard key={`${session.navigationScope}:${query.href}:${page.snapshot}`} initialPage={page} query={query} scope={session.navigationScope ?? ""} />
  </>;
}

async function AssetTransferWorkspace({ identity, query, params, scope }: {
  identity: { role: string; email: string | null }; query: TransferBoardQuery; params: URLSearchParams; scope: string;
}) {
  const requested: WorkspaceView = query.workspace.view ?? "transfers";
  if (requested === "mailing") {
    redirect(viewHref({ view: "mailing", q: query.query, mailedFrom: query.mailed.from,
      mailedThrough: query.mailed.through, mailingStatus: query.mailed.status, carrier: query.mailed.carrier }));
  }
  if (requested === "household" || requested === "queue" || requested === "activity") {
    redirect(viewHref(Object.fromEntries(params)));
  }
  const { transfers } = await getAssetTransferWorkspace(identity);
  const links = { scope, listHref: query.href };
  const create = canWriteTransfers(identity.role)
    ? <NewTransferDialog />
    : null;
  const controls = <div className="row"><WorkingAs role={identity.role} />{create}</div>;
  return <WorkspaceShell label="Asset Transfer">
    <div data-workspace-view="transfers">
      <TransfersView transfers={transfers} query={query.query} stage={query.workspace.stage} outcome={query.outcome} controls={controls} {...links} />
    </div>
  </WorkspaceShell>;
}
