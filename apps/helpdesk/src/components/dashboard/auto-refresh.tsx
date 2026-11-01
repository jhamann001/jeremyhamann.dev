"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-renders the current RSC page on an interval while the tab is visible.
 * Used on the dashboard and queue pages only — list rows and counters are not views, so a refresh
 * writes no audit rows. Never mount this on the ticket detail page: every render there IS a view.
 *
 * A tab that was hidden longer than the interval refreshes once as soon as it becomes visible again,
 * so an operator returning to the screen never looks at data older than `intervalMs`.
 */
export function AutoRefresh({ intervalMs }: { intervalMs: number }): null {
  const router = useRouter();
  const lastRefreshRef = useRef<number>(Date.now());

  useEffect(() => {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;

    const refresh = () => {
      lastRefreshRef.current = Date.now();
      router.refresh();
    };

    const tick = () => {
      if (document.visibilityState === "visible") refresh();
    };

    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastRefreshRef.current >= intervalMs) refresh();
    };

    const id = window.setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, router]);

  return null;
}
