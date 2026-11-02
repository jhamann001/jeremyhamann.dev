// New Request form: standing exclusions. Field state on the draft, the text
// written from standing lists, Manage action availability and the Manage
// dialog's staging rules. Pure; no React, no service calls.

import type { NewRequestContext, NewRequestDraft } from "./new-request";

export const EXCLUSIONS_COPY = {
  advisorExclusions: "Advisor Specific Exclusions",
  advisorPlaceholder: "e.g., TSLA (Concentration risk)",
  clientExclusions: "Client Requested Exclusions",
  clientPlaceholder: "e.g., AAPL (Employer stock)",
  manageExclusions: "Manage exclusions",
  manageTitleOne: "Add or remove standing exclusions for this client without submitting a trade request",
  manageTitleHousehold: "Add or remove standing exclusions for any client in this household — switch tabs inside the modal",
  manageTitleEditClone: "Standing list is disabled in edit / clone mode",
  manageTitleNoClient: "Select a client first",
  reviewBeforeSubmit: "Review Before Submit",
  accountPanelTitle: "Account-Level Standing Exclusions",
  accountPanelLead: "Account-specific standing restrictions for selected accounts. These can differ from client-level exclusions.",
  manageAccountRestrictions: "Manage Account Restrictions",
  accountLoading: "Loading account exclusions...",
  accountLoadFailed: "Unable to load account-level exclusions.",
  accountEmpty: "No account-specific exclusions on selected accounts.",
  ticker: "Ticker",
  lock: "Lock",
  reason: "Reason",
  noReason: "No reason provided",
  dialogClient: "Manage Exclusions",
  dialogAccount: "Manage Account Restrictions",
  closeDialog: "Close dialog",
  selectClient: "Select client",
  selectAccount: "Select account",
  loading: "Loading…",
  noStanding: "No standing exclusions.",
  markedForRemoval: "Marked for removal — click Apply to commit, or click the icon again to keep",
  keepBothSides: "At least one of DNB or DNS must stay checked",
  pickSide: "Pick at least one of DNB or DNS to enable Apply.",
  addRow: "Add row",
  close: "Close",
  applyChanges: "Apply changes",
  applyFailed: "Failed to apply changes",
  loadFailed: "Failed to load exclusions",
  prefillFailed: "Couldn't load standing exclusions — review the fields.",
  refreshFailed: "Couldn't refresh exclusions — review the fields.",
  accountLoadFailedDialog: "Failed to load account exclusions",
  importedReason: "Imported from Meridian restrictions file",
} as const;

export type ExclusionKind = "advisor" | "client";
export const EXCLUSION_KINDS: readonly ExclusionKind[] = ["advisor", "client"];
export const KIND_LABELS: Record<ExclusionKind, string> = {
  advisor: EXCLUSIONS_COPY.advisorExclusions,
  client: EXCLUSIONS_COPY.clientExclusions,
};
export const KIND_TICKER_PLACEHOLDERS: Record<ExclusionKind, string> = { advisor: "TSLA", client: "AAPL" };
export const KIND_REASON_PLACEHOLDERS: Record<ExclusionKind, string> = { advisor: "Concentration risk", client: "Employer stock" };
export const MAX_TICKER_LENGTH = 20;
export const MAX_REASON_LENGTH = 500;
export const MAX_BATCH_ITEMS = 100;

/** A saved standing exclusion (client- or account-level), as the service returns it. */
export type StandingExclusion = {
  id: string; ticker: string; kind: ExclusionKind; reason: string;
  noBuy: boolean; noSell: boolean; createdByName: string; createdAt: string;
};

export type ExclusionsByEntity = Record<string, StandingExclusion[]>;

/** Outcome of a standing-list read or save action. */
export type ExclusionsResult<T> = { ok: true; data: T } | { ok: false; message: string };

export type ExclusionBatch = {
  add: Array<{ ticker: string; kind: ExclusionKind; reason: string; noBuy: boolean; noSell: boolean }>;
  remove: string[];
  edit: Array<{ id: string; noBuy: boolean; noSell: boolean }>;
};
export type ExclusionBatchSaved = { exclusions: StandingExclusion[]; added: number; removed: number; edited: number };

