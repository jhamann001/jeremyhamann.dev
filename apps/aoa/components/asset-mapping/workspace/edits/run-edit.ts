import type { AssetMapEditResult } from "@/app/(authenticated)/asset-mapping/actions";
import type { AssetMapPositionStatus, AssetMapTransferringValue } from "@/lib/data/asset-map";
import { FAILURE_MS, UNDO_MS, editKey, type EditAction, type EditConfirm, type EditFailureReason, type EditKind, type EditState, type SavedAccountType } from "./edit-model";

export type EditActions = {
  saveStatus: (positionId: string, status: string) => Promise<AssetMapEditResult<{ status: AssetMapPositionStatus }>>;
  saveTransferring: (positionId: string, value: AssetMapTransferringValue) => Promise<AssetMapEditResult<{ value: AssetMapTransferringValue }>>;
  saveAccountType: (accountId: string, accountType: string, accountTypeOther: string | null) => Promise<AssetMapEditResult<SavedAccountType>>;
  removePosition: (positionId: string) => Promise<AssetMapEditResult<{ id: string }>>;
  restorePosition: (positionId: string) => Promise<AssetMapEditResult<{ id: string }>>;
  removeAccount: (accountId: string) => Promise<AssetMapEditResult<{ id: string }>>;
  restoreAccount: (accountId: string) => Promise<AssetMapEditResult<{ id: string }>>;
};

export type EditDeps = {
  actions: EditActions;
  dispatch: (a: EditAction) => void;
  nextSeq: () => number;
  schedule: (fn: () => void, ms: number) => void;
  onAccountTypeSaved?: () => void;
};

export type EditIntent =
  | { kind: "positionStatus"; positionId: string; status: AssetMapPositionStatus }
  | { kind: "positionTransferring"; positionId: string; value: AssetMapTransferringValue }
  | { kind: "accountType"; accountId: string; accountType: string; accountTypeOther: string | null }
  | { kind: "removePosition"; positionId: string; label: string }
  | { kind: "removeAccount"; accountId: string; label: string };

async function call<T>(fn: () => Promise<AssetMapEditResult<T>>): Promise<AssetMapEditResult<T>> {
  try {
    return await fn();
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

function fail(deps: EditDeps, key: string, kind: EditKind, reason: EditFailureReason) {
  const seq = deps.nextSeq();
  deps.dispatch({ type: "failed", key, kind, reason, seq });
  deps.schedule(() => deps.dispatch({ type: "failureExpired", seq }), FAILURE_MS);
}

function offerUndo(deps: EditDeps, seq: number) {
  deps.schedule(() => deps.dispatch({ type: "undoExpired", seq }), UNDO_MS);
}

export async function performEdit(intent: EditIntent, deps: EditDeps): Promise<void> {
  const id = "positionId" in intent ? intent.positionId : intent.accountId;
  const key = editKey(intent.kind, id);
  deps.dispatch({ type: "pending", key });
  switch (intent.kind) {
    case "positionStatus": {
      const r = await call(() => deps.actions.saveStatus(intent.positionId, intent.status));
      return r.ok ? deps.dispatch({ type: "statusSaved", key, positionId: intent.positionId, status: r.data.status }) : fail(deps, key, intent.kind, r.reason);
    }
    case "positionTransferring": {
      const r = await call(() => deps.actions.saveTransferring(intent.positionId, intent.value));
      return r.ok ? deps.dispatch({ type: "transferringSaved", key, positionId: intent.positionId, value: r.data.value }) : fail(deps, key, intent.kind, r.reason);
    }
    case "accountType": {
      const r = await call(() => deps.actions.saveAccountType(intent.accountId, intent.accountType, intent.accountTypeOther));
      if (!r.ok) return fail(deps, key, intent.kind, r.reason);
      deps.dispatch({ type: "accountTypeSaved", key, accountId: intent.accountId, saved: r.data });
      return deps.onAccountTypeSaved?.();
    }
    case "removePosition": {
      const r = await call(() => deps.actions.removePosition(intent.positionId));
      if (!r.ok) return fail(deps, key, intent.kind, r.reason);
      const seq = deps.nextSeq();
      deps.dispatch({ type: "positionRemoved", key, positionId: intent.positionId, label: intent.label, seq });
      return offerUndo(deps, seq);
    }
    case "removeAccount": {
      const r = await call(() => deps.actions.removeAccount(intent.accountId));
      if (!r.ok) return fail(deps, key, intent.kind, r.reason);
      const seq = deps.nextSeq();
      deps.dispatch({ type: "accountRemoved", key, accountId: intent.accountId, label: intent.label, seq });
      return offerUndo(deps, seq);
    }
  }
}

export async function performUndo(undo: NonNullable<EditState["undo"]>, deps: EditDeps): Promise<void> {
  deps.dispatch({ type: "undoExpired", seq: undo.seq });
  const kind = undo.kind === "position" ? "restorePosition" : "restoreAccount";
  const key = editKey(kind, undo.id);
  deps.dispatch({ type: "pending", key });
  const r = await call(() => (undo.kind === "position" ? deps.actions.restorePosition(undo.id) : deps.actions.restoreAccount(undo.id)));
  if (!r.ok) return fail(deps, key, kind, r.reason);
  deps.dispatch(undo.kind === "position" ? { type: "positionRestored", key, positionId: undo.id } : { type: "accountRestored", key, accountId: undo.id });
}

export function performConfirm(confirm: EditConfirm, deps: EditDeps): Promise<void> {
  deps.dispatch({ type: "cancelConfirm" });
  return confirm.kind === "removeAccount"
    ? performEdit({ kind: "removeAccount", accountId: confirm.accountId, label: confirm.label }, deps)
    : performEdit({ kind: "accountType", accountId: confirm.accountId, accountType: confirm.accountType, accountTypeOther: confirm.accountTypeOther }, deps);
}
