/**
 * Edge middleware — coarse UX gate only (§h "Middleware").
 * Decisions live in `authConfig.callbacks.authorized`; this file must stay dependency-free.
 *
 * Paths OUTSIDE the matcher answer without a session, each because a different mechanism owns its
 * authentication, and each of those mechanisms is server-side and audited:
 *   /api/auth          Auth.js owns it.
 *   /api/client        bearer CLIENT_API_TOKEN + X-Requester-Email (src/server/client-view.ts).
 *   /api/health        Cloud Run / deploy smoke; two booleans, no record content.
 *   /api/ingest        Wave A machine WRITE path: bearer INTEGRATION_API_TOKEN (src/lib/integration-auth.ts).
 *   /api/export        Wave A machine READ path (the Ops Portal mirror): same bearer.
 *   /api/integrations  Wave A outbox lease / result callbacks: same bearer.
 * A session cookie would be meaningless on all six — the callers are servers, not browsers — and a
 * middleware redirect would turn a 401 into a 307 to /sign-in, which no machine caller can follow.
 * The attachment download route under /api/attachments is deliberately NOT excluded: it is a staff
 * surface and stays behind the session gate, with its own RBAC check and an ATTACHMENT_VIEWED row
 *.
 *
 * The three PWA root files are excluded for a different reason again — not authentication, but the
 * fact that a browser fetches them OUTSIDE any session:
 *   /manifest.webmanifest  fetched uncredentialed (the <link> carries no crossorigin attribute), so
 *                          a 307 to /sign-in is parsed as the manifest and every page load logs a
 *                          JSON syntax error; the app is then not installable at any width.
 *   /sw.js                 `navigator.serviceWorker.register` requires a JavaScript response; handed
 *                          an HTML redirect it rejects, and the whole PWA slice is inert.
 *   /offline.html          the service worker precaches and serves it when the network is gone; a
 *                          redirect caches a sign-in page as the offline shell.
 * None of the three carries client material — they are static files in `public/`, the same category
 * as `favicon.ico` — and the icons under `/icons/**` already answer because of the extension list
 * below, which is exactly why this gap was easy to miss.
 *
 * Every exclusion below is anchored to a path-SEGMENT boundary with `(?:/|$)` (or `$` for a single
 * file such as `favicon.ico` and the three PWA files). A bare prefix inside the negative lookahead
 * would exclude every path that merely STARTS with that text, so a future `/api/clients`,
 * `/api/healthz`, `/api/exports/...`, `/api/integrationsettings` or `/sign-in-help` would silently
 * answer with no session gate. This list is the only place the six non-session-authenticated surfaces
 * are enumerated, so the fencepost is load-bearing; guardrail G3c pins the anchoring.
 */
import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

export default NextAuth(authConfig).auth;

export const config: { matcher: string[] } = {
  matcher: [
    "/((?!api/auth(?:/|$)|api/client(?:/|$)|api/health(?:/|$)|api/ingest(?:/|$)|api/export(?:/|$)|api/integrations(?:/|$)|api/mcp(?:/|$)|_next/static(?:/|$)|_next/image(?:/|$)|favicon\\.ico$|manifest\\.webmanifest$|sw\\.js$|offline\\.html$|sign-in(?:/|$)|no-access(?:/|$)|.*\\.(?:png|svg|ico|jpg|jpeg|webp)$).*)",
  ],
};