/**
 * Standing-exclusion state carried on NewRequestDraft.
 *
 * - `advisorExclusions`, `clientExclusions`: the two text fields, sent as
 *   typed for Initial Funding, Rebalance and Cash Deposit and as "" for the
 *   other types (the fields are shown only for those three). On a new request they are filled from the selected clients'
 *   standing lists; in edit and clone (TRW-15) they hold the source request's
 *   recorded exclusions and are never filled from standing lists (AC-91),
 *   because the fill and both Manage actions require `formMode === "new"`.
 * - `exclusionsFilledText`: the text last written into each field from the
 *   standing lists. A field whose text differs from it has been typed over
 *   and is kept on the next fill (AC-90). A successful Manage exclusions save
 *   replaces both fields regardless (AC-119).
 * - `exclusionsNotice`: shown under the fields when the standing-list read
 *   behind a fill or a post-save replace failed, so the fields may be stale.
 *   Never submitted. Cleared by the next successful write or by typing in
 *   either field. (The standalone form stays silent on these failures.)
 *
 * Write both fields from standing lists only through withStandingExclusions().
 */
export type ExclusionInputs = {
  advisorExclusions: string;
  clientExclusions: string;
  exclusionsFilledText: { advisor: string; client: string };
  exclusionsNotice: string | null;
};

export function initialExclusionInputs(): ExclusionInputs {
  return { advisorExclusions: "", clientExclusions: "", exclusionsFilledText: { advisor: "", client: "" }, exclusionsNotice: null };
}

export function formatExclusionSide(entry: Pick<StandingExclusion, "noBuy" | "noSell">): string {
  if (entry.noBuy && entry.noSell) return "DNB+DNS";
  if (entry.noBuy) return "DNB";
  return "DNS";
}

/** Imported reasons carrying file paths or parser metadata show one source tag instead. */
export function formatRestrictionReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  const importedFile = /^imported\b/.test(lower) && (lower.includes(".csv") || lower.includes("/") || lower.includes("\\"));
  if (lower.includes("meridian") || lower.includes("restrictions.csv") || importedFile) return EXCLUSIONS_COPY.importedReason;
  return trimmed;
}

/** The text written into one field: entries of `kind` in client order, attributed to the client when several are selected. */
export function formatStandingExclusions(
  byClient: ExclusionsByEntity, clients: ReadonlyArray<{ id: string; name: string }>, kind: ExclusionKind,
): string {
  const attribute = clients.length > 1;
  const parts: string[] = [];
  for (const client of clients) {
    for (const entry of byClient[client.id] ?? []) {
      if (entry.kind !== kind) continue;
      const side = formatExclusionSide(entry);
      if (attribute) parts.push(entry.reason ? `${entry.ticker} (${side} - ${entry.reason} – ${client.name})` : `${entry.ticker} (${side} – ${client.name})`);
      else parts.push(entry.reason ? `${entry.ticker} (${side} - ${entry.reason})` : `${entry.ticker} (${side})`);
    }
  }
  return parts.join("; ");
}

export function standingExclusionsText(byClient: ExclusionsByEntity, clients: ReadonlyArray<{ id: string; name: string }>) {
  return { advisor: formatStandingExclusions(byClient, clients, "advisor"), client: formatStandingExclusions(byClient, clients, "client") };
}

/**
 * "fill" (client change, AC-90) writes a field only when it is empty or still
 * holds the text last written; "replace" (after a Manage exclusions save,
 * AC-119) always writes. Both record the written text.
 */
export function withStandingExclusions(
  draft: NewRequestDraft, text: { advisor: string; client: string }, mode: "fill" | "replace",
): NewRequestDraft {
  const previous = draft.exclusionsFilledText;
  const write = (current: string, last: string, next: string) =>
    mode === "replace" || current === "" || current === last ? next : current;
  return {
    ...draft,
    advisorExclusions: write(draft.advisorExclusions, previous.advisor, text.advisor),
    clientExclusions: write(draft.clientExclusions, previous.client, text.client),
    exclusionsFilledText: { advisor: text.advisor, client: text.client },
    exclusionsNotice: null,
  };
}

