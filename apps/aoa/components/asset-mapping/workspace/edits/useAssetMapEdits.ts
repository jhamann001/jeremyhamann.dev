"use client";

import { useEffect, useMemo, useReducer, useRef } from "react";
import {
  removeAssetMapAccount, removeAssetMapPosition, restoreAssetMapAccount, restoreAssetMapPosition,
  saveAssetMapAccountType, saveAssetMapPositionStatus, saveAssetMapPositionTransferring,
} from "@/app/(authenticated)/asset-mapping/actions";
import { editReducer, initialEditState, isAccountTypeChange, type EditState } from "./edit-model";
import { performConfirm, performEdit, performUndo, type EditDeps, type EditIntent } from "./run-edit";

export function useAssetMapEdits(householdId: string | null, onAccountTypeSaved?: () => void) {
  const [state, dispatch] = useReducer(editReducer, undefined, initialEditState);
  const saved = useRef(onAccountTypeSaved);
  saved.current = onAccountTypeSaved;
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const seq = useRef(0);
  const deps = useMemo<EditDeps>(() => ({
    actions: {
      saveStatus: saveAssetMapPositionStatus,
      saveTransferring: saveAssetMapPositionTransferring,
      saveAccountType: saveAssetMapAccountType,
      removePosition: removeAssetMapPosition,
      restorePosition: restoreAssetMapPosition,
      removeAccount: removeAssetMapAccount,
      restoreAccount: restoreAssetMapAccount,
    },
    dispatch,
    nextSeq: () => ++seq.current,
    schedule: (fn, ms) => {
      const t = setTimeout(() => { timers.current.delete(t); fn(); }, ms);
      timers.current.add(t);
    },
    onAccountTypeSaved: () => saved.current?.(),
  }), []);

  useEffect(() => { dispatch({ type: "reset" }); }, [householdId]);
  useEffect(() => () => { for (const t of timers.current) clearTimeout(t); }, []);

  return {
    state,
    edit: (intent: EditIntent) => void performEdit(intent, deps),
    undo: (u: NonNullable<EditState["undo"]>) => void performUndo(u, deps),
    askRemoveAccount: (accountId: string, label: string) => dispatch({ type: "askRemoveAccount", accountId, label }),
    askAccountType: (accountId: string, fromType: string | null, fromOther: string | null, accountType: string, accountTypeOther: string | null) => {
      if (isAccountTypeChange(fromType, fromOther, accountType, accountTypeOther)) {
        dispatch({ type: "askAccountType", accountId, from: fromType, accountType, accountTypeOther });
      }
    },
    confirm: () => { if (state.confirm) void performConfirm(state.confirm, deps); },
    cancel: () => dispatch({ type: "cancelConfirm" }),
  };
}
