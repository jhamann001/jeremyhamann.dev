/**
 * HTML part → plain text — pure, dependency-free.
 *
 * Inbound mail is HTML far more often than not, and the desk stores ONE body. This turns the HTML
 * part into the text a reader would have got had the client sent plain text, with the two things a
 * lossy converter usually throws away kept deliberately:
 *
 *  - **Links are preserved as `text <url>`** — an address change or a "click here" is evidence, and
 *    a bare "click here" in the ledger is worthless. A link whose text already IS the url is not
 *    doubled.
 *  - **Tables are flattened** — Apex and custodian notifications arrive as tables; cells are joined
 *    with " | " and rows with newlines so column structure survives as reading order.
 *
 * `<blockquote>` content is prefixed with "> " so `stripQuotedHistory` can recognise the quoted
 * history a mail client marked up structurally rather than textually.
 *
 * Order matters and is security-relevant: tags are removed BEFORE entities are decoded, so
 * `&lt;script&gt;` in the source can never become a tag this function then honours.
 */

/** Longest input we will convert. Beyond this the caller is not looking at a hand-written email. */
export const HTML_INPUT_MAX_CHARS = 2_000_000 as const;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  eacute: "é",
  deg: "°",
  euro: "€",
  pound: "£",
  cent: "¢",
  times: "×",
  divide: "÷",
  laquo: "«",
  raquo: "»",
  shy: "",
  zwnj: "",
  zwj: "",
};

/** `&amp;` `&#39;` `&#x27;` — decoded last, once the markup is already gone. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});/gi, (whole, body: string) => {
    const lowered = body.toLowerCase();
    if (lowered.startsWith("#x")) {
      const code = Number.parseInt(lowered.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeFromCodePoint(code) : whole;
    }
    if (lowered.startsWith("#")) {
      const code = Number.parseInt(lowered.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeFromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[lowered];
    return named === undefined ? whole : named;
  });
}

function safeFromCodePoint(code: number): string {
  // Lone surrogates would corrupt the stored body; drop them rather than persist half a pair.
  if (code >= 0xd800 && code <= 0xdfff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/**
 * Placeholders for the angle brackets a preserved link needs. The generic tag strip in step 5 would
 * otherwise eat `<https://…>` as if it were markup; these survive it and are restored immediately
 * after, before entity decoding, so nothing downstream can reinterpret them.
 */
const OPEN_ANGLE = "\u0002";
const CLOSE_ANGLE = "\u0003";

