/**
 * Slack posting for the scheduled jobs — node only.
 *
 * TWO RULES GOVERN THIS FILE, and both are acceptance criteria rather than style:
 *
 * 1. **Disabled unless the env key is set.** `postSlack` returns "disabled" when the webhook is unset —
 *    it does not throw and it does not post. Nothing in Wave A transmits anything, so on this branch
 *    every job runs, dedupes and audits with the key absent, and the only observable difference when
 *    the owner sets it is that a message appears (CONTRACT §0 rule 4).
 * 2. **PII-light, always.** A line may carry the ticket number, the queue, the priority, the phase, how
 *    far over the clock is, and the `/tickets/wm/<number>` deep link. NEVER the subject, the requester's
 *    name or address, a staff member's identity, or any body text. `assertPiiLight` is a mechanical
 *    backstop for the rule, not a substitute for writing the line correctly: it refuses an "@" and
 *    anything `sanitizePII` recognises before the line can leave the process.
 *
 * The literal message shapes are in the build record, marked DRAFT for approval.
 */
import { isStandInUrl } from "@/lib/demo/mode";
import { env } from "@/lib/env";
import { sanitizePII } from "@/lib/pii";

export type SlackLine = { text: string };

/** How long a webhook POST may take before it is abandoned. A job must not hang a 5-minute schedule. */
export const SLACK_TIMEOUT_MS = 10_000;

/** Lines beyond this are summarised as "+N more" by the callers; Slack truncates ~40 000 characters. */
export const SLACK_MAX_LINES = 40;

/** Slack's own limit on a webhook `text` payload, applied defensively. */
export const SLACK_MAX_TEXT_CHARS = 38_000;

export type SlackPostResult = "posted" | "disabled" | "failed";

/** A line that fails this is a bug in the caller, not something to redact and send anyway. */
export class SlackPiiError extends Error {
  constructor(reason: string) {
    super(`Slack line is not PII-light: ${reason}`);
    this.name = "SlackPiiError";
  }
}

/**
 * Refuses a line that carries an email address or anything `sanitizePII` recognises — since Decision
 * #116 that is card numbers, SSNs and account numbers, and nothing else. Throws `SlackPiiError`;
 * callers build their lines from structured fields, so a throw here means a code change introduced
 * client material into an alert.
 *
 * THE BACKSTOP NARROWED WITH THE RULE SET, deliberately recorded rather than left to be inferred. The
 * scenario this function exists for is a FUTURE field addition quietly carrying client material into
 * an alert, and four of the seven kinds it used to catch (routing, DOB, passport, licence) no longer
 * trip it. Nothing carries one today — every line here is built from a ticket number, queue, priority,
 * phase and deep link — but if egress should keep refusing a date of birth specifically, that needs
 * its own predicate rather than `sanitizePII(...).redacted`.
 */
export function assertPiiLight(text: string): void {
  if (text.includes("@")) throw new SlackPiiError("contains an '@'");
  const result = sanitizePII(text);
  if (result.redacted) throw new SlackPiiError(`sanitizePII matched ${result.count} value(s)`);
}

/** `true` only for an absolute https URL — a webhook is a credential in a URL, so http would leak it. */
export function isUsableWebhook(url: string | undefined): url is string {
  if (url === undefined) return false;
  const trimmed = url.trim();
  if (trimmed === "") return false;
  try {
    // The demo's loopback Slack stand-in is the one http address accepted, and only in demo mode.
    return new URL(trimmed).protocol === "https:" || isStandInUrl(trimmed);
  } catch {
    return false;
  }
}

/** The exact `text` payload `postSlack` would send for these lines: newline-joined, capped, PII-checked. */
export function slackPayloadText(lines: readonly SlackLine[]): string {
  const kept = lines.slice(0, SLACK_MAX_LINES);
  for (const line of kept) assertPiiLight(line.text);
  const omitted = lines.length - kept.length;
  const texts = kept.map((l) => l.text);
  if (omitted > 0) texts.push(`…and ${omitted} more (see the queue view)`);
  return texts.join("\n").slice(0, SLACK_MAX_TEXT_CHARS);
}

/**
 * Posts one message. Returns:
 *   "disabled" — the webhook env key is unset, blank or not https, OR there is nothing to say. Nothing
 *                was transmitted, and that is not an error.
 *   "posted"   — Slack answered 2xx.
 *   "failed"   — Slack answered non-2xx, the request threw, or the request timed out.
 *
 * NEVER throws, and never logs the webhook URL — the URL IS the credential. A `SlackPiiError` from
 * `slackPayloadText` is the one exception the callers must not swallow, so it propagates.
 */
export async function postSlack(webhookUrl: string | undefined, lines: SlackLine[]): Promise<SlackPostResult> {
  if (!isUsableWebhook(webhookUrl)) return "disabled";
  if (lines.length === 0) return "disabled";

  const text = slackPayloadText(lines);
  if (text === "") return "disabled";

  try {
    const response = await fetch(webhookUrl.trim(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    return response.ok ? "posted" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * The staff deep link for a ticket. `base` is the service's own origin (AUTH_URL on Cloud Run); when it
 * is unset or unusable the path alone is returned, which still routes for anyone with the app open.
 * `/tickets/wm/<number>` is the HD-number route handler.
 */
export function ticketDeepLink(ticketNumber: number, base: string | undefined): string {
  const path = `/tickets/wm/${ticketNumber}`;
  if (base === undefined || base.trim() === "") return path;
  try {
    return new URL(path, base.trim()).toString();
  } catch {
    return path;
  }
}

/** `<url|HD-1234>` when the link is absolute, plain `HD-1234 /tickets/wm/1234` when only the path is known. */
export function ticketLinkMarkup(ticketNumber: number, base: string | undefined): string {
  const link = ticketDeepLink(ticketNumber, base);
  const label = `HD-${ticketNumber}`;
  return link.startsWith("http") ? `<${link}|${label}>` : `${label} ${link}`;
}

/**
 * The app origin the deep links are built from. `APP_BASE_URL` (validated as an absolute https origin
 * by `src/lib/env.ts`) wins, so an operator can point the links at a custom domain without touching
 * the Auth.js variable; `AUTH_URL` is the fallback and is read raw, because Auth.js owns it and it is
 * legitimately `http://localhost:3000` in local development.
 */
export function appBaseUrl(): string | undefined {
  // A blank value counts as unset, the same convention `src/lib/env.ts` applies: a dotenv file routinely
  // carries `APP_BASE_URL=` placeholders, and one of those must not shadow AUTH_URL.
  for (const candidate of [env.APP_BASE_URL, process.env.AUTH_URL]) {
    if (candidate !== undefined && candidate.trim() !== "") return candidate.trim();
  }
  return undefined;
}
