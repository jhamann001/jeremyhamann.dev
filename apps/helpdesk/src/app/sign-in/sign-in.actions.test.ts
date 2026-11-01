/**
 * Sign-in server actions — a REFUSED sign-in must land on the sign-in page's copy, never on Next's
 * error boundary.
 *
 * The finding this covers: deactivate a user in /admin/users, sign out, then pick that
 * person's persona on /sign-in. `callbacks.signIn` correctly refused and no session was created — but
 * the resulting `AccessDenied` escaped the server action, so the operator saw "Application error: a
 * server-side exception has occurred" with a bare digest. The copy for `?error=AccessDenied` already
 * existed in `page.tsx` and was simply unreachable.
 *
 * What is mocked and why: `next/navigation` is replaced with a faithful stand-in (a `redirect` that
 * throws a NEXT_REDIRECT-shaped signal, and an `unstable_rethrow` that re-throws exactly those) so the
 * assertions are about this module's control flow rather than about Next's request store, which does
 * not exist under vitest. `@/auth` and `@/lib/dev-login` are mocked because the behaviour under test
 * is what this module does with what Auth.js throws. `@/lib/rbac` runs for real: `safeRelativePath` is
 * the callback-URL policy, and mocking it would test nothing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// `next-auth`'s entrypoint pulls in `next/server`, which vitest's node environment cannot resolve.
// It is stood up here from the package it re-exports the error classes from, so `AuthError` is the
// REAL class and the `instanceof` branch under test is exercised, not simulated.
vi.mock("next-auth", async () => {
  const errors = await vi.importActual<typeof import("@auth/core/errors")>("@auth/core/errors");
  return { AuthError: errors.AuthError, CredentialsSignin: errors.CredentialsSignin };
});

import { AuthError } from "next-auth";

const nav = vi.hoisted(() => {
  const PREFIX = "NEXT_REDIRECT";
  class RedirectSignal extends Error {
    readonly digest: string;
    constructor(url: string) {
      const digest = `${PREFIX};replace;${url};307;`;
      super(digest);
      this.name = "RedirectSignal";
      this.digest = digest;
    }
  }
  const isFrameworkError = (e: unknown): boolean => {
    const digest = (e as { digest?: unknown } | null | undefined)?.digest;
    return typeof digest === "string" && digest.startsWith(PREFIX);
  };
  return {
    PREFIX,
    RedirectSignal,
    redirect: vi.fn((url: string): never => {
      throw new RedirectSignal(url);
    }),
    /** Next's helper re-throws framework control-flow errors and ignores everything else. */
    unstable_rethrow: vi.fn((e: unknown): void => {
      if (isFrameworkError(e)) throw e;
    }),
  };
});
vi.mock("next/navigation", () => ({ redirect: nav.redirect, unstable_rethrow: nav.unstable_rethrow }));

