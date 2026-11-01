"use client";

import { useCallback, useEffect, useRef } from "react";
import useSWR from "swr";
import { useSession } from "next-auth/react";
import type { PresenceUser } from "@/lib/presence";

// Heartbeat cadence. Fired on any visible tab for any authenticated user.
//
// Earlier this hook also gated on "has the user produced an activity event
// in the last 60s" — same signal use-idle-timeout.ts uses. That turned out
// to be wrong for presence: a user reading the records page without moving
// the mouse falls below the 60s gate, heartbeats stop, and they drop off
// the team list. The corrective signal is visibility alone — if the tab is
// in the foreground, the user counts as "here". The 4-hour server-side
// idle timeout still kicks them when they're truly absent.
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const PRESENCE_REFRESH_MS = 30 * 1000;

/**
 * Fires heartbeats while the tab is visible and the user is signed in.
 *
 * MUST be mounted globally (not inside NavRail) — NavRail is rendered only
 * on a subset of pages (/, /records, /advisor), so anchoring heartbeats to
 * it leaves anyone on /admin or /mcp/connections invisible to the rest of
 * the team. Mount this once in the root layout instead.
 */
export function usePresenceHeartbeat(): void {
  const { status } = useSession();
  const inFlightRef = useRef(false);

  const sendHeartbeat = useCallback(async () => {
    if (inFlightRef.current) return;
    if (typeof document === "undefined") return;
    if (document.visibilityState !== "visible") return;
    inFlightRef.current = true;
    try {
      await fetch("/api/presence/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    } catch {
      // Best-effort — the next interval tick will catch up. SWR-polled
      // /api/presence is the source of truth either way.
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (status !== "authenticated") return;

    void sendHeartbeat();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void sendHeartbeat();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", () => void sendHeartbeat());

    const id = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(id);
    };
  }, [status, sendHeartbeat]);
}

export interface UsePresenceListResult {
  users: PresenceUser[];
  activeCount: number;
  totalCount: number;
  loading: boolean;
}

/**
 * SWR-polled read of the team presence list. Pure consumer — does not write.
 * Safe to call from anywhere; only triggers a request when authenticated.
 *
 * Returns the server's view verbatim. The hook used to optimistically inject
 * the current user as "active" before the first server poll, but that
 * masked real bugs: a broken heartbeat would still show "you" as active,
 * making it impossible to tell whether the feature was working. The trust-
 * the-server approach forces real failures to surface.
 */
export function usePresenceList(): UsePresenceListResult {
  const { status } = useSession();
  const { data, isLoading } = useSWR<{ users: PresenceUser[] }>(
    status === "authenticated" ? "/api/presence" : null,
    { refreshInterval: PRESENCE_REFRESH_MS }
  );

  const users = data?.users ?? [];
  const activeCount = users.filter((u) => u.status === "active").length;

  return {
    users,
    activeCount,
    totalCount: users.length,
    loading: isLoading,
  };
}
