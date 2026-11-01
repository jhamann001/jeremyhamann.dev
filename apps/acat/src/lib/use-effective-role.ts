"use client";

import { useSyncExternalStore, useCallback } from "react";
import { useSession } from "next-auth/react";

// Dev-only "View as User" toggle. Lets an admin see what a regular user sees
// without signing out. Purely cosmetic: server-side authz is untouched, so
// mutating APIs still succeed if hit directly. The override only takes effect
// when NODE_ENV === "development" AND the real session role is ADMIN.

type EffectiveRole = "ADMIN" | "USER";

const STORAGE_KEY = "acat:dev-role-override";
const STORAGE_EVENT = "acat:dev-role-override-changed";

function readOverride(): EffectiveRole | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === "USER" || v === "ADMIN" ? v : null;
}

function subscribe(notify: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", notify);
  window.addEventListener(STORAGE_EVENT, notify);
  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener(STORAGE_EVENT, notify);
  };
}

// SSR / hydration snapshot — no override visible on the server.
function getServerSnapshot(): EffectiveRole | null {
  return null;
}

export function isDevOverrideEnabled(): boolean {
  return process.env.NODE_ENV === "development";
}

export function useEffectiveRole(): {
  role: EffectiveRole | undefined;
  actualRole: EffectiveRole | undefined;
  isOverridden: boolean;
  setOverride: (next: EffectiveRole | null) => void;
} {
  const { data: session } = useSession();
  const actualRole = session?.user?.role as EffectiveRole | undefined;

  const override = useSyncExternalStore(subscribe, readOverride, getServerSnapshot);

  const setOverride = useCallback((next: EffectiveRole | null) => {
    if (!isDevOverrideEnabled() || typeof window === "undefined") return;
    if (next == null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, next);
    window.dispatchEvent(new Event(STORAGE_EVENT));
  }, []);

  // Override only applies when the real user is an admin in dev — a USER who
  // somehow flipped the flag cannot promote themselves to ADMIN.
  const canOverride = isDevOverrideEnabled() && actualRole === "ADMIN";
  const effective = canOverride && override ? override : actualRole;

  return {
    role: effective,
    actualRole,
    isOverridden: canOverride && override != null && override !== actualRole,
    setOverride,
  };
}
