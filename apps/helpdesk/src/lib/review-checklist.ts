/**
 * The supervisory review checklist — pure, L1, edge-safe.
 *
 * CONFIG IS CODE. There is no checklist builder, no admin screen and no table:
 * the five points below are the firm's review procedure, they change when the procedure changes, and
 * a change to the procedure belongs in a reviewed commit rather than in a form somebody filled in on
 * a Tuesday. The same argument the repository already makes about the routing table and the SLA
 * policy seed.
 *
 * WHY IT LIVES IN `src/lib` AND NOT IN THE ACTION. Both halves of the feature need it: the server
 * validates what was ticked, and two CLIENT components render the ticks. A `"use server"` module may
 * export only async actions, and `src/components/**` may not import a non-`.actions` server
 * module, so the shared vocabulary has to be an L1 module. It imports nothing.
 *
 * WHAT THE TICKS ARE, EVIDENTIALLY. They are a record of what the reviewer says they checked, not a
 * machine assertion that the reply passes. Nothing here is validated against the reply's text, and
 * nothing here is required — a reviewer who ticks nothing and writes a sentence has still produced a
 * stamp. The ticks exist because "I reviewed it" and "I checked the disclaimer, the claims and the
 * redactions" are different statements a year later, and only the second one answers an examiner.
 *
 * The ticked keys ride on the `REVIEW_STAMPED` audit row's metadata as an array of enum values —
 * PII-light by construction, and readable without joining anything.
 */

export const REVIEW_CHECKLIST_KEYS = [
  "DISCLAIMER",
  "NO_UNAPPROVED_CLAIM",
  "NO_UNREDACTED_PII",
  "ACCURATE",
  "ESCALATION_HANDLED",
] as const;

export type ReviewChecklistKey = (typeof REVIEW_CHECKLIST_KEYS)[number];

export type ReviewChecklistItem = {
  key: ReviewChecklistKey;
  /** The tick's label — short enough to read down a phone sheet in one pass. */
  label: string;
  /** What the reviewer is actually asserting. Rendered as help text, never as a tooltip alone. */
  detail: string;
};

export const REVIEW_CHECKLIST: readonly ReviewChecklistItem[] = [
  {
    key: "DISCLAIMER",
    label: "Correct disclaimer",
    detail: "The reply carries the disclaimer its category and channel call for, and no other.",
  },
  {
    key: "NO_UNAPPROVED_CLAIM",
    label: "No unapproved claim",
    detail:
      "No performance promise, no guarantee, no recommendation that needed approval and did not have it.",
  },
  {
    key: "NO_UNREDACTED_PII",
    label: "No client identifiers left in",
    detail:
      "Nothing in the body the desk redacts — an account number, a card number, a Social Security number. " +
      "A routing number, date of birth, licence or passport number is left as written (Decision #116); " +
      "the question for those is whether the reply needed to quote the identifier at all.",
  },
  {
    key: "ACCURATE",
    label: "Answer matches the file",
    detail: "What the reply tells the client is what the ticket, the custodian and the record show.",
  },
  {
    key: "ESCALATION_HANDLED",
    label: "Escalation handled",
    detail:
      "Anything in the thread that should have been escalated — a complaint, a suspected impostor — was.",
  },
];

const KEY_SET: ReadonlySet<string> = new Set<string>(REVIEW_CHECKLIST_KEYS);

export function isReviewChecklistKey(value: unknown): value is ReviewChecklistKey {
  return typeof value === "string" && KEY_SET.has(value);
}

/**
 * Normalises whatever the client sent into the canonical order, deduplicated, unknown values dropped.
 * The same shape `parseGroups` uses for the Okta claim, and for the same reason: a list that
 * arrives from a browser is input, not truth, and the ledger should never carry a value the code
 * cannot explain.
 */
export function normalizeChecklist(raw: unknown): ReviewChecklistKey[] {
  const candidates: unknown[] = Array.isArray(raw) ? raw : [];
  const present = new Set<ReviewChecklistKey>();
  for (const c of candidates) {
    if (isReviewChecklistKey(c)) present.add(c);
  }
  return REVIEW_CHECKLIST_KEYS.filter((k) => present.has(k));
}

export const REVIEW_CHECKLIST_LABELS: Readonly<Record<ReviewChecklistKey, string>> = Object.freeze(
  Object.fromEntries(REVIEW_CHECKLIST.map((i) => [i.key, i.label])) as Record<ReviewChecklistKey, string>,
);
