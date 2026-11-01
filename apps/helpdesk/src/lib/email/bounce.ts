/**
 * Delivery Status Notification parsing — pure, layer L1 (the build record B9, §3.2
 * `MESSAGE_BOUNCED`).
 *
 * A bounce is the only inbound message that is ABOUT one of our own outbound messages, and it is the
 * only evidence the desk will ever get that a reply it recorded as "Sent" never reached anybody. Without
 * it a `MessageDelivery` row sits at SENT forever, the comment chip says the client was answered, and
 * the first anyone notices is when the client calls.
 *
 * Three facts come out of a DSN and they are used for three different things:
 *
 *   - **`originalMessageId`** is the key. It is OUR Message-ID, echoed back inside the DSN's
 *     `message/rfc822-headers` part or in an `Original-Message-ID` field, and it is what lets
 *     `src/server/email-intake.ts` find the delivery this notice is about. Without it the DSN is held
 *     for a human like any other machine mail and nothing is transitioned — a bounce that cannot name
 *     what it bounced is not evidence about any particular message.
 *   - **`type`** decides whether the address becomes a suppression CANDIDATE. `"hard"` means the address
 *     does not exist; `"soft"` means it was full, throttled or temporarily unreachable. Only a hard
 *     bounce is offered to an administrator on `/admin/suppression`, and even then it is offered, never
 *     applied (CONTRACT §10 B9: "one DSN is not a policy decision").
 *   - **`status`** is the RFC 3463 enhanced status code, kept verbatim for the audit row so the ledger
 *     records the provider's own answer rather than this module's reading of it.
 *
 * **Ambiguity resolves to `"soft"`, always.** A soft bounce costs a retry; a hard bounce puts a client's
 * address in front of an administrator as a candidate to stop writing to. Guessing wrong in the soft
 * direction wastes an attempt. Guessing wrong in the hard direction is how a desk quietly stops
 * answering somebody.
 *
 * Nothing here reads the database, the environment or the network, and nothing here throws.
 */

/** What one inbound message says about a previous outbound one. */
export type BounceReport = {
  isBounce: boolean;
  /** `"hard"` = the address does not exist. `"soft"` = temporary. Null when this is not a bounce. */
  type: "hard" | "soft" | null;
  /** OUR Message-ID, bare (no angle brackets), lower-cased. Null when the DSN names none. */
  originalMessageId: string | null;
  /** The RFC 3463 enhanced status code (`5.1.1`), verbatim. Null when the DSN carries none. */
  status: string | null;
};

/** How much of the body is scanned. A DSN's machine part is at the top; past this is the returned body. */
export const DSN_SCAN_CHARS = 64_000;

/** Longest Message-ID accepted, matching `SuspendedIntake.messageId` and `externalIdFor`'s own cut. */
const MESSAGE_ID_MAX = 400;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Subjects the five MTAs that matter actually send. Kept in step with `BOUNCE_SUBJECT` in
 * `src/lib/email/classify.ts` — that module decides "hold this", this one decides "which delivery" —
 * but the two lists are deliberately separate: classification errs towards holding anything odd, and a
 * DSN parser that inherited that breadth would start transitioning deliveries on an auto-reply.
 */
const DSN_SUBJECT =
  /^\s*(?:re:\s*)?(?:undeliverable|undelivered mail|delivery status notification|mail delivery (?:failed|subsystem|system)|returned mail|failure notice|delivery (?:has )?failed|message not delivered|warning: message delayed)/i;

/** The RFC 3464 machine part. `Action:` is the field a DSN is required to carry. */
const DSN_ACTION = /^\s*action\s*:\s*(failed|delayed|delivered|relayed|expanded)\s*$/im;
/** RFC 3463 enhanced status, e.g. `Status: 5.1.1`. */
const DSN_STATUS = /^\s*status\s*:\s*([245])\.(\d{1,3})\.(\d{1,3})\s*$/im;
/** `Diagnostic-Code: smtp; 550 5.1.1 <a@b> User unknown` */
const DSN_DIAGNOSTIC = /^\s*diagnostic-code\s*:\s*(.+)$/im;

