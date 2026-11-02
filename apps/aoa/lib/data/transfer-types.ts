// Transfer contract module (TDD ticket §3/§4, ADR-2/3/6/7) — PURE: no Prisma
// import, so unit tests and the seed consume it without touching the client.
// Shared by the T2 seam (`lib/data/transfers.ts`), the T3 form/server actions,
// and the seed — one vocabulary, one row shape, one input shape (the deals
// deal-types idiom carried).

// Lifecycle lanes in board order (ADR-2; ticket Slice 1). String-literal
// unions are structurally identical to the Prisma enums. The model collapsed
// from five stages to three (DECISION → IN_TRANSFER → FUNDED): DISCOVERY and
// ACCOUNTS_OPEN were removed from the process/board/order/labels/gates and
// their rows remapped to DECISION. The two values stay physically present but
// INERT in the Postgres `TransferStage` enum (Postgres cannot cleanly drop an
// in-use enum value — see prisma/schema.prisma); nothing here produces them.
export const TRANSFER_STAGES = ["DECISION", "IN_TRANSFER", "FUNDED"] as const;
export type TransferStage = (typeof TRANSFER_STAGES)[number];

// Row provenance (ADR-1): APP = entered in AOA (the only producer this phase);
// IMPORT is reserved for a future backfill (tracker history / CRM) so it
// links instead of duplicating.
export const TRANSFER_SOURCES = ["APP", "IMPORT"] as const;
export type TransferSource = (typeof TRANSFER_SOURCES)[number];

// Structured owner (ADR-7) — no user FK; owner_name is display-only.
// "Bouncing back to the advisor" is DERIVED, never stored:
// owner_kind === "ADVISOR" && stage !== "FUNDED" (locked, the owner 2026-07-02).
export const TRANSFER_OWNERS = [
  "OPERATIONS",
  "CLIENT_SERVICE",
  "ADVISOR",
] as const;
export type TransferOwner = (typeof TRANSFER_OWNERS)[number];

// Named-person assignees per owner kind (ticket). Order = display order; index 0
// is the default the toolbar auto-assigns when the kind is chosen. UI-only vocabulary
// — owner_name stays a free-text column server-side, so this list can grow without a
// migration and legacy/free-text names remain valid.
export const OWNER_PEOPLE: Record<TransferOwner, readonly string[]> = {
  OPERATIONS: ["Jordan Reyes", "Marco Ferreira"],
  CLIENT_SERVICE: ["Helen Carver"],
  ADVISOR: ["Rachel Moss", "Sam Ortiz", "Dana Pruitt"],
};

export function defaultOwnerName(kind: TransferOwner): string {
  return OWNER_PEOPLE[kind][0];
}

// Option list for the toolbar owner-name <select> (ticket). Always leads with an
// "— Unassigned —" entry (so an owner can be cleared), preserves the current value as
// a selectable option when it isn't a canonical person for the kind (legacy / free-text
// names never silently vanish), then the kind's people. Pure so the highest-risk UI
// branch is unit-tested rather than inlined in the component.
export type OwnerNameOption = { value: string; label: string };
export function ownerNameOptions(
  kind: TransferOwner,
  current: string | null,
): OwnerNameOption[] {
  const people = OWNER_PEOPLE[kind];
  const stored = current ?? "";
  return [
    { value: "", label: "— Unassigned —" },
    ...(stored && !people.includes(stored) ? [{ value: stored, label: stored }] : []),
    ...people.map((p) => ({ value: p, label: p })),
  ];
}

// The human call per position (ADR-3). The recommendation is derived at read
// time (`recommendPosition` in transfer-basis.ts) — never stored.
export const TRANSFER_DECISION_CHOICES = [
  "BRING_IN",
  "LEAVE_GIFT",
  "UNDECIDED",
] as const;
export type TransferDecisionChoice = (typeof TRANSFER_DECISION_CHOICES)[number];

export const TRANSFER_ACCOUNT_STATUSES = ["TO_OPEN", "OPEN"] as const;
export type TransferAccountStatus = (typeof TRANSFER_ACCOUNT_STATUSES)[number];

