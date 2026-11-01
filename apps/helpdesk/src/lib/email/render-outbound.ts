/**
 * Outbound email rendering — pure.
 *
 * Turns the STORED comment body — which already carries the appended disclaimer, because
 * `addPublicReply` writes the row as exactly what the client receives — into the subject, the
 * text/plain part and the text/html part of one message. Nothing here reads the database, the
 * environment or the network, and nothing here sends.
 *
 * Safety: the body is staff-authored markdown that has already been through `sanitizePII`. It is still
 * treated as untrusted text for rendering purposes — every character is HTML-escaped BEFORE any markup
 * is produced, so a body containing `<script>` renders as the literal characters. Only a fixed subset of
 * markdown becomes markup, and only `http:`, `https:` and `mailto:` URLs ever become a link.
 *
 * `react-markdown` (what the staff timeline uses) is a React renderer and cannot produce a string here,
 * and no server-side markdown library is installed — R9 forbids adding one — so the subset below is
 * hand-written and unit-tested.
 */
import type { BrandIdentity } from "@/lib/brand";
import { renderSignatureHtml, renderSignatureText, signatureFor } from "@/lib/email/templates/signature";

export type RenderedOutbound = {
  /** `[HD-<number>] <subject>` — the token is deliberately NOT in the subject. */
  subject: string;
  /** text/plain part. */
  textBody: string;
  /** text/html part: a complete, self-contained document with inline styles only. */
  htmlBody: string;
};

/** `[HD-123] ` at the start of a subject, in any case, with flexible spacing. */
export const SUBJECT_PREFIX_PATTERN = /^\s*\[\s*HD-(\d+)\s*\]\s*/i;

const SUBJECT_MAX_CHARS = 200;

/**
 * C0 controls and DEL, in runs. `Ticket.subject` can carry them: of its writers only the email path
 * normalises whitespace (`normalizeSubject`), while `ingestTicketSchema` and the client-app create
 * schema are `z.string().trim()`, which strips the ends and leaves an embedded CR/LF alone.
 */
const SUBJECT_CONTROL_CHARS = /[\p{Cc}]+/gu;

/**
 * `[HD-<number>] <subject>`. An existing `[HD-…]` prefix is stripped first, so a reply to a threaded
 * message never accumulates `[HD-12] [HD-12] Re: …`. The result is capped at 200 characters
 * (INGEST_LIMITS.subjectMaxChars) with the prefix always kept intact.
 *
 * Control characters are flattened to a space FIRST. This string is published as
 * `OutboxLease.subject` and a poller writes it into the `Subject:` header, so a CR/LF in it is
 * header injection — an injected `Bcc:` in client mail — from anyone holding the ingest or client
 * bearer. Today the n8n sender happens to RFC 2047-encode anything non-printable, but that control
 * lives in a JSON workflow file outside this repo's test suite, and `src/server/outbox.ts` states
 * the design goal that swapping n8n for a dedicated ESP changes the poller and nothing here. The
 * invariant therefore belongs to the app.
 */
export function formatOutboundSubject(ticketNumber: number, subject: string): string {
  const prefix = `[HD-${ticketNumber}] `;
  const flattened = subject.replace(SUBJECT_CONTROL_CHARS, " ");
  const bare = flattened.replace(SUBJECT_PREFIX_PATTERN, "").trim();
  const room = Math.max(0, SUBJECT_MAX_CHARS - prefix.length);
  const body = bare.length === 0 ? "(no subject)" : bare.length > room ? `${bare.slice(0, Math.max(0, room - 1))}…` : bare;
  return `${prefix}${body}`;
}

// ---------------------------------------------------------------------------
// Escaping and URL safety
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes the five characters that can change HTML meaning. Applied before any markup is produced. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** Schemes a rendered link may carry. Anything else renders as inert text. */
const SAFE_SCHEMES = ["http://", "https://", "mailto:"] as const;

/**
 * The URL if it is safe to place in an `href`, else null. The input arrives ALREADY HTML-escaped
 * (so `&` is `&amp;`), which is exactly what an attribute value needs; this only decides the scheme
 * and rejects anything carrying a quote, angle bracket or whitespace.
 */
