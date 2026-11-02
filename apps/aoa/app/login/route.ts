import { redirect } from "next/navigation";
import { signIn } from "@/auth";
import { DEV_LOGIN } from "@/lib/auth/mode";

// Okta-tile entry point (IdP-initiated login). The tile GETs the app's
// "Initiate login URI"; Auth.js v5 only accepts sign-in as a CSRF'd POST, so
// pointing the tile straight at /api/auth/signin/okta 500s (hit live,
// 2026-07-02). This route accepts the GET (any query params Okta adds are
// ignored) and immediately starts the SP-initiated flow server-side —
// signIn() throws a redirect to the Okta authorize URL, so the tile is
// one-click into the app.
export const runtime = "nodejs";

export async function GET() {
  // Dev-login mode has no Okta provider (credentials-only) — land on the persona
  // page. Gate on DEV_LOGIN, not NODE_ENV, so this stays correct on the deployed
  // aoa-dev instance (NODE_ENV=production + AUTH_DEV_LOGIN=1), where calling
  // signIn("okta") would throw on an unregistered provider.
  if (DEV_LOGIN) redirect("/");
  await signIn("okta", { redirectTo: "/command-center" });
}
