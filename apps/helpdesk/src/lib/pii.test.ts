import { describe, expect, it } from "vitest";
import { PII_KINDS, PII_REPLACEMENT_PATTERN } from "@/types/domain";
import type { PiiFinding, PiiKind } from "@/types/domain";
import {
  emptyByKind,
  formatPiiCounts,
  luhnValid,
  mergeSanitize,
  PII_TOKEN_MASK_PATTERN,
  redactionToken,
  sanitizeFields,
  sanitizePII,
  ssnPlausible,
} from "@/lib/pii";

/**
 * `PII_REPLACEMENT_PATTERN` anchored to a whole string, as a LITERAL: `new RegExp(pattern.source)` is
 * a security scanner CWE-185 finding (a pattern built from a non-literal) wherever it appears, tests included.
 * `pins the anchored token pattern to the exported one` below fails if the two ever drift, so this
 * stays a copy that cannot go stale rather than a second source of truth.
 */
const PII_TOKEN_EXACT = /^\[REDACTED:(SSN|CARD|ACCOUNT)(?: \*{4}\d{4})?\]$/;

describe("PII_TOKEN_EXACT", () => {
  it("pins the anchored token pattern to the exported one", () => {
    expect(PII_TOKEN_EXACT.source).toBe(`^${PII_REPLACEMENT_PATTERN.source}$`);
    expect(PII_TOKEN_EXACT.flags).toBe("");
  });

  /**
   * `src/lib/pii.ts` keeps its own regex object for the idempotence mask so the two never share a
   * `lastIndex`. That is the reason a parity assertion exists rather than one shared constant: the
   * mask must blank exactly the tokens `sanitizePII` writes, no more and no less. Wave B widened both
   * to seven; Decision #116 narrows both to three, and this is what fails if only one of them moves.
   */
  it("the idempotence mask matches exactly the tokens the sanitizer writes", () => {
    expect(PII_TOKEN_MASK_PATTERN.source).toBe(PII_REPLACEMENT_PATTERN.source);
    expect(PII_TOKEN_MASK_PATTERN.flags).toContain("g");
    expect(PII_TOKEN_MASK_PATTERN.source).toBe(/\[REDACTED:(SSN|CARD|ACCOUNT)(?: \*{4}\d{4})?\]/g.source);
    // Two objects, never one — a shared `lastIndex` is the bug the duplication prevents.
    expect(PII_TOKEN_MASK_PATTERN).not.toBe(PII_REPLACEMENT_PATTERN);
  });
});

type Vector = { n: number; input: string; expected: string; byKind: Partial<Record<PiiKind, number>> };

/** docs/ARCHITECTURE.md §f — the 35 contract vectors, verbatim. */
const VECTORS: Vector[] = [
  { n: 1, input: "SSN 123-45-6789 on file", expected: "SSN [REDACTED:SSN] on file", byKind: { SSN: 1 } },
  { n: 2, input: "ssn: 123456789", expected: "ssn: [REDACTED:SSN]", byKind: { SSN: 1 } },
  { n: 3, input: "Case #4821: SSN 123-45-6789", expected: "Case #4821: SSN [REDACTED:SSN]", byKind: { SSN: 1 } },
  {
    // The parenthetical is the original 2026-09-16 wording and is kept verbatim; since Decision #116
    // the ABA half is moot (there is no ABA rule) and the "no ssn context" half is the whole reason.
    n: 4,
    input: "client id 123456789 (no ssn context, fails ABA)",
    expected: "client id 123456789 (no ssn context, fails ABA)",
    byKind: {},
  },
  {
    n: 5,
    input: "card 4111 1111 1111 1111 declined",
    expected: "card [REDACTED:CARD ****1111] declined",
    byKind: { CARD: 1 },
  },
  { n: 6, input: "card 4111-1111-1111-1112 (bad luhn)", expected: "card 4111-1111-1111-1112 (bad luhn)", byKind: {} },
  { n: 7, input: "amex 378282246310005 ok", expected: "amex [REDACTED:CARD ****0005] ok", byKind: { CARD: 1 } },
  { n: 8, input: "MC 5105-1051-0510-5100", expected: "MC [REDACTED:CARD ****5100]", byKind: { CARD: 1 } },
  // 9, 10, 12, 29, 30 and 31 changed with Decision #116: rule 3 (ROUTING) is withdrawn, so the ABA
  // number stays in the text verbatim. The INPUTS are byte-identical to the originals on purpose —
  // these are the vectors that prove the account half still redacts beside an untouched routing
  // number, which is the whole basis for "the routing+account pair is still broken".
  {
    n: 9,
    input: "routing 021000021 / acct 000123456789",
    expected: "routing 021000021 / acct [REDACTED:ACCOUNT ****6789]",
    byKind: { ACCOUNT: 1 },
  },
  { n: 10, input: "wire to 121000248 please", expected: "wire to 121000248 please", byKind: {} },
  { n: 11, input: "ref 121000248 attached", expected: "ref 121000248 attached", byKind: {} },
  { n: 12, input: "ABA 011000015", expected: "ABA 011000015", byKind: {} },
  {
    n: 13,
    input: "call me at 555-123-4567 or (555) 123-4567",
    expected: "call me at 555-123-4567 or (555) 123-4567",
    byKind: {},
  },
  { n: 14, input: "see HD-1042 and REQ-20260916", expected: "see HD-1042 and REQ-20260916", byKind: {} },
  {
    n: 15,
    input: "CUSIP 037833100 AAPL; cusip: 594918104",
    expected: "CUSIP 037833100 AAPL; cusip: 594918104",
    byKind: {},
  },
  {
    n: 16,
    input: "amount $1,234,567.89 on 2026-09-16",
    expected: "amount $1,234,567.89 on 2026-09-16",
    byKind: {},
  },
  {
    n: 17,
    input: "account number: 12-345-678",
    expected: "account number: [REDACTED:ACCOUNT ****5678]",
    byKind: { ACCOUNT: 1 },
  },
  {
    n: 18,
    input: "order 1234567890123456 shipped",
    expected: "order 1234567890123456 shipped",
    byKind: {},
  },
  {
    n: 19,
    input: "sold 400 shares 09/16/2026 ticket #987654321",
    expected: "sold 400 shares 09/16/2026 ticket #987654321",
    byKind: {},
  },
  { n: 20, input: "SSN 078-05-1120 (known invalid)", expected: "SSN 078-05-1120 (known invalid)", byKind: {} },
  {
    n: 21,
    input: "Social Security # 987-65-4320 invalid 9xx",
    expected: "Social Security # 987-65-4320 invalid 9xx",
    byKind: {},
  },
  {
    n: 22,
    input: "SSN 000-12-3456 and 666-12-3456 and 900-12-3456",
    expected: "SSN 000-12-3456 and 666-12-3456 and 900-12-3456",
    byKind: {},
  },
  {
    n: 23,
    input: "acct 4111111111111111 (card wins first)",
    expected: "acct [REDACTED:CARD ****1111] (card wins first)",
    byKind: { CARD: 1 },
  },
  {
    n: 24,
    input: "phone 2125551234 and zip 10001-1234",
    expected: "phone 2125551234 and zip 10001-1234",
    byKind: {},
  },
  {
    n: 25,
    input: "Two SSNs 123-45-6789 and 234-56-7890",
    expected: "Two SSNs [REDACTED:SSN] and [REDACTED:SSN]",
    byKind: { SSN: 2 },
  },
  {
    n: 26,
    input: "Account balance 1,234,567.89 as of today",
    expected: "Account balance 1,234,567.89 as of today",
    byKind: {},
  },
  { n: 27, input: "[REDACTED:SSN] already masked", expected: "[REDACTED:SSN] already masked", byKind: {} },
  { n: 28, input: "", expected: "", byKind: {} },
  // 29–35: the adjacency semantics are number punctuation only.
  // Written for rule 3; since Decision #116 withdrew it, 32–34 are carried by rule 4 and 29–31 are
  // pass-through vectors for the routing number beside a still-redacted account.
  {
    n: 29,
    input: "routing 021000021, acct 000123456789",
    expected: "routing 021000021, acct [REDACTED:ACCOUNT ****6789]",
    byKind: { ACCOUNT: 1 },
  },
  { n: 30, input: "wire to 021000021.", expected: "wire to 021000021.", byKind: {} },
  {
    n: 31,
    input: "ABA 021000021; acct 000123456789",
    expected: "ABA 021000021; acct [REDACTED:ACCOUNT ****6789]",
    byKind: { ACCOUNT: 1 },
  },
  { n: 32, input: "1,234,567,890 shares", expected: "1,234,567,890 shares", byKind: {} },
  { n: 33, input: "$021000021", expected: "$021000021", byKind: {} },
  {
    n: 34,
    input: "ratio 0.021000021 vs 1,021000021 or 021000021.5 or 021000021-1",
    expected: "ratio 0.021000021 vs 1,021000021 or 021000021.5 or 021000021-1",
    byKind: {},
  },
  { n: 35, input: "ref 121000248 attached", expected: "ref 121000248 attached", byKind: {} },
  // 36–43: rule-4 hardening. Account context wins over a bare-`#` label (PII-1); structural
  // phone/amount/zip shapes are not account numbers (PII-6); idempotence holds even when a token's wording
  // sits within 24 chars of a later digit run (PII-5).
  {
    n: 36,
    input: "acct # 000123456789",
    expected: "acct # [REDACTED:ACCOUNT ****6789]",
    byKind: { ACCOUNT: 1 },
  },
  { n: 37, input: "acct#12345678", expected: "acct#[REDACTED:ACCOUNT ****5678]", byKind: { ACCOUNT: 1 } },
  {
    n: 38,
    input: "Account Number # 12345678",
    expected: "Account Number # [REDACTED:ACCOUNT ****5678]",
    byKind: { ACCOUNT: 1 },
  },
  {
    n: 39,
    input: "Account holder called from 212-555-1234",
    expected: "Account holder called from 212-555-1234",
    byKind: {},
  },
  { n: 40, input: "account funded with 250000.00", expected: "account funded with 250000.00", byKind: {} },
  { n: 41, input: "account address zip 10001-1234", expected: "account address zip 10001-1234", byKind: {} },
  {
    n: 42,
    input: "acct 000123456789 for Margare 654321",
    expected: "acct [REDACTED:ACCOUNT ****6789] for Margare 654321",
    byKind: { ACCOUNT: 1 },
  },
  {
    n: 43,
    input: "SSN 123-45-6789 belongs to s 212345678",
    expected: "SSN [REDACTED:SSN] belongs to s 212345678",
    byKind: { SSN: 1 },
  },
];

