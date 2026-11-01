"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type InlineEditStatus = "idle" | "saving" | "saved" | "error";

export interface UseInlineEditOptions {
  /**
   * Persist the field. Return `true` on success, `false` on failure (the
   * hook flips status to "error" and keeps the editor open so the user can
   * retry or cancel).
   */
  onSave: (field: string, value: string) => Promise<boolean>;
  /** How long to show the "Saved" pill after a successful commit. */
  savedFlashMs?: number;
}

export interface UseInlineEditApi {
  editingField: string | null;
  editValue: string;
  status: InlineEditStatus;
  /** Field most recently saved while the success indicator is visible. */
  lastSavedField: string | null;
  /** Begin editing `field` with `currentValue` as the initial buffer. */
  start: (field: string, currentValue: string) => void;
  /** Update the in-flight buffer. */
  change: (value: string) => void;
  /**
   * Persist the in-flight buffer if it differs from the original. No-ops if
   * we're not editing anything, the value is unchanged, or a cancel is
   * already in flight (cancel-vs-blur race).
   *
   * Pass `overrideValue` to commit a specific value without round-tripping
   * through React state — useful for `<select>` controls that should save
   * immediately on change instead of waiting for blur.
   */
  commit: (overrideValue?: string) => Promise<void>;
  /** Drop the buffer and exit edit mode. */
  cancel: () => void;
  /**
   * Mark "the user is about to cancel" so a subsequent `commit()` triggered
   * by the input's blur handler is skipped. Wire this to `onMouseDown` on
   * cancel buttons (which fires before the blur).
   */
  beginCancel: () => void;
  /**
   * Convenience helper that returns ready-to-spread handlers for an input
   * being edited. Wires `onBlur` to `commit` and `onKeyDown` to
   * Enter/Escape behaviour. Pass the field key so the hook only attaches
   * handlers when that field is the one being edited.
   */
  bind: (field: string) => {
    autoFocus: boolean;
    onBlur: () => void;
    onKeyDown: (
      e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
    ) => void;
  };
}

/**
 * Centralizes the "click into a value, edit it, click away to save" pattern
 * used in AcatDetail and TransferDetailsTab. Solves the well-known foot-guns
 * once:
 *
 *  - Cancel button vs blur: the cancel button calls `beginCancel()` on
 *    mouse-down so when the input subsequently loses focus, `commit()` is a
 *    no-op. (Blur fires after `mousedown` but before `click`, which is why
 *    the canonical "preventDefault on the cancel button's mousedown" trick
 *    on its own isn't enough — we still need to short-circuit `commit`.)
 *
 *  - Unchanged value: committing the same value the user started with skips
 *    the network call and the success flash. Avoids spurious PATCHes when
 *    the user clicks into a field, looks at it, and clicks away.
 *
 *  - Re-entrancy: `commit()` is locked while a save is in flight so a
 *    rapidly-blurred-then-Entered field doesn't fire two PATCHes.
 *
 *  - Status pill: `idle | saving | saved | error` drives a tiny inline
 *    indicator so the per-field success toast can go away.
 */
export function useInlineEdit(opts: UseInlineEditOptions): UseInlineEditApi {
  const { onSave, savedFlashMs = 1200 } = opts;
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [status, setStatus] = useState<InlineEditStatus>("idle");
  const [lastSavedField, setLastSavedField] = useState<string | null>(null);

  const originalValueRef = useRef<string>("");
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

  const start = useCallback(
    (field: string, currentValue: string) => {
      clearFlash();
      cancellingRef.current = false;
      originalValueRef.current = currentValue;
      setEditingField(field);
      setEditValue(currentValue);
      setStatus("idle");
      setLastSavedField(null);
    },
    [clearFlash]
  );

  const change = useCallback((value: string) => {
    setEditValue(value);
  }, []);

  const cancel = useCallback(() => {
    setEditingField(null);
    setEditValue("");
    setStatus("idle");
    cancellingRef.current = false;
  }, []);

  const beginCancel = useCallback(() => {
    cancellingRef.current = true;
  }, []);

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

  const bind = useCallback(
    (field: string) => ({
      autoFocus: editingField === field,
      onBlur: () => {
        if (editingField !== field) return;
        void commit();
      },
      onKeyDown: (
        e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
      ) => {
        if (editingField !== field) return;
        if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) {
          e.preventDefault();
          void commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      },
    }),
    [cancel, commit, editingField]
  );

  return {
    editingField,
    editValue,
    status,
    lastSavedField,
    start,
    change,
    commit,
    cancel,
    beginCancel,
    bind,
  };
}
