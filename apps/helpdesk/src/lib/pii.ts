/**
 * PII redaction — pure, deterministic, idempotent, never throws.
 *
 * Rules run in order — CARD, SSN, ACCOUNT — on the running text, so an earlier rule's replacement
 * token is never re-read as a digit run (tokens carry at most 4 consecutive digits). Context windows
 * (the ≤ 24 chars before a candidate) are evaluated against the ORIGINAL text at the candidate's
 * original offset, so the wording of a replacement token can never act as context.
 *
 * `findings` carry offsets into the original text and the replacement — never the matched value — so the
 * result object is safe to log.
 *
 * ---------------------------------------------------------------------------------------------------
 * DECISION #116 (2026-09-20) — the desk redacts THREE kinds: SSN, CARD, ACCOUNT.
 *
 * Four rules were withdrawn in one pass. `ROUTING` (§f rule 3) because a routing number identifies a
 * BANK, not a person: the Fed publishes the whole table, and redacting it cost the wire desk real time
 * while protecting nothing on its own — ACCOUNT still redacts, so the routing+account PAIR is still
 * broken. `DOB`, `PASSPORT` and `DL` (Wave B rules 5–7) because they were never in the original spec
 * and a date of birth is working data here: required minimum distributions, beneficiary forms and
 * caller verification all need it.
 *
 * **Rule numbers are deliberately NOT re-flowed.** §f rule 3 is withdrawn, not renamed, so that
 * Decision #48 ("rule 3 adjacency") and Decision #50 ("rule 4 hardening") keep pointing at the rules
 * they were written about. CARD is 1, SSN is 2, ACCOUNT is 4, and there is no 3, 5, 6 or 7.
 *
 * **What retiring rule 3 exposed, and the guard that answers it.** Rule 3 used to CONSUME every bare
 * nine-digit run before rule 4 ever saw it. Without it a routing number is just a nine-digit run, and
 * rule 4's context window reaches back 24 characters — so `acct 4455667788, routing 021000021` would
 * have redacted the published ABA number as an account, because the word "acct" is still inside the
 * window. `ROUTING_CONTEXT_TAIL` therefore survives rule 3's withdrawal as a NEGATIVE guard on rule 4:
 * a routing marker immediately before a NINE-DIGIT candidate means "this is a routing number", which is
 * now a thing we deliberately leave alone. The regression vectors for this are in `src/lib/pii.test.ts`
 * under "a routing number is not swept up by a neighbouring rule".
 *
 * **What the guard does NOT do, stated so the wire desk is not surprised by it.**
 *   - It is SCOPED TO NINE DIGITS. Any other length after `routing`/`aba`/`rtn`/`transit number` still
 *     redacts as ACCOUNT, because it cannot be an ABA number — `account 4455667788, routing 4455667788`
 *     (a client who pasted the same number into both fields) keeps both halves redacted.
 *   - It is NO LONGER ADJACENCY-ONLY (amendment, 2026-09-20). The anchored guard destroyed the
 *     routing half of every LABEL-PAIR layout — `Routing / Account: 021000021 / 4455667788` is one of
 *     the commonest ways a client sends wire instructions, and there the marker introduces the PAIR,
 *     not the number, so nothing sits adjacent to the digits. A second, STRUCTURAL guard answers
 *     those: `looksLikeRoutingNumber` recognises an ABA number by SHAPE (exactly nine digits, valid
 *     Federal Reserve prefix, ABA 3-7-1 checksum) and rule 4 suppresses only when a routing marker
 *     ALSO appears anywhere in the 48 characters before the candidate.
 *
 *     BOTH halves are required, and shape alone is deliberately not enough: about 3.8% of random
 *     nine-digit runs pass it, so a nine-digit ACCOUNT number with no routing word anywhere still
 *     redacts. That is why `Chase checking 021000021 4455667788` still redacts BOTH runs — nothing in
 *     it claims a routing number, so redacting both is the safe reading — and why that case is pinned
 *     by test rather than left to be "fixed" later.
 *   - It does NOT make a date, a passport number or a licence number unconditionally safe. Rule 4 never
 *     knew those kinds and still does not: an ISO (`1975-01-02`) or compact (`19750102`) date is a
 *     6–17 digit run once its dash is treated as a separator, so it redacts as ACCOUNT when account
 *     context ends within 24 characters — `IRA account 4471209983 — owner born 1975-01-02` masks the
 *     date as `[REDACTED:ACCOUNT ****0102]`. Slash and written-month dates (`01/02/1975`,
 *     `2 January 1975`) pass through. This is UNCHANGED by Decision #116 — rule 4 always ran before the
 *     Wave B rules — but it is the limit of "a date of birth passes through", and it is pinned by test.
 *
 * Redaction is irreversible. Rows written under the four-kind and seven-kind sets keep their tokens;
 * nothing is backfilled. A historical `[REDACTED:ROUTING]`, `[REDACTED:DOB]`, `[REDACTED:PASSPORT]` or
 * `[REDACTED:DL]` in stored text is inert here — it carries no digit run any candidate can match, and
 * none of its words is positive context for a surviving rule — which `pii.test.ts` asserts directly
 * rather than leaving to inspection.
 * ---------------------------------------------------------------------------------------------------
 */