function fullByKind(partial: Partial<Record<PiiKind, number>>): Record<PiiKind, number> {
  const out = emptyByKind();
  for (const kind of PII_KINDS) out[kind] = partial[kind] ?? 0;
  return out;
}

/** Re-applies the findings to the original input; must reproduce `text` exactly (offsets are into the original). */
function applyFindings(input: string, findings: PiiFinding[]): string {
  let out = "";
  let cursor = 0;
  for (const f of findings) {
    out += input.slice(cursor, f.start) + f.replacement;
    cursor = f.end;
  }
  return out + input.slice(cursor);
}

describe("sanitizePII — §f contract vectors", () => {
  for (const v of VECTORS) {
    it(`#${v.n}: ${JSON.stringify(v.input)}`, () => {
      const result = sanitizePII(v.input);
      expect(result.text).toBe(v.expected);
      expect(result.byKind).toEqual(fullByKind(v.byKind));

      // Structural assertions on every vector.
      const total = PII_KINDS.reduce((sum, kind) => sum + result.byKind[kind], 0);
      expect(result.count).toBe(total);
      expect(result.redacted).toBe(result.count > 0);
      expect(result.findings).toHaveLength(result.count);

      const json = JSON.stringify(result);
      for (const f of result.findings) {
        expect(f.replacement).not.toMatch(/\d{5,}/);
        expect(f.replacement).toMatch(PII_TOKEN_EXACT);
        const span = v.input.slice(f.start, f.end);
        expect(span).toMatch(/^\d[\d -]*\d$/);
        const spanDigits = span.replace(/\D/g, "");
        expect(spanDigits.length).toBeGreaterThanOrEqual(6);
        expect(json).not.toContain(span);
        expect(json).not.toContain(spanDigits);
      }
      expect(applyFindings(v.input, result.findings)).toBe(result.text);

      // Idempotence.
      const again = sanitizePII(result.text);
      expect(again.redacted).toBe(false);
      expect(again.count).toBe(0);
      expect(again.text).toBe(result.text);
    });
  }

  it("findings are sorted by original offset and never overlap", () => {
    const r = sanitizePII("routing 021000021 / acct 000123456789, SSN 123-45-6789, card 4111 1111 1111 1111");
    // Three, not four: the routing number is left in place.
    expect(r.count).toBe(3);
    for (let i = 1; i < r.findings.length; i++) {
      expect(r.findings[i].start).toBeGreaterThanOrEqual(r.findings[i - 1].end);
    }
    expect(r.findings.map((f) => f.kind)).toEqual(["ACCOUNT", "SSN", "CARD"]);
    expect(r.text).toContain("021000021");
  });

  it("a failed long candidate does not hide a valid card starting inside it", () => {
    // The 4 leading digits make a 16-digit Luhn-invalid window; the real card follows.
    const r = sanitizePII("ref 1234 4111 1111 1111 1111 end");
    expect(r.byKind.CARD).toBe(1);
    expect(r.text).toBe("ref 1234 [REDACTED:CARD ****1111] end");
  });

  it("a routing marker no longer turns anything on — there is no rule 3 (Decision #116)", () => {
    // This used to read "explicit routing context wins over an adjacent negative label" and assert
    // `ref routing [REDACTED:ROUTING]`. The keyword list survives, but only as a NEGATIVE guard on
    // rule 4; on its own it redacts nothing.
    for (const input of ["ref routing 121000248", "routing 121000248", "ABA 021000021", "transit no. 011000015"]) {
      const r = sanitizePII(input);
      expect(r.redacted, input).toBe(false);
      expect(r.text, input).toBe(input);
    }
  });

  it("explicit account context wins over a bare-# negative label (rule 4, Decision #50)", () => {
    // `#` is a member of NEGATIVE_CONTEXT_TAIL, but when it is part of the account marker the account
    // context must win — the same precedence rule 3 gives routing. Every common `acct #` phrasing redacts.
    for (const [input, last4] of [
      ["acct # 000123456789", "6789"],
      ["acct#12345678", "5678"],
      ["Account Number # 12345678", "5678"],
      ["a/c #12345678", "5678"],
      ["checking #12345678", "5678"],
      ["savings account # 12345678", "5678"],
      ["IBAN # 12345678901", "8901"],
    ] as const) {
      const r = sanitizePII(input);
      expect(r.byKind.ACCOUNT, input).toBe(1);
      expect(r.text, input).toContain(`[REDACTED:ACCOUNT ****${last4}]`);
      // A real "#" reference label with no account keyword still suppresses ACCOUNT.
      expect(sanitizePII("ticket #12345678").byKind.ACCOUNT).toBe(0);
    }
  });

  it("rule 4 excludes structural non-account shapes even next to account context (Decision #50)", () => {
    // Formatted phone (3-3-4), decimal/grouped amount, and zip+4 are never account numbers.
    for (const input of [
      "Account holder called from 212-555-1234",
      "Account holder called from 212 555 1234",
      "account funded with 250000.00",
      "account grew to 1,250,000 this year",
      "account address zip 10001-1234",
    ]) {
      expect(sanitizePII(input).redacted, input).toBe(false);
    }
  });

  it("idempotence holds when a token's wording sits within the context window of a later digit run (§f, Decision #50)", () => {
    // Pass 1 leaves a 6–10 digit run just past a token; before the fix the token's ACCOUNT/SSN wording
    // acted as context on pass 2 and corrupted an ordinary number. §f requires sanitize to be idempotent.
    for (const input of [
      "acct 000123456789 for Margare 654321",
      "acct 000123456789 Margaret ca 2125551234",
      "SSN 123-45-6789 belongs to s 212345678",
    ]) {
      const once = sanitizePII(input).text;
      const twice = sanitizePII(once);
      expect(twice.redacted, input).toBe(false);
      expect(twice.text, input).toBe(once);
    }
  });

  it("the §j.6 seed fixture sentence (with commas) redacts the account and the SSN and leaves the ABA number (F1, #116)", () => {
    // Verbatim §j.6 text; prisma/seed-dev.ts asserts the same expectation before persisting.
    const sentence = "Client wants to wire to routing 021000021, acct 000123456789, SSN 123-45-6789 for verification";
    const r = sanitizePII(sentence);
    expect(r.text).toBe(
      "Client wants to wire to routing 021000021, acct [REDACTED:ACCOUNT ****6789], SSN [REDACTED:SSN] for verification",
    );
    expect(r.redacted).toBe(true);
    expect(r.byKind).toEqual({ SSN: 1, CARD: 0, ACCOUNT: 1 });
    for (const probe of ["000123456789", "123-45-6789"]) {
      expect(r.text).not.toContain(probe);
    }
    // The routing number is deliberately still there, and the pair is still broken without it.
    expect(r.text).toContain("routing 021000021");
  });

  it("the §j.6 fixture's second sentence: a TEN-digit number after `routing` is still an account number", () => {
    // Verbatim §j.6 text, added with the nine-digit scoping. It is the same `routing` marker that lets
    // `021000021` through one sentence earlier, so the two halves of the guard are pinned against each
    // other. `prisma/seed-dev.ts` carries `4455667788` in `RAW_PII_PROBES`, so this expectation is also
    // asserted against a real seeded row rather than only here.
    const sentence = "Second attempt: client gave the same number twice — account 4455667788, routing 4455667788.";
    const r = sanitizePII(sentence);
    expect(r.text).toBe(
      "Second attempt: client gave the same number twice — account [REDACTED:ACCOUNT ****7788], routing [REDACTED:ACCOUNT ****7788].",
    );
    expect(r.byKind).toEqual({ SSN: 0, CARD: 0, ACCOUNT: 2 });
    expect(r.text).not.toContain("4455667788");
    expect(sanitizePII(r.text).redacted).toBe(false);
  });

  it("sentence punctuation after an account number never suppresses; number punctuation does (Decision #48 adjacency)", () => {
    // Decision #48's adjacency guard was written for rule 3 and is now exercised through rule 4, its
    // only remaining caller. Trailing , . ; : ) ! ? and end-of-text are sentence punctuation.
    for (const tail of [",", ".", ";", ":", ")", "!", "?", "", ", then", ". Next"]) {
      const r = sanitizePII(`acct 000123456789${tail}`);
      expect(r.byKind.ACCOUNT, JSON.stringify(tail)).toBe(1);
      expect(r.text).toBe(`acct [REDACTED:ACCOUNT ****6789]${tail}`);
    }
    // Glued to a formatted number: a fragment of an amount or a reference, never an account number.
    for (const s of ["$000123456789", "-000123456789", "1,000123456789", "0.000123456789", "000123456789,5", "000123456789.5"]) {
      expect(sanitizePII(`acct ${s}`).redacted, s).toBe(false);
    }
    // `2026-000123456789` and `000123456789-1` are deliberately NOT on that list. Rule 4's candidate
    // accepts single dashes INSIDE the run (vector 17, `account number: 12-345-678`), so a dash-joined
    // neighbour is part of the candidate rather than glue beside it, and the whole run redacts. Those
    // two shapes were only ever rule-3 cases — rule 3 matched exactly nine digits — and rule 3 is
    // withdrawn. This is pre-existing rule-4 behaviour, unchanged by Decision #116, pinned here so the
    // difference between the two rules' adjacency semantics is on the record rather than inferred.
    expect(sanitizePII("acct 2026-000123456789").text).toBe("acct [REDACTED:ACCOUNT ****6789]");
    expect(sanitizePII("acct 000123456789-1").text).toBe("acct [REDACTED:ACCOUNT ****7891]");
    // A dash or dot that is NOT between digits is punctuation.
    expect(sanitizePII("acct 000123456789 - thanks").text).toBe("acct [REDACTED:ACCOUNT ****6789] - thanks");
    expect(sanitizePII("acct 000123456789-").text).toBe("acct [REDACTED:ACCOUNT ****6789]-");
  });

  it("bare nine digits with SSN context but SSA-implausible digits stay untouched", () => {
    expect(sanitizePII("ssn: 000123456").redacted).toBe(false);
    expect(sanitizePII("ssn: 123006789").redacted).toBe(false);
    expect(sanitizePII("ssn: 123450000").redacted).toBe(false);
  });

  it("SSN context keyword must be a whole word (\"routing\" does not contain the keyword \"tin\")", () => {
    // 123456789 is SSA-plausible, so the ONLY thing keeping it in the text is that no SSN keyword
    // sits within 24 characters. This matters more since Decision #116: rule 3 used to consume bare
    // nine-digit runs, and now nothing does unless rule 2b's context gate opens.
    expect(sanitizePII("continue 123456789").redacted).toBe(false);
    expect(sanitizePII("routing 123456789").redacted).toBe(false);
    // The gate does open on a real keyword, which is rule 2b working as specified.
    expect(sanitizePII("ssn 123456789").text).toBe("ssn [REDACTED:SSN]");
  });

  it("never throws on odd input and reports no findings for digit-free text", () => {
    expect(sanitizePII("no digits here").redacted).toBe(false);
    expect(sanitizePII(String(undefined as unknown as string)).redacted).toBe(false);
    expect(() => sanitizePII(undefined as unknown as string)).not.toThrow();
  });
});

