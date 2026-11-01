import NextAuth, { type NextAuthRequest } from "next-auth";
import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { authConfig } from "@/lib/auth-config";
import { auth as currentAuth } from "@/lib/auth";
import { rateLimit, parseClientIp, rateLimitKey } from "@/lib/rate-limit-redis";
import { buildCsp, generateNonce } from "@/lib/csp";
import { logger } from "@/lib/logger";
import { demoMode } from "@/lib/demo/mode";
import { DEMO_HISTORY_FULL_MESSAGE, demoHistoryFull } from "@/lib/demo/limits";

// Public paths only decode the JWT for logging/rate-limit keys. Protected
// paths use the same current allow-list/role checks as route handlers. Proxy
// runs in Node.js in Next.js 16, so Prisma is supported here. Keep public and
// machine-auth traffic independent of browser-user database availability.
const { auth: publicAuth } = NextAuth(authConfig);

// Phase 3.3: structured request logging. One log line per API request
// with ip/user/method/path/ua + a generated request id (also returned
// as X-Request-Id) so frontend bug reports can be grep'd against Cloud
// Logging. We log inbound only; the response status is emitted from
// the route handlers themselves (via logger.error in catch blocks).
const LOGGED_PATH_PREFIXES = ["/api/"];

function generateRequestId(): string {
  // 16 random hex chars (64 bits). crypto.randomUUID() isn't available
  // in every deployment runtime this app might target; this is portable
  // and collision-resistant enough for log correlation.
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Paths that don't require a valid session. They *do* still get rate-limited
// (keyed on IP) to blunt credential-stuffing against /login and abuse of
// unauthenticated endpoints. Exact-match `/api/health` so the detailed
// sub-route stays behind auth; `/api/health/*` still requires a session.
// `/api/machine/*` routes carry NO NextAuth session — they authenticate a
// Google OIDC ID token in-app (see `@/lib/machine-auth`). Treat them as
// public here so the session gate below doesn't 401 the machine caller
// before its own token verification runs. They still get IP rate-limited.
const PUBLIC_PATHS = ["/login", "/api/auth/", "/api/machine/"];
const EXACT_PUBLIC_PATHS = new Set([
  "/api/health",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/api/mcp/oauth/register",
  "/api/mcp/oauth/token",
  "/api/mcp/oauth/revoke",
  // ticket: the daily-digest cron is called by a GitHub Action that
  // doesn't carry a NextAuth session. The route validates its own
  // bearer token (DIGEST_CRON_TOKEN) via constant-time compare, so
  // session auth here would just block the legitimate caller.
  "/api/cron/daily-digest",
  // Dedicated constant-time bearer token is checked by the directory route.
  "/api/cron/client-directory",
  // Demo only: the nightly reset, called by the Worker's cron; the route checks DEMO_RESET_TOKEN.
  "/api/internal/demo-reset",
]);

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) return true;
  // Keep OAuth public paths exact. The consent page and approve route remain
  // behind the app session; future /api/mcp/* routes are not public by default.
  if (EXACT_PUBLIC_PATHS.has(pathname)) return true;
  return false;
}

type LimitSpec = { bucket: string; maxTokens: number; interval: number };

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Sign-in and sign-out, the reset, and the presence heartbeat write no history.
const HISTORY_EXEMPT = /^\/api\/(auth|internal|presence)\//;

const GLOBAL_AUTH_LIMIT: LimitSpec = {
  bucket: "api-auth-global",
  maxTokens: 120,
  interval: 60_000,
};

const GLOBAL_ANON_LIMIT: LimitSpec = {
  bucket: "api-anon-global",
  maxTokens: 60,
  interval: 60_000,
};

