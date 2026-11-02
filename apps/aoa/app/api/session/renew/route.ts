import { cookies } from "next/headers";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { SESSION_MAX_AGE_SECONDS } from "@/lib/auth/session-timeout";

// ticket — "Stay signed in" renew.
//
// Extends the current session another full 4h and returns the new expiry so the
// client can reset its countdown. This is the RISKY bit: it must actually move
// the session expiry forward in DATABASE-session mode (prod).
//
// We do NOT rely on Auth.js `unstable_update`/session refresh here: in the
// database strategy that API is really about the JWT and does not dependably
// re-stamp the Session row. Instead we resolve the session cookie to its
// `Session.sessionToken` and UPDATE `Session.expires` directly via Prisma —
// the same row the PrismaAdapter reads on every request. Verified empirically
// (see PR) that this moves the DB row ~4h forward.
//
// DEV uses JWT sessions (no Session row). There the client already gets a fresh
// expiry on navigation (the token slides), and there is nothing server-side to
// bump; we just return the projected new expiry so the modal dismisses and the
// UX is exercisable locally. The prod database path is the one that matters and
// is proven against the DB.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Auth.js v5 cookie names: `authjs.session-token` over http (dev/localhost),
// `__Secure-authjs.session-token` when the cookie is issued Secure (prod/https).
// Check the Secure name first (prod), fall back to the plain name (dev).
const SECURE_COOKIE = "__Secure-authjs.session-token";
const PLAIN_COOKIE = "authjs.session-token";

export async function POST() {
  // Re-verify there is a real session for this caller (defence in depth on top
  // of the auth middleware). No session → 401, never touch the DB.
  const session = await auth();
  if (!session?.user) {
    return Response.json({ ok: false }, { status: 401 });
  }

  const newExpires = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);

  const jar = await cookies();
  const sessionToken =
    jar.get(SECURE_COOKIE)?.value ?? jar.get(PLAIN_COOKIE)?.value ?? null;

  // Database-session mode: the cookie value IS the Session.sessionToken. Bump
  // that row's expires to now + maxAge. updateMany (not update) so a missing /
  // already-rotated token is a no-op (count 0) instead of a throw. Scope the
  // WHERE to the caller's own userId as well so a stale/foreign cookie value can
  // never extend someone else's session.
  if (sessionToken) {
    const res = await prisma.session.updateMany({
      where: { sessionToken, userId: (session.user as { id?: string }).id },
      data: { expires: newExpires },
    });
    // count 0 in dev (jwt: no Session row) — expected, not an error. In prod a
    // matched row means the DB expiry moved forward.
    return Response.json({ ok: true, expires: newExpires.toISOString(), updated: res.count });
  }

  // No session cookie resolvable (e.g. jwt-only dev where the token is signed,
  // not a DB handle): nothing to bump server-side; hand back the projected
  // expiry so the client resets its countdown.
  return Response.json({ ok: true, expires: newExpires.toISOString(), updated: 0 });
}