/** `<a href="https://x">click</a>` → `click <https://x>`; a self-describing link is left alone. */
function expandLinks(html: string): string {
  return html.replace(
    /<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (whole, _q: string, dq: string | undefined, sq: string | undefined, bare: string | undefined, inner: string) => {
      const href = (dq ?? sq ?? bare ?? "").trim();
      const label = decodeEntities(inner.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
      if (href.length === 0 || /^(javascript|data|vbscript):/i.test(href)) return label.length > 0 ? label : "";
      if (href.startsWith("mailto:")) {
        const address = href.slice("mailto:".length);
        return label.length === 0 || label.toLowerCase() === address.toLowerCase()
          ? address
          : `${label} ${OPEN_ANGLE}${address}${CLOSE_ANGLE}`;
      }
      if (label.length === 0) return `${OPEN_ANGLE}${href}${CLOSE_ANGLE}`;
      const normalisedLabel = label.replace(/\/$/, "");
      const normalisedHref = href.replace(/\/$/, "");
      if (normalisedLabel.toLowerCase() === normalisedHref.toLowerCase()) return href;
      return `${label} ${OPEN_ANGLE}${href}${CLOSE_ANGLE}`;
    },
  );
}

/**
 * Sentinels for a blockquote's boundaries, carried through the tag strip and consumed in step 7.
 * Control characters are used so no email body can contain one by accident; step 7 removes any that
 * survive, so a hand-crafted body cannot inject a quote level either.
 */
const QUOTE_START = "\u0001QUOTE_START\u0001";
const QUOTE_END = "\u0001QUOTE_END\u0001";

/** Marks blockquote bodies so the textual quoted-history stripper can see structural quoting too. */
function markBlockquotes(html: string): string {
  return html
    .replace(/<blockquote\b[^>]*>/gi, `\n${QUOTE_START}\n`)
    .replace(/<\/blockquote\s*>/gi, `\n${QUOTE_END}\n`);
}

function applyQuoteMarkers(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let depth = 0;
  for (const line of lines) {
    if (line.includes(QUOTE_START)) {
      depth += 1;
      continue;
    }
    if (line.includes(QUOTE_END)) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    out.push(depth > 0 && line.trim().length > 0 ? `${"> ".repeat(depth)}${line}` : line);
  }
  return out.join("\n");
}

/**
 * Converts an HTML mail part to text. Always returns a string (never throws); an empty or
 * over-long input returns "" so the caller can fall back to the text part or suspend PARSE_FAILED.
 */
export function htmlToText(html: string): string {
  if (typeof html !== "string" || html.length === 0) return "";
  if (html.length > HTML_INPUT_MAX_CHARS) return "";

  let working = html;

  // 1. Structural noise that must not contribute text at all.
  working = working.replace(/<!--[\s\S]*?-->/g, "");
  working = working.replace(/<(script|style|head|title|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  working = working.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  working = working.replace(/<\?[\s\S]*?\?>/g, "");
  working = working.replace(/<!DOCTYPE[^>]*>/gi, "");

  // 2. Links, then quoting, before the generic tag strip eats the attributes.
  working = expandLinks(working);
  working = markBlockquotes(working);

  // 3. Table cells flatten to " | "; only the ROW opener contributes a newline, so adjacent rows do
  //    not each produce a blank line between them.
  working = working.replace(/<\/(td|th)\s*>\s*(?=<(td|th)\b)/gi, " | ");
  working = working.replace(/<\/(td|th)\s*>/gi, "");
  working = working.replace(/<(td|th)\b[^>]*>/gi, "");

  // 4. Remaining block-level and break elements become newlines; list items get a bullet. Closing
  //    <li> and <tr> contribute nothing for the same reason.
  working = working.replace(/<br\b[^>]*>/gi, "\n");
  working = working.replace(/<hr\b[^>]*>/gi, "\n---\n");
  working = working.replace(/<\/(li|tr)\s*>/gi, "");
  working = working.replace(/<li\b[^>]*>/gi, "\n- ");
  working = working.replace(/<tr\b[^>]*>/gi, "\n");
  working = working.replace(
    /<\/?(table|thead|tbody|tfoot|caption|p|div|section|article|header|footer|ul|ol|h[1-6]|pre|address|figure|figcaption|dl|dt|dd|main|aside|nav|form|fieldset)\b[^>]*>/gi,
    "\n",
  );

  // 5. Everything else is inline: drop the tag, keep the text. Restore the preserved link brackets
  //    immediately afterwards — they were never markup and must not be re-read as such.
  working = working.replace(/<[^>]*>/g, "");
  working = working.replaceAll(OPEN_ANGLE, "<").replaceAll(CLOSE_ANGLE, ">");

  // 6. Entities LAST — nothing after this point interprets markup.
  working = decodeEntities(working);

  // 7. Whitespace normalisation. NBSP became a space in step 6; CR and zero-width joiners go now.
  working = working.replace(/\r\n?/g, "\n").replace(/[​‌‍﻿]/g, "");
  working = applyQuoteMarkers(working);
  // Any sentinel a hostile body supplied itself is gone by now; drop every other control character.
  working = working.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  working = working
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trimEnd())
    .join("\n");
  working = working.replace(/\n{3,}/g, "\n\n");

  return working.trim();
}