// Funding rail (ticket Slice 2; split for ticket). ACAT_FULL/ACAT_PARTIAL
// are the only rails that read the tracker's redacted asset map (S5).
// DRS is a separate securities-transfer rail, not an ACAT.
// Array order is the dropdown render order: the transfer rails
// (ACAT-Full, ACAT-Partial, DRS, Manual Transfer) grouped first, then
// the cash rails (Check, Wire, ACH). This is UI ordering only — decoupled from
// the Prisma/DB `FundingType` enum's physical sortorder (which the migration
// pins separately). Nullable on a transfer until the Decision checklist card
// (S2) or the sync (S4) sets it.
export const FUNDING_TYPES = [
  "ACAT_FULL",
  "ACAT_PARTIAL",
  "DRS",
  "MANUAL",
  "CHECK",
  "WIRE",
  "ACH",
] as const;
export type FundingType = (typeof FUNDING_TYPES)[number];

export const FUNDING_TYPE_LABEL: Record<FundingType, string> = {
  ACAT_FULL: "ACAT-Full",
  ACAT_PARTIAL: "ACAT-Partial",
  DRS: "DRS",
  MANUAL: "Manual Transfer",
  CHECK: "Check",
  WIRE: "Wire",
  ACH: "ACH",
};

// Owner-provided estimated funding arrival per rail (ticket). Static display
// copy — NOT calendar math. Rendered next to the selected funding type.
export const FUNDING_TYPE_ETA: Record<FundingType, string | null> = {
  ACAT_FULL: "5 business days",
  ACAT_PARTIAL: "5 business days",
  DRS: null, // No fixed arrival estimate has been provided for DRS.
  MANUAL: "3–5 months",
  CHECK: "30 business days",
  WIRE: "1–2 business days",
  ACH: "3–5 business days",
};

// Only the ACAT rails read the tracker's redacted asset map (S5).
// DRS, manual transfers, and cash rails do not use this ACAT-specific path.
export function isAcatFunding(ft: FundingType | null): boolean {
  return ft === "ACAT_FULL" || ft === "ACAT_PARTIAL";
}

// Board ordering for lanes / stage selects (T2/T3 render in this order).
export const STAGE_ORDER: readonly TransferStage[] = TRANSFER_STAGES;

/** Board fall-off (ticket): a FUNDED transfer whose every checklist task is done
 *  (zero tasks → vacuously). The board hides these unless "Show completed" is on. Pure —
 *  mirrors the `hideCompletedFunded` SQL rule so client + seam agree. Structurally
 *  typed (not the seam's TransferBoardRow) so this stays Prisma-free and the client
 *  bundle never drags in the seam. */
export function isFallenOff(row: {
  stage: TransferStage;
  tasksDone: number;
  tasksTotal: number;
}): boolean {
  return row.stage === "FUNDED" && row.tasksDone === row.tasksTotal;
}

export const STAGE_LABEL: Record<TransferStage, string> = {
  DECISION: "Preparation",
  IN_TRANSFER: "In transfer",
  FUNDED: "Funded",
};

export function stageLabel(stage: TransferStage): string {
  return STAGE_LABEL[stage];
}

/** The presentation names DECISION "Decision"; flag off keeps `stageLabel`. */
export function workspaceStageLabel(stage: TransferStage, enabled: boolean): string {
  return enabled && stage === "DECISION" ? "Decision" : stageLabel(stage);
}

// Per-stage gate captions (ADR-2, from the mockup's STAGES). Gates are SOFT
// and advisory (locked, the owner 2026-07-02): satisfaction is computed at read
// time by `gateStatus` (transfer-basis.ts); transitions are never blocked —
// the audit trail (`transfer.stage_change {from, to}`) is the control.
export const STAGE_GATES: Record<TransferStage, string> = {
  DECISION: "Accounts open · funding plan · funding initiated",
  IN_TRANSFER: "ACAT in motion / cash in flight",
  FUNDED: "Positions reconciled",
};