/** An SMTP reply code anywhere in the returned text, when the machine part is missing or unparsed. */
const SMTP_REPLY = /\b([45]\d{2})(?:[ -]\d\.\d{1,3}\.\d{1,3})?\b/;
/** An enhanced status embedded in free text, e.g. `550-5.1.1 The email account that you tried…`. */
const LOOSE_ENHANCED = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/;

const HARD_PHRASES: readonly string[] = [
  "user unknown",
  "unknown user",
  "no such user",
  "no such recipient",
  "recipient address rejected",
  "address rejected",
  "does not exist",
  "account that you tried to reach does not exist",
  "mailbox not found",
  "mailbox unavailable",
  "invalid recipient",
  "unrouteable address",
  "unrouteable mail domain",
  "domain not found",
  "host or domain name not found",
  "no mx record",
  "recipient not found",
  "not a valid mailbox",
  "address unknown",
];

const SOFT_PHRASES: readonly string[] = [
  "over quota",
  "quota exceeded",
  "mailbox full",
  "mailbox is full",
  "insufficient system storage",
  "try again later",
  "temporarily deferred",
  "temporary failure",
  "temporarily unavailable",
  "greylisted",
  "greylisting",
  "rate limited",
  "too many connections",
  "connection timed out",
  "message delayed",
  "will retry",
  "service unavailable, try again",
];

/** Lower-cases every key once so a caller can forward whatever casing the MTA used. */
function lower(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === null || typeof headers !== "object") return out;
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") continue;
    out[key.trim().toLowerCase()] = value;
  }
  return out;
}

/** The bare local part of an address header, lower-cased. `""` when there is none. */
function localPartOf(raw: string | undefined): string {
  if (typeof raw !== "string") return "";
  const angled = /<([^<>]+)>/.exec(raw);
  const address = (angled ? angled[1] : raw).trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0) return "";
  const local = address.slice(0, at);
  const plus = local.indexOf("+");
  return plus === -1 ? local : local.slice(0, plus);
}

/**
 * Whether this message is a DSN at all.
 *
 * The structural signals come first and are sufficient on their own: `multipart/report` with
 * `report-type=delivery-status`, a `message/delivery-status` part, an `X-Failed-Recipients` header, or
 * an RFC 3464 `Action:` field in the body. The shape-based signals — a MAILER-DAEMON sender, a bounce
 * subject — need corroboration, because a human at `postmaster@` writing to the desk is a person, and a
 * client whose subject happens to start "Undeliverable" is still a client.
 */
