/**
 * The `?error=` code `src/app/sign-in/page.tsx` shows copy for, from a refusal Auth.js threw. Shared by the
 * sign-in server actions (Okta, Google) and the demo personas' form route (src/app/sign-in/persona/route.ts).
 */
import type { AuthError } from "next-auth";

/**
 * `AuthError.type` → the `?error=` code `src/app/sign-in/page.tsx` maps to fixed copy.
 *
 * The table is closed on purpose: only codes that page knows ever reach the URL, so a refusal can
 * never put provider-controlled text — or an Auth.js class name — into a link a locked-out person can
 * share. An unmapped type falls back to `Callback` ("Sign-in could not be completed. Try again.")
 * rather than to `AccessDenied`, which would tell someone their account was deactivated when the real
 * failure was, say, a misconfigured issuer.
 */
const SIGN_IN_ERROR_CODES: Readonly<Record<string, string | undefined>> = {
  // `callbacks.signIn` returned false for a deactivated `User`. Also every other
  // refusal by that hook — the page's copy names both halves (deactivated here, or Okta groups).
  AccessDenied: "AccessDenied",
  CredentialsSignin: "CredentialsSignin",
  Verification: "Verification",
  OAuthSignInError: "OAuthSignin",
  OAuthCallbackError: "OAuthCallbackError",
  OAuthProfileParseError: "OAuthCallbackError",
  OAuthAccountNotLinked: "OAuthAccountNotLinked",
  AccountNotLinked: "OAuthAccountNotLinked",
  CallbackRouteError: "Callback",
  InvalidCallbackUrl: "Callback",
  MissingCSRF: "Callback",
  UnknownAction: "Callback",
  // Deployment faults. "Contact the Operations team" is the right instruction; "try again" is not.
  InvalidProvider: "Configuration",
  InvalidEndpoints: "Configuration",
  MissingSecret: "Configuration",
  MissingAdapter: "Configuration",
  MissingAdapterMethods: "Configuration",
  MissingAuthorize: "Configuration",
  UnsupportedStrategy: "Configuration",
  UntrustedHost: "Configuration",
  AdapterError: "Configuration",
};

const SIGN_IN_FALLBACK_CODE = "Callback";

export function signInErrorCode(error: AuthError): string {
  return SIGN_IN_ERROR_CODES[error.type] ?? SIGN_IN_FALLBACK_CODE;
}