export function withExclusionsNotice(draft: NewRequestDraft, notice: string | null): NewRequestDraft {
  return draft.exclusionsNotice === notice ? draft : { ...draft, exclusionsNotice: notice };
}

export type ExclusionClient = { id: string; name: string };

/** Selected listed clients in selection order; empty in manual entry. */
export function exclusionClientTargets(context: NewRequestContext): ExclusionClient[] {
  if (context.draft.manualMode) return [];
  return context.draft.clientIds
    .map((id) => context.clientsById.get(id))
    .filter((client): client is NonNullable<typeof client> => !!client)
    .map((client) => ({ id: client.id, name: client.name }));
}

/** The standing-list fill's input, or null when no fill applies (edit/clone, manual entry, nothing selected). */
export function standingExclusionsFillKey(context: NewRequestContext): string | null {
  if (context.draft.formMode !== "new") return null;
  const clients = exclusionClientTargets(context);
  return clients.length > 0 ? JSON.stringify(clients) : null;
}

/** AC-120 states (accepted in TRW-15): disabled in edit or clone, or with no listed client. */
export function manageExclusionsEnabled(context: NewRequestContext): boolean {
  return context.draft.formMode === "new" && exclusionClientTargets(context).length > 0;
}

export function manageExclusionsTitle(context: NewRequestContext): string {
  if (manageExclusionsEnabled(context)) {
    return context.draft.clientIds.length > 1 ? EXCLUSIONS_COPY.manageTitleHousehold : EXCLUSIONS_COPY.manageTitleOne;
  }
  return context.draft.formMode !== "new" ? EXCLUSIONS_COPY.manageTitleEditClone : EXCLUSIONS_COPY.manageTitleNoClient;
}

export type AccountExclusionGroup = { accountId: string; accountNumber: string; clientName: string };

/** Selected listed accounts with their ids, grouped in client order. */
export function accountExclusionGroups(context: NewRequestContext): AccountExclusionGroup[] {
  if (context.draft.manualMode) return [];
  const chosen = new Set(context.draft.selectedAccounts);
  return exclusionClientTargets(context).flatMap(({ id, name }) =>
    (context.clientsById.get(id)?.accounts ?? [])
      .filter((account) => chosen.has(account.accountNumber))
      .map((account) => ({ accountId: account.id, accountNumber: account.accountNumber, clientName: name })));
}

/** AC-143 states (accepted in TRW-15): hidden in edit or clone, manual entry, or with no account selected. */
export function manageAccountRestrictionsShown(context: NewRequestContext): boolean {
  return context.draft.formMode === "new" && accountExclusionGroups(context).length > 0;
}

// ─── Manage dialog staging ─────────────────────────────────────────────────

export type StagedAdd = { tempId: string; ticker: string; kind: ExclusionKind; reason: string; noBuy: boolean; noSell: boolean };
export type PendingSides = { noBuy: boolean; noSell: boolean };
/** One tab's unsaved changes; kept per entity so they survive switching tabs. */
export type PendingChanges = { adds: StagedAdd[]; removeIds: string[]; edits: Record<string, PendingSides> };

export const NO_PENDING: PendingChanges = { adds: [], removeIds: [], edits: {} };

export function pendingCount(pending: PendingChanges | undefined): number {
  return pending ? pending.adds.length + pending.removeIds.length + Object.keys(pending.edits).length : 0;
}

export function stagedAdd(tempId: string, kind: ExclusionKind): StagedAdd {
  return { tempId, ticker: "", kind, reason: "", noBuy: false, noSell: false };
}

export function withStagedField(pending: PendingChanges, tempId: string, field: "ticker" | "reason", value: string): PendingChanges {
  const next = field === "ticker" ? value.toUpperCase().slice(0, MAX_TICKER_LENGTH) : value.slice(0, MAX_REASON_LENGTH);
  return { ...pending, adds: pending.adds.map((add) => (add.tempId === tempId ? { ...add, [field]: next } : add)) };
}

export function withStagedSide(pending: PendingChanges, tempId: string, side: keyof PendingSides): PendingChanges {
  return { ...pending, adds: pending.adds.map((add) => (add.tempId === tempId ? { ...add, [side]: !add[side] } : add)) };
}