// Per-stage default checklist template (ADR-3). The mockup's task vocabulary,
// accepted as the seed defaults (answered question 3, the owner 2026-07-02;
// editable in the UI later). T3's create seeds the chosen stage's list; the
// synthetic seed exercises every stage's template. Tasks can be added, never
// deleted (uncheck instead — the uniform no-DELETE story).
export const DEFAULT_TASKS: Record<TransferStage, readonly string[]> = {
  // ticket Slice 1: DECISION now spans the collapsed pre-transfer work — the
  // former DISCOVERY + DECISION + ACCOUNTS_OPEN task vocabularies merged in
  // workflow order (deduped).
  DECISION: [
    "Collect statements",
    "Run asset mapper",
    // "Send decision worksheet" + "Asset decisions finalized" are SEEDED here
    // but only SHOWN for a partial ACAT (visibleTasks) — the worksheet is only
    // needed to decide what to bring on a partial transfer. Advisor-meeting /
    // "resolve review items" / "asset decisions made" / "submit ACAT to Apex"
    // were removed (owner 2026-07-20): the checklist is ops's executable steps,
    // not the advisor/relationship timeline, and the ACAT submit is the stage
    // boundary (IN_TRANSFER's first task) governed by the hard gate.
    "Send decision worksheet",
    "Asset decisions finalized",
    "Open receiving accounts",
    "Confirm account numbers",
  ],
  IN_TRANSFER: [
    "ACAT submitted to Apex",
    "Transfer accepted by contra",
    "Positions settling",
    "Cost basis received",
  ],
  FUNDED: [
    "All positions received",
    "Cost basis verified",
    "Transition template applied",
    "Fee reimbursement filed",
  ],
};

// DECISION checklist visibility (owner 2026-07-20). We never DELETE task rows
// (append-only ADR-3 — the no-DELETE story), so trimming/conditioning the
// DECISION checklist is done at RENDER via visibleTasks(): the hidden titles
// stay in the DB but don't show. This also applies the trim to EXISTING
// transfers instantly (no migration) since their persisted rows are just filtered.

/** DECISION titles removed from the checklist — hidden on every transfer.
 *  Kept as a denylist (not just dropped from DEFAULT_TASKS) so existing
 *  transfers that already seeded these rows stop showing them too. EXPORTED as
 *  the single source of truth: both visibleTasks (detail render) and the board
 *  seam's task-count aggregate (lib/data/transfers.ts) filter on these, so the
 *  card counts match the trimmed detail checklist — no SQL/TS drift. */
export const DECISION_HIDDEN_TASK_TITLES = [
  "Resolve review items",
  "Advisor meeting scheduled",
  "Advisor meeting held",
  "Asset decisions made",
  "Submit ACAT to Apex",
] as const;

/** DECISION titles shown ONLY when funding is a PARTIAL ACAT — the decision
 *  worksheet is only needed to choose what to bring on a partial transfer
 *  (a full ACAT brings everything; nothing to decide). Seeded on every transfer
 *  but hidden until funding_type = ACAT_PARTIAL. Exported (see above). */
export const PARTIAL_ACAT_ONLY_TASK_TITLES = [
  "Send decision worksheet",
  "Asset decisions finalized",
] as const;

const DECISION_HIDDEN_TITLES: ReadonlySet<string> = new Set(
  DECISION_HIDDEN_TASK_TITLES,
);
const PARTIAL_ACAT_ONLY_TITLES: ReadonlySet<string> = new Set(
  PARTIAL_ACAT_ONLY_TASK_TITLES,
);

/**
 * The checklist tasks to SHOW for a transfer, given its stage + funding type.
 * DECISION applies the trim (DECISION_HIDDEN_TITLES) and the partial-ACAT gate
 * (PARTIAL_ACAT_ONLY_TITLES shown only when funding_type = ACAT_PARTIAL); other
 * stages pass through unchanged. Pure + generic over the row shape so the page
 * can filter TransferTaskRow[] once and feed the result to the checklist, the
 * done-count, and the gate stepper consistently. Never mutates the input.
 */
