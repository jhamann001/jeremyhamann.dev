import "server-only";
import { OPERATIONS_SLACK_VERIFICATION_REQUEST_ID } from "@/lib/operations/operations-slack-verification";

// This module accepts only an opaque request ID and a fixed request category.
// Client/account data, arbitrary destinations, and arbitrary message text are
// intentionally not part of its API. Activation is a separate approved step.
export const OPERATIONS_SLACK_CHANNEL = "C00OBJK6X0W";
export const OPERATIONS_SLACK_ORIGIN = "https://aoa.jeremyhamann.dev";
const SLACK_ENDPOINT = "https://slack.com/api/chat.postMessage";
const TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 16_384;
const MAX_RETRY_AFTER_SECONDS = 86_400;

const MESSAGE_LABELS = {
  FEE_CREDIT: "fee credit",
  SERVICE_GUARANTEE: "service guarantee",
  BILLING_EXCEPTION: "billing exception",
  LARGE_HOUSEHOLD_EXCEPTION: "$10M+ household billing exception",
} as const;

export type OperationsSlackRequestKind = keyof typeof MESSAGE_LABELS;
export type OperationsSlackInput = {
  kind: OperationsSlackRequestKind;
  requestId: string;
};
export type OperationsSlackDeliveryConfig = Readonly<{
  botToken: string;
  channel: typeof OPERATIONS_SLACK_CHANNEL;
  origin: typeof OPERATIONS_SLACK_ORIGIN;
}>;
export type OperationsSlackResult =
  | { status: "sent"; ts: string; channel: typeof OPERATIONS_SLACK_CHANNEL }
  | { status: "retry"; retryAfterSeconds: number; code: string }
  | { status: "failed"; code: string }
  | { status: "uncertain"; code: string };

export function operationsSlackCaptureEnabled(): boolean {
  return (process.env.APP_ENV === "prod" || process.env.APP_ENV === "dev")
    && process.env.OPERATIONS_SLACK_CAPTURE_ENABLED === "true";
}

export function getOperationsSlackDeliveryConfig(): OperationsSlackDeliveryConfig | null {
  if (process.env.APP_ENV !== "prod"
    || !operationsSlackCaptureEnabled()
    || process.env.OPERATIONS_SLACK_DELIVERY_ENABLED !== "true") return null;
  const token = process.env.OPERATIONS_SLACK_BOT_TOKEN;
  if (!token || token.length < 20 || token.length > 512
    || !/^xoxb-[A-Za-z0-9-]+$/.test(token) || /\s/.test(token)) return null;
  // Never inherit AUTH_URL, a request Host header, or another Slack integration's
  // token/channel. This credential is dedicated to the approved destination.
  return Object.freeze({
    botToken: token,
    channel: OPERATIONS_SLACK_CHANNEL,
    origin: OPERATIONS_SLACK_ORIGIN,
  });
}

export function buildOperationsSlackMessage(kind: OperationsSlackRequestKind, requestId: string): string {
  if (typeof requestId !== "string" || requestId.length < 16 || requestId.length > 64
    || /[^A-Za-z0-9_-]/.test(requestId)
    || !Object.hasOwn(MESSAGE_LABELS, kind)) throw new Error("invalid_operations_slack_request");
  if (requestId === OPERATIONS_SLACK_VERIFICATION_REQUEST_ID) {
    if (kind !== "SERVICE_GUARANTEE") throw new Error("invalid_operations_slack_request");
    return "TEST — AOA Operations notification verification.\n"
      + "No action required. This is a synthetic test; no client, fee, credit, waiver, or billing action is requested.\n"
      + `Test ID: ${OPERATIONS_SLACK_VERIFICATION_REQUEST_ID}\n`
      + `Review test in AOA: ${OPERATIONS_SLACK_ORIGIN}/operations/notification-verification`;
  }
  const url = `${OPERATIONS_SLACK_ORIGIN}/operations/fee-requests?request=${requestId}#request-${requestId}`;
  return `New ${MESSAGE_LABELS[kind]} request — pending review.\nRequest ID: ${requestId}\nReview in AOA: ${url}`;
}

