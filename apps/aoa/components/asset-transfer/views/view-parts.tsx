import type { WorkspaceTransfer } from "@/lib/transfers/workspace-queue";
import { Badge } from "@/components/asset-transfer/workspace/ui";
import { lifecycleBadge, queueBlocker, stageText, stageTone } from "./view-helpers";

/** Funding stage badge plus the ATW-10 outcome badge when the movement is paused or stopped. */
export function StageBadges({ transfer }: { transfer: WorkspaceTransfer }) {
  const lifecycle = lifecycleBadge(transfer);
  return <>
    <Badge tone={stageTone(transfer)}>{stageText(transfer.stage)}</Badge>
    {lifecycle ? <Badge tone={lifecycle[0]}>{lifecycle[1]}</Badge> : null}
  </>;
}

export function QueueBlocker({ transfer }: { transfer: WorkspaceTransfer }) {
  const blocker = queueBlocker(transfer);
  if (!blocker) return null;
  return <div className="queue-blocker"><Badge tone={blocker.tone}>{blocker.label}</Badge><span>{blocker.text}</span></div>;
}
