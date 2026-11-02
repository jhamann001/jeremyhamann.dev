"use client";

import { useLayoutEffect } from "react";
import { getBrowserListNavigationMemory } from "@/lib/navigation/list-memory";
import { clearListHistoryState, setListHistoryScope } from "@/lib/navigation/history-entry";

/** Scope follows the authenticated login, not individual layout mount lifetimes. */
export function ListNavigationBoundary({ scope }: { scope: string }) {
  useLayoutEffect(() => {
    const memory = getBrowserListNavigationMemory();
    memory?.setScope(scope);
    setListHistoryScope(scope);
  }, [scope]);
  return null;
}

/** Render only after the server establishes that the browser is signed out. */
export function ClearNavigationMemory() {
  useLayoutEffect(() => {
    getBrowserListNavigationMemory()?.clear();
    clearListHistoryState();
  }, []);
  return null;
}