describe("helpers", () => {
  it("luhnValid", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(luhnValid("378282246310005")).toBe(true);
    expect(luhnValid("5105105105105100")).toBe(true);
    expect(luhnValid("1234567890123456")).toBe(false);
    expect(luhnValid("")).toBe(false);
    expect(luhnValid("41x1")).toBe(false);
  });

  it("ssnPlausible", () => {
    expect(ssnPlausible("123", "45", "6789")).toBe(true);
    expect(ssnPlausible("000", "45", "6789")).toBe(false);
    expect(ssnPlausible("666", "45", "6789")).toBe(false);
    expect(ssnPlausible("900", "45", "6789")).toBe(false);
    expect(ssnPlausible("999", "45", "6789")).toBe(false);
    expect(ssnPlausible("899", "45", "6789")).toBe(true);
    expect(ssnPlausible("123", "00", "6789")).toBe(false);
    expect(ssnPlausible("123", "45", "0000")).toBe(false);
    expect(ssnPlausible("078", "05", "1120")).toBe(false);
    expect(ssnPlausible("219", "09", "9999")).toBe(false);
    expect(ssnPlausible("12", "45", "6789")).toBe(false);
  });

  it("redactionToken", () => {
    expect(redactionToken("SSN")).toBe("[REDACTED:SSN]");
    expect(redactionToken("CARD", "1111")).toBe("[REDACTED:CARD ****1111]");
    expect(redactionToken("ACCOUNT", "6789")).toBe("[REDACTED:ACCOUNT ****6789]");
    // SSN never carries a tail (Reg S-P: partial SSNs are NPI), even if a caller passes one.
    expect(redactionToken("SSN", "6789")).toBe("[REDACTED:SSN]");
    expect(redactionToken("CARD")).toBe("[REDACTED:CARD]");
    for (const kind of PII_KINDS) {
      expect(redactionToken(kind, "1234")).toMatch(PII_TOKEN_EXACT);
    }
  });

  it("formatPiiCounts / emptyByKind", () => {
    // Three counters. This line has had three shapes — four counters through Wave A,
    // seven through Wave B, three now — and `AuditLog` is append-only, so all three are in the ledger
    // forever. Nothing in this repository PARSES the string into fields: the timeline and the audit
    // table render `newValue` verbatim, and the one shape-sensitive assertion
    // (`src/server/import.integration.test.ts`) matches the substring `SSN=<n>`, which is true of all
    // three shapes. That tolerance is asserted below rather than assumed.
    expect(formatPiiCounts({ SSN: 1, CARD: 0, ACCOUNT: 1 })).toBe("SSN=1;CARD=0;ACCOUNT=1");
    expect(formatPiiCounts(emptyByKind())).toBe("SSN=0;CARD=0;ACCOUNT=0");
    // A partial record still reads: a missing counter is 0, never NaN or "undefined".
    expect(formatPiiCounts({ SSN: 2 })).toBe("SSN=2;CARD=0;ACCOUNT=0");
    expect(emptyByKind()).toEqual({ SSN: 0, CARD: 0, ACCOUNT: 0 });
    expect(emptyByKind()).not.toBe(emptyByKind());
  });

  it("all three historical counter shapes stay readable to the one assertion that inspects them", () => {
    // The shapes, oldest first. A reader that splits on ";" and "=" and looks up "SSN" — or matches
    // the `SSN=<n>` substring, which is what `import.integration.test.ts` does — reads the same
    // number from every one of them.
    const historical = [
      "SSN=1;CARD=0;ROUTING=1;ACCOUNT=1",
      "SSN=1;CARD=0;ROUTING=1;ACCOUNT=1;DOB=0;PASSPORT=0;DL=0",
      formatPiiCounts({ SSN: 1, CARD: 0, ACCOUNT: 1 }),
    ];
    for (const row of historical) {
      expect(row, row).toMatch(/SSN=[1-9]/);
      const fields = new Map(row.split(";").map((pair) => pair.split("=") as [string, string]));
      expect(fields.get("SSN"), row).toBe("1");
      expect(fields.get("ACCOUNT"), row).toBe("1");
      expect(fields.get("CARD"), row).toBe("0");
    }
    // Only the newest shape is written from here on.
    expect(historical[2]).toBe("SSN=1;CARD=0;ACCOUNT=1");
  });

  it("sanitizeFields sanitizes per field and aggregates", () => {
    const r = sanitizeFields({
      subject: "SSN 123-45-6789",
      description: "card 4111 1111 1111 1111 and routing 021000021",
      clientReference: null,
      requesterName: undefined,
      note: "clean",
    });
    expect(r.values.subject).toBe("SSN [REDACTED:SSN]");
    expect(r.values.description).toBe("card [REDACTED:CARD ****1111] and routing 021000021");
    expect(r.values.clientReference).toBeNull();
    expect(r.values.requesterName).toBeUndefined();
    expect(r.values.note).toBe("clean");
    expect(r.redacted).toBe(true);
    expect(r.count).toBe(2);
    expect(r.byKind).toEqual({ SSN: 1, CARD: 1, ACCOUNT: 0 });
    expect(r.redactedFields).toEqual(["subject", "description"]);
    expect(formatPiiCounts(r.byKind)).toBe("SSN=1;CARD=1;ACCOUNT=0");
  });

  it("sanitizeFields with nothing to redact", () => {
    const r = sanitizeFields({ subject: "hello", description: "world" });
    expect(r.redacted).toBe(false);
    expect(r.count).toBe(0);
    expect(r.redactedFields).toEqual([]);
    expect(r.values).toEqual({ subject: "hello", description: "world" });
  });

  it("mergeSanitize sums results", () => {
    const a = sanitizePII("SSN 123-45-6789");
    const b = sanitizePII("acct 000123456789");
    const c = sanitizePII("nothing");
    const m = mergeSanitize(a, b, c);
    expect(m.count).toBe(2);
    expect(m.redacted).toBe(true);
    expect(m.byKind).toEqual({ SSN: 1, CARD: 0, ACCOUNT: 1 });
    expect(mergeSanitize()).toEqual({ redacted: false, count: 0, byKind: emptyByKind() });
  });
});

