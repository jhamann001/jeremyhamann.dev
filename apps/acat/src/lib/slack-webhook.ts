// ticket: Minimal Slack incoming-webhook client.
//
// Only one consumer today: the daily digest cron route. The webhook
// URL itself is the secret — anyone who has it can post into the
// configured channel — so it lives in Secret Manager in prod and in
// `.env` (gitignored) locally.
//
// Deliberately tiny:
//   - Read `SLACK_WEBHOOK_URL` lazily so module load doesn't crash
//     local dev or unit tests that don't need Slack.
//   - One function, one POST. No queueing, no retry-with-backoff —
//     the cron is best-effort daily; if it ever fails we'll just see
//     it in Logfire and re-run on the next schedule.

import { logger } from "@/lib/logger";
import { isStandInUrl } from "@/lib/demo/flags";

export interface SlackBlockMessage {
  text: string;
  blocks?: unknown[];
}

export interface PostSlackOptions {
  // Override the webhook URL — used by tests so they don't need to
  // monkey-patch process.env. Production callers always omit this.
  webhookUrl?: string;
  // Override the fetch implementation. Same testability rationale.
  fetchImpl?: typeof fetch;
}

export class SlackWebhookError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "SlackWebhookError";
  }
}

/**
 * Resolve the webhook URL from env, with a sanity check that it
 * actually looks like a Slack incoming webhook. Helps catch the
 * "accidentally pasted a placeholder" case during onboarding.
 */
export function getSlackWebhookUrl(): string | null {
  const raw = process.env.SLACK_WEBHOOK_URL?.trim();
  if (!raw) return null;
  if (!raw.startsWith("https://hooks.slack.com/") && !isStandInUrl(raw)) {
    logger.warn(
      { prefix: raw.slice(0, 24) },
      "SLACK_WEBHOOK_URL is set but doesn't look like a Slack incoming webhook URL"
    );
  }
  return raw;
}

export async function postToSlack(
  payload: SlackBlockMessage,
  opts: PostSlackOptions = {}
): Promise<void> {
  const url = opts.webhookUrl ?? getSlackWebhookUrl();
  if (!url) {
    throw new SlackWebhookError("SLACK_WEBHOOK_URL is not configured");
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Body is small + non-PII (Slack returns "invalid_payload" etc.).
    throw new SlackWebhookError(
      `Slack webhook returned ${res.status}: ${body.slice(0, 200)}`,
      res.status
    );
  }
}
