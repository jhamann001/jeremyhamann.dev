import { tradeRequestsSlackEnabled } from "@/lib/flags";

// Where a drift run writes and whether it may send (ticket). Shadow writes only the shadow tables and never
// sends; live writes the live tables and sends only while AOA is still the drift sender and the drift channel can
// actually be posted to, both checked at the moment of sending.

/** AOA production origin for the drift alert link (the standalone CLIENT_ORIGIN link pointed at its own screens). */
export const DRIFT_DASHBOARD_ORIGIN = "https://aoa.jeremyhamann.dev";

export const DRIFT_CHANNEL_ID = /^[CG][A-Z0-9]{2,30}$/;

export type DriftRunTarget = { kind: "shadow" } | { kind: "live"; stillSender: () => Promise<boolean> };

export interface DriftTables {
  householdRuns: string;
  accountRuns: string;
}

export const LIVE_DRIFT_TABLES: DriftTables = {
  householdRuns: "trade_request.registry_drift_runs",
  accountRuns: "trade_request.position_drift_accounts",
};

export const SHADOW_DRIFT_TABLES: DriftTables = {
  householdRuns: "trade_request.shadow_registry_drift_runs",
  accountRuns: "trade_request.shadow_position_drift_accounts",
};

export function tablesFor(run: DriftRunTarget): DriftTables {
  return run.kind === "live" ? LIVE_DRIFT_TABLES : SHADOW_DRIFT_TABLES;
}

/**
 * The drift channel can be posted to: its id is configured, ticket's sender is configured (bot token and its
 * Trade Request channel, without which it skips every destination) and the Trade Request Slack breaker is on.
 * Checked before the alert claims its date so a run never keeps a claim it could not post (ticket: a caller
 * that claims before posting treats a skipped send as not sent).
 */
export function driftChannelReady(): boolean {
  const channel = process.env.TRADE_REQUEST_DRIFT_SLACK_CHANNEL_ID?.trim() ?? "";
  const token = process.env.TRADE_REQUEST_SLACK_BOT_TOKEN?.trim() ?? "";
  const senderChannel = process.env.TRADE_REQUEST_SLACK_CHANNEL_ID?.trim() ?? "";
  return (
    tradeRequestsSlackEnabled() &&
    DRIFT_CHANNEL_ID.test(channel) &&
    /^xoxb-[A-Za-z0-9-]+$/.test(token) &&
    /^[CGDUW][A-Z0-9]{2,30}$/.test(senderChannel)
  );
}

export function senderFor(run: DriftRunTarget): () => Promise<boolean> {
  return run.kind === "live" ? async () => driftChannelReady() && (await run.stillSender()) : async () => false;
}