// ---------------------------------------------------------------------------------------------------
// the four withdrawn kinds.
//
// Removing a rule is not the same as removing a behaviour: rule 3 used to CONSUME every bare
// nine-digit run before rule 4 ever saw it, so the interesting question is not "does ROUTING still
// fire" (it cannot, it is gone) but "did rule 4 or rule 2b quietly inherit what rule 3 was taking".
// These two blocks are the answer, and they are the reason this change was reviewed.
// ---------------------------------------------------------------------------------------------------

describe("a routing number is not swept up by a neighbouring rule (Decision #116)", () => {
  /**
   * Rule 4's candidate shape is 6–17 digits, which a nine-digit routing number satisfies, and its
   * context window reaches back 24 characters — far enough to find an account keyword from the OTHER
   * half of the same wire instruction. `ROUTING_CONTEXT_TAIL` is what stops it, and these are the
   * sentences a wire desk actually types.
   */
  it("leaves the routing number and redacts only the account, in either order", () => {
    for (const [input, expected] of [
      // Routing first, account second — the account keyword sits AFTER the ABA number, so the window
      // cannot reach it at all.
      [
        "wire to routing 021000021 account 987654321",
        "wire to routing 021000021 account [REDACTED:ACCOUNT ****4321]",
      ],
      // Labelled routing number with the account on the same line.
      [
        "routing number: 011401533, acct 4455667788",
        "routing number: 011401533, acct [REDACTED:ACCOUNT ****7788]",
      ],
      // ACCOUNT FIRST. This is the case the guard exists for: "acct" is only 18 characters before the
      // routing number, so rule 4's window reaches it and would have redacted a published ABA number
      // as an account if `ROUTING_CONTEXT_TAIL` had left with rule 3.
      [
        "wire out: acct 4455667788, routing 021000021",
        "wire out: acct [REDACTED:ACCOUNT ****7788], routing 021000021",
      ],
      [
        "account 987654321 then ABA 021000021",
        "account [REDACTED:ACCOUNT ****4321] then ABA 021000021",
      ],
    ] as const) {
      const r = sanitizePII(input);
      expect(r.text, input).toBe(expected);
      expect(r.byKind.ACCOUNT, input).toBe(1);
      expect(r.count, input).toBe(1);
      // Idempotence still holds over the mixed result.
      expect(sanitizePII(r.text).redacted, input).toBe(false);
    }
  });

  it("a routing number with no account context anywhere is untouched", () => {
    for (const input of [
      "ABA 021000021",
      "routing 021000021",
      "RTN 121000248",
      "transit number 011000015",
      "wire to 121000248 please",
      "wire to 021000021.",
      // Every routing marker the guard knows, immediately in front of the number.
      "routing no. 021000021",
      "aba# 021000021",
    ]) {
      const r = sanitizePII(input);
      expect(r.redacted, input).toBe(false);
      expect(r.text, input).toBe(input);
    }
  });

  /**
   * Rule 2b is the other neighbour. A routing number can be SSA-plausible — 011401533 reads as area
   * 011, group 40, serial 1533, all valid — so the only thing between it and an SSN redaction is the
   * context gate, which needs `ssn|social security|soc sec|tax id|tin|itin` as a WHOLE word. "routing"
   * contains "tin" but not on a word boundary.
   */
  it("is not swept up by the bare-nine-digit SSN rule either", () => {
    for (const input of [
      "routing number: 011401533",
      "ABA 011401533 for the wire",
      "routing 011401533 and acct 4455667788",
    ]) {
      expect(sanitizePII(input).byKind.SSN, input).toBe(0);
    }
    expect(sanitizePII("routing number: 011401533").text).toBe("routing number: 011401533");
    // Proof the digits really are SSA-plausible, so the test above is the context gate doing the work
    // rather than the plausibility check.
    expect(ssnPlausible("011", "40", "1533")).toBe(true);
    // And with a real SSN keyword in front, the same digits DO redact — rule 2b, unchanged.
    expect(sanitizePII("ssn 011401533").text).toBe("ssn [REDACTED:SSN]");
  });

  /**
   * THE GUARD IS SCOPED TO NINE DIGITS, and this block is why.
   *
   * `ROUTING_CONTEXT_TAIL` was a POSITIVE trigger for rule 3, where over-firing could only cause an
   * extra redaction. As a NEGATIVE guard on rule 4, over-firing leaves a raw account number in the
   * database and — through `writeAudit` and the nightly retention-locked copy — in a place with no
   * post-hoc redaction path. An ABA number is nine digits by definition, so every other length after a
   * routing marker is an account number somebody put in the wrong field.
   *
   * These are the wire-desk phrasings that produce exactly that: a transposition, the same number
   * pasted into both fields, and "in transit", which on an ACAT desk is a description of the ACCOUNT.
   */
  it("a NON-nine-digit run after a routing marker is still an account number", () => {
    for (const [input, expected] of [
      // 10 digits after each marker in the list.
      ["Receiving account in transit 1234567890 from Schwab", "Receiving account in transit [REDACTED:ACCOUNT ****7890] from Schwab"],
      ["Send the check to the savings, rtn 5566778899", "Send the check to the savings, rtn [REDACTED:ACCOUNT ****8899]"],
      ["the acct, routing 4455667788", "the acct, routing [REDACTED:ACCOUNT ****7788]"],
      ["the acct, aba 4455667788", "the acct, aba [REDACTED:ACCOUNT ****7788]"],
      // The client gave the same number twice — the one labelled "routing" IS the account number.
      [
        "Client says the wire bounced: account 4455667788, routing 4455667788 — looks transposed.",
        "Client says the wire bounced: account [REDACTED:ACCOUNT ****7788], routing [REDACTED:ACCOUNT ****7788] — looks transposed.",
      ],
      // 12 digits, and 6, 7, 8 and 17 — every length the candidate shape admits except nine.
      ["Chase — acct 000123456789, routing 000123456789", "Chase — acct [REDACTED:ACCOUNT ****6789], routing [REDACTED:ACCOUNT ****6789]"],
      ["acct, routing 123456", "acct, routing [REDACTED:ACCOUNT ****3456]"],
      ["acct, routing 1234567", "acct, routing [REDACTED:ACCOUNT ****4567]"],
      ["acct, routing 12345678", "acct, routing [REDACTED:ACCOUNT ****5678]"],
      ["acct routing 12345678901234567", "acct routing [REDACTED:ACCOUNT ****4567]"],
    ] as const) {
      const r = sanitizePII(input);
      expect(r.text, input).toBe(expected);
      expect(sanitizePII(r.text).redacted, input).toBe(false);
    }
  });

  /**
   * "In transit" is how an ACAT/wire desk describes an ACCOUNT, so bare `transit` cannot be a negative
   * marker. The list still holds the term it was written for — "transit number" — which is always
   * written with the noun.
   */
  it("`in transit` describes the account, and does not suppress it at any length", () => {
    for (const [input, expected] of [
      ["acct in transit 000123456789", "acct in transit [REDACTED:ACCOUNT ****6789]"],
      ["account in transit 4471209983", "account in transit [REDACTED:ACCOUNT ****9983]"],
      ["acct number in transit 000123456789", "acct number in transit [REDACTED:ACCOUNT ****6789]"],
      ["the acct is in transit 000123456789", "the acct is in transit [REDACTED:ACCOUNT ****6789]"],
      ["savings acct, funds in transit 000123456789", "savings acct, funds in transit [REDACTED:ACCOUNT ****6789]"],
      ["checking in transit 4455667788", "checking in transit [REDACTED:ACCOUNT ****7788]"],
      // Nine digits too: bare `transit` is no longer a marker at all, so the length scope never
      // gets the chance to matter here.
      ["acct in transit 021000021", "acct in transit [REDACTED:ACCOUNT ****0021]"],
    ] as const) {
      expect(sanitizePII(input).text, input).toBe(expected);
    }
    // The term the list exists for still suppresses, with and without account context nearby.
    expect(sanitizePII("transit number 011000015").text).toBe("transit number 011000015");
    expect(sanitizePII("acct, transit no. 021000021").text).toBe("acct, transit no. 021000021");
  });

  /** A nine-digit ABA written with a separator is still nine digits — separators are stripped first. */
  it("the nine-digit scope counts digits, not characters", () => {
    expect(sanitizePII("acct 4455667788, routing 0210 00021").text).toBe(
      "acct [REDACTED:ACCOUNT ****7788], routing 0210 00021",
    );
  });

  it("the residual is stated: an unlabelled nine-digit run near account context still redacts", () => {
    // No routing marker, so nothing distinguishes this from an account number written without one.
    // §f rule 4 has always accepted that over-redaction; recorded here so it is a known reading of
    // the rule rather than a surprise.
    expect(sanitizePII("account 987654321 sent via 021000021").text).toBe(
      "account [REDACTED:ACCOUNT ****4321] sent via [REDACTED:ACCOUNT ****0021]",
    );
  });

  /**
   * GUARD 2 — STRUCTURAL RECOGNITION (amendment, 2026-09-20). These are the layouts guard 1 cannot see.
   *
   * `ROUTING_CONTEXT_TAIL` is anchored (`\s*$`), so guard 1 only fires on a marker sitting immediately
   * in front of the digits. In a LABEL-PAIR layout the marker introduces the PAIR, so nothing is
   * adjacent to the number and guard 1 never fires — and `Routing / Account: X / Y` is one of the
   * commonest ways a client sends wire instructions. Every layout below used to have its routing half
   * destroyed, which is the defect this block exists for.
   *
   * What answers them is `looksLikeRoutingNumber` (exactly nine digits, valid Federal Reserve prefix,
   * valid 3-7-1 checksum) AND a routing marker anywhere in the 48 characters before. The account
   * number beside it is still redacted in every case, which is the point: the PAIR stays broken.
   */
  it("a labelled routing number is recognised structurally, not only by adjacency", () => {
    for (const [input, expected] of [
      // The headline layout: "Routing / Account: X / Y".
      ["Routing / Account: 021000021 / 4455667788", "Routing / Account: 021000021 / [REDACTED:ACCOUNT ****7788]"],
      [
        "routing and account numbers: 021000021 / 4471209983",
        "routing and account numbers: 021000021 / [REDACTED:ACCOUNT ****9983]",
      ],
      [
        "Routing number / Account number: 021000021 / 4455667788",
        "Routing number / Account number: 021000021 / [REDACTED:ACCOUNT ****7788]",
      ],
      ["ABA / acct: 021000021 / 4455667788", "ABA / acct: 021000021 / [REDACTED:ACCOUNT ****7788]"],
      // Pasted as separate lines, which is how a client forwards a bank's own instructions. `\s*` in
      // the context shapes spans the newline, so both gates behave exactly as they do inline.
      ["Routing:\n021000021\nAccount:\n4455667788", "Routing:\n021000021\nAccount:\n[REDACTED:ACCOUNT ****7788]"],
    ] as const) {
      const r = sanitizePII(input);
      expect(r.text, input).toBe(expected);
      expect(r.byKind.ACCOUNT, input).toBe(1);
      expect(r.count, input).toBe(1);
      expect(sanitizePII(r.text).redacted, input).toBe(false);
    }
  });

  /**
   * THE RECOGNISER'S WINDOW IS A BOUNDED CONSTANT (48), and these are both sides of the boundary.
   *
   * Three real layouts put the marker further from the digits than the 24 every positive context gate
   * uses, which is why the recogniser has its own wider one. Past 48 the marker stops counting, so a
   * `routing` in an earlier clause cannot silence a nine-digit run later in the same sentence. The gap
   * quoted on each line is measured from the end of the routing keyword to the first digit.
   */
  it("the routing marker stops counting past the recogniser's window", () => {
    for (const input of [
      "Routing number for the wire and account: 021000021", // gap 26 — inside 48, outside 24
      "Routing is on the letter; the account: 021000021", // gap 31
      "routing confirmed by the bank; acct 021000021", // gap 28
      "Routing per the bank letter, checking account: 021000021", // gap 39
    ]) {
      const r = sanitizePII(input);
      expect(r.text, input).toBe(input);
      expect(r.redacted, input).toBe(false);
    }
    // Gap 51 — PAST the window. The marker no longer reaches and the run redacts as ACCOUNT, which is
    // the deliberate failure mode: the guard runs out rather than running on.
    expect(sanitizePII("routing details were confirmed by the bank yesterday; acct 021000021").text).toBe(
      "routing details were confirmed by the bank yesterday; acct [REDACTED:ACCOUNT ****0021]",
    );
  });

  /**
   * CONDITION (a) ALONE IS NOT ENOUGH. This block is here to stop someone "fixing" the last vector.
   *
   * About 3.8% of random nine-digit runs pass `looksLikeRoutingNumber` (0.38 Fed-prefix × 0.10
   * checksum — measured, not estimated). If shape alone suppressed, roughly one nine-digit ACCOUNT
   * number in twenty-six would stop being redacted, permanently, into an append-only hash-chained
   * ledger and a retention-locked nightly copy with no post-hoc redaction path. So a run that IS a
   * valid ABA number still redacts when nothing in the text CLAIMS one.
   *
   * `Chase checking 021000021 4455667788` is therefore an ACCEPTED reading, not a defect: the sentence
   * asserts two account numbers and no routing number, so redacting both is the safe one.
   */
  it("structure alone never suppresses — a valid ABA number with no routing word still redacts", () => {
    for (const [input, expected] of [
      ["Chase checking 021000021 4455667788", "Chase checking [REDACTED:ACCOUNT ****0021] [REDACTED:ACCOUNT ****7788]"],
      ["account 021000021", "account [REDACTED:ACCOUNT ****0021]"],
      ["For the account, wire via 021000021", "For the account, wire via [REDACTED:ACCOUNT ****0021]"],
      [
        "account 987654321 sent via 021000021",
        "account [REDACTED:ACCOUNT ****4321] sent via [REDACTED:ACCOUNT ****0021]",
      ],
    ] as const) {
      const r = sanitizePII(input);
      expect(r.text, input).toBe(expected);
      expect(sanitizePII(r.text).redacted, input).toBe(false);
    }
  });

  /**
   * CONDITION (b) ALONE IS NOT ENOUGH EITHER — both halves of the shape test have to hold.
   *
   * A labelled run that is not ABA-shaped is an account number somebody put in the wrong field, which
   * is the same thing guard 1's nine-digit length scope already refuses to swallow. Guard 1 is
   * UNCHANGED by this amendment and still takes an ADJACENT marker at its word without looking at the
   * digits, so these inputs put the label pair in front instead.
   */
  it("a routing label does not suppress a run that is not ABA-shaped", () => {
    for (const [input, expected] of [
      // Checksum passes; Federal Reserve prefix 45 does not.
      [
        "Routing / Account: 450000003 / 4455667788",
        "Routing / Account: [REDACTED:ACCOUNT ****0003] / [REDACTED:ACCOUNT ****7788]",
      ],
      // Prefix 02 passes; checksum does not (021000021 with its last digit moved on by one).
      [
        "Routing / Account: 021000022 / 4455667788",
        "Routing / Account: [REDACTED:ACCOUNT ****0022] / [REDACTED:ACCOUNT ****7788]",
      ],
      // Neither passes.
      [
        "Routing / Account: 987654321 / 4455667788",
        "Routing / Account: [REDACTED:ACCOUNT ****4321] / [REDACTED:ACCOUNT ****7788]",
      ],
    ] as const) {
      expect(sanitizePII(input).text, input).toBe(expected);
    }
    // Guard 1, unchanged: an adjacent marker is taken at its word, checksum or no checksum.
    expect(sanitizePII("acct 4455667788, routing 021000022").text).toBe(
      "acct [REDACTED:ACCOUNT ****7788], routing 021000022",
    );
  });

  /**
   * THE HISTORICAL-TOKEN MASK EXISTS FOR THIS ONE CASE.
   *
   * `[REDACTED:ROUTING]` carries the very word guard 2 looks for, and guard 2's 48-character window is
   * wide enough to reach across the token's `]` — which neither anchored tail check could. Rule 4
   * blanks the four withdrawn token shapes before the routing scan, so "tokens from the withdrawn
   * kinds are inert" stays LITERALLY true rather than nearly true after the amendment.
   */
  it("a historical token cannot suppress an ABA-shaped account number either", () => {
    for (const token of ["[REDACTED:ROUTING]", "[REDACTED:DOB]", "[REDACTED:PASSPORT]", "[REDACTED:DL]"]) {
      const r = sanitizePII(`${token} acct 021000021`);
      expect(r.text, token).toBe(`${token} acct [REDACTED:ACCOUNT ****0021]`);
      expect(r.byKind.ACCOUNT, token).toBe(1);
    }
  });

  /**
   * A SECOND RESIDUAL OF RULE 4'S CANDIDATE SHAPE, recorded because withdrawing rule 3 made it
   * reachable for one more input class.
   *
   * `ACCOUNT_CANDIDATE` accepts a single space as an intra-number separator (that is what lets
   * `1234 5678 9012` redact as one account number), so an account number and a space-adjacent second
   * run form ONE candidate when the combined digit count is ≤ 17 — and the emitted last-four is the
   * SECOND run's. This is NOT new and is not caused by Decision #116: `acct 12345678 87654321` and
   * `acct 12345678 123456789` behaved identically before the change, because rule 3 only ever consumed
   * a nine-digit run that passed the Fed-prefix and ABA checks. Withdrawing it extended the same
   * behaviour to a VALID ABA number sitting one space after an account number.
   *
   * It is pinned rather than fixed. No plaintext escapes — the digits are redacted either way — and
   * every available fix is worse: rejecting the merged run makes `applyRule` resume at `index + 1`,
   * which matches the nine-digit tail alone and leaves the eight-digit ACCOUNT in front of it raw.
   */
  it("pins the space-adjacent merge: the last-four is the trailing run's", () => {
    for (const [input, expected] of [
      // Pre-existing, unchanged by Decision #116 — neither trailing run was ever a rule-3 candidate.
      ["acct 12345678 87654321", "acct [REDACTED:ACCOUNT ****4321]"],
      ["acct 12345678 123456789", "acct [REDACTED:ACCOUNT ****6789]"],
      // Reachable since Decision #116: a real ABA number one space after the account number.
      ["acct 12345678 021000021", "acct [REDACTED:ACCOUNT ****0021]"],
      ["checking 12345678 021000021", "checking [REDACTED:ACCOUNT ****0021]"],
    ] as const) {
      const r = sanitizePII(input);
      expect(r.text, input).toBe(expected);
      // The account digits never survive, whichever last-four the token carries.
      expect(r.text, input).not.toContain("12345678");
      expect(r.count, input).toBe(1);
    }
    // A word between the two numbers is enough to break the merge, which is the common layout.
    expect(sanitizePII("acct 12345678 routing 021000021").text).toBe(
      "acct [REDACTED:ACCOUNT ****5678] routing 021000021",
    );
  });
});