export function visibleTasks<T extends { title: string }>(
  stage: TransferStage,
  tasks: readonly T[],
  fundingType: FundingType | null,
): T[] {
  if (stage !== "DECISION") return [...tasks];
  const isPartialAcat = fundingType === "ACAT_PARTIAL";
  return tasks.filter((t) => {
    if (DECISION_HIDDEN_TITLES.has(t.title)) return false;
    if (PARTIAL_ACAT_ONLY_TITLES.has(t.title) && !isPartialAcat) return false;
    return true;
  });
}

/**
 * The checklist tasks for a transfer SCOPED TO ITS CURRENT STAGE — the selector
 * for the CHECKLIST_STAGE_GATE world (StageChecklistCard + the setStage gate).
 * A transfer accumulates tasks across stages (DECISION tasks + the IN_TRANSFER
 * set seeded on entry, …); `visibleTasks` only hides DECISION titles on DECISION
 * and would otherwise show EVERY accumulated task on later stages (so the gate
 * would wrongly require stale earlier-stage tasks). This scopes to the titles
 * that belong to `stage` (DEFAULT_TASKS[stage] membership), then applies the
 * DECISION partial-ACAT rule. On DECISION it yields the same set as visibleTasks
 * for clean data (DEFAULT_TASKS.DECISION already excludes the trimmed titles);
 * on IN_TRANSFER/FUNDED it returns only that stage's own tasks. Custom ad-hoc
 * tasks (not in DEFAULT_TASKS) are intentionally NOT part of the stage gate.
 */
export function stageChecklistTasks<T extends { title: string }>(
  stage: TransferStage,
  tasks: readonly T[],
  fundingType: FundingType | null,
): T[] {
  const allowed = new Set<string>(DEFAULT_TASKS[stage]);
  const isPartialAcat = fundingType === "ACAT_PARTIAL";
  return tasks.filter((t) => {
    if (!allowed.has(t.title)) return false;
    if (
      stage === "DECISION" &&
      PARTIAL_ACAT_ONLY_TITLES.has(t.title) &&
      !isPartialAcat
    )
      return false;
    return true;
  });
}

/**
 * Build the missing DEFAULT_TASKS rows when a transfer enters `stage`.
 *
 * Transfers deliberately retain prior-stage tasks, so every writer that can
 * move `transfer.stage` must append only the destination titles that are not
 * already present. Keeping the calculation here gives the manual stage
 * action, edit form and deal reconciler one idempotent definition. The caller
 * supplies `transfer_id` because Prisma's nested-create and createMany shapes
 * differ; this helper targets the latter.
 */
export function missingStageChecklistRows<
  T extends { title: string; sort_order: number },
>(
  transferId: string,
  stage: TransferStage,
  tasks: readonly T[],
): { transfer_id: string; title: string; sort_order: number }[] {
  const have = new Set(tasks.map((task) => task.title));
  const base = tasks.reduce(
    (max, task) => Math.max(max, task.sort_order),
    -1,
  ) + 1;

  return DEFAULT_TASKS[stage]
    .filter((title) => !have.has(title))
    .map((title, index) => ({
      transfer_id: transferId,
      title,
      sort_order: base + index,
    }));
}

// deal-card mirror S2 (owner "#3"). The two DECISION checklist titles below
// LIVE-MIRROR a Deal flag (transfer.deal_id → app.deal), with a sticky, one-way
// ops override (deal → card auto; a card toggle writes transfer_task.override_done
// and NEVER the deal). Exact-title match (like visibleTasks). These are the ONE
// source of truth for WHICH titles sync — the board seam SQL interpolates the
// same two constants (lib/data/transfers.ts).
export const STATEMENTS_TITLE = "Collect statements";
export const ASSET_MAPPER_TITLE = "Run asset mapper";

/** Synced title → the app.deal boolean it mirrors. */
export const SYNCED_TASK_DEAL_FLAG: Readonly<
  Record<string, "statements" | "asset_mapped">
> = {
  [STATEMENTS_TITLE]: "statements",
  [ASSET_MAPPER_TITLE]: "asset_mapped",
};

/** The two deal flags the synced tasks mirror (null when the transfer has no
 *  linked deal — then a synced task falls back to its own `done`). */
export type DealMirrorFlags = {
  statements: boolean;
  asset_mapped: boolean;
} | null;