import { PII_KINDS } from "@/types/domain";
import type { PiiFinding, PiiKind, SanitizeResult } from "@/types/domain";

const CONTEXT_WINDOW_CHARS = 24;

/**
 * The lookbehind window for the ROUTING RECOGNISER only — rule 4's structural negative guard, and
 * nothing else in this module. Deliberately wider than `CONTEXT_WINDOW_CHARS`, and deliberately a
 * bounded constant.
 *
 * WHY WIDER AT ALL. In a label-pair layout the marker introduces the PAIR, not the number, so the gap
 * grows with the label rather than staying at zero. Measured from the first digit back to the end of
 * the routing keyword, on the phrasings this desk actually receives:
 *
 *     11  `Routing / Account: N`
 *     18  `Routing number / Account number: N`
 *     21  `routing and account numbers: N`
 *     26  `Routing number for the wire and account: N`
 *     31  `Routing is on the letter; the account: N`
 *     39  `Routing per the bank letter, checking account: N`
 *
 * Twenty-four reaches the first three and misses the last three.
 *
 * WHY 48 AND NOT MORE. It is exactly two of the existing windows — the longest phrasing above plus
 * about a quarter again in headroom — and still under a written sentence, so a routing word belonging
 * to the PREVIOUS sentence does not reach forward into this one. It is a constant rather than a scan
 * back to the start of the text: an unbounded lookbehind would let one `routing` anywhere in a long
 * ticket body silence every nine-digit run after it for the rest of the ticket.
 *
 * WHY IT CANNOT RUN AWAY. Rule 4 only ever reaches this guard for a candidate whose ACCOUNT context
 * already ended within `CONTEXT_WINDOW_CHARS`, so the account keyword is always the nearer of the two
 * and the routing marker can only be as far back as a label pair puts it. That is what bounds the
 * useful width in practice, and it is why a much larger number would buy nothing but suppression.
 *
 * The width only ever matters for a candidate that has ALREADY passed `looksLikeRoutingNumber`, which
 * about 3.8% of random nine-digit runs do. Widening it therefore trades a narrow slice of that 3.8%
 * for the wire desk's commonest layouts; see rule 4 for the accounting.
 */
const ROUTING_CONTEXT_WINDOW_CHARS = 48;

/**
 * Human labels for the three kinds — used by `PiiIndicator`'s optional breakdown.
 *
 * INTEGRATION NOTE: the `WIDE_PII_KINDS` / `WidePiiKind` / `WideSanitizeResult` /
 * `WidePiiFinding` / `WIDE_PII_REPLACEMENT_PATTERN` names are GONE rather than re-pointed. They were
 * Wave B's "the widened set" and had already collapsed to aliases of the canonical names in
 * integration round 1; with the widening reversed, a name that says "wide" on a list that is now
 * shorter than the original four is worse than no name. Every importer reads `PII_KINDS` / `PiiKind` /
 * `SanitizeResult` / `PiiFinding` from `@/types/domain` directly — two app modules
 * (`src/server/import.ts`, `src/components/tickets/pii-indicator.tsx`) and the tests.
 */
export const PII_KIND_LABELS: Readonly<Record<PiiKind, string>> = {
  SSN: "Social Security number",
  CARD: "Payment card",
  ACCOUNT: "Account number",
};

/**
 * Matches every replacement token this module can emit.
 *
 * A LITERAL, not `new RegExp` over `PII_KINDS.join("|")`: a regex constructed from a non-literal
 * argument is security scanner `CWE-185` regardless of how constant the argument is (the build record), and
 * the constructor is what the rule sees. "A kind can never be added or removed without the idempotence
 * mask learning about it" is a PARITY ASSERTION instead — `src/lib/pii.test.ts` pins this `.source` to
 * `PII_REPLACEMENT_PATTERN.source`, and `src/types/domain.test.ts` pins THAT pattern to `PII_KINDS`.
 *
 * It is kept as its own regex object rather than re-exporting the domain constant so the two never
 * share a `lastIndex`.
 */
export const PII_TOKEN_MASK_PATTERN = /\[REDACTED:(SSN|CARD|ACCOUNT)(?: \*{4}\d{4})?\]/g;

// --- candidate shapes -------------------------------------------------------------------------------
/** 15–16 digits, optional single space/dash separators (uniformity is checked after matching). */
const CARD_CANDIDATE = /\b(?:\d[ -]?){14,15}\d\b/g;
/** Separated SSN; the two separators must agree (checked after matching). */
const SSN_SEPARATED = /\b(\d{3})([- ])(\d{2})([- ])(\d{4})\b/g;
/** Bare nine digits (an SSN written without separators). */
const NINE_DIGITS = /\b\d{9}\b/g;
/** 6–17 digits with single separators; redacted only with account context. */
const ACCOUNT_CANDIDATE = /\b\d(?:[ -]?\d){5,16}\b/g;