const authMock = vi.hoisted(() => ({ signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/auth", () => authMock);

import { signInWithGoogle, signInWithOkta, signOutAction } from "@/app/sign-in/sign-in.actions";

/** A real `AuthError` carrying a given `type` — the shape Auth.js throws out of `signIn`. */
function authErrorOfType(type: string): AuthError {
  const error = new AuthError("refused");
  (error as unknown as { type: string }).type = type;
  return error;
}

/** The `?error=` code a call redirected with, or `null` when it did not redirect to /sign-in. */
function signInErrorCode(error: unknown): string | null {
  if (!(error instanceof nav.RedirectSignal)) return null;
  const target = error.digest.split(";")[2] ?? "";
  if (!target.startsWith("/sign-in")) return null;
  return new URL(target, "https://wm-helpdesk.invalid").searchParams.get("error");
}

/** Every `?error=` key `src/app/sign-in/page.tsx` has fixed copy for, read from the page itself. */
function pageErrorKeys(): Set<string> {
  const source = readFileSync(path.join(process.cwd(), "src/app/sign-in/page.tsx"), "utf8");
  const block = /const ERROR_MESSAGES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source);
  expect(block, "ERROR_MESSAGES not found in src/app/sign-in/page.tsx").not.toBeNull();
  const keys = new Set<string>();
  for (const m of (block?.[1] ?? "").matchAll(/^\s{2}([A-Za-z]+):/gm)) keys.add(m[1]);
  return keys;
}

/**
 * Every `AuthError.type` Auth.js declares, plus an invented one. Shared by the Okta and Google sweeps
 * below: both actions funnel through the same table, so a type that resolves to page copy for one and not
 * the other would be a table that had been split without anyone meaning to.
 */
const AUTH_ERROR_TYPES = [
  "AccessDenied", "AdapterError", "CallbackRouteError", "ErrorPageLoop", "EventError",
  "InvalidCallbackUrl", "CredentialsSignin", "InvalidEndpoints", "InvalidCheck",
  "JWTSessionError", "MissingAdapter", "MissingAdapterMethods", "MissingAuthorize",
  "MissingSecret", "OAuthAccountNotLinked", "OAuthCallbackError", "OAuthProfileParseError",
  "SessionTokenError", "OAuthSignInError", "EmailSignInError", "SignOutError", "UnknownAction",
  "UnsupportedStrategy", "InvalidProvider", "UntrustedHost", "Verification", "MissingCSRF",
  "AccountNotLinked", "DuplicateConditionalUI", "MissingWebAuthnAutocomplete",
  "WebAuthnVerificationError", "ExperimentalFeatureNotEnabled", "SomethingAuthJsAddsLater",
];

afterEach(() => {
  vi.clearAllMocks();
});

describe("signInWithOkta", () => {
  it("turns AccessDenied into /sign-in?error=AccessDenied", async () => {
    authMock.signIn.mockRejectedValueOnce(authErrorOfType("AccessDenied"));

    const thrown = await signInWithOkta("/dashboard").catch((e: unknown) => e);

    expect(signInErrorCode(thrown)).toBe("AccessDenied");
  });

  it("lets the provider redirect through and sanitizes the callback URL", async () => {
    authMock.signIn.mockImplementationOnce(() => {
      throw new nav.RedirectSignal("https://okta.example/oauth2/v1/authorize");
    });

    const thrown = await signInWithOkta("//evil.example").catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(nav.RedirectSignal);
    expect(authMock.signIn).toHaveBeenCalledWith("okta", { redirectTo: "/dashboard" });
    expect(nav.redirect).not.toHaveBeenCalled();
  });

  it("does not mislabel a deployment fault as a deactivated account", async () => {
    authMock.signIn.mockRejectedValueOnce(authErrorOfType("UntrustedHost"));

    const thrown = await signInWithOkta("/dashboard").catch((e: unknown) => e);

    expect(signInErrorCode(thrown)).toBe("Configuration");
  });

  it("falls back to a code the page has copy for when the AuthError type is unmapped", async () => {
    authMock.signIn.mockRejectedValueOnce(authErrorOfType("WebAuthnVerificationError"));

    const thrown = await signInWithOkta("/dashboard").catch((e: unknown) => e);

    expect(signInErrorCode(thrown)).toBe("Callback");
  });

  it("only ever emits an ?error= code that src/app/sign-in/page.tsx has fixed copy for", async () => {
    // Every `AuthError.type` Auth.js declares, plus an invented one, must resolve to page copy —
    // otherwise a refusal renders the anonymous "Sign-in failed. Try again." fallback.
    const authErrorTypes = AUTH_ERROR_TYPES;
    const known = pageErrorKeys();
    expect(known.has("AccessDenied")).toBe(true);

    const unknown: string[] = [];
    for (const type of authErrorTypes) {
      authMock.signIn.mockRejectedValueOnce(authErrorOfType(type));
      const code = signInErrorCode(await signInWithOkta("/dashboard").catch((e: unknown) => e));
      if (code === null || !known.has(code)) unknown.push(`${type} -> ${String(code)}`);
    }
    expect(unknown).toEqual([]);
  });
});

/**
 * The temporary Google sign-in. It is asserted as thoroughly as the Okta twin because it owns two things
 * nothing else covers:
 *
 *  - the literal provider id `"google"`. `src/auth.config.test.ts` asserts the PROVIDER's id; nothing
 *    asserted the CALLER's string, so a typo (`"Google"`, `"google-oauth"`) would type-check, render a
 *    button, pass every existing test and fail at runtime for every user.
 *  - the `AuthError` funnel, which is the user-visible half of the refusal: `callbacks.signIn` returns
 *    false for an out-of-domain, unverified or non-Workspace Google identity, and without the funnel that
 *    surfaces as Next's error boundary instead of /sign-in?error=AccessDenied, whose copy names the domain
 *    restriction and who to ask.
 */
describe("signInWithGoogle", () => {
  it("turns the domain gate's AccessDenied into /sign-in?error=AccessDenied, not a 500", async () => {
    authMock.signIn.mockRejectedValueOnce(authErrorOfType("AccessDenied"));

    const thrown = await signInWithGoogle("/dashboard").catch((e: unknown) => e);

    expect(signInErrorCode(thrown)).toBe("AccessDenied");
    expect(nav.redirect).toHaveBeenCalledWith("/sign-in?error=AccessDenied");
    expect(thrown).not.toBeInstanceOf(AuthError);
  });

  it("calls Auth.js with the provider id \"google\" and sanitizes the callback URL", async () => {
    authMock.signIn.mockImplementationOnce(() => {
      throw new nav.RedirectSignal("https://accounts.google.com/o/oauth2/v2/auth");
    });

    const thrown = await signInWithGoogle("//evil.example").catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(nav.RedirectSignal);
    expect(authMock.signIn).toHaveBeenCalledWith("google", { redirectTo: "/dashboard" });
    expect(nav.redirect).not.toHaveBeenCalled();
  });

  it("does not mislabel a deployment fault as a refused account", async () => {
    authMock.signIn.mockRejectedValueOnce(authErrorOfType("UntrustedHost"));

    const thrown = await signInWithGoogle("/dashboard").catch((e: unknown) => e);

    expect(signInErrorCode(thrown)).toBe("Configuration");
  });

  it("reports an existing User row with the same email as OAuthAccountNotLinked, not as AccessDenied", async () => {
    // @auth/core throws this BEFORE `callbacks.signIn` when a row already holds the email and carries no
    // Google Account link — `allowDangerousEmailAccountLinking` is deliberately absent (the build record
    // §4), so this is the fail-closed answer and its copy must not read as "your account was deactivated".
    authMock.signIn.mockRejectedValueOnce(authErrorOfType("OAuthAccountNotLinked"));

    const thrown = await signInWithGoogle("/dashboard").catch((e: unknown) => e);

    expect(signInErrorCode(thrown)).toBe("OAuthAccountNotLinked");
  });

  it("falls back to a code the page has copy for when the AuthError type is unmapped", async () => {
    authMock.signIn.mockRejectedValueOnce(authErrorOfType("WebAuthnVerificationError"));

    const thrown = await signInWithGoogle("/dashboard").catch((e: unknown) => e);

    expect(signInErrorCode(thrown)).toBe("Callback");
  });

  it("re-throws a genuine fault rather than dressing it up as a refusal", async () => {
    const boom = new Error("secret manager is unreachable");
    authMock.signIn.mockRejectedValueOnce(boom);

    await expect(signInWithGoogle("/dashboard")).rejects.toBe(boom);
    expect(nav.redirect).not.toHaveBeenCalled();
  });

  it("only ever emits an ?error= code that src/app/sign-in/page.tsx has fixed copy for", async () => {
    const known = pageErrorKeys();
    expect(known.has("AccessDenied")).toBe(true);

    const unknown: string[] = [];
    for (const type of AUTH_ERROR_TYPES) {
      authMock.signIn.mockRejectedValueOnce(authErrorOfType(type));
      const code = signInErrorCode(await signInWithGoogle("/dashboard").catch((e: unknown) => e));
      if (code === null || !known.has(code)) unknown.push(`${type} -> ${String(code)}`);
    }
    expect(unknown).toEqual([]);
  });
});

describe("signOutAction", () => {
  it("lets the sign-out redirect through", async () => {
    authMock.signOut.mockImplementationOnce(() => {
      throw new nav.RedirectSignal("/sign-in");
    });

    const thrown = await signOutAction().catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(nav.RedirectSignal);
    expect(nav.redirect).not.toHaveBeenCalled();
  });

  it("sends a failed sign-out to /sign-in with no misleading sign-in error code", async () => {
    authMock.signOut.mockRejectedValueOnce(authErrorOfType("SignOutError"));

    const thrown = await signOutAction().catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(nav.RedirectSignal);
    expect(nav.redirect).toHaveBeenCalledWith("/sign-in");
    expect(signInErrorCode(thrown)).toBeNull();
  });

  it("re-throws a genuine fault", async () => {
    const boom = new Error("cookie store unavailable");
    authMock.signOut.mockRejectedValueOnce(boom);

    await expect(signOutAction()).rejects.toBe(boom);
  });
});
