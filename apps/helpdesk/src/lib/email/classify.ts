/**
 * Inbound classification — pure.
 *
 * Decides whether a message is something a human wrote to the desk, or machine traffic that must be
 * held instead. A held message NEVER becomes a ticket and NEVER becomes a comment: the intake path
 * writes a `SuspendedIntake` row with the reason this function returns and an `INTAKE_SUSPENDED`
 * audit row in the same transaction.
 *
 * Returning `null` means "nothing disqualifying was found" — it is not an assertion that the sender
 * is authentic. Sender authentication is `auth-results.ts` and is checked separately, BEFORE this,
 * because an unauthenticated auto-reply is an authentication failure first.
 *
 * Precedence, first match wins: BOUNCE → LOOP_DETECTED → AUTO_REPLY → SYSTEM_SENDER → SPAM.
 * Bounces lead because a DSN almost always also sets `Auto-Submitted: auto-replied`, and the
 * reviewer needs to see "this address is dead", not "something answered automatically".
 */
import type { SuspendedIntakeReason } from "@/types/domain";

/**
 * Local-parts that are structurally incapable of holding a conversation. Code-owned rather than an
 * env key on purpose: this is the same class of artefact as the disclaimer texts —
 * reviewable in a diff, dated by git, not a console field where a typo silently opens the desk to
 * a notification firehose. Matching is on the local part, case-insensitively, exact.
 */
export const SYSTEM_SENDER_LOCAL_PARTS: readonly string[] = [
  "noreply",
  "no-reply",
  "no_reply",
  "donotreply",
  "do-not-reply",
  "do_not_reply",
  "notifications",
  "notification",
  "notify",
  "alerts",
  "alert",
  "automated",
  "automailer",
  "mailer",
  "mailer-daemon",
  "maildaemon",
  "postmaster",
  "bounce",
  "bounces",
  "bounce-noreply",
  "root",
  "daemon",
  "cron",
  "nobody",
];

/** Whole addresses that are system senders regardless of local part. */
export const SYSTEM_SENDER_ADDRESSES: readonly string[] = [
  "calendar-notification@google.com",
  "drive-shares-dm-noreply@google.com",
  "comments-noreply@docs.google.com",
];

const BOUNCE_SUBJECT =
  /^\s*(?:re:\s*)?(?:undeliverable|undelivered mail|delivery status notification|mail delivery (?:failed|subsystem|system)|returned mail|failure notice|delivery failure|message not delivered|automatic reply: undeliverable)/i;

const BOUNCE_BODY_PHRASES = [
  "delivery to the following recipient failed",
  "delivery has failed to these recipients",
  "was undeliverable",
  "could not be delivered",
  "recipient address rejected",
  "550 5.1.1",
  "550 5.4.1",
  "user unknown",
  "mailbox unavailable",
  "this is the mail system at host",
  "the following message to",
];

const AUTO_REPLY_SUBJECT =
  /^\s*(?:re:\s*)?(?:out of (?:the )?office|automatic reply|auto(?:matic)? response|autoreply|auto-reply|abwesenheitsnotiz|réponse automatique|respuesta automática)\b/i;

const AUTO_REPLY_BODY_PHRASES = [
  "i am currently out of the office",
  "i'm currently out of the office",
  "i am out of the office",
  "thank you for your message. i am away",
  "this is an automated response",
  "this is an automatic reply",
  "do not reply to this message",
];

/** RFC 3834 and the de-facto bulk headers. */
const PRECEDENCE_BULK = /^\s*(?:bulk|list|junk|auto_reply|auto-reply)\s*$/i;

/** Lower-cases every key once so callers can forward whatever casing the MTA used. */
function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === null || typeof headers !== "object") return out;
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") continue;
    out[key.trim().toLowerCase()] = value;
  }
  return out;
}

/** The bare address inside `"Name" <a@b.c>`, `<a@b.c>` or `a@b.c`, lower-cased. */
export function bareAddress(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const angled = /<([^<>]+)>/.exec(raw);
  const candidate = (angled ? angled[1] : raw).trim().toLowerCase().replace(/^mailto:/, "");
  if (candidate.length === 0 || candidate.length > 320) return null;
  return candidate.includes("@") ? candidate : null;
}

/** The address with any `+tag` suffix removed — `support+wm.a.b@x` → `support@x`. */
export function withoutPlusTag(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return address;
  const local = address.slice(0, at);
  const domain = address.slice(at);
  const plus = local.indexOf("+");
  return plus === -1 ? address : `${local.slice(0, plus)}${domain}`;
}

