import "server-only";
import { prisma } from "@/lib/db";
import { readServingState } from "@/lib/trade-requests/serving-state";
import { eligibleRecipientIds } from "@/lib/trade-requests/roster";
import {
  AOA_LINKS, buildExclusionBatchText, buildExclusionChangeText, buildNewRequestText, buildStatusChangeText,
  formatSide, sendTradeRequestSlack, type ExclusionBatchInfo, type ExclusionChangeInfo, type NewRequestInfo,
} from "@/lib/slack/trade-requests";

export type TradeRequestEvent =
  | { kind: "submitted"; request: NewRequestInfo }
  | { kind: "resubmitted"; requestId: string; clientName: string; changedBy: string }
  | {
      kind: "status_changed"; requestId: string; clientName: string; newStatus: string; note: string; changedBy: string;
      submitterId: string | null; submitterSlackId: string | null;
    }
  | { kind: "exclusion_changed"; change: ExclusionChangeInfo }
  | { kind: "exclusion_batch_changed"; batch: ExclusionBatchInfo; clientId?: string };

/** The standalone buildInAppSummary (server/src/routes/exclusions.ts:724-739 at d41b6c9). */
export function exclusionBatchBellText(clientName: string, added: number, removed: number, edited: number): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`-${removed}`);
  if (edited > 0) parts.push(`~${edited}`);
  const total = added + removed + edited;
  if (parts.length === 1) {
    if (added > 0) return `${clientName}: ${added} exclusion${added > 1 ? "s" : ""} added`;
    if (removed > 0) return `${clientName}: ${removed} exclusion${removed > 1 ? "s" : ""} removed`;
    return `${clientName}: ${edited} exclusion${edited > 1 ? "s" : ""} updated`;
  }
  return `${clientName}: ${total} exclusions changed (${parts.join(", ")})`;
}

async function addBells(userIds: string[], body: string, requestId: string | null): Promise<void> {
  if (userIds.length === 0) return;
  await prisma.$executeRaw`
    INSERT INTO trade_request.notifications (user_id, body, request_id)
    SELECT u::uuid, ${body}::text, ${requestId}::text FROM unnest(${userIds}::text[]) AS u`;
}

async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    console.error(JSON.stringify({ event: "trade_request_side_effect_failed", step: name }));
  }
}

/**
 * Runs once per committed write. Never throws (the whole body is guarded) and never blocks the caller's result.
 * No-op unless the epic master is on and Trade Requests are AOA-served (the master switch governs every AOA child).
 */
export async function emitTradeRequestEvent(event: TradeRequestEvent): Promise<void> {
  try {
    if (process.env.EPIC_TRADE_REQUESTS_BACKEND_MOVE !== "1") return;
    if ((await readServingState()).servingSource !== "aoa") return;
    await emit(event);
  } catch {
    console.error(JSON.stringify({ event: "trade_request_side_effect_failed", step: "emit" }));
  }
}

// Order follows the standalone handlers: Slack first, bells after, both after the caller's commit.
async function emit(event: TradeRequestEvent): Promise<void> {
  switch (event.kind) {
    case "submitted": {
      const r = event.request;
      await step("slack", () => sendTradeRequestSlack("channel", buildNewRequestText(r, AOA_LINKS), undefined, { requestId: r.requestId }));
      await step("bells", async () => addBells(await eligibleRecipientIds(), `New trade request ${r.requestId} submitted for ${r.clientName}`, r.requestId));
      return;
    }
    case "resubmitted": {
      await step("slack", () =>
        sendTradeRequestSlack(
          "channel",
          buildStatusChangeText(
            { requestId: event.requestId, clientName: event.clientName, newStatus: "Pending Review", note: "Advisor resubmitted request with updates.", changedBy: event.changedBy },
            AOA_LINKS,
          ),
          undefined,
          { requestId: event.requestId },
        ),
      );
      await step("bells", async () => addBells(await eligibleRecipientIds(), `Trade request ${event.requestId} resubmitted for ${event.clientName}`, event.requestId));
      return;
    }
    case "status_changed": {
      await step("slack", () =>
        sendTradeRequestSlack(event.submitterSlackId ? { user: event.submitterSlackId } : "channel", buildStatusChangeText(event, AOA_LINKS),
          undefined, { requestId: event.requestId }),
      );
      const submitterId = event.submitterId;
      if (submitterId) {
        await step("bells", () => addBells([submitterId], `Trade request ${event.requestId} status updated to: ${event.newStatus}`, event.requestId));
      }
      return;
    }
    case "exclusion_changed": {
      const c = event.change;
      await step("slack", () => sendTradeRequestSlack("channel", buildExclusionChangeText(c)));
      await step("bells", async () =>
        addBells(await eligibleRecipientIds(), `Exclusion ${c.action} for ${c.clientName}: ${c.ticker} (${c.kind}, ${formatSide(c.noBuy, c.noSell)})`, null),
      );
      return;
    }
    case "exclusion_batch_changed": {
      const b = event.batch;
      if (b.added.length + b.removed.length + b.changed.length === 0) return;
      await step("slack", async () => {
        const text = buildExclusionBatchText(b);
        if (text !== null) await sendTradeRequestSlack("channel", text, undefined, event.clientId ? { cedarRidgeUserId: event.clientId } : undefined);
      });
      await step("bells", async () =>
        addBells(await eligibleRecipientIds(), exclusionBatchBellText(b.clientName, b.added.length, b.removed.length, b.changed.length), null),
      );
      return;
    }
  }
}
