"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { useSession, signOut } from "next-auth/react";

// Must stay in lockstep with IDLE_TIMEOUT_SEC in src/lib/auth-jwt.ts. The
// server-side check is authoritative; the client-side timer is just a
// friendlier UX so the user sees a countdown / clean signOut instead of
// suddenly getting 401s on their next request.
export const IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours

// Warn the user 3 minutes before we sign them out.
export const WARNING_AT_MS = IDLE_TIMEOUT_MS - 3 * 60 * 1000;

const CHECK_INTERVAL_MS = 1000; // check every second for smooth countdown
const THROTTLE_MS = 30 * 1000; // update lastActivity at most every 30s

// Pointer / keyboard / touch events are the strongest signal that a real
// person is actively using the app. We also listen for `visibilitychange`
// and window `focus` below so users who read the screen without moving
// the mouse aren't signed out while the tab is demonstrably in the
// foreground.
const ACTIVITY_EVENTS: (keyof DocumentEventMap)[] = [
  "mousemove",
  "keydown",
  "mousedown",
  "touchstart",
  "scroll",
];

export interface IdleTimeoutState {
  showWarning: boolean;
  secondsLeft: number;
  staySignedIn: () => void;
}

export function useIdleTimeout(): IdleTimeoutState {
  const { data: session } = useSession();
  const lastActivityRef = useRef(0);
  const signingOutRef = useRef(false);
  const [showWarning, setShowWarning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  const recordActivity = useCallback(() => {
    const now = Date.now();
    if (now - lastActivityRef.current >= THROTTLE_MS) {
      lastActivityRef.current = now;
    }
  }, []);

  // Visibility / focus activity bypasses the throttle: these events are
  // rare and cheap, and we want an immediate reset when the user tabs back.
  const recordFocusActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
  }, []);

  const staySignedIn = useCallback(() => {
    lastActivityRef.current = Date.now();
    setShowWarning(false);
    setSecondsLeft(0);
  }, []);

  useEffect(() => {
    if (!session) return;

    lastActivityRef.current = Date.now();
    signingOutRef.current = false;

    for (const event of ACTIVITY_EVENTS) {
      document.addEventListener(event, recordActivity, { passive: true });
    }

    const onVisibility = () => {
      if (document.visibilityState === "visible") recordFocusActivity();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", recordFocusActivity);

    const intervalId = setInterval(() => {
      const idle = Date.now() - lastActivityRef.current;

      if (idle >= IDLE_TIMEOUT_MS && !signingOutRef.current) {
        signingOutRef.current = true;
        setShowWarning(false);
        signOut({ callbackUrl: "/login?reason=timeout" });
      } else if (idle >= WARNING_AT_MS) {
        const remaining = Math.ceil((IDLE_TIMEOUT_MS - idle) / 1000);
        setSecondsLeft(Math.max(remaining, 0));
        setShowWarning(true);
      } else {
        if (showWarning) {
          setShowWarning(false);
          setSecondsLeft(0);
        }
      }
    }, CHECK_INTERVAL_MS);

    return () => {
      for (const event of ACTIVITY_EVENTS) {
        document.removeEventListener(event, recordActivity);
      }
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", recordFocusActivity);
      clearInterval(intervalId);
    };
  }, [session, recordActivity, recordFocusActivity, showWarning]);

  return { showWarning, secondsLeft, staySignedIn };
}
