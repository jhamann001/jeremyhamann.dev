"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./Toast.module.css";

// Minimal ephemeral-stub feedback (Phase C posture, P1 ticket): a
// `role="status"` toast that announces itself to screen readers and
// auto-dismisses. No global provider exists yet — hosts own their toast via
// `useToast()` and render `<Toast message={toast} />`.

const TOAST_MS = 2800;

export function useToast(): { toast: string | null; showToast: (msg: string) => void } {
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    if (timer.current) clearTimeout(timer.current);
    setToast(msg);
    timer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { toast, showToast };
}

export function Toast({ message }: { message: string | null }) {
  // The status region stays mounted so assistive tech hears content changes.
  return (
    <div role="status" aria-live="polite" className={styles.region}>
      {message ? (
        <div className={styles.toast}>
          <span className={styles.dot} aria-hidden="true" />
          {message}
        </div>
      ) : null}
    </div>
  );
}