function withoutEdit(edits: Record<string, PendingSides>, id: string): Record<string, PendingSides> {
  return Object.fromEntries(Object.entries(edits).filter(([key]) => key !== id));
}

/** Marking a row for removal (or unmarking it) drops any side change on it. */
export function withRemovalToggled(pending: PendingChanges, id: string): PendingChanges {
  const removeIds = pending.removeIds.includes(id) ? pending.removeIds.filter((entry) => entry !== id) : [...pending.removeIds, id];
  return { ...pending, removeIds, edits: withoutEdit(pending.edits, id) };
}

/** Effective sides of a saved row: the pending change, unless it is marked for removal. */
export function effectiveSides(pending: PendingChanges, row: StandingExclusion): PendingSides {
  const edit = pending.edits[row.id];
  return edit && !pending.removeIds.includes(row.id) ? edit : { noBuy: row.noBuy, noSell: row.noSell };
}

/** True when unticking `side` would leave neither side ticked. */
export function sideLocked(pending: PendingChanges, row: StandingExclusion, side: keyof PendingSides): boolean {
  const sides = effectiveSides(pending, row);
  return sides[side] && !sides[side === "noBuy" ? "noSell" : "noBuy"];
}

/** A change back to the saved sides is not pending; a change that clears both sides is refused. */
export function withSavedSideToggled(pending: PendingChanges, row: StandingExclusion, side: keyof PendingSides): PendingChanges {
  if (pending.removeIds.includes(row.id) || sideLocked(pending, row, side)) return pending;
  const current = pending.edits[row.id] ?? { noBuy: row.noBuy, noSell: row.noSell };
  const next = { ...current, [side]: !current[side] };
  const edits = withoutEdit(pending.edits, row.id);
  return { ...pending, edits: next.noBuy === row.noBuy && next.noSell === row.noSell ? edits : { ...edits, [row.id]: next } };
}

export function addsValid(pending: PendingChanges): boolean {
  return pending.adds.every((add) => add.ticker.trim().length > 0 && (add.noBuy || add.noSell));
}

export function applyEnabled(pending: PendingChanges, applying: boolean): boolean {
  return !applying && pendingCount(pending) > 0 && addsValid(pending);
}

export function batchFromPending(pending: PendingChanges): ExclusionBatch {
  return {
    add: pending.adds.map(({ ticker, kind, reason, noBuy, noSell }) => ({ ticker: ticker.trim().toUpperCase(), kind, reason: reason.trim(), noBuy, noSell })),
    remove: [...pending.removeIds],
    edit: Object.entries(pending.edits).map(([id, sides]) => ({ id, ...sides })),
  };
}

export function applyLabel(pending: PendingChanges): string {
  const n = pendingCount(pending);
  return n > 0 ? `Apply ${n} change${n === 1 ? "" : "s"}` : EXCLUSIONS_COPY.applyChanges;
}

export function savedSummary({ added, removed, edited }: Pick<ExclusionBatchSaved, "added" | "removed" | "edited">): string {
  return ["Saved.", added > 0 ? `Added ${added}.` : "", removed > 0 ? `Removed ${removed}.` : "", edited > 0 ? `Updated ${edited}.` : ""]
    .filter(Boolean).join(" ");
}

export function sideChangeText(row: StandingExclusion, sides: PendingSides): string {
  return `Side change pending: ${formatExclusionSide(row)} → ${formatExclusionSide(sides)}`;
}

export function addedByText(row: StandingExclusion): string {
  const date = new Date(row.createdAt);
  return `added by ${row.createdByName}, ${Number.isNaN(date.getTime()) ? row.createdAt : date.toLocaleDateString()}`;
}

/** The close confirmation, or null when nothing is unsaved. */
export function discardMessage(pendingByEntity: Record<string, PendingChanges>, labels: ReadonlyMap<string, string>): string | null {
  const parts = Object.entries(pendingByEntity)
    .filter(([, pending]) => pendingCount(pending) > 0)
    .map(([id, pending]) => {
      const n = pendingCount(pending);
      return `${n} unsaved change${n === 1 ? "" : "s"} for ${labels.get(id) ?? id}`;
    });
  return parts.length > 0 ? `Discard ${parts.join(" and ")}?` : null;
}