// Tighter per-endpoint quotas for expensive or abusable routes. Applied
// instead of the generic global limit when the request matches.
const PER_ENDPOINT_LIMITS: Array<{
  method: string;
  test: (p: string) => boolean;
  spec: LimitSpec;
}> = [
  {
    method: "POST", test: (p) => p === "/api/clients/search",
    spec: { bucket: "client-search", maxTokens: 60, interval: 60_000 },
  },
  {
    method: "PUT", test: (p) => /^\/api\/acats\/[^/]+\/client-identity$/.test(p),
    spec: { bucket: "client-identity-relink", maxTokens: 30, interval: 60_000 },
  },
  {
    method: "POST",
    test: (p) => p === "/api/asset-mapping",
    spec: { bucket: "asset-mapping-post", maxTokens: 10, interval: 60_000 },
  },
  {
    method: "POST",
    test: (p) => p === "/api/fees",
    spec: { bucket: "fees-post", maxTokens: 30, interval: 60_000 },
  },
  {
    method: "POST",
    test: (p) => p === "/api/acats",
    spec: { bucket: "acats-post", maxTokens: 60, interval: 60_000 },
  },
  {
    // Building a transfer form is the app's costliest request.
    method: "POST",
    test: (p) => /^\/api\/acats\/[^/]+\/manual-form-recommendation$/.test(p),
    spec: { bucket: "transfer-form", maxTokens: 10, interval: 60_000 },
  },
];

function pickLimit(method: string, pathname: string, isAuthed: boolean): LimitSpec {
  for (const entry of PER_ENDPOINT_LIMITS) {
    if (entry.method === method && entry.test(pathname)) {
      return entry.spec;
    }
  }
  return isAuthed ? GLOBAL_AUTH_LIMIT : GLOBAL_ANON_LIMIT;
}

function buildPassthroughResponse(
  req: Request,
  opts: { nonce: string; csp: string; rateRemaining?: number; requestId: string }
): NextResponse {
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", opts.nonce);
  requestHeaders.set("x-request-id", opts.requestId);
  // Propagating CSP on the request lets Next.js App Router hydrate its own
  // inline scripts with the matching nonce.
  requestHeaders.set("Content-Security-Policy", opts.csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", opts.csp);
  res.headers.set("X-Request-Id", opts.requestId);
  if (opts.rateRemaining != null) {
    res.headers.set("X-RateLimit-Remaining", String(opts.rateRemaining));
  }
  return res;
}

const handleRequest: (
  req: NextAuthRequest,
  event: NextFetchEvent
) => Promise<NextResponse> = async (req) => {
  const { pathname } = req.nextUrl;
  const method = req.method ?? "GET";
  const isPub = isPublic(pathname);
  const isApi = pathname.startsWith("/api/");

  const nonce = generateNonce();
  const csp = buildCsp({ nonce, isDev: process.env.NODE_ENV !== "production" });
  const requestId = generateRequestId();

  if (LOGGED_PATH_PREFIXES.some((p) => pathname.startsWith(p))) {
    const email =
      (req.auth as { user?: { email?: string } } | null)?.user?.email ?? null;
    const ip = parseClientIp(req.headers.get("x-forwarded-for"), 1);
    const ua = req.headers.get("user-agent") ?? "";
    logger.info(
      {
        requestId,
        method,
        path: pathname,
        user: email,
        ip,
        // Trim UA to keep log lines bounded; a pathological long UA
        // shouldn't blow up per-request log cost.
        ua: ua.length > 200 ? ua.slice(0, 200) : ua,
      },
      "api request"
    );
  }

  if (!isPub && !req.auth?.user?.email) {
    if (isApi) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", `${pathname}${req.nextUrl.search}`);
    return NextResponse.redirect(loginUrl);
  }

  if (!isPub) {
    const role = (req.auth as { user?: { role?: string } })?.user?.role;

    // ticket: ADVISOR is a third role with read-only access to the
    // /advisor surface and its API. Everything else (ops dashboard,
    // records page, admin tools, ops API) must redirect/403 so a
    // misclicked link or stale bookmark never leaks data the redaction
    // layer is supposed to hide.
    if (role === "ADVISOR") {
      const isAdvisorAllowed =
        pathname === "/advisor" ||
        pathname.startsWith("/advisor/") ||
        pathname.startsWith("/api/advisor/") ||
        // The post-login signOut and account avatar use these — without
        // them the advisor can't even log out.
        pathname.startsWith("/api/auth/") ||
        // Keep static asset fetches working.
        pathname.startsWith("/_next/") ||
        pathname === "/favicon.ico";
      if (!isAdvisorAllowed) {
        if (isApi) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        return NextResponse.redirect(new URL("/advisor", req.url));
      }
    } else {
      // ticket: non-advisor users (USER, ADMIN) must NOT see the
      // advisor surface — it's role-specific UI, not "extra" view. ADMIN
      // is the one exception so admins can sanity-check the redaction
      // surface; USER falls through to the redirect.
      if (pathname.startsWith("/advisor") || pathname.startsWith("/api/advisor")) {
        if (role !== "ADMIN") {
          if (isApi) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
          }
          return NextResponse.redirect(new URL("/", req.url));
        }
      }
    }

    // /admin/custodians* is view-accessible to all authenticated users; the
    // page hides edit controls for non-admins and the mutating API routes
    // enforce admin themselves via requireAdmin().
    const isAdminGated =
      (pathname.startsWith("/admin") && !pathname.startsWith("/admin/custodians")) ||
      pathname.startsWith("/api/admin");
    if (isAdminGated) {
      if (role !== "ADMIN") {
        if (isApi) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        return NextResponse.redirect(new URL("/", req.url));
      }
    }
  }

  // Rate limit every API request (authed or not), plus /login so that
  // unauthenticated credential-stuffing is bounded. Cloud Run sits behind
  // a single Google front-end hop, so trustHops=1 gets the real client IP.
  const rateLimitTarget =
    isApi ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/.well-known/");
  if (rateLimitTarget) {
    const email = (req.auth as { user?: { email?: string } } | null)?.user?.email ?? null;
    const isAuthed = !!email;
    const spec = pickLimit(method, pathname, isAuthed);
    // Demo personas are shared accounts, so their quota is kept per visitor (see rateLimitKey).
    const key = rateLimitKey(email, req.headers.get("x-forwarded-for"));
    const { allowed, remaining } = await rateLimit(spec.bucket, key, {
      maxTokens: spec.maxTokens,
      interval: spec.interval,
    });
    if (!allowed) {
      return NextResponse.json(
        { error: "Too many requests" },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil(spec.interval / 1000)),
            "X-RateLimit-Remaining": "0",
          },
        }
      );
    }
    // Demo: record history grows with every change and is capped (see demoHistoryFull).
    if (isAuthed && isApi && WRITE_METHODS.has(method) && !HISTORY_EXEMPT.test(pathname) && (await demoHistoryFull())) {
      return NextResponse.json({ error: DEMO_HISTORY_FULL_MESSAGE }, { status: 429 });
    }
    return buildPassthroughResponse(req, {
      nonce,
      csp,
      rateRemaining: remaining,
      requestId,
    });
  }

  return buildPassthroughResponse(req, { nonce, csp, requestId });
};

