import { workspaceStageLabel, type TransferStage } from "@/lib/data/transfer-types";
import { WORKSPACE_VIEWS, type WorkspaceView } from "@/lib/navigation/transfer-query";
import { routeLabel } from "@/lib/transfers/route-label";
import { transferLifecycle, type WorkspaceTransfer } from "@/lib/transfers/workspace-queue";
import type { BadgeTone } from "@/components/asset-transfer/workspace/ui";

export function stageText(stage: TransferStage): string {
  return workspaceStageLabel(stage, true);
}

/** Household and transfer rows: Funded is complete, an active rejection blocks, anything else is still waiting. */
export function stageTone(transfer: WorkspaceTransfer): BadgeTone {
  if (transfer.stage === "FUNDED") return "completed";
  return transfer.rejection && transfer.rejection.status !== "resolved" ? "blocked" : "waiting";
}

/** The deal row's stage colour, as in the mockup's client-deal list. */
export function dealStageTone(stage: TransferStage): BadgeTone {
  switch (stage) {
    case "DECISION":
      return "neutral";
    case "IN_TRANSFER":
      return "progress";
    case "FUNDED":
      return "completed";
    default: {
      const unreachable: never = stage;
      return unreachable;
    }
  }
}

export function dealStageText(transfer: WorkspaceTransfer): string {
  if (transfer.outcome) return transfer.outcome;
  switch (transfer.stage) {
    case "DECISION":
      return transfer.statement?.accepted === false ? "Blocked · statement not accepted" : "preparation";
    case "IN_TRANSFER":
      return "Submitted · awaiting arrival";
    case "FUNDED":
      return "Funds arrived";
    default: {
      const unreachable: never = transfer.stage;
      return unreachable;
    }
  }
}

/** Paused and stopped movements carry the ATW-10 outcome as a second badge. */
export function lifecycleBadge(transfer: WorkspaceTransfer): [BadgeTone, string] | null {
  const lifecycle = transferLifecycle(transfer);
  switch (lifecycle) {
    case "active":
      return null;
    case "deferred":
      return ["waiting", transfer.outcome ?? "Deferred"];
    case "stopped":
      return ["blocked", transfer.outcome ?? "Stopped"];
    default: {
      const unreachable: never = lifecycle;
      return unreachable;
    }
  }
}

export function routeText(transfer: WorkspaceTransfer): string {
  return transfer.fundingType ? routeLabel(transfer.fundingType, transfer.appAuthorized) : "Movement path not chosen";
}

export function scopeText(transfer: WorkspaceTransfer): string | null {
  if (transfer.fundingType === "ACAT_FULL") return "Full scope";
  if (transfer.fundingType === "ACAT_PARTIAL") return "Partial scope";
  return null;
}

const NO_SOURCE = "Source account not yet added";
const NO_DESTINATION = "Receiving account not yet chosen";

function sourceKnown(transfer: WorkspaceTransfer): boolean {
  const { institution, type, last4 } = transfer.source;
  return Boolean(institution || type || last4);
}

const masked = (last4: string | null) => (last4 ? `•••• ${last4}` : null);

export function sourceInstitution(transfer: WorkspaceTransfer): string {
  return transfer.source.institution ?? (sourceKnown(transfer) ? "Source institution not recorded" : NO_SOURCE);
}

/** "Client · Individual · •••• 2488" */
export function sourceAccountLine(transfer: WorkspaceTransfer): string {
  return [transfer.clientName, transfer.source.type, masked(transfer.source.last4)].filter(Boolean).join(" · ");
}

/** "Northstar Brokerage · •••• 2488" */
export function sourceShort(transfer: WorkspaceTransfer): string {
  if (!sourceKnown(transfer)) return NO_SOURCE;
  return [sourceInstitution(transfer), masked(transfer.source.last4)].filter(Boolean).join(" · ");
}

/** "Northstar Brokerage · Individual •••• 2488" */
export function sourceWithType(transfer: WorkspaceTransfer): string {
  if (!sourceKnown(transfer)) return NO_SOURCE;
  const account = [transfer.source.type, masked(transfer.source.last4)].filter(Boolean).join(" ");
  return [sourceInstitution(transfer), account].filter(Boolean).join(" · ");
}

