"use server";

/**
 * Auth.js redirecting wrappers — the convention-4 carve-out.
 * These return `Promise<void>` and MAY throw: `signIn` / `signOut` redirect by throwing, so `runAction`
 * cannot wrap them. This is the only "use server" module outside src/server/ and must never gain a
 * non-redirecting export (guardrail G4).
 *
 * Auth.js also REFUSES by throwing. `callbacks.signIn` returning false surfaces as an `AuthError`
 * (`AccessDenied`), and the refusal a real operator produces is Decision #72's deactivated account.
 * Unhandled, that error escaped the server action, Next rendered the error boundary ("Application
 * error: a server-side exception has occurred", plus a digest), and the finished copy
 * `src/app/sign-in/page.tsx` already carries for `?error=AccessDenied` was unreachable — the
 * offboarded person was stranded on a dead page with no link back, and the one operator-facing signal
 * that offboarding worked was a stack trace. Every export below therefore funnels an `AuthError` back
 * to the sign-in page. The security half is unchanged: the hook still refuses, no session is created,
 * and nothing here inspects or reports WHY beyond the fixed code the page knows.
 *
 * The added code is redirect-only, so this module still satisfies the terms of the G4 carve-out.
 */
import { AuthError } from "next-auth";
import { redirect, unstable_rethrow } from "next/navigation";
import { signIn, signOut } from "@/auth";
import { safeRelativePath } from "@/lib/rbac";
import { signInErrorCode } from "@/lib/sign-in-errors";

/**
 * Turn a throw out of `signIn` into either the framework's own control flow or a redirect the sign-in
 * page can render. Never returns.
 *
 * `redirect()` reports SUCCESS by throwing, and so do `notFound()` and the dynamic-rendering bailouts
 * that `signIn` can raise through `headers()` / `cookies()`. `unstable_rethrow` is Next's own helper
 * for exactly this position — "use it before you do any error handling" — and re-throws precisely
 * those, so the successful sign-in still redirects to `redirectTo`. Anything that is not an
 * `AuthError` is a genuine fault and is re-thrown untouched: swallowing it would trade a visible crash
 * for a silent one.
 */
function redirectToSignInError(error: unknown): never {
  unstable_rethrow(error);
  if (error instanceof AuthError) {
    redirect(`/sign-in?error=${encodeURIComponent(signInErrorCode(error))}`);
  }
  throw error;
}

export async function signInWithOkta(callbackUrl: string): Promise<void> {
  try {
    await signIn("okta", { redirectTo: safeRelativePath(callbackUrl, "/dashboard") });
  } catch (error) {
    redirectToSignInError(error);
  }
}

/**
 * The temporary domain-restricted Google sign-in. Identical in shape to `signInWithOkta` on purpose — same
 * `safeRelativePath` on the callback, same `AuthError` funnel — because the refusal it produces most often
 * IS an `AuthError`: `callbacks.signIn` returns false for an out-of-domain or unverified Google address, and
 * without the funnel that surfaces as the error boundary rather than as /sign-in?error=AccessDenied, whose
 * copy names the domain restriction. Nothing here inspects or reports WHY beyond the fixed code.
 */
export async function signInWithGoogle(callbackUrl: string): Promise<void> {
  try {
    await signIn("google", { redirectTo: safeRelativePath(callbackUrl, "/dashboard") });
  } catch (error) {
    redirectToSignInError(error);
  }
}

export async function signOutAction(): Promise<void> {
  try {
    await signOut({ redirectTo: "/sign-in" });
  } catch (error) {
    unstable_rethrow(error);
    // A failed sign-out is not a sign-in problem, so none of the codes above would be honest here.
    // Land the person on the public sign-in page — where they can try again — rather than on the error
    // boundary. The session cookie may survive; /sign-in is reachable either way.
    if (error instanceof AuthError) redirect("/sign-in");
    throw error;
  }
}