const handleProtectedRequest = currentAuth(handleRequest);
const handlePublicRequest = publicAuth(handleRequest);

// Auth.js hands the handler the request with its address rewritten to NEXTAUTH_URL (the public https
// origin), so a redirect built from it is absolute and https. Put the caller's own origin back: Next then
// sends a relative Location, which a browser resolves against the address it used. The demo's container
// platform needs this: its start check calls "/" over plain http inside Cloudflare and follows the
// redirect, and it can't reach an https address there.
function withCallerOrigin(req: NextRequest, response: Response): Response {
  const location = response.headers.get("Location");
  const authUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  if (!location || !authUrl) return response;
  let target: URL;
  try {
    target = new URL(location);
  } catch {
    return response;
  }
  if (target.origin !== new URL(authUrl).origin || target.origin === req.nextUrl.origin) return response;
  response.headers.set("Location", `${req.nextUrl.origin}${target.pathname}${target.search}${target.hash}`);
  return response;
}

// The demo's Worker answers 404 for these before they reach the app. The app does too, in case it is
// ever reached another way: the scheduled jobs, the machine API for the firm's other systems, and the
// MCP server's OAuth (MCP is off in the demo). The nightly reset checks its own token.
const DEMO_CLOSED_PATHS = /^\/(api\/(cron|machine|mcp)(\/|$)|mcp\/oauth(\/|$)|\.well-known\/oauth-)/i;

export default async function proxy(req: NextRequest, event: NextFetchEvent) {
  if (demoMode() && DEMO_CLOSED_PATHS.test(req.nextUrl.pathname)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const response = await (isPublic(req.nextUrl.pathname)
    ? handlePublicRequest(req, event)
    : handleProtectedRequest(req, event));
  return response instanceof Response ? withCallerOrigin(req, response) : response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
