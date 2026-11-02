import type {
  AssetMapAccountView,
  AssetMapHouseholdView,
  AssetMapPositionStatus,
  AssetMapPositionView,
  AssetMapTransferringValue,
} from "@/lib/data/asset-map";

export const POSITION_STATUSES = ["ACAT", "LIQUIDATE", "UNSUPPORTED", "REVIEW", "ACH/WIRE"] as const satisfies readonly AssetMapPositionStatus[];

// Same order as the pipeline UI's ACCOUNT_TYPE_OPTIONS; same set as the
// pipeline's CANONICAL_ACCOUNT_TYPES, which validates the save.
export const ACCOUNT_TYPE_OPTIONS = [
  "Individual", "Joint", "Trust", "Custodial",
  "IRA", "Roth IRA", "SEP IRA", "SIMPLE IRA",
  "Inherited IRA", "Inherited Roth IRA",
  "401k", "403b", "457b", "TSP",
  "Profit-Sharing Plan", "Money Purchase Plan", "Defined Benefit Plan",
  "529",
  "Savings", "Checking", "CMA",
  "Annuity",
  "Employee Stock Plan",
  "Other",
] as const;

export const UNDO_MS = 8000;
export const FAILURE_MS = 5000;

export type EditKind =
  | "positionStatus" | "positionTransferring" | "accountType"
  | "removePosition" | "removeAccount" | "restorePosition" | "restoreAccount";
export type EditFailureReason = "forbidden" | "rejected" | "unavailable";