describe("DOB, passport and driver's licence pass through (Decision #116)", () => {
  function expectUnchanged(input: string): void {
    const r = sanitizePII(input);
    expect(r.text, input).toBe(input);
    expect(r.redacted, input).toBe(false);
    expect(r.count, input).toBe(0);
  }

  /** Every phrasing the withdrawn `DOB_CONTEXT` recognised: dob, d.o.b., date of birth, birth date, birthday, born. */
  it("every date-of-birth phrasing the old rule 5 caught is left alone", () => {
    for (const input of [
      "DOB 01/02/1975",
      "dob: 1/2/1975",
      "DOB 01-02-1975",
      "d.o.b. 03-04-75",
      "D.O.B. 1975-01-02",
      "Date of Birth: 1975-01-02",
      "date of birth 02.29.1980",
      "birthdate 12/31/1999",
      "birth date 12/31/1999",
      "birthday 12/31/1999",
      "born March 3, 1975",
      "born on Mar. 3 1975",
      "born 3 March 1975",
      "born 3rd March, 1975",
      "client DOB is 02/29/1980",
      "DOB 13/05/1975",
      "Beneficiary DOB 01/02/1975 — needed for the RMD calculation",
    ]) {
      expectUnchanged(input);
    }
  });

  it("a passport number in passport context is left alone", () => {
    for (const input of [
      "passport 123456789 expires 2030",
      "Passport No. A12345678",
      "passport number: AB1234567",
      "Passport # 123456789",
      "Passport #123456789",
      "passports on file: 553019876",
    ]) {
      expectUnchanged(input);
    }
  });

  it("a driver's licence in licence context is left alone", () => {
    for (const input of [
      "DL A1234567 on file",
      "D.L. A1234567",
      "DLN A1234567",
      "driver's license D1234567",
      "drivers licence S12345678",
      "driving licence 123456789",
      "License Number: F123456789012",
      "DL #A1234567",
      "licence #A1234567",
    ]) {
      expectUnchanged(input);
    }
  });

  it("the identity-verification note that used to redact three kinds now redacts none", () => {
    const input =
      "Called the number on file. Confirmed DOB 01/02/1975, driver's licence A1234567 and passport 553019876.";
    const r = sanitizePII(input);
    expect(r.text).toBe(input);
    expect(r.byKind).toEqual({ SSN: 0, CARD: 0, ACCOUNT: 0 });
  });

  /**
   * THE LIMIT OF "A DATE OF BIRTH PASSES THROUGH", pinned so nobody reads the sentence as absolute.
   *
   * Rule 4 never knew what a date was and still does not. `ACCOUNT_CANDIDATE` spans a single dash, so
   * `1975-01-02` is an 8-digit candidate and `19750102` is a bare one; either redacts as ACCOUNT when
   * account context ends within 24 characters. That is UNCHANGED by Decision #116 — rule 4 has always
   * run before the Wave B rules, so these inputs behaved identically while rule 5 existed — but the
   * decision's headline cases (RMDs, beneficiary forms, caller verification) happen on tickets that
   * carry an account number, so the limit is worth a vector rather than a discovery.
   *
   * It is distance-dependent, which is the part an operator would not guess: the same fact written two
   * ways gets two different answers. If the desk wants dates genuinely exempt, the lever is a
   * date-shaped negative guard on rule 4, not re-adding rule 5.
   */
  it("an ISO or compact date near ACCOUNT context is still redacted, as ACCOUNT", () => {
    for (const [input, expected] of [
      [
        "IRA account 4471209983 — owner born 1975-01-02, RMD due.",
        "IRA account [REDACTED:ACCOUNT ****9983] — owner born [REDACTED:ACCOUNT ****0102], RMD due.",
      ],
      [
        "Caller verified on checking 1234567890, DOB 19750102.",
        "Caller verified on checking [REDACTED:ACCOUNT ****7890], DOB [REDACTED:ACCOUNT ****0102].",
      ],
    ] as const) {
      expect(sanitizePII(input).text, input).toBe(expected);
    }
    // Slash and written-month dates pass through even with an account number in the same sentence,
    // and an ISO date far enough from the account keyword does too — the 24-char window is the line.
    expect(sanitizePII("IRA account 4471209983 — owner born 01/02/1975, RMD due.").text).toBe(
      "IRA account [REDACTED:ACCOUNT ****9983] — owner born 01/02/1975, RMD due.",
    );
    expect(sanitizePII("Date of Birth: 1975-01-02").text).toBe("Date of Birth: 1975-01-02");
  });

  /** Same mechanism, same two other withdrawn kinds: nine digits is a rule-4 candidate shape. */
  it("a numeric passport or licence number near ACCOUNT context is still redacted, as ACCOUNT", () => {
    expect(sanitizePII("acct 12345678, passport 553019876").text).toBe(
      "acct [REDACTED:ACCOUNT ****5678], passport [REDACTED:ACCOUNT ****9876]",
    );
    expect(sanitizePII("a/c 1234567890 licence 123456789").text).toBe(
      "a/c [REDACTED:ACCOUNT ****7890] licence [REDACTED:ACCOUNT ****6789]",
    );
    // With no account context anywhere, both pass through — the rule 6/7 withdrawal is real.
    expectUnchanged("passport 553019876");
    expectUnchanged("licence 123456789");
  });

  it("the surviving three still fire in a note that also carries the withdrawn four", () => {
    // The point of the mixed case: withdrawing four rules changed nothing about the other three.
    const r = sanitizePII(
      "DOB 01/02/1975, licence A1234567, passport 553019876, routing 021000021, acct 000123456789, SSN 123-45-6789, card 4111 1111 1111 1111",
    );
    expect(r.byKind).toEqual({ SSN: 1, CARD: 1, ACCOUNT: 1 });
    expect(r.text).toBe(
      "DOB 01/02/1975, licence A1234567, passport 553019876, routing 021000021, acct [REDACTED:ACCOUNT ****6789], SSN [REDACTED:SSN], card [REDACTED:CARD ****1111]",
    );
    expect(sanitizePII(r.text).redacted).toBe(false);
  });
});

