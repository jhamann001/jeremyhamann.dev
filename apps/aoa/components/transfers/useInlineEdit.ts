"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

export type InlineEditStatus = "idle" | "saving" | "saved" | "error";

export type InlineEditApi = {
  editingField: string | null;
  editValue: string;
  status: InlineEditStatus;
  lastSavedField: string | null;
  start: (field: string, currentValue: string) => void;
  change: (value: string) => void;
  commit: (overrideValue?: string) => Promise<void>;
  cancel: () => void;
  beginCancel: () => void;
  bind: (field: string) => {
    autoFocus: boolean;
    onBlur: () => void;
    onKeyDown: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => void;
  };
};

/** Click into a value, edit it, blur or Enter to save, Escape to cancel. An
 *  unchanged value is a no-op, one save runs at a time, and a failed save
 *  (`onSave` returns false) keeps the editor and its buffer open. */
export function useInlineEdit({ onSave, savedFlashMs = 1200 }: {
  onSave: (field: string, value: string) => Promise<boolean>;
  savedFlashMs?: number;
}): InlineEditApi {
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [status, setStatus] = useState<InlineEditStatus>("idle");
  const [lastSavedField, setLastSavedField] = useState<string | null>(null);

  const originalValueRef = useRef("");
  const cancellingRef = useRef(false);
  const inFlightRef = useRef(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearFlash = useCallback(() => {
    if (flashTimerRef.current) {
      clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearFlash(), [clearFlash]);

  const start = useCallback((field: string, currentValue: string) => {
    clearFlash();
    cancellingRef.current = false;
    originalValueRef.current = currentValue;
    setEditingField(field);
    setEditValue(currentValue);
    setStatus("idle");
    setLastSavedField(null);
  }, [clearFlash]);

  const change = useCallback((value: string) => setEditValue(value), []);

  const cancel = useCallback(() => {
    setEditingField(null);
    setEditValue("");
    setStatus("idle");
    cancellingRef.current = false;
  }, []);

  const beginCancel = useCallback(() => { cancellingRef.current = true; }, []);

  const commit = useCallback(async (overrideValue?: string) => {
    if (!editingField) return;
    if (cancellingRef.current) {
      cancellingRef.current = false;
      return;
    }
    if (inFlightRef.current) return;

    const field = editingField;
    const value = overrideValue ?? editValue;
    if (value === originalValueRef.current) {
      cancel();
      return;
    }

    inFlightRef.current = true;
    setStatus("saving");
    try {
      const success = await onSave(field, value);
      if (success) {
        setStatus("saved");
        setLastSavedField(field);
        setEditingField(null);
        setEditValue("");
        clearFlash();
        flashTimerRef.current = setTimeout(() => {
          setStatus("idle");
          setLastSavedField(null);
          flashTimerRef.current = null;
        }, savedFlashMs);
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    } finally {
      inFlightRef.current = false;
    }
  }, [cancel, clearFlash, editValue, editingField, onSave, savedFlashMs]);

  const bind = useCallback((field: string) => ({
    autoFocus: editingField === field,
    onBlur: () => {
      if (editingField !== field) return;
      void commit();
    },
    onKeyDown: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      if (editingField !== field) return;
      if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        void commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    },
  }), [cancel, commit, editingField]);

  return { editingField, editValue, status, lastSavedField, start, change, commit, cancel, beginCancel, bind };
}