// Only explicit rate-limit rejections are automatically retryable. In
// particular, Slack documents internal_error/fatal_error as potentially partly
// successful, so retrying them blindly could create duplicate notifications.
// https://docs.slack.dev/reference/methods/chat.postMessage/
const DEFINITE_REJECTIONS = new Set([
  "access_denied", "accesslimited", "account_inactive", "app_access_restricted",
  "channel_not_found", "ekm_access_denied", "enterprise_is_restricted",
  "invalid_arg_name", "invalid_arguments", "invalid_array_arg", "invalid_auth",
  "invalid_blocks", "invalid_blocks_format", "invalid_charset", "invalid_form_data",
  "invalid_post_type", "is_archived", "message_limit_exceeded", "missing_post_type",
  "missing_scope", "no_permission", "no_text", "not_allowed_token_type", "not_authed",
  "not_in_channel", "request_timeout", "restricted_action", "restricted_action_read_only_channel",
  "restricted_action_thread_only_channel", "team_access_not_granted", "token_expired", "token_revoked",
]);

function rateLimitResult(value: string | null): OperationsSlackResult {
  // Slack specifies an integer number of seconds. Missing/malformed values use
  // a conservative delay; an excessive value stops for review instead of being
  // clamped down and violating the server's minimum waiting period.
  if (value !== null && /^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds) || seconds > MAX_RETRY_AFTER_SECONDS) {
      return { status: "failed", code: "retry_after_exceeds_limit" };
    }
    return { status: "retry", retryAfterSeconds: Math.max(1, seconds), code: "rate_limited" };
  }
  return { status: "retry", retryAfterSeconds: 60, code: "rate_limited" };
}

async function readBoundedResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("missing_response_body");
  const reader = response.body.getReader();
  let byteCount = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export async function sendOperationsSlackNotification(
  input: OperationsSlackInput,
  config: OperationsSlackDeliveryConfig | null,
  fetchImpl: typeof fetch = fetch,
): Promise<OperationsSlackResult> {
  // Re-read the gates immediately before each send. A stale config, a dev
  // environment, or forged destination must never bypass the kill switch.
  const current = getOperationsSlackDeliveryConfig();
  if (!current || !config || config.botToken !== current.botToken
    || config.channel !== current.channel || config.origin !== current.origin) {
    return { status: "failed", code: "delivery_disabled" };
  }
  let text: string;
  try {
    text = buildOperationsSlackMessage(input.kind, input.requestId);
  } catch {
    return { status: "failed", code: "invalid_request" };
  }

  try {
    const response = await fetchImpl(SLACK_ENDPOINT, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${config.botToken}` },
      body: JSON.stringify({
        channel: OPERATIONS_SLACK_CHANNEL,
        text,
        mrkdwn: false,
        // Omit parse: "none": Slack documents that it removes hyperlinks. The
        // approved literal URL must remain clickable. All text/IDs are fixed or
        // tightly validated, with no mentions, free text, or client details.
        link_names: false,
        unfurl_links: false,
        unfurl_media: false,
        unfurl_app_links: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 429) return rateLimitResult(response.headers.get("retry-after"));
    if (response.status >= 500 || response.status === 408 || response.status < 200
      || (response.status >= 300 && response.status < 400)) {
      return { status: "uncertain", code: "http_ambiguous" };
    }
    if (!response.ok) return { status: "failed", code: "http_rejected" };
    const body = await readBoundedResponse(response);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { status: "uncertain", code: "invalid_response" };
    }
    const result = body as Record<string, unknown>;
    if (result.ok === true) {
      if (result.channel === OPERATIONS_SLACK_CHANNEL && typeof result.ts === "string"
        && /^\d{10,16}\.\d{6}$/.test(result.ts) && !/\s/.test(result.ts)) {
        return { status: "sent", ts: result.ts, channel: OPERATIONS_SLACK_CHANNEL };
      }
      return { status: "uncertain", code: "invalid_receipt" };
    }
    if (result.ok === false && typeof result.error === "string") {
      if (result.error === "rate_limited" || result.error === "ratelimited") {
        return rateLimitResult(response.headers.get("retry-after"));
      }
      if (DEFINITE_REJECTIONS.has(result.error)) return { status: "failed", code: result.error };
      // Never persist unknown upstream strings: a response could contain PII or
      // credentials, and an undocumented error could represent partial success.
      return { status: "uncertain", code: "slack_ambiguous" };
    }
    return { status: "uncertain", code: "invalid_response" };
  } catch {
    // A timeout, socket reset, redirect, or malformed body may happen after Slack
    // committed the message. Do not log or blindly replay its opaque contents.
    return { status: "uncertain", code: "transport_or_response_ambiguous" };
  }
}