describe("tokens from the withdrawn kinds are inert (nothing is backfilled)", () => {
  const HISTORICAL = ["[REDACTED:ROUTING]", "[REDACTED:DOB]", "[REDACTED:PASSPORT]", "[REDACTED:DL]"] as const;

  /**
   * The idempotence mask narrowed with the rule set, so these four token shapes are no longer blanked
   * before context detection runs. That is safe, and this is the proof rather than the argument: they
   * carry no digits for a candidate to match, none of their words is positive context for a surviving
   * rule, and the two anchored tail checks cannot reach across a token's closing `]` to suppress one.
   */
  it("a historical token neither redacts nor changes under a fresh pass", () => {
    for (const token of HISTORICAL) {
      const r = sanitizePII(`already masked: ${token} on file`);
      expect(r.redacted, token).toBe(false);
      expect(r.text, token).toBe(`already masked: ${token} on file`);
    }
  });

  it("a historical token cannot act as context for a number beside it", () => {
    for (const token of HISTORICAL) {
      // No surviving rule's keyword lives inside these tokens, so a bare digit run after one stays put.
      expect(sanitizePII(`${token} 123456789`).redacted, token).toBe(false);
      expect(sanitizePII(`${token} 000123456789`).redacted, token).toBe(false);
    }
  });

  it("a historical token cannot SUPPRESS a redaction beside it either", () => {
    // `[REDACTED:ROUTING]` carries the word "routing", which is now rule 4's negative guard — but the
    // guard is anchored and cannot match across the token's `]`, so the account still redacts.
    for (const token of HISTORICAL) {
      const r = sanitizePII(`${token} acct 000123456789`);
      expect(r.byKind.ACCOUNT, token).toBe(1);
      expect(r.text, token).toBe(`${token} acct [REDACTED:ACCOUNT ****6789]`);
    }
    expect(sanitizePII("routing [REDACTED:ROUTING] acct 000123456789").text).toBe(
      "routing [REDACTED:ROUTING] acct [REDACTED:ACCOUNT ****6789]",
    );
  });
});