export function safeHref(escapedUrl: string): string | null {
  const url = escapedUrl.trim();
  if (url.length === 0 || url.length > 2000) return null;
  if (/[\s<>"']/.test(url)) return null;
  const lower = url.toLowerCase();
  if (!SAFE_SCHEMES.some((scheme) => lower.startsWith(scheme))) return null;
  return url;
}

// ---------------------------------------------------------------------------
// Inline markdown
// ---------------------------------------------------------------------------

/**
 * The one pass `renderInline` makes, as a REGEX LITERAL — the alternatives in order, matching the
 * capture-group numbering the replacer destructures:
 *
 *  1. `` `code` ``
 *  2,3. `[text](url)`
 *  4. `&lt;url&gt;` autolink (the angle brackets are already HTML-escaped by the time we see them)
 *  5. a bare `http(s)://…` URL
 *  6. `**strong**`   7. `__strong__`   8. `*em*`   9. `_em_`
 *
 * It used to be assembled from an array of strings and handed to `new RegExp(…)`. That is a regex
 * built from a non-literal argument — security scanner `CWE-185` — and the rule is right that the shape is the
 * problem rather than the particular argument: a literal cannot be reached by anything at runtime.
 * Every alternative is linear (one quantifier each, over a negated character class that excludes the
 * alternative's own delimiter), so no alternative can backtrack into another.
 */
const INLINE_PATTERN =
  /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|&lt;((?:https?:\/\/|mailto:)[^\s]+?)&gt;|(https?:\/\/[^\s<>()\[\]]+)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|(?<![A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])/g;

/**
 * Inline conversion over ALREADY-ESCAPED text, in one pass so a replacement's output is never rescanned:
 * `` `code` ``, `[text](url)`, `<url>` autolinks, bare http(s) URLs, `**strong**` / `__strong__`,
 * `*em*` / `_em_`. Anything unmatched stays literal.
 */
export function renderInline(escaped: string): string {
  return escaped.replace(INLINE_PATTERN, (match, code, linkText, linkUrl, autoUrl, bareUrl, strong1, strong2, em1, em2) => {
    if (typeof code === "string") return `<code style="font-family:ui-monospace,Menlo,Consolas,monospace">${code}</code>`;
    if (typeof linkText === "string" && typeof linkUrl === "string") {
      const href = safeHref(linkUrl);
      return href === null ? `${linkText} (${linkUrl})` : `<a href="${href}">${linkText}</a>`;
    }
    if (typeof autoUrl === "string") {
      const href = safeHref(autoUrl);
      return href === null ? match : `<a href="${href}">${autoUrl}</a>`;
    }
    if (typeof bareUrl === "string") {
      // A trailing sentence period is punctuation, not part of the URL.
      const trailing = /[.,;:!?]$/.test(bareUrl) ? bareUrl.slice(-1) : "";
      const url = trailing === "" ? bareUrl : bareUrl.slice(0, -1);
      const href = safeHref(url);
      return href === null ? match : `<a href="${href}">${url}</a>${trailing}`;
    }
    if (typeof strong1 === "string") return `<strong>${strong1}</strong>`;
    if (typeof strong2 === "string") return `<strong>${strong2}</strong>`;
    if (typeof em1 === "string") return `<em>${em1}</em>`;
    if (typeof em2 === "string") return `<em>${em2}</em>`;
    return match;
  });
}

/** The plain-text counterpart of `renderInline`: markers removed, links flattened to `text <url>`. */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => `${label} <${url}>`)
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/(?<![A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])/g, "$1");
}

// ---------------------------------------------------------------------------
// Block markdown
// ---------------------------------------------------------------------------

