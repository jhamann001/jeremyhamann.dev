import { auth } from "@/auth";
import { appWritesPaused } from "@/lib/maintenance";
import { demoMode } from "@/lib/demo/mode";

// Gate the app behind Okta auth. Unauthenticated requests to anything other
// than the public/auth routes are redirected to sign-in.
export default auth((req) => {
  const { pathname } = req.nextUrl;
  const safeMethod = ["GET", "HEAD", "OPTIONS"].includes(req.method);
  const authOrSessionLifecycle =
    pathname.startsWith("/api/auth") || pathname === "/api/session/renew";

  // The public demo has no machine callers: no n8n feeds, no Cloud Scheduler, no AI probe. What they would bring in
  // is seeded instead, so these routes refuse before their handlers (and bearer or OIDC checks) run.
  if (demoMode() && (pathname.startsWith("/api/ingest/") || pathname.startsWith("/api/cron/")
    || pathname === "/api/health/ai")) {
    return Response.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  // The owner-gated canonical-dev cleanup switches the service into read-only
  // mode before touching data. Block every business mutation at the request
  // boundary, including Next.js server-action POSTs, while leaving reads,
  // health checks, sign-in callbacks and session renewal available.
  if (appWritesPaused() && !safeMethod && !authOrSessionLifecycle) {
    return Response.json(
      { error: "temporarily_read_only" },
      { status: 503, headers: { "Retry-After": "60" } },
    );
  }
  const isPublic =
    pathname === "/" ||
    // Okta-tile entry point (IdP-initiated): must be reachable without a
    // session — it IS the way to get a session. See app/login/route.ts.
    pathname === "/login" ||
    pathname.startsWith("/api/auth") ||
    // Unauthenticated health/readiness probe (TDD ADR-7): reachable WITHOUT a
    // session so the Cloud Run / uptime probe + deploy smoke-check work pre-Okta.
    pathname.startsWith("/api/health") ||
    // Phase D ingest (TDD ADR-3): /api/ingest/* is excluded from the Okta
    // session redirect so the routes reach their OWN constant-time bearer
    // check (lib/ingest/auth.ts) instead of a 302 to sign-in. This does NOT
    // make them unauthenticated — the route enforces Bearer <INGEST_TOKEN>
    // and fails closed when the token is unset. The ONLY new exclusion.
    // Trailing slash is deliberate: it scopes the exclusion to the /api/ingest/*
    // subtree (clients, accounts) only — a future sibling like /api/ingest-admin
    // or /api/ingestion does NOT match and stays session-gated.
    pathname.startsWith("/api/ingest/") ||
    // tkt account-AUM feed: /api/cron/* is excluded on the SAME basis as
    // /api/ingest/* — the cron pull route (app/api/cron/account-aum) enforces
    // its OWN Bearer <INGEST_TOKEN> check (requireIngestToken) and fails closed
    // when unset, so it must reach the handler instead of 302-ing to Okta.
    // Trailing slash scopes the exclusion to the /api/cron/* subtree only.
    pathname.startsWith("/api/cron/") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    // Public app icons + web manifest (ticket): the browser fetches these for
    // the tab/app icon before any session exists (e.g. on the login screen), so
    // they must not 302 to sign-in. Covers app/icon.svg, app/apple-icon.png,
    // the manifest route, and the manifest's icon-*.png assets under public/.
    pathname === "/icon.svg" ||
    pathname === "/apple-icon.png" ||
    pathname === "/manifest.webmanifest" ||
    /^\/icon-\d+\.png$/.test(pathname);
  if (!req.auth && !isPublic) {
    // Paging is a JSON fetch, not a document navigation. Keep the exact route
    // session-gated and return 401 so the client can clear retained rows rather
    // than following a redirect and trying to append a branded-login HTML page.
    if (pathname === "/api/households" || pathname === "/api/data-health/jobs" || pathname === "/api/acat-workspace"
      || pathname === "/api/diagnostics/acat-legacy-links"
      || pathname === "/api/trade-requests/requests" || pathname === "/api/trade-requests/counts"
      || pathname === "/api/trade-requests/export"
      || /^\/api\/trade-requests\/(roster|drift\/(history|allow-list|exclusion-overlap|runs\/[^/]{1,40}|overrides\/[^/]{1,200}))$/.test(pathname)
      || /^\/api\/data-health\/jobs\/[a-zA-Z0-9_-]{1,120}\/runs$/.test(pathname)
      || /^\/api\/navigation\/(badges|acat-count|clients|crm|crm-duplicates|audit|reporting|deals|transfers|household-tasks|household-email|household-email\/search|household-activity)$/.test(pathname)) {
      return Response.json(
        { error: "unauthorized" },
        { status: 401, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } },
      );
    }
    // Send unauthenticated users to our branded sign-in at "/" (NOT Auth.js's
    // default /api/auth/signin gray page). Preserve where they were headed as a
    // ?callbackUrl (path only) so the page returns them there after login; the
    // page sanitizes it to a same-origin path (ticket).
    const url = new URL("/", req.nextUrl.origin);
    const dest = req.nextUrl.pathname + req.nextUrl.search;
    if (dest && dest !== "/") url.searchParams.set("callbackUrl", dest);
    return Response.redirect(url);
  }
});

// This middleware imports `@/auth` (next-auth + Prisma), which cannot run on the
// edge runtime. Pin it to node so it is never bundled for edge (TDD §7 / ADR-3).
export const runtime = "nodejs";

export const config = {
  // Run on everything except static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
