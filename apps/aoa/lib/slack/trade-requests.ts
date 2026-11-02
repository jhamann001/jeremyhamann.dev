import "server-only";
import { tradeRequestsSlackEnabled } from "@/lib/flags";
import { demoMode } from "@/lib/demo/mode";

// Trade Request Slack messages (ticket). The builders are line-for-line ports of the standalone service's
// server/src/services/slack.ts (trade-request d41b6c9); only the link targets differ, and they are parameters so
// test/trade-request-slack-wording.test.ts can prove the wording against the captured standalone fixture.
export const TRADE_REQUESTS_SLACK_ORIGIN = "https://aoa.jeremyhamann.dev";
const SLACK_ENDPOINT = "https://slack.com/api/chat.postMessage";
const TIMEOUT_MS = 5_000;

export type SlackLinks = { requestUrl: (id: string) => string; editUrl: (id: string) => string };
/** The public demo only: the request or client a post is about, so its Outbox shows the capture to the personas who
 *  can see that client. Slack never receives it. */
export type TradeRequestSlackSubject = { requestId: string } | { cedarRidgeUserId: string };
// Owner decision D0.1 (2026-10-18): links point at the AOA Trade Requests workspace, not the standalone screens.
export const AOA_LINKS: SlackLinks = {
  requestUrl: (id) => `${TRADE_REQUESTS_SLACK_ORIGIN}/trade-requests/queue/${encodeURIComponent(id)}`,
  editUrl: (id) => `${TRADE_REQUESTS_SLACK_ORIGIN}/trade-requests/new/edit/${encodeURIComponent(id)}`,
};

export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatSide(noBuy: boolean, noSell: boolean): string {
  if (noBuy && noSell) return "DNB+DNS";
  if (noBuy) return "DNB";
  return "DNS";
}

export type NewRequestInfo = {
  requestId: string;
  clientName: string;
  clientNames?: string[];
  tradeType: string;
  priority: string;
  submittedBy: string;
  totalValue: number;
  accounts: string[];
  advisorNotes?: string;
};
export type StatusChangeInfo = { requestId: string; clientName: string; newStatus: string; note: string; changedBy: string };
export type ExclusionChangeInfo = {
  clientName: string;
  ticker: string;
  kind: "advisor" | "client";
  reason: string;
  noBuy: boolean;
  noSell: boolean;
  action: "added" | "removed";
  changedBy: string;
};
export type ExclusionBatchEntry = { ticker: string; kind: "advisor" | "client"; reason: string; noBuy: boolean; noSell: boolean };
export type ExclusionBatchChangeEntry = {
  ticker: string;
  kind: "advisor" | "client";
  before: { noBuy: boolean; noSell: boolean };
  after: { noBuy: boolean; noSell: boolean };
};
export type ExclusionBatchInfo = {
  clientName: string;
  added: ExclusionBatchEntry[];
  removed: ExclusionBatchEntry[];
  changed: ExclusionBatchChangeEntry[];
  changedBy: string;
};

export function buildNewRequestText(info: NewRequestInfo, links: SlackLinks): string {
  const formatted = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(info.totalValue);
  const clientLabel = info.clientNames && info.clientNames.length > 1
    ? info.clientNames.map((n) => escapeSlack(n)).join(", ")
    : escapeSlack(info.clientName);
  const lines = [
    `*New Trade Request* \`${escapeSlack(info.requestId)}\``,
    `Client: *${clientLabel}* | Type: ${escapeSlack(info.tradeType)} | Priority: ${escapeSlack(info.priority)}`,
    `Accounts: ${info.accounts.map((a) => `\`${escapeSlack(a)}\``).join(", ")}`,
    `Submitted by: ${escapeSlack(info.submittedBy)} | Value: ${formatted}`,
  ];
  if (info.advisorNotes) lines.push(`Notes: ${escapeSlack(info.advisorNotes)}`);
  lines.push(`View request: ${links.requestUrl(info.requestId)}`);
  return lines.join("\n");
}

export function buildStatusChangeText(info: StatusChangeInfo, links: SlackLinks): string {
  const lines = [
    `Request \`${escapeSlack(info.requestId)}\` for *${escapeSlack(info.clientName)}* updated to: *${escapeSlack(info.newStatus)}*`,
    `Note: ${info.note ? escapeSlack(info.note) : "No additional notes"}`,
    `Updated by: ${escapeSlack(info.changedBy)}`,
  ];
  if (info.newStatus === "Needs Info") lines.push("", `Please review and edit your request: ${links.editUrl(info.requestId)}`);
  return lines.join("\n");
}

export function buildExclusionChangeText(info: ExclusionChangeInfo): string {
  const lines = [
    `*Exclusion ${info.action}* for *${escapeSlack(info.clientName)}*`,
    `Ticker: \`${escapeSlack(info.ticker)}\` | Kind: ${info.kind} | Side: ${formatSide(info.noBuy, info.noSell)}`,
  ];
  if (info.reason) lines.push(`Reason: ${escapeSlack(info.reason)}`);
  lines.push(`Changed by: ${escapeSlack(info.changedBy)}`);
  return lines.join("\n");
}

