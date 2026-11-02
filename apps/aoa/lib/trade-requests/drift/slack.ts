import { DRIFT_CHANNEL_ID } from "@/lib/trade-requests/drift/targets";

// The drift channel sender for the ported alert modules (ticket), over ticket's one-attempt Slack sender and
// its `{ channel }` destination. Anything short of a confirmed post throws, so a caller holding the date claim
// releases it and a later run that day can post (standalone diverged here: an unconfigured sender was a silent
// no-op that kept the claim). Callers check `driftChannelReady()` before claiming, so a throw here is the rare
// race (configuration changed mid-run) or a real Slack failure.
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function sendDriftChannelMessage(text: string): Promise<void> {
  const channel = process.env.TRADE_REQUEST_DRIFT_SLACK_CHANNEL_ID?.trim() ?? "";
  if (!DRIFT_CHANNEL_ID.test(channel)) throw new Error("drift Slack post not sent: channel_not_configured");
  // Imported lazily: the sender module is server-only and the ported unit suites load this file.
  const { sendTradeRequestSlack } = await import("@/lib/slack/trade-requests");
  const result = await sendTradeRequestSlack({ channel }, text);
  if (result.status === "skipped") throw new Error("drift Slack post not sent: sender_skipped");
  if (result.status === "failed") throw new Error(`drift Slack post failed: ${result.code}`);
}