function detect(h: Record<string, string>, bodyLower: string): boolean {
  const contentType = (h["content-type"] ?? "").toLowerCase();
  if (contentType.includes("multipart/report") && contentType.includes("delivery-status")) return true;
  if (contentType.includes("message/delivery-status")) return true;
  if (typeof h["x-failed-recipients"] === "string") return true;
  if (DSN_ACTION.test(bodyLower)) return true;

  const daemon = ["mailer-daemon", "postmaster", "mail-daemon", "maildaemon", "bounce", "bounces"].includes(
    localPartOf(h["from"]) || localPartOf(h["return-path"]),
  );
  const bounceSubject = DSN_SUBJECT.test(h["subject"] ?? "");
  // Either shape signal is enough ONLY with a status code or a diagnostic line to corroborate it.
  if ((daemon || bounceSubject) && (DSN_STATUS.test(bodyLower) || DSN_DIAGNOSTIC.test(bodyLower))) return true;
  // A daemon sender AND a bounce subject together, with DSN language, is the malformed-report case.
  if (daemon && bounceSubject && LOOSE_ENHANCED.test(bodyLower)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// The three facts
// ---------------------------------------------------------------------------

/** `<a@b>` → `a@b`, lower-cased and bounded. Null for anything that cannot be a Message-ID. */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const bare = raw.trim().replace(/^<|>$/g, "").trim().toLowerCase();
  if (bare.length === 0 || bare.length > MESSAGE_ID_MAX) return null;
  if (/\s/.test(bare)) return null;
  return bare;
}

/**
 * Our Message-ID, as the DSN echoes it back.
 *
 * Three places, in order of how load-bearing they are:
 *   1. `Original-Message-ID` / `X-Original-Message-ID` — the explicit field, when the MTA sets it.
 *   2. The DSN's own `In-Reply-To` / `References`, which several MTAs populate with the failed message.
 *   3. A `Message-ID:` line in the BODY, which is the returned `message/rfc822-headers` part.
 *
 * The body is read LAST and only for the first match: the DSN's own Message-ID is in its headers, not
 * its body, so the first `Message-ID:` line inside the body belongs to the message that failed.
 */
function findOriginalMessageId(h: Record<string, string>, body: string): string | null {
  const direct = normalizeMessageId(h["original-message-id"] ?? h["x-original-message-id"]);
  if (direct !== null) return direct;

  for (const key of ["in-reply-to", "references"]) {
    const value = h[key];
    if (typeof value !== "string") continue;
    const angled = /<([^<>\s]{1,400})>/.exec(value);
    const candidate = normalizeMessageId(angled === null ? value.split(/[\s,]+/)[0] : angled[1]);
    if (candidate !== null && candidate.includes("@")) return candidate;
  }

  const inBody =
    /^\s*(?:original-)?message-id\s*:\s*(.+)$/im.exec(body) ?? /^\s*x-original-message-id\s*:\s*(.+)$/im.exec(body);
  if (inBody === null) return null;
  const angled = /<([^<>\s]{1,400})>/.exec(inBody[1]);
  const candidate = normalizeMessageId(angled === null ? inBody[1] : angled[1]);
  return candidate !== null && candidate.includes("@") ? candidate : null;
}

/** The enhanced status code, from the machine part first and free text second. */
function findStatus(body: string): string | null {
  const structured = DSN_STATUS.exec(body);
  if (structured !== null) return `${structured[1]}.${structured[2]}.${structured[3]}`;
  const loose = LOOSE_ENHANCED.exec(body);
  if (loose !== null && (loose[1] === "4" || loose[1] === "5")) return `${loose[1]}.${loose[2]}.${loose[3]}`;
  return null;
}

/**
 * Hard or soft.
 *
 * The order is the evidence order. The enhanced status class is the provider's own structured verdict
 * and wins. `Action: delayed` is explicitly temporary and overrides a 5.x that some MTAs emit alongside
 * it. The SMTP reply class is next. Phrases are last, because they are the only signal that is a guess.
 * Anything left over is soft — see the module comment.
 */
function classify(body: string, bodyLower: string, status: string | null): "hard" | "soft" {
  const action = DSN_ACTION.exec(bodyLower);
  if (action !== null && action[1].toLowerCase() === "delayed") return "soft";

  if (status !== null) {
    if (status.startsWith("5.")) return "hard";
    if (status.startsWith("4.")) return "soft";
  }

  const reply = SMTP_REPLY.exec(body);
  if (reply !== null) {
    if (reply[1].startsWith("5")) return "hard";
    if (reply[1].startsWith("4")) return "soft";
  }

  if (SOFT_PHRASES.some((p) => bodyLower.includes(p))) return "soft";
  if (HARD_PHRASES.some((p) => bodyLower.includes(p))) return "hard";
  return "soft";
}

/**
 * Reads one inbound message as a Delivery Status Notification.
 *
 * `headers` is the forwarded header block in any casing; `body` is the already-extracted text body.
 * Returns `{ isBounce: false, type: null, originalMessageId: null, status: null }` for anything that is
 * not a DSN — which is every ordinary message, and is the common case.
 */
export function parseDsn(headers: Record<string, string>, body: string): BounceReport {
  const h = lower(headers);
  const text = (typeof body === "string" ? body : "").slice(0, DSN_SCAN_CHARS);
  const textLower = text.toLowerCase();

  if (!detect(h, textLower)) {
    return { isBounce: false, type: null, originalMessageId: null, status: null };
  }

  const status = findStatus(text);
  return {
    isBounce: true,
    type: classify(text, textLower, status),
    originalMessageId: findOriginalMessageId(h, text),
    status,
  };
}