export const EDIT_COPY = {
  statusHeader: "Override Status",
  statusPending: "Updating…",
  transferringHeader: "Transferring?",
  transferringUnset: "Set…",
  transferringYes: "Yes",
  transferringNo: "No",
  transferringClear: "Clear",
  transferringPending: "Saving…",
  accountTypeHeader: "Override Account Type",
  accountTypePending: "Reclassifying…",
  otherOption: "Other…",
  otherPrompt: "Describe the account type",
  otherPlaceholder: "e.g. Donor-Advised Fund",
  otherSave: "Save",
  otherBack: "Back",
  accountTypeConfirmBody:
    "This will re-run the rule engine for every position in this account. Manual position-level overrides will be preserved.",
  changeType: "Change type",
  cancel: "Cancel",
  deletePosition: "Delete",
  deletePositionTitle: "Delete this position",
  deleteAccount: "Delete account",
  deleteAccountTitle: "Delete this account",
  undo: "Undo",
  forbidden: "Operations role required",
  failed: {
    positionStatus: "Failed to update status",
    positionTransferring: "Failed to update transferring",
    accountType: "Failed to update account type",
    removePosition: "Failed to delete position",
    removeAccount: "Failed to delete account",
    restorePosition: "Failed to restore position",
    restoreAccount: "Failed to restore account",
  } satisfies Record<EditKind, string>,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isPipelineId(v: unknown): v is string { return typeof v === "string" && UUID.test(v); }
export function isPositionStatus(v: unknown): v is AssetMapPositionStatus {
  return typeof v === "string" && (POSITION_STATUSES as readonly string[]).includes(v);
}
export function isAccountTypeOption(v: unknown): v is string {
  return typeof v === "string" && (ACCOUNT_TYPE_OPTIONS as readonly string[]).includes(v);
}
export function isTransferringValue(v: unknown): v is AssetMapTransferringValue {
  return v === "YES" || v === "NO" || v === null;
}
export function transferringFromView(v: boolean | null): AssetMapTransferringValue {
  return v === true ? "YES" : v === false ? "NO" : null;
}
export function normalizeOther(accountType: string, other: string | null | undefined): string | null {
  return accountType === "Other" ? (other ?? "").trim() || null : null;
}
export function isAccountTypeChange(currentType: string | null, currentOther: string | null, nextType: string, nextOther: string | null): boolean {
  return nextType !== currentType || (nextType === "Other" && normalizeOther(nextType, nextOther) !== normalizeOther("Other", currentOther));
}
export function accountTypeLabel(type: string | null, other: string | null): string {
  return type === "Other" && other ? `Other · ${other}` : (type || "Unknown");
}
export function accountTypeConfirmTitle(from: string | null, toType: string, toOther: string | null): string {
  const to = toType === "Other" && toOther ? `Other (${toOther})` : toType;
  return `Change account classification from "${from || "Unknown"}" to "${to}"?`;
}
export function deleteAccountConfirm(label: string): string {
  return `Delete "${label}" and all its positions? You can undo this.`;
}
export function undoMessage(kind: "position" | "account", label: string): string {
  return `Deleted ${kind} ${label}`;
}
export function positionLabel(p: AssetMapPositionView): string { return p.symbol || p.description || "position"; }
export function accountLabel(a: AssetMapAccountView): string {
  return [a.custodian, a.accountType].filter(Boolean).join(" ") || "account";
}
export function failureText(kind: EditKind, reason: EditFailureReason): string {
  return reason === "forbidden" ? EDIT_COPY.forbidden : EDIT_COPY.failed[kind];
}
export function editKey(kind: EditKind, id: string): string { return `${kind}:${id}`; }

export type SavedAccountType = {
  accountType: string;
  accountTypeOther: string | null;
  isRollover?: boolean;
  isInherited?: boolean;
  apexRestriction?: string | null;
  overriddenBy?: string | null;
  overriddenAt?: string;
};

export type EditConfirm =
  | { kind: "removeAccount"; accountId: string; label: string }
  | { kind: "accountType"; accountId: string; from: string | null; accountType: string; accountTypeOther: string | null };

export type EditState = {
  status: Record<string, AssetMapPositionStatus>;
  transferring: Record<string, AssetMapTransferringValue>;
  accountType: Record<string, SavedAccountType>;
  removedPositions: string[];
  removedAccounts: string[];
  pending: string[];
  failure: { key: string; text: string; seq: number } | null;
  undo: { kind: "position" | "account"; id: string; label: string; seq: number } | null;
  confirm: EditConfirm | null;
};

export type EditAction =
  | { type: "reset" }
  | { type: "pending"; key: string }
  | { type: "statusSaved"; key: string; positionId: string; status: AssetMapPositionStatus }
  | { type: "transferringSaved"; key: string; positionId: string; value: AssetMapTransferringValue }
  | { type: "accountTypeSaved"; key: string; accountId: string; saved: SavedAccountType }
  | { type: "positionRemoved"; key: string; positionId: string; label: string; seq: number }
  | { type: "accountRemoved"; key: string; accountId: string; label: string; seq: number }
  | { type: "positionRestored"; key: string; positionId: string }
  | { type: "accountRestored"; key: string; accountId: string }
  | { type: "failed"; key: string; kind: EditKind; reason: EditFailureReason; seq: number }
  | { type: "failureExpired"; seq: number }
  | { type: "undoExpired"; seq: number }
  | { type: "askRemoveAccount"; accountId: string; label: string }
  | { type: "askAccountType"; accountId: string; from: string | null; accountType: string; accountTypeOther: string | null }
  | { type: "cancelConfirm" };

export function initialEditState(): EditState {
  return { status: {}, transferring: {}, accountType: {}, removedPositions: [], removedAccounts: [], pending: [], failure: null, undo: null, confirm: null };
}

const without = (list: string[], v: string) => list.filter((x) => x !== v);
const settle = (s: EditState, key: string): EditState => ({
  ...s,
  pending: without(s.pending, key),
  failure: s.failure?.key === key ? null : s.failure,
});

export function editReducer(s: EditState, a: EditAction): EditState {
  switch (a.type) {
    case "reset":
      return initialEditState();
    case "pending":
      return { ...s, pending: s.pending.includes(a.key) ? s.pending : [...s.pending, a.key], failure: s.failure?.key === a.key ? null : s.failure };
    case "statusSaved":
      return { ...settle(s, a.key), status: { ...s.status, [a.positionId]: a.status } };
    case "transferringSaved":
      return { ...settle(s, a.key), transferring: { ...s.transferring, [a.positionId]: a.value } };
    case "accountTypeSaved":
      return { ...settle(s, a.key), accountType: { ...s.accountType, [a.accountId]: a.saved } };
    case "positionRemoved":
      return { ...settle(s, a.key), removedPositions: [...without(s.removedPositions, a.positionId), a.positionId], undo: { kind: "position", id: a.positionId, label: a.label, seq: a.seq } };
    case "accountRemoved":
      return { ...settle(s, a.key), removedAccounts: [...without(s.removedAccounts, a.accountId), a.accountId], undo: { kind: "account", id: a.accountId, label: a.label, seq: a.seq } };
    case "positionRestored":
      return { ...settle(s, a.key), removedPositions: without(s.removedPositions, a.positionId) };
    case "accountRestored":
      return { ...settle(s, a.key), removedAccounts: without(s.removedAccounts, a.accountId) };
    case "failed":
      return { ...s, pending: without(s.pending, a.key), failure: { key: a.key, text: failureText(a.kind, a.reason), seq: a.seq } };
    case "failureExpired":
      return s.failure?.seq === a.seq ? { ...s, failure: null } : s;
    case "undoExpired":
      return s.undo?.seq === a.seq ? { ...s, undo: null } : s;
    case "askRemoveAccount":
      return { ...s, confirm: { kind: "removeAccount", accountId: a.accountId, label: a.label } };
    case "askAccountType":
      return { ...s, confirm: { kind: "accountType", accountId: a.accountId, from: a.from, accountType: a.accountType, accountTypeOther: a.accountTypeOther } };
    case "cancelConfirm":
      return { ...s, confirm: null };
  }
}

/** The household as operators should see it: saved values from save responses
 *  overlaid on the mirror read, deleted rows hidden. */
export function applyEdits(h: AssetMapHouseholdView, s: EditState): AssetMapHouseholdView {
  return {
    ...h,
    accounts: h.accounts
      .filter((a) => !s.removedAccounts.includes(a.id))
      .map((a) => {
        const t = s.accountType[a.id];
        return {
          ...a,
          ...(t ? {
            accountType: t.accountType,
            accountTypeOther: t.accountTypeOther,
            ...(t.isRollover !== undefined ? { isRollover: t.isRollover } : {}),
            ...(t.isInherited !== undefined ? { isInherited: t.isInherited } : {}),
            ...(t.apexRestriction !== undefined ? { apexRestriction: t.apexRestriction } : {}),
            ...(t.overriddenAt !== undefined ? { accountTypeOverride: { by: t.overriddenBy ?? null, at: t.overriddenAt } } : {}),
          } : {}),
          positions: a.positions
            .filter((p) => !s.removedPositions.includes(p.id))
            .map((p) => ({
              ...p,
              ...(s.status[p.id] ? { effectiveStatus: s.status[p.id] } : {}),
              ...(p.id in s.transferring
                ? { transferring: s.transferring[p.id] === "YES" ? true : s.transferring[p.id] === "NO" ? false : null }
                : {}),
            })),
        };
      }),
  };
}