function localPartOf(address: string): string {
  const at = address.lastIndexOf("@");
  const local = at <= 0 ? address : address.slice(0, at);
  const plus = local.indexOf("+");
  return (plus === -1 ? local : local.slice(0, plus)).toLowerCase();
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

function isBounce(h: Record<string, string>, from: string | null, bodyLower: string): boolean {
  const contentType = (h["content-type"] ?? "").toLowerCase();
  if (contentType.includes("multipart/report") && contentType.includes("delivery-status")) return true;
  if (contentType.includes("message/delivery-status") || contentType.includes("message/feedback-report")) return true;
  if (h["x-failed-recipients"] !== undefined || h["x-original-message-id"] !== undefined) return true;
  if ((h["auto-submitted"] ?? "").toLowerCase().includes("auto-generated") && from !== null && localPartOf(from) === "mailer-daemon") {
    return true;
  }
  if (BOUNCE_SUBJECT.test(h["subject"] ?? "")) return true;
  if (from !== null && ["mailer-daemon", "postmaster", "bounce", "bounces"].includes(localPartOf(from))) {
    // A postmaster address alone is not proof; require DSN language in the body too, so a human at
    // postmaster@ who writes in can still reach the desk.
    if (containsAny(bodyLower, BOUNCE_BODY_PHRASES)) return true;
  }
  return false;
}

function isLoop(h: Record<string, string>, from: string | null): boolean {
  if (h["x-loop"] !== undefined || h["x-wm-helpdesk"] !== undefined || h["x-autoreply-loop"] !== undefined) return true;
  const deliveredTo = bareAddress(h["delivered-to"]);
  if (from !== null && deliveredTo !== null && withoutPlusTag(from) === withoutPlusTag(deliveredTo)) return true;
  const received = h["received"];
  if (typeof received === "string" && (received.match(/\bby\b/g) ?? []).length > 40) return true;
  return false;
}

function isAutoReply(h: Record<string, string>, bodyLower: string): boolean {
  const autoSubmitted = (h["auto-submitted"] ?? "").trim().toLowerCase();
  if (autoSubmitted.length > 0 && !autoSubmitted.startsWith("no")) return true;
  if (h["x-autoreply"] !== undefined || h["x-autorespond"] !== undefined || h["x-auto-response-suppress"] !== undefined) {
    return true;
  }
  if (PRECEDENCE_BULK.test(h["precedence"] ?? "")) return true;
  if (h["list-id"] !== undefined || h["list-unsubscribe"] !== undefined || h["list-post"] !== undefined) return true;
  if ((h["x-ms-exchange-inbox-rules-loop"] ?? "").length > 0) return true;
  if (AUTO_REPLY_SUBJECT.test(h["subject"] ?? "")) return true;
  if (containsAny(bodyLower, AUTO_REPLY_BODY_PHRASES)) return true;
  return false;
}

function isSystemSender(from: string | null): boolean {
  if (from === null) return false;
  if (SYSTEM_SENDER_ADDRESSES.includes(withoutPlusTag(from))) return true;
  return SYSTEM_SENDER_LOCAL_PARTS.includes(localPartOf(from));
}

function isSpam(h: Record<string, string>): boolean {
  if ((h["x-spam-flag"] ?? "").trim().toLowerCase().startsWith("yes")) return true;
  if ((h["x-spam-status"] ?? "").trim().toLowerCase().startsWith("yes")) return true;
  if ((h["x-gm-spam"] ?? "").trim() === "1") return true;
  if ((h["x-gm-phishy"] ?? "").trim() === "1") return true;
  const level = h["x-spam-level"] ?? "";
  if (/^\*{5,}/.test(level.trim())) return true;
  const microsoft = (h["x-forefront-antispam-report"] ?? h["x-microsoft-antispam"] ?? "").toUpperCase();
  if (/\bSFV:(SPM|PHSH)\b/.test(microsoft)) return true;
  return false;
}

/**
 * The reason this message must be held, or null when it looks like a person writing to the desk.
 *
 * `headers` is the forwarded header block (any casing); `body` is the already-extracted text body.
 * Never throws: every branch tolerates a missing header and a non-string value, because the input
 * comes from an unauthenticated mail path.
 */
export function classifyInbound(headers: Record<string, string>, body: string): SuspendedIntakeReason | null {
  const h = normalizeHeaders(headers);
  const from = bareAddress(h["from"]) ?? bareAddress(h["return-path"]);
  const bodyLower = (typeof body === "string" ? body : "").slice(0, 20_000).toLowerCase();

  if (isBounce(h, from, bodyLower)) return "BOUNCE";
  if (isLoop(h, from)) return "LOOP_DETECTED";
  if (isAutoReply(h, bodyLower)) return "AUTO_REPLY";
  if (isSystemSender(from)) return "SYSTEM_SENDER";
  if (isSpam(h)) return "SPAM";
  return null;
}
