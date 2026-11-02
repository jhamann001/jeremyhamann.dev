"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import {
  formatCountdown,
  isExpired,
  msUntilExpiry,
  shouldWarn,
} from "@/lib/auth/session-timeout";
import styles from "./SessionTimeout.module.css";

// ticket — client-side session-timeout warning.
//
// The server layout passes the current session `expires` (from auth()) as a
// prop. That is the ONLY time source: every navigation re-renders the layout
// with a fresh expiry (the session slides server-side, see auth.ts), so there
// is no client polling of the session and no drift — we just count down toward
// the prop we were given.
//
// When <= 5 min remain we show a modal with a live "Signing out in M:SS"
// countdown. "Stay signed in" hits /api/session/renew (which moves the DB
// Session.expires ~8h forward in prod) and resets the countdown to the returned
// expiry. Reaching 0 — or "Sign out" — signs the user out to the login screen.
//
// Sign-out goes through a Next.js Server Action (`signOutAction`, passed from
// the layout), rendered as a <form action={signOutAction}> — the SAME
// CSRF-protected pattern the Topbar sign-out uses. We deliberately do NOT
// navigate to a state-changing GET route: a GET that mutates session state is
// forgeable (CWE-352 CSRF; flagged by security scanner SAST). Both triggers submit that one
// form: the "Sign out" button is a normal submit, and the countdown-to-0 auto
// sign-out calls form.requestSubmit() (no user gesture, so it must be
// programmatic) — both carry the server-action CSRF token.
//
// Deliberate v1 scope (noted in the PR): no mouse/keyboard silent-extend (the
// warning is what covers an idle reader), and no cross-tab coordination.

// Tick once a second — enough for a smooth M:SS countdown without churn.
const TICK_MS = 1000;

type Props = {
  /** ISO timestamp of the current session's expiry (from the server layout). */
  expiresAt: string;
  /**
   * CSRF-protected sign-out Server Action supplied by the layout (it wraps
   * next-auth `signOut({ redirectTo: "/" })`, matching the Topbar). Invoked as a
   * form action — by the "Sign out" button and, on timeout, programmatically via
   * form.requestSubmit(). Server Actions are POST-only and Origin-checked by
   * Next.js, so there is no forgeable GET sign-out.
   */
  signOutAction: () => Promise<void>;
};

export function SessionTimeout({ expiresAt, signOutAction }: Props) {
  // Expiry we are counting toward, as epoch ms. Seeded from the prop; "Stay
  // signed in" replaces it with the renewed expiry the server returns.
  const [expiresMs, setExpiresMs] = useState<number>(() =>
    new Date(expiresAt).getTime(),
  );
  // Re-derive the current time each tick; kept in state so the countdown label
  // and the warn/expired transitions re-render.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [renewing, setRenewing] = useState(false);
  const signingOut = useRef(false);
  const signOutFormRef = useRef<HTMLFormElement>(null);

  // If the server hands us a newer expiry on a re-render (navigation slid the
  // session forward), adopt it — but never move backwards, so an in-flight
  // renew that already pushed us further isn't clobbered by a staler prop.
  useEffect(() => {
    const propMs = new Date(expiresAt).getTime();
    setExpiresMs((cur) => (propMs > cur ? propMs : cur));
  }, [expiresAt]);

  const goSignOut = useCallback(() => {
    if (signingOut.current) return;
    signingOut.current = true;
    // Submit the CSRF-protected sign-out form (server action). requestSubmit()
    // runs the action even with no click, so the countdown-to-0 auto sign-out
    // and the "Sign out" button share one path. The action redirects to "/"
    // server-side (and, in prod, on to Okta). Fallback: if the ref somehow
    // isn't mounted, a hard reload lands the now-untrusted client on the auth
    // gate rather than leaving the modal stuck.
    const form = signOutFormRef.current;
    if (form) form.requestSubmit();
    else window.location.reload();
  }, []);

  // The one interval: advance `now`, and when the clock fully elapses, sign out.
  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now();
      setNowMs(t);
      if (isExpired(expiresMs, t)) {
        clearInterval(id);
        goSignOut();
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [expiresMs, goSignOut]);

  const renew = useCallback(async () => {
    if (renewing) return;
    setRenewing(true);
    try {
      const res = await fetch("/api/session/renew", {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      if (!res.ok) {
        // Renew failed (e.g. session already gone) — fail safe by signing out.
        goSignOut();
        return;
      }
      const data: { expires?: string } = await res.json();
      if (data.expires) {
        setExpiresMs(new Date(data.expires).getTime());
        setNowMs(Date.now());
      }
    } catch {
      goSignOut();
    } finally {
      setRenewing(false);
    }
  }, [renewing, goSignOut]);

  const open = shouldWarn(expiresMs, nowMs);
  if (!open) return null;

  const remaining = msUntilExpiry(expiresMs, nowMs);

  return (
    <div
      className={styles.overlay}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="session-timeout-title"
      aria-describedby="session-timeout-body"
      // Esc must NOT silently dismiss without a choice (a11y requirement): the
      // user has to pick "Stay signed in" or "Sign out". Swallow Escape here.
      onKeyDown={(e) => {
        if (e.key === "Escape") e.preventDefault();
      }}
    >
      <div className={styles.modal}>
        <h2 id="session-timeout-title" className={styles.title}>
          Still there?
        </h2>
        <p id="session-timeout-body" className={styles.body}>
          You&rsquo;ll be signed out in{" "}
          <span className={styles.countdown} aria-live="assertive">
            {formatCountdown(remaining)}
          </span>{" "}
          for your security. Choose to stay signed in to keep working.
        </p>
        <div className={styles.actions}>
          {/* CSRF-protected sign-out via server action (same pattern as the
              Topbar). The button is a normal submit; the countdown-to-0 auto
              sign-out submits this same form programmatically. */}
          <form ref={signOutFormRef} action={signOutAction}>
            <Button type="submit" variant="ghost" disabled={renewing}>
              Sign out
            </Button>
          </form>
          <Button
            variant="primary"
            onClick={renew}
            disabled={renewing}
            // Focus the safe/affirmative action on open (focus lands inside the
            // modal — basic focus containment for this two-button dialog).
            autoFocus
          >
            {renewing ? "Staying signed in…" : "Stay signed in"}
          </Button>
        </div>
      </div>
    </div>
  );
}
