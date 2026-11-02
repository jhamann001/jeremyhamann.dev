import type { PillTone } from "@/components/ui";

// Action → PillTone, the house tone-map idiom (components/deals/stage-tone.ts,
// components/workflow/status-tone.ts): one total map per vocabulary, screens
// call the helper instead of re-deriving tones inline. Pure (no React) —
// unit-tested in test/audit-tone.test.ts.
//
// The mockup toned audit pills by DEMO role (extraction §5 flags that as an
// ambiguity for the app's real role set); WO ticket resolves it as a small
// action→tone map keyed on the dotted verb suffix lib/audit.ts writes
// ("deal.create" → create), so every future writer (transfer.create,
// task.update, …) tones correctly with no per-entity additions.

const VERB_TONE: Record<string, PillTone> = {
  create: "green",
  update: "blue",
  stage_change: "amber",
  delete: "red",
};

export function actionTone(action: string): PillTone {
  const verb = action.slice(action.lastIndexOf(".") + 1);
  return VERB_TONE[verb] ?? "gray";
}

// Row-change op → PillTone for the field-level audit view
// (tkt-audit-row-change-ui). The trigger's TG_OP vocabulary is a small closed
// set (INSERT/UPDATE/DELETE); toned to match the VERB_TONE semantics above
// (create→green, update→blue, delete→red) so the two audit views read alike.
const OP_TONE: Record<string, PillTone> = {
  INSERT: "green",
  UPDATE: "blue",
  DELETE: "red",
};

export function opTone(op: string): PillTone {
  return OP_TONE[(op ?? "").toUpperCase()] ?? "gray";
}

// Friendly labels for the rolled-up ingest actions in the Events view
// (tkt-audit-events-ingest-rollup). The seam collapses every "ingest.*" action
// into one daily summary row; the pill reads as a human phrase ("Deals ingest")
// instead of the raw dotted action. Unknown ingest actions fall back to a
// title-cased suffix so a new ingest source labels sensibly with no edit here.
const INGEST_LABELS: Record<string, string> = {
  "ingest.deals": "Deals ingest",
  "ingest.clients": "Clients ingest",
  "ingest.accounts": "Accounts ingest",
  "ingest.tasks": "Tasks ingest",
  "ingest.emails": "Emails ingest",
  "ingest.activity": "Activity ingest",
  "ingest.account_aum": "Account AUM ingest",
};

export function ingestActionLabel(action: string): string {
  const known = INGEST_LABELS[action];
  if (known) return known;
  const suffix = action.slice(action.lastIndexOf(".") + 1).replace(/_/g, " ");
  const titled = suffix.charAt(0).toUpperCase() + suffix.slice(1);
  return `${titled} ingest`;
}
