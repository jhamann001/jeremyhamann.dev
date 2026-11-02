"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readRequestChecklist, writeRequestChecklistItem } from "@/app/(authenticated)/trade-requests/checklist-actions";
import {
  CHECKLIST_ITEMS, CHECKLIST_KEYS, checkedCount, checklistAccess,
  type ChecklistAccess, type ChecklistChange, type ChecklistItemKey, type ChecklistState,
} from "@/lib/trade-requests/checklist-view";
import type { TradeRequest } from "@/lib/trade-requests/request-types";

export type RequestChecklist = {
  checklist: ChecklistState;
  /** The load has settled; a failed load leaves every item unchecked (AC-84). */
  loaded: boolean;
  access: ChecklistAccess;
  checkedCount: number;
  uncheckedCount: number;
  total: number;
  /** Whether this item's controls accept changes now. */
  isEditable: (key: ChecklistItemKey) => boolean;
  toggle: (key: ChecklistItemKey) => void;
  changeText: (key: ChecklistItemKey, value: string) => void;
  commitText: (key: ChecklistItemKey) => void;
};

const FIELD_KEYS = new Set(CHECKLIST_ITEMS.filter((item) => item.field).map((item) => item.key));

/**
 * The open request's checklist. Loaded once per request; every change shows at
 * once and is saved in the background. A failed save keeps the reviewer's
 * state until the request is reopened (AC-85); neither failure shows a message.
 *
 * Every save carries the item's text, so nothing is editable until the load
 * settles, and after a failed load the items with a text field stay read-only:
 * their stored text is unknown and a save would replace it.
 */
export function useRequestChecklist(request: Pick<TradeRequest, "id" | "status">, role: string): RequestChecklist {
  const [checklist, setChecklist] = useState<ChecklistState>({});
  const [load, setLoad] = useState<"pending" | "ok" | "failed">("pending");
  const current = useRef<ChecklistState>({});
  // The text last loaded or sent per item; an unchanged blur is not saved.
  const savedText = useRef<Partial<Record<ChecklistItemKey, string>>>({});
  const access = checklistAccess(role, request.status);
  const id = request.id;

  const apply = useCallback((next: ChecklistState) => {
    current.current = next;
    setChecklist(next);
  }, []);

  useEffect(() => {
    let alive = true;
    apply({});
    savedText.current = {};
    setLoad("pending");
    readRequestChecklist(id)
      .then((result) => {
        if (!alive) return;
        if (!result.ok) {
          setLoad("failed");
          return;
        }
        savedText.current = Object.fromEntries(Object.entries(result.checklist).map(([key, state]) => [key, state?.value ?? ""]));
        apply(result.checklist);
        setLoad("ok");
      })
      .catch(() => {
        if (alive) setLoad("failed");
      });
    return () => {
      alive = false;
    };
  }, [id, apply]);

  const isEditable = useCallback(
    (key: ChecklistItemKey) => access === "edit" && (load === "ok" || (load === "failed" && !FIELD_KEYS.has(key))),
    [access, load],
  );

  const save = useCallback((change: ChecklistChange) => {
    const previous = savedText.current[change.key];
    savedText.current[change.key] = change.value;
    const forget = () => {
      if (savedText.current[change.key] === change.value) savedText.current[change.key] = previous;
    };
    writeRequestChecklistItem(id, change)
      .then((result) => {
        if (!result.ok) forget();
      })
      .catch(forget);
  }, [id]);

  const toggle = useCallback((key: ChecklistItemKey) => {
    if (!isEditable(key)) return;
    const state = current.current[key];
    const checked = !state?.checked;
    const value = state?.value ?? "";
    apply({ ...current.current, [key]: { ...state, checked, value } });
    save({ key, checked, value });
  }, [isEditable, apply, save]);

  const changeText = useCallback((key: ChecklistItemKey, value: string) => {
    if (!isEditable(key)) return;
    const state = current.current[key];
    apply({ ...current.current, [key]: { ...state, checked: state?.checked ?? true, value } });
  }, [isEditable, apply]);

  const commitText = useCallback((key: ChecklistItemKey) => {
    if (!isEditable(key)) return;
    const state = current.current[key];
    const value = state?.value ?? "";
    if (value === (savedText.current[key] ?? "")) return;
    save({ key, checked: state?.checked ?? false, value });
  }, [isEditable, save]);

  const checked = checkedCount(checklist);
  return {
    checklist, loaded: load !== "pending", access, checkedCount: checked, uncheckedCount: CHECKLIST_KEYS.length - checked,
    total: CHECKLIST_KEYS.length, isEditable, toggle, changeText, commitText,
  };
}
