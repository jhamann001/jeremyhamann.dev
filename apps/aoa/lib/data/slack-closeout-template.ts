// Slack closeout checklist template (SLACK_TRANSFER_CLOSEOUT).
//
// AOA owns the checklist (ADR-3): items are snapshotted into transfer_slack_item
// at IN_TRANSFER entry, sent to n8n for the Slack render, and read back as
// completion status. Editing THIS file is the only change needed to adjust the
// list. `item_key` is the stable id the Slack callback keys toggles on — keep keys
// stable once shipped; `label`/`sort`/`group`/`note` are display-only (not persisted).
//
// SHAPE: a flat row per checkbox. Rows sharing a `group` render under one header
// in Slack (here: "Trade Instructions" over Trade Center / CRM / Meridian);
// `note` is a subscript shown under that row. The group header itself is not a row.
//
// COMPLETION (owner 2026-07-23, Notewell regrouped 2026-07-24) is NOT "every box
// checked" — see isCloseoutComplete: the standalone items must all be done AND
// Trade Instructions must be satisfied, where Trade Instructions = Trade Center
// OR CRM ONLY. Meridian and Notewell can be recorded but never satisfy the
// group — alone or together (a template assigned in Meridian is not trade
// instructions, and notes of a discussion are not instructions either).
export type SlackCloseoutItem = {
  item_key: string;
  label: string;
  sort: number;
  group?: string;
  note?: string;
};

export const SLACK_CLOSEOUT_TEMPLATE: readonly SlackCloseoutItem[] = [
  { item_key: "cost_basis_verified", label: "Cost Basis Verified", sort: 1 },
  { item_key: "transition_template_applied", label: "Transition Template Applied", sort: 2 },
  { item_key: "fee_reimbursement_filed", label: "Fee Reimbursement Filed", sort: 3 },
  { item_key: "trade_instructions_trade_center", label: "Trade Center", sort: 4, group: "Trade Instructions" },
  { item_key: "trade_instructions_crm", label: "CRM", sort: 5, group: "Trade Instructions" },
  {
    item_key: "trade_instructions_meridian",
    label: "Meridian",
    sort: 6,
    group: "Trade Instructions",
    note: "A template assigned in Meridian does NOT count — if you can't find actual trade instructions, don't check this.",
  },
  {
    item_key: "notewell_notes_reviewed",
    label: "Notewell Notes Reviewed",
    sort: 7,
    group: "Trade Instructions",
    note: "Check the Notewell meeting notes for whether investment instructions or an allocation were discussed. Notes alone do NOT satisfy Trade Instructions.",
  },
];

// A persisted transfer_slack_item row, as read for display (subset of the
// Prisma model — label/sort are the seed-time snapshot).
export type SlackCloseoutItemRow = {
  item_key: string;
  label: string;
  sort: number;
  done: boolean;
  done_by: string | null;
  done_at: Date | null;
};

// The merged row the UI renders: template display metadata (label/group/note,
// which the DB does not fully persist) + the row's completion state.
export type SlackCloseoutItemView = SlackCloseoutItemRow & {
  group?: string;
  note?: string;
};

/**
 * Merge persisted checklist rows with the template's display metadata, keyed on
 * item_key (the stable id). Template wins on label/sort so display follows
 * template edits; group/note come only from the template (not persisted).
 * Unknown item_keys (template drift on old transfers) keep their seed-time
 * snapshot label (item_key if somehow blank) and sort AFTER every known item,
 * preserving their relative seeded order. Output is display-ordered.
 */
export function mergeCloseoutItems(
  rows: readonly SlackCloseoutItemRow[],
): SlackCloseoutItemView[] {
  const byKey = new Map(SLACK_CLOSEOUT_TEMPLATE.map((t) => [t.item_key, t]));
  const maxSort = Math.max(0, ...SLACK_CLOSEOUT_TEMPLATE.map((t) => t.sort));
  return rows
    .map((r) => {
      const t = byKey.get(r.item_key);
      return {
        item_key: r.item_key,
        label: t?.label ?? (r.label || r.item_key),
        // Unknown keys land past the template range, ordered by their own sort.
        sort: t ? t.sort : maxSort + r.sort,
        group: t?.group,
        note: t?.note,
        done: r.done,
        done_by: r.done_by,
        done_at: r.done_at,
      };
    })
    .sort((a, b) => a.sort - b.sort || a.item_key.localeCompare(b.item_key));
}

// Standalone items that must all be done.
const REQUIRED_ITEM_KEYS = [
  "cost_basis_verified",
  "transition_template_applied",
  "fee_reimbursement_filed",
] as const;
// Trade Instructions is satisfied by EITHER of these ONLY (owner 2026-07-24):
// Meridian and Notewell are deliberately excluded — neither counts, alone or
// together.
const TRADE_INSTRUCTIONS_SATISFYING_KEYS = [
  "trade_instructions_trade_center",
  "trade_instructions_crm",
] as const;

/**
 * Closeout completion rule (owner 2026-07-23): all standalone items done AND
 * Trade Instructions satisfied (Trade Center OR CRM). NOT a plain "all boxes"
 * check — Meridian is optional and never satisfies Trade Instructions by itself.
 * `doneKeys` = the item_keys currently marked done.
 */
export function isCloseoutComplete(doneKeys: Iterable<string>): boolean {
  const done = doneKeys instanceof Set ? doneKeys : new Set(doneKeys);
  return (
    REQUIRED_ITEM_KEYS.every((k) => done.has(k)) &&
    TRADE_INSTRUCTIONS_SATISFYING_KEYS.some((k) => done.has(k))
  );
}
