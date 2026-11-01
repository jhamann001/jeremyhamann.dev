/**
 * Mailbox map — pure (the build record `MAILBOX_MAP`, §10 "S2").
 *
 * `MAILBOX_MAP` is a JSON object keyed by the inbound address, e.g.
 *
 * ```json
 * {
 *   "service@example.com": { "queueKey": "CLIENT_SERVICE", "brand": "CEDAR_RIDGE_WEALTH" },
 *   "operations@example.com": { "queueKey": "OPERATIONS", "brand": "CEDAR_RIDGE_WEALTH" },
 *   "statements@example.com": { "queueKey": "CLIENT_SERVICE", "brand": "CEDAR_RIDGE_WEALTH",
 *                                       "category": "STATEMENT_REQUEST" },
 *   "*@example.net": { "queueKey": "CLIENT_SERVICE", "brand": "CEDAR_RIDGE_DIRECT" }
 * }
 * ```
 *
 * Unset means every inbound address is unknown and every message suspends as `UNKNOWN_MAILBOX` —
 * the fail-closed rule in §4. An entry whose `queueKey`, `brand` or `category` is not a real enum
 * value is DROPPED rather than thrown on: a typo in one line must not take the whole intake path
 * down, and a dropped entry is visible immediately as UNKNOWN_MAILBOX rows in the review queue.
 *
 * `env.ts` already refuses a `MAILBOX_MAP` that is not a JSON object, by key name, at boot.
 */
import { QUEUE_KEYS, TICKET_BRANDS, TICKET_CATEGORIES } from "@/types/domain";
import type { QueueKey, TicketBrand, TicketCategory } from "@/types/domain";

export type MailboxRoute = {
  queueKey: QueueKey;
  brand: TicketBrand;
  /** Default category for mail to this address; the routing table supplies queue/priority when absent. */
  category?: TicketCategory;
};

/** The wildcard key form: `*@domain` matches any local part at that domain. `*` matches anything. */
const DOMAIN_WILDCARD = /^\*@([^\s@]+)$/;

const EMPTY: Readonly<Record<string, MailboxRoute>> = Object.freeze({});

function isQueueKey(v: unknown): v is QueueKey {
  return typeof v === "string" && (QUEUE_KEYS as readonly string[]).includes(v);
}

function isBrand(v: unknown): v is TicketBrand {
  return typeof v === "string" && (TICKET_BRANDS as readonly string[]).includes(v);
}