/**
 * Resolve the DISPLAY done-state of a checklist task.
 *   • A SYNCED title: `override_done ?? dealFlag ?? done` — ops override wins;
 *     else the mirrored deal flag; else (no linked deal) the task's own `done`.
 *   • Any other title: `done` unchanged.
 * Pure. Used by the detail page, the board count (SQL mirrors this), and the
 * setStage advance-gate — so every surface agrees.
 */
export function resolveTaskDone(
  task: { title: string; done: boolean; override_done: boolean | null },
  dealFlags: DealMirrorFlags,
): boolean {
  const flag = SYNCED_TASK_DEAL_FLAG[task.title];
  if (!flag) return task.done;
  if (task.override_done !== null) return task.override_done;
  return dealFlags ? dealFlags[flag] : task.done;
}

/**
 * Resolve the DISPLAY value (amount) of a transfer. When the transfer is linked
 * to a deal, the deal OWNS the amount (owner decision 2026-07-21, matching
 * transfer-sync's DEAL_OWNED_FIELDS `value ⟵ deal.amount`) — so we show the LIVE
 * `deal.amount` and a deal-amount edit flows straight to the card without waiting
 * on the (flag-gated, batch) transfer-sync cron. No linked deal — or the deal is
 * RLS-hidden / not found, so `dealAmount` is null — falls back to the transfer's
 * own stored `value`. Unlike the statements/asset-mapping task mirror this has NO
 * sticky override: the deal always wins while linked.
 *
 * Pure. The board list + ops-stats SQL mirror this as `COALESCE(d.amount, t.value)`
 * (lib/data/transfers.ts) — keep the two in sync. (deal.amount is NOT NULL in the
 * schema, so a joined deal always yields its amount; `??` handles the no-deal /
 * hidden-deal null the LEFT JOIN produces.)
 */
export function resolveTransferValue(
  value: number,
  dealAmount: number | null | undefined,
): number {
  return dealAmount ?? value;
}

// The full app.transfer row as the T2 seam returns it (TDD §3 contract).
//
// DECIMAL TRAP (carried, see lib/data/deal-types.ts): `value` (and the
// decision row's `value`/`cost_basis`) are Postgres `numeric` columns — Prisma
// hands back Decimal objects at runtime, which do NOT serialize across the
// Server → Client Component boundary. The seam MUST coerce them with Number()
// before a row leaves lib/data/transfers.ts; these fields are typed `number`
// to encode that contract.
export type TransferRow = {
  id: string;
  source: TransferSource;
  client_first_name: string;
  client_last_name: string;
  client_sf_id: string | null; // nudge-composition + Phase D join key (ADR-6)
  household_name: string | null;
  household_sf_id: string | null; // deal-rollup key today (ADR-6)
  value: number; // Number() at the seam — never a raw Decimal
  stage: TransferStage;
  stage_entered_at: Date; // reset on transition; days-in-stage derived (ADR-2)
  owner_kind: TransferOwner;
  owner_name: string | null;
  next_step: string | null;
  next_step_owner: string | null;
  pending_nudge: string | null; // label only; action composes Smart Nudges (ADR-8)
  acat_transfer_id: string | null; // Transfer Tracker link (ticket); null = no ACAT yet
  // ticket Slice 2 — deal-sourced lifecycle columns. All bool/text/enum, so
  // NO Decimal-coercion trap at the seams (unlike `value`).
  funding_type: FundingType | null; // funding rail; null = not yet chosen
  /** Completed-transfer factual correction; workflow routing stays on funding_type. */
  recorded_funding_type?: FundingType | null;
  /** Optimistic revision for explicit method changes/corrections. */
  funding_method_revision?: number;
  /** An in-flight switch to DRS still needs its earlier prerequisites reviewed. */
  drs_method_change_pending?: boolean;
  /** A changed operational route still needs its initiation/workflow review. */
  funding_route_change_pending?: boolean;
  accounts_opened_at_apex: boolean; // NOT NULL DEFAULT false in the DB
  funding_plan_complete: boolean;
  funding_plan_version: number;
  funding_plan_approved_at: Date | null;
  funding_plan_approved_by: string | null;
  funding_initiated: boolean;
  cash_in_flight: boolean;
  deal_id: string | null; // S4 sync idempotent key (partial-unique when set)
  deal_sf_id: string | null; // display / rollup linkage
  transferring_firm: string | null; // seeded from the deal (S4)
  archived_at: Date | null; // soft-archive (deal D7 pattern); null = active
  archived_by: string | null;
  archived_reason: string | null;
  sync_flag: string | null; // §1.5b uncommitted_review marker
  acat_record_id: string | null; // tracker record PK (owner-approved; §S3/S5)
  // Asset-map link (rework S3) — the ONE asset-mapping account funding this
  // transfer, on the durable (folder, custodian, account_number) key. All-null =
  // unlinked. No Decimal trap (all text).
  asset_map_folder_id: string | null;
  asset_map_custodian: string | null;
  asset_map_account_number: string | null;
  asset_map_account_type: string | null; // S5 — registration type, part of the key
  /** Intake and request fields; read by the transfer detail only. */
  client_requested_on?: Date | null;
  client_request_source?: string | null;
  source_account_type?: string | null;
  source_account_last4?: string | null;
  source_account_title?: string | null;
  receiving_account_type?: string | null;
  receiving_account_title?: string | null;
  /** Custodian-library profile of the delivering firm; null until chosen. */
  delivering_custodian_id?: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
};