describe("false positives the brief named explicitly (folded in from the Wave B suite)", () => {
  it("plain dates, invoice numbers, WM references and market identifiers survive untouched", () => {
    for (const input of [
      "sold 400 shares 09/16/2026 ticket #987654321",
      "invoice 1234567 dated 2026-09-16 is unpaid",
      "invoice no. 123456789 for the quarter",
      "see HD-1042 and REQ-20260916",
      "HD-1042 opened 01/02/2026, closed 03/04/2026",
      "statement period 2026-01-01 to 2026-03-31",
      "CUSIP 037833100 AAPL; cusip: 594918104",
      "call me at 555-123-4567 or (555) 123-4567",
      "phone 2125551234 and zip 10001-1234",
      "amount $1,234,567.89 on 2026-09-16",
      "meeting on 01/02/2026 confirmed",
      "the transfer settled 3 March 2026",
      "renewal due 12/31/2026",
    ]) {
      const r = sanitizePII(input);
      expect(r.redacted, input).toBe(false);
      expect(r.text, input).toBe(input);
    }
  });
});

/**
 * THE TWELVE ACCEPTANCE VECTORS from the 2026-09-20 routing-recogniser brief, pinned verbatim.
 *
 * Six are the wire-instruction layouts the recogniser is about — the slash layout, the labelled pair
 * and the bare adjacency were the three the brief called out, and the first two of those were WRONG
 * before this change. The other six are behaviours the fix had to leave exactly alone: a date of birth
 * and a date of death pass through, an SSN and a card still redact, and a passport number and an ACAT
 * control number pass through for want of account context.
 *
 * They duplicate assertions made elsewhere in this file on purpose. This is the list that was agreed
 * and re-run by hand, so it is the list that has to keep passing, in one place a reviewer can read end
 * to end without reconstructing it from five blocks.
 */
