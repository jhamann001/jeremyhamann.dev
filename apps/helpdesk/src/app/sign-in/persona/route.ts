/**
 * POST /sign-in/persona — the demo personas' sign-in, as a plain form post.
 *
 * It was a server action, and two things made that fail with an error page instead of signing in:
 *  - A destination that redirects again. Next renders a server action's redirect target into the action's
 *    own response; `/` (where every visitor from the portfolio site starts) redirects to /dashboard, the
 *    browser followed that as an ordinary HTTP redirect, and the action got an HTML page instead of its
 *    result: "An unexpected response was received from the server".
 *  - A tab opened before a deploy: each clean build renames every server action.
 * A form post to a fixed path has neither problem. The answer is a 303 to a path, which the browser loads
 * like any page, redirects and all.
 *
 * The checks are the action's: dev login must be on, the destination is a same-origin path (safeRelativePath),
 * and an Auth.js refusal comes back as /sign-in?error=<code>. Next checks a server action's origin itself; a
 * route has to, or another site's form could sign a visitor in as a persona.
 */
import { AuthError } from "next-auth";
import { signIn } from "@/auth";
import { DEV_PROVIDER_ID, isDevLoginEnabled } from "@/lib/dev-login";
import { logError } from "@/lib/logger";
import { safeRelativePath } from "@/lib/rbac";
import { signInErrorCode } from "@/lib/sign-in-errors";

export const dynamic = "force-dynamic";

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
}

/** The browser's own word on where the form came from; the Origin header for one too old to send it. */
function fromThisSite(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin === null || host === null) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!fromThisSite(req)) return new Response("Forbidden", { status: 403 });
  if (!isDevLoginEnabled()) return seeOther("/sign-in?error=Configuration");

  const form = await req.formData().catch(() => null);
  const persona = form?.get("persona");
  const destination = safeRelativePath(form?.get("callbackUrl"), "/dashboard");
  if (typeof persona !== "string" || persona === "") return seeOther("/sign-in?error=CredentialsSignin");

  try {
    await signIn(DEV_PROVIDER_ID, { persona, redirect: false });
  } catch (error) {
    if (error instanceof AuthError) return seeOther(`/sign-in?error=${encodeURIComponent(signInErrorCode(error))}`);
    // Not a refusal: a fault, logged, and the visitor gets the page's "try again" copy rather than a 500.
    logError("route:/sign-in/persona", error);
    return seeOther("/sign-in?error=Callback");
  }
  return seeOther(destination);
}
