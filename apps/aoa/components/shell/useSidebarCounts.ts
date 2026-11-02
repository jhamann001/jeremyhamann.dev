"use client";

import { useEffect, useState } from "react";
import type { NavCounts } from "@/lib/data/nav-counts";

type ReadState<T> = { scope: string; status: "loading" | "available" | "unavailable"; value: T | null };
const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function validNavCounts(value: unknown): value is NavCounts {
  if (!value || typeof value !== "object") return false;
  return ["households", "clients", "openDeals", "activeTransfers", "crmOpenExceptions"]
    .every(key => integer((value as Record<string, unknown>)[key]));
}
export function validAcatCount(value: unknown): value is { count: number } {
  return !!value && typeof value === "object" && integer((value as { count?: unknown }).count);
}

/** GET reads never enter Next's serialized server-action/router queue. */
export function useSidebarCounts<T>(endpoint: string, scope: string, enabled: boolean,
  validate: (value: unknown) => value is T) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ReadState<T>>({ scope, status: "loading", value: null });
  useEffect(() => {
    let alive = true;
    if (!enabled) { setState({ scope, status: "available", value: null }); return; }
    const controller = new AbortController();
    setState({ scope, status: "loading", value: null });
    const timer = setTimeout(() => {
      controller.abort();
      if (alive) setState({ scope, status: "unavailable", value: null });
    }, 20_000);
    void (async () => {
      try {
        const response = await fetch(endpoint, { signal: controller.signal, cache: "no-store",
          credentials: "same-origin", redirect: "error" });
        if (!response.ok || response.headers.get("X-AOA-Navigation-Scope") !== scope) throw new Error("badge_unavailable");
        const value: unknown = await response.json();
        if (!validate(value)) throw new Error("badge_unavailable");
        if (alive && !controller.signal.aborted) setState({ scope, status: "available", value });
      } catch {
        if (alive && !controller.signal.aborted) setState({ scope, status: "unavailable", value: null });
      } finally { clearTimeout(timer); }
    })();
    return () => { alive = false; controller.abort(); clearTimeout(timer); };
  }, [endpoint, scope, enabled, validate, attempt]);
  // A newly authenticated scope must not render the previous scope's counts
  // even for the render before this effect's cleanup runs.
  const current = state.scope === scope ? state : { scope, status: "loading" as const, value: null };
  return { ...current, retry: () => setAttempt(previous => previous + 1) };
}
