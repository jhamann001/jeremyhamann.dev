import { getSession, signOut } from "next-auth/react";

/**
 * Shared SWR fetcher. Forces `cache: 'no-store'` so browsers, service workers,
 * or intermediary caches never serve stale data — critical for cross-user
 * propagation where another user's writes must be visible on focus / interval.
 *
 * Error text is shaped to match the previous hand-rolled hook behaviour
 * (`HTTP <status>` for non-OK responses, underlying message for network
 * failures) so existing test assertions keep passing with minimal churn.
 *
 * On 401 we don't sign the user out blindly. A single 401 can come from
 * legitimate places that aren't "session gone" (e.g. a Cloud Run cold-start
 * hiccup where Proxy briefly can't decode the cookie, or a stale
 * response mid-rotation). Instead we do an authoritative session check via
 * `/api/auth/session` and only invoke `signOut` if the session is really
 * null. The `verificationInFlight` guard collapses concurrent 401s from
 * multiple SWR hooks down to a single verify-then-signOut sequence.
 */
let verificationInFlight = false;

export function __resetFetcherGuardForTests(): void {
  verificationInFlight = false;
}

async function verifySessionAndMaybeSignOut(): Promise<void> {
  if (verificationInFlight) return;
  verificationInFlight = true;
  try {
    const session = await getSession();
    if (!session) {
      await signOut({ callbackUrl: "/login?reason=expired" });
      // Intentionally leave verificationInFlight=true; we're navigating away.
      return;
    }
    // Session still valid — the 401 was transient (cold start, race, etc.).
    // Re-arm the guard so a future genuine expiry can be handled.
    verificationInFlight = false;
  } catch {
    // Network error calling /api/auth/session — don't boot the user over a
    // flaky check. Re-arm and let a subsequent 401 try again.
    verificationInFlight = false;
  }
}

export async function jsonFetcher<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 401) {
    if (typeof window !== "undefined") {
      void verifySessionAndMaybeSignOut();
    }
    throw new Error("HTTP 401");
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}
