// Pure deal-name parser (Phase Deals D4, TDD ticket §7 step 1) — extracts the
// account fields the report never carries as columns from the deal-name
// convention:
//
//   "<Client> - <Transferring Firm> - <Account Type> - <last4>"
//   e.g. "Jordan Sample - Fidelity - Roth IRA - 1234"        (INVENTED example)
//
// Real names vary — the pattern zoo this parser tolerates:
//   - status prefixes:  "[Pending Client Signature] Jordan Sample - …"
//   - $TBD placeholders in the last4 slot: "… - Roth IRA - $TBD"
//   - decorated last4:  "#1234", "x1234", "*1234", "…1234"
//   - missing segments: "Client - Firm - Roth IRA" (no last4),
//     "Client - Roth IRA - 1234" (no firm — the lone middle segment is
//     classified firm-vs-type by account-type keywords), "Client - Firm"
//   - unparseable names: everything null, confidence "none"
//
// Segments split on SPACE-PADDED dashes only (" - ", en/em dash tolerated) so
// hyphenated tokens like "SEP-IRA" or hyphenated firm names survive intact.
//
// PURE + zero imports: consumed by the D4 scripts and unit tests without
// touching Prisma. All extraction is deterministic — anything ambiguous lands
// in the parse-and-review CSV for human correction (never guessed silently
// beyond the documented keyword heuristic, which the confidence flag exposes).

export type ParseConfidence = "high" | "partial" | "none";

export type ParsedDealName = {
  /** Segment 0 — the client display name as written in the deal name. */
  client_name: string | null;
  transferring_firm: string | null;
  account_type: string | null;
  /** Exactly 4 digits when found; null for $TBD / missing. */
  account_last4: string | null;
  /** Contents of a leading "[…]" status prefix, e.g. "Pending Client Signature". */
  status_prefix: string | null;
  /**
   * "high"    = firm + type + last4 all extracted (the canonical shape);
   * "partial" = some but not all account fields extracted (review recommended);
   * "none"    = nothing account-shaped found (review required).
   */
  confidence: ParseConfidence;
};

// Leading "[Status]" prefix (one; the report uses a single status tag).
const STATUS_PREFIX = /^\[([^\]]+)\]\s*/;

// Segment separator: space-padded hyphen / en dash / em dash.
const SEGMENT_SPLIT = /\s+[-–—]\s+/;

// last4: exactly 4 digits, optionally decorated (#1234, x1234, *1234, …1234, ...1234).
const LAST4 = /^(?:#|x+|\*+|…|\.{3})?\s*(\d{4})$/i;

// Placeholder for a not-yet-known account number: "$TBD", "TBD", "TBD$".
const TBD = /^\$?\s*TBD\s*\$?$/i;

// Account-type vocabulary — a segment containing any of these words is an
// account type, not a firm (used only when a lone middle segment must be
// classified). Word-boundary matched so "401" hits "401(k) Rollover" but a
// firm like "Fidelity" never matches.
const ACCOUNT_TYPE_WORDS =
  /(?:^|[^A-Za-z0-9])(?:IRA|ROTH|401|403|457|SEP|SIMPLE|HSA|529|JOINT|INDIVIDUAL|TRUST|BROKERAGE|ROLLOVER|INHERITED|CUSTODIAL|UTMA|UGMA|TOD|ANNUITY|CHECKING|SAVINGS|TAXABLE|ESTATE|PENSION)(?:[^A-Za-z0-9]|$)/i;

function isAccountTypeLike(segment: string): boolean {
  return ACCOUNT_TYPE_WORDS.test(segment);
}

export function parseDealName(rawName: string | null | undefined): ParsedDealName {
  const none: ParsedDealName = {
    client_name: null,
    transferring_firm: null,
    account_type: null,
    account_last4: null,
    status_prefix: null,
    confidence: "none",
  };

  let name = (rawName ?? "").trim();
  if (name === "") return none;

  // 1) Peel a leading "[Status]" prefix.
  let status_prefix: string | null = null;
  const prefixMatch = name.match(STATUS_PREFIX);
  if (prefixMatch) {
    status_prefix = prefixMatch[1].trim() || null;
    name = name.slice(prefixMatch[0].length).trim();
  }
  if (name === "") return { ...none, status_prefix };

  // 2) Split into segments on space-padded dashes.
  const segments = name
    .split(SEGMENT_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s !== "");

  const client_name = segments[0] ?? null;
  const rest = segments.slice(1);

  // 3) Pull the trailing last4 (or a $TBD placeholder occupying its slot).
  let account_last4: string | null = null;
  if (rest.length > 0) {
    const tail = rest[rest.length - 1];
    const last4Match = tail.match(LAST4);
    if (last4Match) {
      account_last4 = last4Match[1];
      rest.pop();
    } else if (TBD.test(tail)) {
      rest.pop(); // placeholder — last4 stays unknown (null)
    }
  }

  // 4) Classify the middle segments.
  let transferring_firm: string | null = null;
  let account_type: string | null = null;
  if (rest.length === 1) {
    // Lone middle segment: keyword heuristic decides firm vs type.
    if (isAccountTypeLike(rest[0])) account_type = rest[0];
    else transferring_firm = rest[0];
  } else if (rest.length >= 2) {
    // Canonical order: firm first, then type; extra segments belong to the
    // type (e.g. an account type that itself contains " - ").
    transferring_firm = rest[0];
    account_type = rest.slice(1).join(" - ");
  }

  // 5) Confidence.
  const extracted = [transferring_firm, account_type, account_last4].filter(
    (v) => v != null,
  ).length;
  const confidence: ParseConfidence =
    extracted === 3 ? "high" : extracted > 0 ? "partial" : "none";

  return {
    client_name,
    transferring_firm,
    account_type,
    account_last4,
    status_prefix,
    confidence,
  };
}
