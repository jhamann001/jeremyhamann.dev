import { readAcatWorkspace } from "@/lib/data/acat-workspace";
import { acatWorkspaceResponseSchema, type AcatWorkspaceView, type AcatWorkspaceResponse } from "@/lib/data/acat-workspace-contract";
import type { Identity } from "@/lib/data/types";
import { AcatWorkspace } from "./AcatWorkspace";

export async function AcatWorkspaceData({ identity, view, scope, sessionExpiresAt, custodianAdmin = false, authorityLibrary = false }: {
  identity: Identity; view: AcatWorkspaceView; scope: string; sessionExpiresAt: number; custodianAdmin?: boolean; authorityLibrary?: boolean;
}) {
  let initial: AcatWorkspaceResponse | null = null;
  try {
    const snapshot = await readAcatWorkspace(identity, view);
    initial = acatWorkspaceResponseSchema.parse({ snapshot, scope, sessionExpiresAt, serverNow: Date.now() });
    if (initial.serverNow >= Math.min(snapshot.expiresAt, sessionExpiresAt)) initial = null;
  } catch { /* Fail closed with the same refreshable source-unavailable UI. */ }
  return <AcatWorkspace key={scope} scope={scope} initialView={view} initial={initial} custodianAdmin={custodianAdmin} authorityLibrary={authorityLibrary} />;
}