export function statementLine(transfer: WorkspaceTransfer): string {
  if (!transfer.statement) return "Statement not yet provided";
  return transfer.statement.accepted ? `Statement ${transfer.statement.recordedOn}` : `Statement not accepted · ${transfer.statement.recordedOn}`;
}

export function destinationType(transfer: WorkspaceTransfer): string {
  return transfer.destination.type ?? NO_DESTINATION;
}

export function destinationNumber(transfer: WorkspaceTransfer): string {
  if (transfer.destination.last4) return `•••• ${transfer.destination.last4}`;
  return transfer.destination.opening ? "Account opening pending" : "Full account number not recorded";
}

/** "Individual · •••• 5472", or the single fallback phrase when no receiving account is chosen. */
export function destinationLine(transfer: WorkspaceTransfer, separator = " · "): string {
  if (!transfer.destination.type) return NO_DESTINATION;
  return `${transfer.destination.type}${transfer.destination.last4 ? separator : " · "}${destinationNumber(transfer)}`;
}

/** "To Individual · •••• 5472" */
export function destinationTo(transfer: WorkspaceTransfer, separator = " · "): string {
  return transfer.destination.type ? `To ${destinationLine(transfer, separator)}` : NO_DESTINATION;
}

export function dealReference(transfer: WorkspaceTransfer): string {
  return transfer.dealRef ?? "No deal linked";
}

export type QueueBlocker = { tone: BadgeTone; label: string; text: string };

/** The mockup's queue blocker line: an ACAT rejection, else a statement that was not accepted. */
export function queueBlocker(transfer: WorkspaceTransfer): QueueBlocker | null {
  const rejection = transfer.rejection;
  if (rejection) {
    switch (rejection.status) {
      case "open":
        return { tone: "blocked", label: "ACAT rejected", text: `${rejection.owner} · Respond to the rejection` };
      case "returned":
        return { tone: "blocked", label: "ACAT rejected", text: "Operations · Review the returned information" };
      case "resolved":
        return { tone: "waiting", label: "Preparing resubmission", text: "Ops reviews the corrected transfer before resubmission." };
      default: {
        const unreachable: never = rejection.status;
        return unreachable;
      }
    }
  }
  if (transfer.statement && !transfer.statement.accepted && transfer.stage === "DECISION") {
    return { tone: "blocked", label: "Statement not accepted", text: `Preparation paused · statement recorded ${transfer.statement.recordedOn}` };
  }
  return null;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Detail links carry the list they came from so the transfer page can offer the way back. */
export function detailHref(transferId: string, from: WorkspaceView): string {
  return `/asset-transfer/${encodeURIComponent(transferId)}?from=${from}`;
}

function workspaceView(value: string | null | undefined): WorkspaceView | null {
  return value && (WORKSPACE_VIEWS as readonly string[]).includes(value) ? value as WorkspaceView : null;
}

/** Where each workspace view lives in the AOA navigation. */
export function viewPath(value: string | null | undefined): string {
  const view = workspaceView(value);
  if (view === null) return "/asset-transfer";
  switch (view) {
    case "transfers":
      return "/asset-transfer";
    case "mailing":
      return "/reporting/mailing";
    case "queue":
      return "/tasks";
    case "activity":
      return "/reporting/transfer-activity";
    case "household":
      return "/households";
    default: {
      const unreachable: never = view;
      return unreachable;
    }
  }
}

/** A workspace household key is `household:<Salesforce id>`; single-transfer groups have no household page. */
export function householdHref(key: string | null | undefined): string {
  const sfId = key?.startsWith("household:") ? key.slice("household:".length).trim() : "";
  return /^[A-Za-z0-9_-]{1,128}$/.test(sfId) ? `/households/${sfId}` : "/households";
}

export function viewHref(params: Record<string, string | null | undefined>): string {
  const view = workspaceView(params.view);
  if (view === "household") return householdHref(params.household);
  const url = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value && key !== "view") url.set(key, value);
  }
  url.sort();
  const query = url.toString();
  const path = viewPath(view);
  return query ? `${path}?${query}` : path;
}
