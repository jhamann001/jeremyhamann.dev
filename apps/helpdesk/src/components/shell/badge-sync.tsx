"use client";

import { useEffect } from "react";

/**
 * App-icon badge.
 *
 * Rendered ONCE by the `(app)` layout, which is the only place that already knows the number. It
 * draws nothing: it calls the Badging API so an INSTALLED icon — on a dock, a taskbar or a home
 * screen — carries the same count the Inbox entry carries inside the app.
 *
 * Three rules, and they are all about not being a nuisance:
 *
 *  - **A count is all it ever gets.** `setAppBadge(n)` takes a number. It cannot carry a subject, a
 *    requester or a ticket number, and that is the right ceiling for something that renders outside
 *    the app on a screen anyone walking past can see.
 *  - **Unsupported is a no-op, never a throw.** Safari on macOS supports it for installed apps,
 *    Firefox does not, and every mobile browser answers differently. This component is mounted in a
 *    LAYOUT: an exception here would take every authenticated page down to an error boundary.
 *  - **Zero clears it.** A badge that survives reading everything is a badge people stop believing.
 *
 * The badge is also cleared on unmount, so signing out does not leave a number on the icon that
 * nothing in the app will ever come back to clear.
 */

/** The value to pass to `setAppBadge`, or `null` meaning "clear it". Pure; the whole decision. */
export function badgeValue(count: number): number | null {
  if (!Number.isFinite(count)) return null;
  const n = Math.floor(count);
  if (n <= 0) return null;
  // The API itself has no ceiling, but platforms render a badge as a small disc: an exact 4,312 is
  // unreadable and a lie about precision nobody needs. The app's own Inbox entry carries the truth.
  return Math.min(n, 999);
}

/** The Badging API, duck-typed. `navigator` has no ambient types for it in this repo's `lib`. */
type BadgingNavigator = {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

export type BadgeSyncProps = { count: number };

export function BadgeSync({ count }: BadgeSyncProps): React.JSX.Element | null {
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const nav = navigator as Navigator & BadgingNavigator;
    if (typeof nav.setAppBadge !== "function" || typeof nav.clearAppBadge !== "function") return;

    const value = badgeValue(count);
    // Both calls return a promise that rejects when the document is not installed or not permitted.
    // Swallowing it is the correct handling: there is no badge, and there is nothing to tell anyone.
    const apply = value === null ? nav.clearAppBadge() : nav.setAppBadge(value);
    void apply.catch(() => undefined);

    return () => {
      void nav.clearAppBadge?.().catch(() => undefined);
    };
  }, [count]);

  return null;
}