type Block =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "code"; lines: string[] }
  | { kind: "rule" };

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s{0,3}(?:```|~~~)/;

/**
 * Splits a body into the block subset this renderer supports: fenced code, ATX headings, thematic
 * breaks, blockquotes, flat bullet/ordered lists and paragraphs. Nested lists are deliberately NOT
 * supported — they flatten into their parent list, which is honest and deterministic for email.
 */
export function parseBlocks(body: string): Block[] {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", lines: paragraph });
      paragraph = [];
    }
  };
  const flushQuote = (): void => {
    if (quote.length > 0) {
      blocks.push({ kind: "quote", lines: quote });
      quote = [];
    }
  };
  const flushAll = (): void => {
    flushParagraph();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (FENCE.test(line)) {
      flushAll();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: "code", lines: code });
      continue;
    }

    if (line.trim().length === 0) {
      flushAll();
      continue;
    }

    if (RULE.test(line)) {
      flushAll();
      blocks.push({ kind: "rule" });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushAll();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    const quoted = QUOTE.exec(line);
    if (quoted) {
      flushParagraph();
      quote.push(quoted[1]);
      continue;
    }
    flushQuote();

    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const isOrdered = ordered !== null;
      const items: string[] = [(bullet ?? ordered)![1].trim()];
      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        const nextMatch = isOrdered ? ORDERED.exec(nextLine) : BULLET.exec(nextLine);
        if (!nextMatch) break;
        items.push(nextMatch[1].trim());
        i += 1;
      }
      blocks.push({ kind: "list", ordered: isOrdered, items });
      continue;
    }

    paragraph.push(line);
  }

  flushAll();
  return blocks;
}

const P_STYLE = 'style="margin:0 0 12px;line-height:1.5"';
const QUOTE_STYLE = 'style="margin:0 0 12px;padding:4px 0 4px 12px;border-left:3px solid #d4d4d8;color:#52525b"';
const CODE_STYLE =
  'style="margin:0 0 12px;padding:10px 12px;background:#f4f4f5;border-radius:6px;overflow-x:auto;' +
  'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:1.45"';
const RULE_STYLE = 'style="border:0;border-top:1px solid #e4e4e7;margin:16px 0"';
const LIST_STYLE = 'style="margin:0 0 12px;padding-left:20px;line-height:1.5"';

function blockToHtml(block: Block): string {
  switch (block.kind) {
    case "heading": {
      const level = Math.min(Math.max(block.level, 1), 6);
      const size = [20, 18, 16, 15, 14, 14][level - 1];
      return `<h${level} style="margin:16px 0 8px;font-size:${size}px;line-height:1.35">${renderInline(escapeHtml(block.text))}</h${level}>`;
    }
    case "rule":
      return `<hr ${RULE_STYLE} />`;
    case "code":
      return `<pre ${CODE_STYLE}><code>${escapeHtml(block.lines.join("\n"))}</code></pre>`;
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const items = block.items.map((item) => `<li>${renderInline(escapeHtml(item))}</li>`).join("");
      return `<${tag} ${LIST_STYLE}>${items}</${tag}>`;
    }
    case "quote":
      return `<blockquote ${QUOTE_STYLE}>${renderInline(escapeHtml(block.lines.join("\n"))).replace(/\n/g, "<br />")}</blockquote>`;
    case "paragraph":
      return `<p ${P_STYLE}>${renderInline(escapeHtml(block.lines.join("\n"))).replace(/\n/g, "<br />")}</p>`;
  }
}

function blockToText(block: Block): string {
  switch (block.kind) {
    case "heading":
      return stripInlineMarkdown(block.text);
    case "rule":
      return "----------------------------------------";
    case "code":
      return block.lines.join("\n");
    case "list":
      return block.items
        .map((item, i) => `${block.ordered ? `${i + 1}.` : "-"} ${stripInlineMarkdown(item)}`)
        .join("\n");
    case "quote":
      return block.lines.map((line) => `> ${stripInlineMarkdown(line)}`).join("\n");
    case "paragraph":
      return block.lines.map((line) => stripInlineMarkdown(line)).join("\n");
  }
}

/** Markdown subset → a safe HTML fragment (no `<html>` wrapper). Exported for the unit tests. */
export function markdownToSafeHtml(body: string): string {
  return parseBlocks(body).map(blockToHtml).join("\n");
}

/** Markdown subset → readable plain text. Exported for the unit tests. */
export function markdownToPlainText(body: string): string {
  return parseBlocks(body).map(blockToText).join("\n\n").trim();
}

// ---------------------------------------------------------------------------
// The plain-text part
// ---------------------------------------------------------------------------

/** C0 controls and DEL, except tab and newline, which are the two this part is allowed to carry. */
const TEXT_CONTROL_CHARS = /[ --]/g;
/** Zero-width and bidi-override characters. Invisible in a composer, visible as mojibake in a client. */
const TEXT_INVISIBLES = /[​-‏‪-‮⁠﻿]/g;

/**
 * Cleans the plain-text part ("a clean plain-text part").
 *
 * Four passes, each answering a specific way the text/plain half of a multipart message arrives
 * looking broken when the HTML half looks fine — which is the half a screen reader, a mail archive and
 * a text-only client actually read:
 *
 *  1. **Newlines are normalised to `\n`.** A body composed on Windows, pasted from a PDF and stored
 *     through three layers can carry all three conventions at once; a lone `\r` renders as a hard
 *     return in some clients and as nothing in others.
 *  2. **Trailing whitespace is stripped per line.** A trailing space before a newline is what
 *     quoted-printable encodes as `=20`, and `=20` at the end of every line is the single most common
 *     reason a clean text part arrives full of visible escape sequences.
 *  3. **Runs of blank lines collapse to one.** Markdown blocks already join with a blank line; three in
 *     a row is an artefact of the source, never a paragraph break somebody meant.
 *  4. **Invisible characters are removed.** Zero-width spaces and bidi overrides survive copy-paste out
 *     of web pages, carry no meaning in a text part, and a right-to-left override can reverse the way a
 *     reference number reads.
 *
 * It deliberately does NOT hard-wrap at 78 columns. RFC 5322's line-length guidance is about transport,
 * and every MTA in the path handles long lines by soft-wrapping; hard-wrapping breaks URLs across lines
 * and produces a ragged column on the phone screen most of these replies are read on.
 */
export function toCleanPlainText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(TEXT_CONTROL_CHARS, "")
    .replace(TEXT_INVISIBLES, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

const DOC_STYLE =
  "margin:0;padding:24px 16px;background:#ffffff;color:#18181b;" +
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px";
const WRAP_STYLE = "max-width:640px;margin:0 auto";
const FOOTER_STYLE = "margin:20px 0 0;padding-top:12px;border-top:1px solid #e4e4e7;font-size:12px;color:#71717a";
/** Each paragraph of the signature block. Inline, like everything else in an email document. */
const SIGNATURE_LINE_STYLE = "margin:0 0 8px;line-height:1.5";

/**
 * The complete rendered message for one public reply.
 *
 * `body` is the STORED comment body: the disclaimer is already inside it, so this function must
 * not append one — doing so would make the sent mail differ from the record of what was sent.
 *
 * The SIGNATURE is the one thing this function adds, and it is not record content: it is the same four
 * firm-level lines on every reply, rendered from `src/lib/email/templates/signature.ts`, carrying the
 * desk name, the firm name, what to do with the reference and the reference itself. It cannot carry an
 * individual or a phone number — there is no field for one, and `assertNoPersonalContact` refuses one
 * at module load. Both parts render the same signature from the same source, so the
 * text and HTML halves of a message can never sign off differently.
 *
 * The plain-text part goes through {@link toCleanPlainText} last, so the whole part — body, separator
 * and signature together — is free of trailing whitespace, stray control characters and triple blank
 * lines. It is the half a text-only client, a screen reader and the mail archive read.
 */
export function renderOutbound(input: {
  ticketNumber: number;
  subject: string;
  body: string;
  identity: BrandIdentity;
}): RenderedOutbound {
  const subject = formatOutboundSubject(input.ticketNumber, input.subject);
  const signature = signatureFor(input.identity.brand);

  const textBody = `${toCleanPlainText(
    `${markdownToPlainText(input.body)}\n\n${renderSignatureText(signature, input.ticketNumber)}`,
  )}\n`;

  const htmlBody = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width,initial-scale=1" />',
    `<title>${escapeHtml(subject)}</title>`,
    "</head>",
    `<body style="${DOC_STYLE}">`,
    `<div style="${WRAP_STYLE}">`,
    markdownToSafeHtml(input.body),
    `<div style="${FOOTER_STYLE}">${renderSignatureHtml(signature, input.ticketNumber, escapeHtml, SIGNATURE_LINE_STYLE)}</div>`,
    "</div>",
    "</body>",
    "</html>",
    "",
  ].join("\n");

  return { subject, textBody, htmlBody };
}
