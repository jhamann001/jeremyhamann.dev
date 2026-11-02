"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./Toast.module.css";

// Minimal bottom-center toast (mockup #toast, index.html:371/:2015): dark chip,
// check mark, auto-hides after ~2.6s. Local to the Command Center's ephemeral
// P2 actions (ticket) — deliberately NOT a global system; Phase C workflow
// screens have their own affordances.

const TOAST_MS = 2600;

export function useToast(): { show: (msg: string) => void; toast: React.ReactNode } {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((m: string) => {
    setMsg(m);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), TOAST_MS);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const toast = msg ? (
    <div className={styles.toast} role="status" data-testid="cc-toast">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        aria-hidden="true"
      >
        <path d="M20 6L9 17l-5-5" />
      </svg>
      <span>{msg}</span>
    </div>
  ) : null;

  return { show, toast };
}