function isCategory(v: unknown): v is TicketCategory {
  return typeof v === "string" && (TICKET_CATEGORIES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// RFC 5322 address parsing
// ---------------------------------------------------------------------------
//
// A `From` header is `display-name <addr-spec>`, and the display name is sender-controlled text that
// may legally contain `<` and `>` — inside a quoted string, inside a comment, or after the upstream
// workflow has decoded an RFC 2047 encoded word. Reading the FIRST angle-bracketed group therefore
// reads whatever the sender chose to put in their own display name, which would let anyone whose own
// domain passes DMARC present themselves as any address they like:
//
//   From: "Quinn Ambrose <quinn@client.test>" <attacker@evil.test>
//
// That message belongs to `attacker@evil.test` — that is the mailbox DMARC authenticated — and the
// scanner below says so. Quoted strings and comments are consumed first, the addr-spec of a mailbox
// is the LAST `<...>` group in what remains, and a header naming more than one mailbox yields more
// than one address so that `parseFromAddress` can refuse it instead of silently picking one.
//
// RFC 2047 encoded words are deliberately NOT decoded here: an encoded word is legal only in a
// phrase, never in an addr-spec, so decoding one could only ever introduce structure the sender
// chose. (The n8n node decodes `payload.from` before posting it; the scan is quote-aware and
// last-group-wins precisely so that a decoded display name carrying `<...>` still resolves to the
// mailbox that was actually authenticated.)

/** Longest header value worth scanning; `inboundEmailSchema` already caps `from` far below this. */
const MAX_HEADER_CHARS = 4096;

/** Characters that only ever carry a header's structure — a survivor means a malformed address. */
const STRUCTURAL_CHARS = /[\s<>()[\],;:\\"]/;

/** C0 controls and DEL. A CR/LF inside an address is header injection, never an address. */
const CONTROL_CHARS = /[\p{Cc}]/u;

/**
 * One addr-spec, lower-cased and stripped of a `mailto:` prefix, or null when the token is not an
 * address. Fail-closed: by the time this runs the scanner has consumed every structural character,
 * so anything left that still looks like syntax means the header was malformed — and a malformed
 * `From` is held for a human rather than guessed at.
 */
function normalizeAddrSpec(raw: string): string | null {
  const candidate = raw.trim().toLowerCase().replace(/^mailto:/, "").trim();
  if (candidate.length === 0 || candidate.length > 320) return null;
  if (STRUCTURAL_CHARS.test(candidate) || CONTROL_CHARS.test(candidate)) return null;
  const at = candidate.indexOf("@");
  if (at <= 0 || at !== candidate.lastIndexOf("@") || at === candidate.length - 1) return null;
  return candidate;
}

/**
 * Splits an address header into its mailboxes, returning each one with its quoted strings and its
 * (possibly nested) comments removed. A separator only counts at the top level: the comma inside
 * `"Okonkwo, Dean"` or inside `<...>` does not start a new mailbox.
 */
function splitMailboxes(raw: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let quoted = false;
  let commentDepth = 0;
  let angleDepth = 0;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quoted) {
      if (ch === "\\") i += 1;
      else if (ch === '"') {
        quoted = false;
        buf += " ";
      }
      continue;
    }
    if (commentDepth > 0) {
      if (ch === "\\") i += 1;
      else if (ch === "(") commentDepth += 1;
      else if (ch === ")") {
        commentDepth -= 1;
        if (commentDepth === 0) buf += " ";
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === "(") {
      commentDepth = 1;
      continue;
    }
    if (ch === "<") {
      angleDepth += 1;
      buf += ch;
      continue;
    }
    if (ch === ">") {
      if (angleDepth > 0) angleDepth -= 1;
      buf += ch;
      continue;
    }
    if ((ch === "," || ch === ";") && angleDepth === 0) {
      parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts;
}

const ANGLE_GROUP = /<([^<>]*)>/g;

/**
 * The addresses one already-stripped mailbox yields: the LAST angle-bracketed group when there is
 * one, else every address-shaped whitespace-separated token — so a bare `a@x b@y` reads as the two
 * mailboxes it is rather than as one.
 */
function addressesInMailbox(stripped: string): string[] {
  let last: string | null = null;
  for (const match of stripped.matchAll(ANGLE_GROUP)) last = match[1];
  if (last !== null) {
    const addr = normalizeAddrSpec(last);
    return addr === null ? [] : [addr];
  }
  const out: string[] = [];
  for (const token of stripped.split(/\s+/)) {
    if (!token.includes("@")) continue;
    const addr = normalizeAddrSpec(token);
    if (addr !== null) out.push(addr);
  }
  return out;
}

/** Every mailbox an address header names, in order, normalized. Empty when it names none. */
export function parseAddressList(raw: string | null | undefined): string[] {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_HEADER_CHARS) return [];
  const out: string[] = [];
  for (const mailbox of splitMailboxes(raw)) out.push(...addressesInMailbox(mailbox));
  return out;
}

/**
 * `"Name" <a+tag@B.com>` → `a+tag@b.com`. Null when there is no address-shaped token.
 *
 * This is the ROUTING/lookup parse: a header carrying several addresses resolves to the first, which
 * is what a `MAILBOX_MAP` key or an envelope recipient needs. It must NOT be used to decide who SENT
 * a message — `parseFromAddress` is that, and it refuses an ambiguous header instead of picking.
 */
export function normalizeMailboxAddress(raw: string | null | undefined): string | null {
  const list = parseAddressList(raw);
  return list.length === 0 ? null : list[0];
}

/**
 * The single mailbox a `From` header names, or null when it names none or more than one.
 *
 * This is the SENDER-IDENTITY parse: the threading identity gate, the
 * `requesterEmail` of a ticket opened from mail, and the `senderAddress` recorded on a requester
 * comment all derive from it, so an ambiguous header is a hold (`PARSE_FAILED`), never a guess.
 * RFC 5322 permits a `From` to carry several mailboxes; a real client's mailer never does, and one
 * that does cannot be attributed to a single person anyway.
 */
export function parseFromAddress(raw: string | null | undefined): string | null {
  const list = parseAddressList(raw);
  return list.length === 1 ? list[0] : null;
}

/** Drops the `+tag` suffix a reply token rides on: `service+wm.a.b@x` → `service@x`. */
export function baseMailboxAddress(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return address;
  const local = address.slice(0, at);
  const plus = local.indexOf("+");
  return plus === -1 ? address : `${local.slice(0, plus)}${address.slice(at)}`;
}

/**
 * Parses `MAILBOX_MAP`. Returns a frozen map keyed by the lower-cased address (or the wildcard key
 * verbatim). Never throws: a missing, empty, non-object or unparseable value yields an empty map,
 * which means every mailbox is unknown.
 */
export function parseMailboxMap(raw: string | undefined): Readonly<Record<string, MailboxRoute>> {
  if (typeof raw !== "string" || raw.trim().length === 0) return EMPTY;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return EMPTY;

  const out: Record<string, MailboxRoute> = {};
  for (const [rawKey, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
    const trimmed = rawKey.trim().toLowerCase();
    if (trimmed.length === 0) continue;
    const key = trimmed === "*" || DOMAIN_WILDCARD.test(trimmed) ? trimmed : normalizeMailboxAddress(trimmed);
    if (key === null) continue;
    if (typeof rawValue !== "object" || rawValue === null || Array.isArray(rawValue)) continue;

    const value = rawValue as Record<string, unknown>;
    if (!isQueueKey(value.queueKey) || !isBrand(value.brand)) continue;
    const route: MailboxRoute = { queueKey: value.queueKey, brand: value.brand };
    if (isCategory(value.category)) route.category = value.category;
    out[key] = Object.freeze(route);
  }
  return Object.freeze(out);
}

/**
 * The route for an inbound address: exact match first (with the `+tag` suffix stripped, so the
 * reply-token plus-address still resolves), then `*@domain`, then `*`. Null when nothing matches,
 * which the intake path turns into `SuspendedIntake(UNKNOWN_MAILBOX)`.
 */
export function routeForMailbox(
  address: string,
  map: Readonly<Record<string, MailboxRoute>>,
): MailboxRoute | null {
  const normalized = normalizeMailboxAddress(address);
  if (normalized === null) return null;

  const base = baseMailboxAddress(normalized);
  const exact = map[normalized] ?? map[base];
  if (exact !== undefined) return exact;

  const at = base.lastIndexOf("@");
  if (at > 0) {
    const domainWildcard = map[`*@${base.slice(at + 1)}`];
    if (domainWildcard !== undefined) return domainWildcard;
  }
  return map["*"] ?? null;
}