/** Returns null for an empty batch (the standalone builder posts nothing). */
export function buildExclusionBatchText(info: ExclusionBatchInfo): string | null {
  const addedCount = info.added.length;
  const removedCount = info.removed.length;
  const changedCount = info.changed.length;
  const totalCount = addedCount + removedCount + changedCount;
  if (totalCount === 0) return null;
  const name = escapeSlack(info.clientName);
  const buckets = (addedCount > 0 ? 1 : 0) + (removedCount > 0 ? 1 : 0) + (changedCount > 0 ? 1 : 0);
  let header: string;
  if (buckets > 1) header = `*${totalCount} exclusions updated* for *${name}*`;
  else if (addedCount > 0) header = addedCount === 1 ? `*Exclusion added* for *${name}*` : `*${addedCount} exclusions added* for *${name}*`;
  else if (removedCount > 0) header = removedCount === 1 ? `*Exclusion removed* for *${name}*` : `*${removedCount} exclusions removed* for *${name}*`;
  else header = changedCount === 1 ? `*Exclusion updated* for *${name}*` : `*${changedCount} exclusions updated* for *${name}*`;
  const row = (e: ExclusionBatchEntry) =>
    `- \`${escapeSlack(e.ticker)}\` (${e.kind}, ${formatSide(e.noBuy, e.noSell)})${e.reason ? ` — ${escapeSlack(e.reason)}` : ""}`;
  const changeRow = (e: ExclusionBatchChangeEntry) =>
    `- \`${escapeSlack(e.ticker)}\` (${e.kind}): ${formatSide(e.before.noBuy, e.before.noSell)} → ${formatSide(e.after.noBuy, e.after.noSell)}`;
  const lines = [header];
  if (addedCount > 0) lines.push("Added:", ...info.added.map(row));
  if (removedCount > 0) lines.push("Removed:", ...info.removed.map(row));
  if (changedCount > 0) lines.push("Changed:", ...info.changed.map(changeRow));
  lines.push(`Changed by: ${escapeSlack(info.changedBy)}`);
  return lines.join("\n");
}

export type SlackConfig = { token: string; channel: string };

export function tradeRequestSlackConfig(): SlackConfig | null {
  if (!tradeRequestsSlackEnabled()) return null;
  const token = process.env.TRADE_REQUEST_SLACK_BOT_TOKEN?.trim();
  const channel = process.env.TRADE_REQUEST_SLACK_CHANNEL_ID?.trim();
  if (!token || !/^xoxb-[A-Za-z0-9-]+$/.test(token) || !channel || !/^[CGDUW][A-Z0-9]{2,30}$/.test(channel)) return null;
  return { token, channel };
}

export type SlackSendResult = { status: "sent" } | { status: "skipped" } | { status: "failed"; code: string };

/**
 * One attempt, no retry: Slack may have posted on internal errors, and a retry could post twice. Logs only a code;
 * never the text or the destination. `"channel"` is the Trade Request channel; `{ channel }` an explicit channel id
 * (the drift channel, read by ticket from its own setting); `{ user }` a direct message. Callers that claim a date
 * before posting (the digest) must treat `skipped` as not sent.
 */
export async function sendTradeRequestSlack(
  destination: "channel" | { channel: string } | { user: string },
  text: string,
  fetchImpl: typeof fetch = fetch,
  about?: TradeRequestSlackSubject,
): Promise<SlackSendResult> {
  if (demoMode()) return tradeRequestsSlackEnabled() ? captureInDemo(destination, text, about) : { status: "skipped" };
  const config = tradeRequestSlackConfig();
  if (!config) return { status: "skipped" };
  const channel = destination === "channel" ? config.channel : "user" in destination ? destination.user : destination.channel;
  try {
    const response = await fetchImpl(SLACK_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel, text, mrkdwn: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
      cache: "no-store",
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (response.ok && body?.ok === true) return { status: "sent" };
    const code = typeof body?.error === "string" && /^[a-z_]{1,64}$/.test(body.error) ? body.error : `http_${response.status}`;
    console.warn(JSON.stringify({ event: "trade_request_slack_failed", code }));
    return { status: "failed", code };
  } catch (err) {
    const code = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network_error";
    console.warn(JSON.stringify({ event: "trade_request_slack_failed", code }));
    return { status: "failed", code };
  }
}

// The public demo's Slack: the post goes to the Outbox (lib/demo/outbox.ts) and counts as sent. A post about no one
// client (the digest, drift alerts) is left without a subject, so only admin and operations read it.
async function captureInDemo(
  destination: "channel" | { channel: string } | { user: string },
  text: string,
  about: TradeRequestSlackSubject | undefined,
): Promise<SlackSendResult> {
  const where = destination === "channel" ? "#trade-requests" : "user" in destination ? "Direct message" : "#trade-drift";
  try {
    const [{ prisma }, { recordOutbox, slackSummary, tradeRequestSubject }] = await Promise.all([import("@/lib/db"), import("@/lib/demo/outbox")]);
    const subject = !about ? undefined : "requestId" in about ? await tradeRequestSubject(prisma, about.requestId) : about;
    await recordOutbox(prisma, { channel: "Slack", destination: where, ...slackSummary(text), body: text, about: subject });
    return { status: "sent" };
  } catch {
    console.warn(JSON.stringify({ event: "trade_request_slack_failed", code: "outbox_failed" }));
    return { status: "failed", code: "outbox_failed" };
  }
}
