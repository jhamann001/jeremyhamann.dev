"use client";

import { useCallback, useSyncExternalStore } from "react";

/** Tailwind `md`. Keep equal to the `md:` utilities the shell uses (48rem = 768px at 16px root). */
export const MD_UP = "(min-width: 48rem)";

function canMatchMedia(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function";
}

/**
 * SSR-safe matchMedia (rule R6). `ssrDefault` (default false = phone) is what
 * the server and the hydrating render return; the real value takes over right after hydration.
 * useSyncExternalStore: subscribe adds/removes a "change" listener on window.matchMedia(query).
 *
 * PERMITTED CONSUMERS: ResponsiveSheet and ResponsivePopover (src/components/shell/responsive-sheet.tsx).
 * Everything else decides breakpoints in CSS — never read window.innerWidth or matchMedia elsewhere.
 */
export function useMediaQuery(query: string, ssrDefault = false): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!canMatchMedia()) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(
    () => (canMatchMedia() ? window.matchMedia(query).matches : ssrDefault),
    [query, ssrDefault],
  );
  const getServerSnapshot = useCallback(() => ssrDefault, [ssrDefault]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