export type TransferTaskRow = {
  id: string;
  transfer_id: string;
  title: string;
  sort_order: number;
  done: boolean;
  // deal-card mirror S2: ops override for the two SYNCED titles (see
  // resolveTaskDone). NULL = follow the deal flag (live mirror); true/false =
  // ops toggled the card, and that sticks (one-way — never writes the deal).
  // For non-synced titles this is unused (always null; `done` is authoritative).
  override_done: boolean | null;
  completed_at: Date | null;
  completed_by: string | null;
  created_at: Date;
  updated_at: Date;
};

export type TransferDecisionRow = {
  id: string;
  transfer_id: string;
  symbol: string;
  description: string;
  value: number; // Number() at the seam
  cost_basis: number | null; // Number() at the seam; null = basis needed
  decision: TransferDecisionChoice;
  decided_by: string | null;
  decided_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type TransferAccountRow = {
  id: string;
  transfer_id: string;
  label: string;
  status: TransferAccountStatus;
  opened_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

// The write-facing shape shared by the T3 form actions and the seed (validated
// by `validateTransferInput` — one contract, so the seed can't smuggle in rows
// the form would reject). `value` is a number — callers coerce raw form
// strings with Number() before validating.
export type TransferInput = {
  source: TransferSource;
  client_first_name: string;
  client_last_name: string;
  client_sf_id?: string | null;
  household_name?: string | null;
  household_sf_id?: string | null;
  value: number;
  stage: TransferStage;
  owner_kind: TransferOwner;
  owner_name?: string | null;
  next_step?: string | null;
  next_step_owner?: string | null;
  pending_nudge?: string | null;
  acat_transfer_id?: string | null; // Transfer Tracker link (ticket)
  // ticket Slice 2 — all optional (the create/edit form does not own these;
  // they are written by the Decision checklist card actions and the S4 sync).
  // `validateTransferInput` checks funding_type membership when non-null.
  funding_type?: FundingType | null;
  accounts_opened_at_apex?: boolean;
  funding_plan_complete?: boolean;
  funding_initiated?: boolean;
  cash_in_flight?: boolean;
  deal_id?: string | null;
  deal_sf_id?: string | null;
  transferring_firm?: string | null;
  archived_at?: Date | null;
  archived_by?: string | null;
  archived_reason?: string | null;
  sync_flag?: string | null;
  acat_record_id?: string | null;
  // Asset-map link (rework S3) — written by the link/unlink actions, not the
  // create/edit form. Opaque ids; validateTransferInput does not constrain them.
  asset_map_folder_id?: string | null;
  asset_map_custodian?: string | null;
  asset_map_account_number?: string | null;
  asset_map_account_type?: string | null; // S5
};

/** Card funding one-line meta (ticket): "<account type> • <contra>", omitting whichever
 *  part is absent; null when neither exists (e.g. cash funding). Joined with " • " so it
 *  reads inline on the value line (ticket collapsed the 2nd card line). Structurally typed →
 *  Prisma-free, so the client bundle never pulls the seam. */
export function fundingSummary(row: {
  asset_map_account_type: string | null;
  transferring_firm: string | null;
}): string | null {
  const parts = [row.asset_map_account_type, row.transferring_firm]
    .map((p) => p?.trim())
    .filter((p): p is string => !!p);
  return parts.length ? parts.join(" • ") : null;
}

// ── Board focus filter + grouped search (ticket) ──────────────────────────
// Pure, structurally typed helpers (Prisma-free) mirroring the server-side ?owner
// filter: a client/household focus narrows the board, and the search dropdown groups
// its matches into Households + Individuals.

export type TransferFocus = { household?: string | null; q?: string | null };
/** Server board focus filter (ticket), mirroring the ?owner filter. household matches
 *  the row's sf_id OR name (exact); q is a case-insensitive substring over client name +
 *  household name. Empty focus → true (no narrowing). */
export function matchesFocus(
  row: {
    client_first_name: string;
    client_last_name: string;
    household_name: string | null;
    household_sf_id: string | null;
  },
  focus: TransferFocus,
): boolean {
  if (focus.household)
    return (
      row.household_sf_id === focus.household ||
      row.household_name === focus.household
    );
  const q = focus.q?.trim().toLowerCase();
  if (!q) return true;
  return (
    `${row.client_first_name} ${row.client_last_name}`
      .toLowerCase()
      .includes(q) || (row.household_name ?? "").toLowerCase().includes(q)
  );
}

// Enriched search row — the single source of truth for the shape. `ClientSearch` imports
// this and aliases it locally (`type ClientSearchRow = SearchRow`) so there is ONE shape,
// not two.
export type SearchRow = {
  id: string;
  name: string; // "First Last"
  household: string | null; // household_name
  householdKey: string | null; // household_sf_id ?? household_name (dedupe/link key)
  stage: TransferStage;
  value: number;
  contra: string | null; // transferring_firm
};
export type SearchGroups = {
  households: { key: string; name: string; count: number; total: number }[];
  individuals: {
    id: string;
    name: string;
    stage: TransferStage;
    value: number;
    contra: string | null;
  }[];
};
/** Dropdown grouping (ticket): from the rows whose client name OR household name contains
 *  `query` (case-insensitive), (a) dedupe households by `householdKey` (skip rows with no
 *  household), accumulating count + total value; (b) list every matching row as an
 *  individual. Empty/blank query → `{ households: [], individuals: [] }`. */
export function buildSearchGroups(
  rows: SearchRow[],
  query: string,
): SearchGroups {
  const q = query.trim().toLowerCase();
  if (!q) return { households: [], individuals: [] };
  const matched = rows.filter(
    (r) =>
      r.name.toLowerCase().includes(q) ||
      (r.household ?? "").toLowerCase().includes(q),
  );
  const hMap = new Map<
    string,
    { key: string; name: string; count: number; total: number }
  >();
  for (const r of matched) {
    if (!r.householdKey || !r.household) continue;
    const h = hMap.get(r.householdKey) ?? {
      key: r.householdKey,
      name: r.household,
      count: 0,
      total: 0,
    };
    h.count += 1;
    h.total += r.value;
    hMap.set(r.householdKey, h);
  }
  return {
    households: [...hMap.values()],
    individuals: matched.map((r) => ({
      id: r.id,
      name: r.name,
      stage: r.stage,
      value: r.value,
      contra: r.contra,
    })),
  };
}

export type SortDir = "asc" | "desc";

/** Client-name comparator for the per-lane board sort (ticket): last name, then first. */
export function compareByClientName(
  a: { client_last_name: string; client_first_name: string },
  b: { client_last_name: string; client_first_name: string },
): number {
  return (
    a.client_last_name.localeCompare(b.client_last_name) ||
    a.client_first_name.localeCompare(b.client_first_name)
  );
}