describe("acceptance vectors (2026-09-20 routing-recogniser brief)", () => {
  const CASES: ReadonlyArray<readonly [string, string, string]> = [
    // label            input                                                 expected
    ["routing first", "Wire to Chase, routing 021000021, acct 000123456789", "Wire to Chase, routing 021000021, acct [REDACTED:ACCOUNT ****6789]"],
    ["account first", "Wire out: acct 4455667788, routing 021000021", "Wire out: acct [REDACTED:ACCOUNT ****7788], routing 021000021"],
    ["slash layout", "Routing / Account: 021000021 / 4455667788", "Routing / Account: 021000021 / [REDACTED:ACCOUNT ****7788]"],
    ["labelled pair", "routing and account numbers: 021000021 / 4471209983", "routing and account numbers: 021000021 / [REDACTED:ACCOUNT ****9983]"],
    // ACCEPTED AS-IS, deliberately: nothing in this sentence claims a routing number, so redacting
    // both runs is the safe reading. Do not "fix" this one — see the structure-alone block above.
    ["bare adjacency", "Chase checking 021000021 4455667788", "Chase checking [REDACTED:ACCOUNT ****0021] [REDACTED:ACCOUNT ****7788]"],
    ["aba alone", "ABA 021000021 for the incoming wire", "ABA 021000021 for the incoming wire"],
    ["dob", "Beneficiary DOB 01/02/1975", "Beneficiary DOB 01/02/1975"],
    ["date of death", "Date of death: 03/14/2025", "Date of death: 03/14/2025"],
    ["ssn", "SSN 123-45-6789", "SSN [REDACTED:SSN]"],
    ["card", "4111 1111 1111 1111", "[REDACTED:CARD ****1111]"],
    ["passport", "passport 553019876", "passport 553019876"],
    ["acat control", "ACAT control number 123456789 from Schwab", "ACAT control number 123456789 from Schwab"],
  ];

  it("all twelve behave as the brief specifies", () => {
    for (const [label, input, expected] of CASES) {
      const r = sanitizePII(input);
      expect(r.text, label).toBe(expected);
      // Structural invariants hold on every one of them, same as the §f vectors.
      expect(r.redacted, label).toBe(r.count > 0);
      expect(sanitizePII(r.text).redacted, label).toBe(false);
    }
  });

  it("no acceptance vector leaks its own digits into the result object", () => {
    for (const [label, input] of CASES) {
      const r = sanitizePII(input);
      const serialised = JSON.stringify(r);
      for (const f of r.findings) {
        // The finding names the span, never the value.
        expect(input.slice(f.start, f.end).length, label).toBe(f.end - f.start);
        expect(serialised, label).not.toContain(input.slice(f.start, f.end));
      }
    }
  });
});