// --- context shapes (evaluated on the original text) -------------------------------------------------
/** SSN context: keyword, optional `no.`/`number`/`#`, optional `:`; must end within the 24 chars before the match. */
const SSN_CONTEXT = /\b(?:ssn|social\s+security|soc\s+sec|tax\s+id|tin|itin)(?![a-z])\s*(?:no\.?|number|#)?\s*:?/gi;
/** Account context, same shape. */
const ACCOUNT_CONTEXT = /\b(?:acct|account|a\/c|iban|checking|savings)(?![a-z])\s*(?:no\.?|number|#)?\s*:?/gi;
/**
 * A routing marker immediately before a candidate (anchored at the end of the window).
 *
 * This used to be what TURNED ON §f rule 3. Rule 3 is withdrawn and the same literal is
 * now a NEGATIVE guard on rule 4: a number introduced by `routing` / `aba` / `rtn` / `transit number` is
 * a routing number, and a routing number is no longer redacted — including when an account keyword
 * earlier in the sentence has left account context inside the 24-character window.
 *
 * TWO NARROWINGS THE PROMOTION FORCED, both because a POSITIVE trigger that over-fires only ever caused
 * an extra redaction while a NEGATIVE guard that over-fires leaves a raw account number in the database:
 *
 *   1. `transit` alone is gone; it now requires an explicit `no.` / `number` / `#` after it. "In transit"
 *      is ordinary phrasing on an ACAT/wire desk — `acct in transit 000123456789` is an ACCOUNT number —
 *      whereas the term this list wants, "transit number", is always written with the noun. `routing`,
 *      `aba` and `rtn` are unambiguous on their own and keep the optional marker.
 *   2. The CALLER length-scopes it to nine digits (see rule 4). A routing number is exactly nine digits
 *      by definition, so a 6–8 or 10–17 digit run after a routing marker cannot be one, and suppressing
 *      it would only ever be an I4 false negative.
 */
const ROUTING_CONTEXT_TAIL =
  /\b(?:(?:routing|aba|rtn)(?![a-z])\s*(?:no\.?|number|#)?|transit(?![a-z])\s*(?:no\.?|number|#))\s*:?\s*$/i;
/**
 * The SAME keyword list as {@link ROUTING_CONTEXT_TAIL}, carrying the SAME two narrowings (bare
 * `transit` is not a marker; `transit` requires its noun), declared as a SECOND LITERAL with the
 * trailing `$` anchor dropped and `g` added. Never `new RegExp(ROUTING_CONTEXT_TAIL.source, "gi")` —
 * the build record: a second literal, not a pattern derived from another's `.source`. Its
 * shape is `ACCOUNT_CONTEXT`'s exactly, which is the windowed-context shape this module already uses.
 *
 * Unanchored, it answers "is there a routing marker ANYWHERE in the window" rather than "is one
 * immediately in front of the digits". That question is only ever asked about a candidate that has
 * already passed {@link looksLikeRoutingNumber}; asked on its own it would suppress far too much,
 * which is the whole reason rule 4 requires both and not either.
 */
const ROUTING_CONTEXT_WINDOWED =
  /\b(?:(?:routing|aba|rtn)(?![a-z])\s*(?:no\.?|number|#)?|transit(?![a-z])\s*(?:no\.?|number|#))\s*:?/gi;
/** Negative-context label immediately adjacent before the number — verbatim from §f. */
const NEGATIVE_CONTEXT_TAIL =
  /(cusip|isin|sedol|ticket|case|ref|reference|order|confirmation|invoice|wm-|req-|#)\s*(?:#|no\.?|number|id)?\s*[:#-]?\s*$/i;
/**
 * Account context immediately adjacent before the number (anchored at the end of the window). Explicit
 * account context wins over a bare-`#` negative label (§f rule 4). `#` is a slot separate
 * from `no.`/`number`, so both `acct #` and `account number #` match.
 */
const ACCOUNT_CONTEXT_TAIL = /\b(?:acct|account|a\/c|iban|checking|savings)(?![a-z])\s*(?:no\.?|number)?\s*#?\s*:?\s*$/i;
/**
 * Structural shapes that are never an account number even when account context sits nearby (§f rule 4,
 * Decision #50): a FORMATTED NANP phone number (3-3-4 with a `.`/`-`/space separator — a bare 10-digit run
 * is deliberately NOT excluded, so a 10-digit account still redacts) and a zip+4. The phone shape is matched
 * against the whole text (not the candidate alone) so a phone's trailing sub-run — e.g. `555 1234` inside
 * `212 555 1234`, which `applyRule` re-examines after the full run is rejected — is excluded too.
 */
const FORMATTED_PHONE = /\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}/g;
const ZIP_PLUS_FOUR = /^\d{5}-\d{4}$/;

// --- helpers ---------------------------------------------------------------------------------------

export function emptyByKind(): Record<PiiKind, number> {
  const out = {} as Record<PiiKind, number>;
  for (const kind of PII_KINDS) out[kind] = 0;
  return out;
}

/** Luhn mod-10 over a digit string (the whole string, no separators). */
export function luhnValid(digits: string): boolean {
  if (!/^\d{2,}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** SSA-plausible: area ∉ {000, 666, 900–999}, group ≠ 00, serial ≠ 0000, not the advertising numbers. */
export function ssnPlausible(area: string, group: string, serial: string): boolean {
  if (!/^\d{3}$/.test(area) || !/^\d{2}$/.test(group) || !/^\d{4}$/.test(serial)) return false;
  const a = Number(area);
  if (a === 0 || a === 666 || a >= 900) return false;
  if (group === "00" || serial === "0000") return false;
  const full = `${area}-${group}-${serial}`;
  if (full === "078-05-1120" || full === "219-09-9999") return false;
  return true;
}

/**
 * ROUTING-NUMBER RECOGNISER — **NOT A REDACTION RULE**, and deliberately private so it cannot become
 * one by accident.
 *
 * §f rule 3 (ROUTING) is withdrawn and is not coming back. Nothing here ever produces
 * a redaction, a token or a finding: the single caller is rule 4's negative guard, where a `true`
 * answer means **leave this text alone**. Rule 3's exported `abaValid` was deleted with the rule; this
 * is its checksum reintroduced under a name that states the job, and unexported, because an exported
 * `abaValid` invites a future caller to redact on it — which is Decision #116 reversed by accident.
 *
 * Two independent structural facts, both required:
 *   - **Federal Reserve routing symbol** — the first two digits are 00–12 (Fed districts), 21–32
 *     (thrift), 61–72 (electronic / traveller's cheque) or 80 (government). 38 of the 100 prefixes.
 *   - **ABA checksum** — 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10). Exactly 1 run in 10
 *     passes: d9 carries weight 1, so for any first eight digits exactly one d9 satisfies it.
 *
 * Joint pass rate on a uniformly random nine-digit run: 0.38 × 0.10 = **3.8%**. That number is the
 * reason rule 4 does not treat `true` here as sufficient — see the guard for the accounting.
 */
function fedRoutingPrefixValid(digits: string): boolean {
  const prefix = (digits.charCodeAt(0) - 48) * 10 + (digits.charCodeAt(1) - 48);
  return prefix <= 12 || (prefix >= 21 && prefix <= 32) || (prefix >= 61 && prefix <= 72) || prefix === 80;
}

function abaChecksumValid(digits: string): boolean {
  const d = (i: number): number => digits.charCodeAt(i) - 48;
  const sum = 3 * (d(0) + d(3) + d(6)) + 7 * (d(1) + d(4) + d(7)) + (d(2) + d(5) + d(8));
  return sum % 10 === 0;
}

function looksLikeRoutingNumber(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  return fedRoutingPrefixValid(digits) && abaChecksumValid(digits);
}

/**
 * `[REDACTED:SSN]`, `[REDACTED:CARD ****1111]`, `[REDACTED:ACCOUNT ****6789]`.
 *
 * A last-4 tail is emitted for CARD and ACCOUNT only (PCI DSS permits it); SSN tokens never carry a
 * tail, because Reg S-P treats a partial SSN as NPI.
 */
export function redactionToken(kind: PiiKind, last4?: string): string {
  const tail =
    last4 !== undefined && (kind === "CARD" || kind === "ACCOUNT") && /^\d{4}$/.test(last4) ? ` ****${last4}` : "";
  return `[REDACTED:${kind}${tail}]`;
}

/**
 * `"SSN=1;CARD=0;ACCOUNT=1"` in `PII_KINDS` order.
 *
 * THIS STRING HAS HAD THREE SHAPES, and all three are still in the ledger:
 *   - four counters  `SSN=…;CARD=…;ROUTING=…;ACCOUNT=…`                       (through Wave A)
 *   - seven counters `SSN=…;CARD=…;ROUTING=…;ACCOUNT=…;DOB=…;PASSPORT=…;DL=…`
 *   - three counters `SSN=…;CARD=…;ACCOUNT=…`                                
 *
 * `AuditLog` is append-only and hash-chained, so the older rows keep their older strings forever. It
 * is display-only — `ActivityRow` and the audit table/dialog render `newValue` verbatim, and no
 * reader in this repository splits it into fields (the one shape-sensitive assertion,
 * `src/server/import.integration.test.ts`, matches the substring `SSN=<n>` and is true of all three).
 * Fixed width within a shape is still deliberate: a counter that appeared only when non-zero would
 * make "this row had no ACCOUNT redaction" and "this row predates the ACCOUNT counter" the same string.
 */
export function formatPiiCounts(byKind: Partial<Record<PiiKind, number>>): string {
  return PII_KINDS.map((kind) => `${kind}=${byKind[kind] ?? 0}`).join(";");
}

// --- internal scanning machinery ---------------------------------------------------------------------

type Replacement = { start: number; end: number; replacement: string };

type ScanState = {
  /** The original input; contexts and reported offsets refer to it. */
  original: string;
  /** Text after the rules applied so far. */
  running: string;
  /** running index → original index (-1 for characters belonging to a replacement token). */
  map: number[];
  findings: PiiFinding[];
};

/**
 * Every match end position of a global context regex over the original text (computed once per rule).
 * `ctx` MUST carry the `g` flag — both callers pass a module-level `g` literal, and `matchAll` throws
 * loudly rather than silently looping if a future one does not.
 *
 * `String.prototype.matchAll` rather than the `new RegExp(ctx.source, …)` copy this used to build: a
 * regex constructed from a non-literal argument is security scanner `CWE-185`, and the copy bought nothing the
 * iterator does not already give — `matchAll` iterates from the start, advances over a zero-length
 * match by one, and leaves the caller's `lastIndex` untouched, which is the whole reason a private
 * copy existed.
 */
function contextEnds(original: string, ctx: RegExp): number[] {
  const ends: number[] = [];
  for (const m of original.matchAll(ctx)) {
    if (m[0].length === 0) continue;
    ends.push(m.index + m[0].length);
  }
  return ends;
}

/**
 * True when some context match ends within `windowChars` immediately before `start` (inclusive of
 * `start`). The default is the 24-character window every POSITIVE context gate uses; rule 4's routing
 * recogniser is the one caller that passes a different width (`ROUTING_CONTEXT_WINDOW_CHARS`), and it
 * passes it explicitly at the call site so the wider window is visible where it is used.
 */
function contextEndsBefore(
  ends: readonly number[],
  start: number,
  windowChars: number = CONTEXT_WINDOW_CHARS,
): boolean {
  const from = start - windowChars;
  return ends.some((e) => e <= start && e >= from);
}

/** Anchored tail check over the ≤ 24 chars before `start`, ignoring a keyword cut in half by the window edge. */
function tailMatches(original: string, start: number, tail: RegExp): boolean {
  const from = Math.max(0, start - CONTEXT_WINDOW_CHARS);
  const window = original.slice(from, start);
  const m = tail.exec(window);
  if (m === null) return false;
  if (m.index === 0 && from > 0 && /\w/.test(original.charAt(from - 1)) && /\w/.test(m[0].charAt(0))) {
    return false;
  }
  return true;
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

/**
 * Replaces every redaction token already present in the text with same-length filler, so a token's own
 * wording (`ACCOUNT`, `SSN`, …) can never act as context for a later rule or a second sanitize pass
 * (§f idempotence clause). Length is preserved so offsets into the original text stay valid.
 * Context detection and tail matching run over this masked copy; candidate detection still runs over the
 * live running text, so nothing about which digits get redacted changes — only which context is honoured.
 * The filler is a non-word, non-whitespace sentinel, NOT a space: a space would be swallowed by a context
 * regex's trailing `\s*`, moving the context end forward to just before the number (idempotence would still
 * break). `~` matches neither `\s` nor `\w` nor any literal in the context / negative / routing patterns, so
 * a masked token can neither supply a keyword nor extend an adjacent one's window.
 *
 * DECISION #116: the mask narrowed to three kinds with the rule set, and that is SAFE for the four
 * retired token shapes still sitting in stored text. `[REDACTED:ROUTING]`, `[REDACTED:DOB]`,
 * `[REDACTED:PASSPORT]` and `[REDACTED:DL]` carry no digits at all, so no candidate can match inside
 * one; none of their words is positive context for a surviving rule (`ROUTING` contains `TIN` only
 * mid-word, which `\b` rejects); and the two anchored tail checks cannot reach across a token's
 * closing `]`, so an unmasked token cannot SUPPRESS a redaction either. `pii.test.ts` asserts all of
 * that on the four historical shapes rather than leaving it to inspection.
 */
const MASK_FILL = "~";
function maskReplacementTokens(text: string): string {
  // The constant is passed straight to `String.replace` rather than copied through
  // `new RegExp(….source, "g")`, which was a non-literal regex construction (security scanner CWE-185). It is
  // already a `g` literal, and `String.replace` sets a global regex's `lastIndex` to 0 before it
  // scans, which is what the copy was buying.
  return text.replace(PII_TOKEN_MASK_PATTERN, (m) => MASK_FILL.repeat(m.length));
}

/**
 * Character spans of every formatted phone number in the text (computed once per rule). `matchAll`
 * over the `g` literal, for the reason given on {@link contextEnds}: no `new RegExp` (security scanner CWE-185).
 */
function formattedPhoneSpans(original: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const m of original.matchAll(FORMATTED_PHONE)) {
    if (m[0].length === 0) continue;
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

/** True when [start, end) lies entirely within one of the given spans. */
function insideAnySpan(spans: ReadonlyArray<readonly [number, number]>, start: number, end: number): boolean {
  return spans.some(([s, e]) => s <= start && e >= end);
}

/**
 * Number-punctuation adjacency guard. A digit run is a fragment of a larger formatted
 * number — and therefore never an identifier of its own — only when it is glued to NUMBER punctuation: a
 * `$` or `-` immediately before it (`$021000021`, `2026-021000021`), a `,` or `.` that sits BETWEEN digits
 * on either side (`1,021000021`, `0.021000021`, `021000021,5`, `021000021.5`), or a `-` directly followed
 * by a digit (`021000021-1`). A `,`, `.` or `-` followed by whitespace, the end of the text or any
 * non-digit is SENTENCE punctuation and never suppresses.
 *
 * Written for rule 3, which is withdrawn; rule 4 has used it since Decision #50 and is
 * now its only caller, which is why it survives.
 */
function gluedToNumberPunctuation(original: string, start: number, end: number): boolean {
  const prev = start > 0 ? original.charAt(start - 1) : "";
  if (prev === "$" || prev === "-") return true;
  if ((prev === "," || prev === ".") && start >= 2 && isDigit(original.charAt(start - 2))) return true;
  const next = end < original.length ? original.charAt(end) : "";
  if ((next === "," || next === "." || next === "-") && end + 1 < original.length && isDigit(original.charAt(end + 1))) {
    return true;
  }
  return false;
}

/**
 * Runs one rule over the running text. `decide` receives the match plus its ORIGINAL offsets and returns
 * a replacement token to consume the span, or null to leave it. Rejected candidates resume scanning at
 * `index + 1` so a failed long run cannot hide a valid shorter one that starts inside it.
 *
 * `candidate` MUST be one of this file's module-level `g` literals. The scan drives `lastIndex` by hand
 * (that is what "resume at index + 1" means) and always runs to exhaustion, which leaves `lastIndex`
 * back at 0; resetting it here as well means a rule cannot inherit a previous rule's position even if
 * that ever stopped holding. This used to scan a `new RegExp(candidate.source, …)` copy instead, which
 * is a regex built from a non-literal argument — security scanner `CWE-185` — for no behavioural gain.
 */
function applyRule(
  state: ScanState,
  candidate: RegExp,
  kind: PiiKind,
  decide: (m: RegExpExecArray, origStart: number, origEnd: number) => string | null,
): void {
  const re = candidate;
  re.lastIndex = 0;
  const replacements: Replacement[] = [];
  const { running, map } = state;
  let m: RegExpExecArray | null;
  while ((m = re.exec(running)) !== null) {
    const s = m.index;
    const e = s + m[0].length;
    if (e === s) {
      re.lastIndex = s + 1;
      continue;
    }
    const origStart = map[s];
    const origEnd = map[e - 1] + 1;
    let replacement: string | null = null;
    // A candidate never spans a replacement token (tokens hold ≤ 4 consecutive digits); guard anyway.
    if (origStart >= 0 && map[e - 1] >= 0 && origEnd - origStart === e - s) {
      replacement = decide(m, origStart, origEnd);
    }
    if (replacement === null) {
      re.lastIndex = s + 1;
      continue;
    }
    replacements.push({ start: s, end: e, replacement });
    state.findings.push({ kind, start: origStart, end: origEnd, replacement });
    re.lastIndex = e;
  }
  if (replacements.length === 0) return;

  // Rebuild the running text and its offset map once per rule.
  let out = "";
  const newMap: number[] = [];
  let cursor = 0;
  for (const r of replacements) {
    out += running.slice(cursor, r.start);
    for (let i = cursor; i < r.start; i++) newMap.push(map[i]);
    out += r.replacement;
    for (let i = 0; i < r.replacement.length; i++) newMap.push(-1);
    cursor = r.end;
  }
  out += running.slice(cursor);
  for (let i = cursor; i < running.length; i++) newMap.push(map[i]);
  state.running = out;
  state.map = newMap;
}

// --- public API ------------------------------------------------------------------------------------

export function sanitizePII(text: string): SanitizeResult {
  const original = typeof text === "string" ? text : String(text ?? "");
  const byKind = emptyByKind();
  if (original.length === 0) {
    return { text: original, redacted: false, count: 0, byKind, findings: [] };
  }

  const state: ScanState = {
    original,
    running: original,
    map: Array.from({ length: original.length }, (_, i) => i),
    findings: [],
  };

  // Context and tail checks run over a copy in which any pre-existing redaction token is blanked out, so a
  // token's wording can never supply context (§f idempotence). Same length ⇒ offsets align.
  const masked = maskReplacementTokens(original);

  // Rule 1 — CARD: not preceded by $ . , ; uniform separators; 15 or 16 digits; Luhn.
  applyRule(state, CARD_CANDIDATE, "CARD", (m, origStart) => {
    const prev = origStart > 0 ? original.charAt(origStart - 1) : "";
    if (prev === "$" || prev === "." || prev === ",") return null;
    const raw = m[0];
    const separators = raw.replace(/\d/g, "");
    if (separators.length > 0 && !/^(?: +|-+)$/.test(separators)) return null;
    const digits = raw.replace(/\D/g, "");
    if (digits.length !== 15 && digits.length !== 16) return null;
    if (!luhnValid(digits)) return null;
    return redactionToken("CARD", digits.slice(-4));
  });

  // Rule 2a — SSN, separated: consistent separator, SSA-plausible; no negative-context suppression.
  applyRule(state, SSN_SEPARATED, "SSN", (m) => {
    if (m[2] !== m[4]) return null;
    if (!ssnPlausible(m[1], m[3], m[5])) return null;
    return redactionToken("SSN");
  });

  // Rule 2b — SSN, bare nine digits: SSA-plausible AND SSN context ending within the 24 chars before.
  //
  // The SSN context list has never contained a routing keyword, so retiring rule 3
  // does not hand this rule the nine-digit runs rule 3 used to take: a routing number needs
  // `ssn|social security|soc sec|tax id|tin|itin` within 24 characters AND SSA-plausible digits before
  // it can be mistaken for an SSN here, and "routing" does not contain the keyword "tin" (no `\b`).
  const ssnContextEnds = contextEnds(masked, SSN_CONTEXT);
  applyRule(state, NINE_DIGITS, "SSN", (m, origStart) => {
    const d = m[0];
    if (!ssnPlausible(d.slice(0, 3), d.slice(3, 5), d.slice(5))) return null;
    if (!contextEndsBefore(ssnContextEnds, origStart)) return null;
    return redactionToken("SSN");
  });

  // Rule 3 — ROUTING: WITHDRAWN. A routing number identifies a bank, the Fed publishes
  // the table, and the routing+account pair stays broken because rule 4 still redacts the account. The
  // number is left in the text verbatim. `ROUTING_CONTEXT_TAIL` did not leave with it — see rule 4.

  // Rule 4 — ACCOUNT: 6–17 digits with single separators; account context within 24 chars before. Explicit
  // account context immediately adjacent wins over a bare-`#` negative label. Structural
  // shapes that are never account numbers (a formatted phone, a zip+4, or a run glued to number
  // punctuation such as a decimal amount) are excluded first — and so, since Decision #116, is a routing
  // number, recognised by TWO guards: an adjacent routing marker on a nine-digit run (guard 1), or the
  // ABA structure plus a routing marker anywhere in the wider window (guard 2, the 2026-09-20 amendment).
  const accountContextEnds = contextEnds(masked, ACCOUNT_CONTEXT);
  // Guard 2's window is WIDE and its effect is NEGATIVE, so — unlike every other context scan here — it
  // must not be able to read a keyword out of a redaction token an earlier rule set wrote. `masked`
  // already blanks the three kinds this module emits; the four kinds withdrawn by Decision #116 are NOT
  // in that mask, and `[REDACTED:ROUTING]` carries the word this guard looks for. The two ANCHORED tail
  // checks could never reach across a token's `]`; a 48-character window can. Blanking the withdrawn
  // shapes at this one call site keeps "historical tokens are inert" literally true rather than nearly
  // true. The literal is inlined rather than hoisted to a constant because a pattern that reaches a
  // matcher as an identifier is a security scanner CWE-185 finding (the build record).
  const routingScanText = masked.replace(/\[REDACTED:(ROUTING|DOB|PASSPORT|DL)\]/g, (t) =>
    MASK_FILL.repeat(t.length),
  );
  const routingContextEnds = contextEnds(routingScanText, ROUTING_CONTEXT_WINDOWED);
  const phoneSpans = formattedPhoneSpans(original);
  applyRule(state, ACCOUNT_CANDIDATE, "ACCOUNT", (m, origStart, origEnd) => {
    if (!contextEndsBefore(accountContextEnds, origStart)) return null;
    const raw = m[0];
    const digits = raw.replace(/\D/g, "");
    // GUARD 1 — ADJACENCY. A routing marker immediately in front of a NINE-DIGIT candidate means this
    // is a routing number, which is deliberately not redacted. The whole point is that rule 4 must not
    // inherit what rule 3 used to consume: in "acct 4455667788, routing 021000021" the account keyword
    // is still 18 characters back, inside rule 4's window.
    //
    // THE LENGTH SCOPE IS LOAD-BEARING, not tidiness. An ABA number is nine digits by definition, so a
    // 6–8 or 10–17 digit run introduced by a routing marker cannot be one — it is an account number a
    // client transposed into the routing field, or pasted into both ("account 4455667788, routing
    // 4455667788"), which is exactly the wire-desk correction this suppression must NOT swallow.
    // Unscoped, the guard turned every such run into raw plaintext in the database and in the
    // append-only ledger, which has no post-hoc redaction path. Separators are stripped first, so a
    // nine-digit ABA written `0210 00021` is still recognised.
    //
    // Guard 1 asks nothing about the digits beyond their COUNT: an adjacent `routing` marker is taken at
    // its word, so `routing 123456789` (a checksum failure) is still left alone. That is unchanged.
    if (digits.length === 9 && tailMatches(masked, origStart, ROUTING_CONTEXT_TAIL)) return null;
    // GUARD 2 — STRUCTURE PLUS A WINDOWED MARKER (2026-09-20 amendment), for the layouts guard 1
    // cannot see. `Routing / Account: 021000021 / 4455667788` is one of the commonest ways a client
    // sends wire instructions: the marker introduces the LABEL PAIR, so nothing is adjacent to the
    // digits, guard 1 never fires, and the routing half was being destroyed on every such ticket.
    //
    // BOTH conditions are required:
    //   (a) the run is SHAPED like an ABA number — exactly nine digits, valid Fed prefix, valid 3-7-1
    //       checksum (`looksLikeRoutingNumber`: a recogniser, not a rule; it never redacts anything);
    //   (b) a routing marker appears ANYWHERE in the `ROUTING_CONTEXT_WINDOW_CHARS` before it, not
    //       only immediately before.
    //
    // (a) ALONE MUST NOT BE ENOUGH, and that is the whole design. About 3.8% of random nine-digit runs
    // satisfy it (0.38 prefix × 0.10 checksum), so accepting shape on its own would stop redacting
    // roughly one nine-digit account number in twenty-six — a permanent I4 false negative written into
    // an append-only, retention-locked ledger with no post-hoc redaction path. Requiring (b) makes the
    // suppression a reading of what the TEXT CLAIMS rather than a property of the digits. It is why
    // "Chase checking 021000021 4455667788" still redacts BOTH runs: nothing in it claims a routing
    // number, so redacting both is the safe reading — pinned in `pii.test.ts` so it is not "fixed".
    if (
      looksLikeRoutingNumber(digits) &&
      contextEndsBefore(routingContextEnds, origStart, ROUTING_CONTEXT_WINDOW_CHARS)
    ) {
      return null;
    }
    if (
      insideAnySpan(phoneSpans, origStart, origEnd) ||
      ZIP_PLUS_FOUR.test(raw) ||
      gluedToNumberPunctuation(original, origStart, origEnd)
    ) {
      return null;
    }
    const token = redactionToken("ACCOUNT", digits.slice(-4));
    if (tailMatches(masked, origStart, ACCOUNT_CONTEXT_TAIL)) return token;
    if (tailMatches(masked, origStart, NEGATIVE_CONTEXT_TAIL)) return null;
    return token;
  });

  const findings = state.findings.slice().sort((a, b) => a.start - b.start);
  for (const f of findings) byKind[f.kind] += 1;
  const count = findings.length;
  return { text: state.running, redacted: count > 0, count, byKind, findings };
}

/** Sanitizes each string field independently and aggregates the counts. Null/undefined fields pass through. */
export function sanitizeFields<K extends string>(
  fields: Record<K, string | null | undefined>,
): {
  values: Record<K, string | null | undefined>;
  redacted: boolean;
  count: number;
  byKind: Record<PiiKind, number>;
  redactedFields: K[];
} {
  const values = { ...fields } as Record<K, string | null | undefined>;
  const byKind = emptyByKind();
  const redactedFields: K[] = [];
  let count = 0;
  for (const key of Object.keys(fields) as K[]) {
    const value = fields[key];
    if (typeof value !== "string" || value.length === 0) continue;
    const result = sanitizePII(value);
    if (!result.redacted) continue;
    values[key] = result.text;
    redactedFields.push(key);
    count += result.count;
    for (const kind of PII_KINDS) byKind[kind] += result.byKind[kind];
  }
  return { values, redacted: count > 0, count, byKind, redactedFields };
}

/** Sums several results (e.g. a ticket write plus its comment write) into one count triple. */
export function mergeSanitize(
  ...results: Pick<SanitizeResult, "redacted" | "count" | "byKind">[]
): Pick<SanitizeResult, "redacted" | "count" | "byKind"> {
  const byKind = emptyByKind();
  let count = 0;
  let redacted = false;
  for (const r of results) {
    count += r.count;
    redacted = redacted || r.redacted;
    for (const kind of PII_KINDS) byKind[kind] += r.byKind[kind] ?? 0;
  }
  return { redacted: redacted || count > 0, count, byKind };
}
