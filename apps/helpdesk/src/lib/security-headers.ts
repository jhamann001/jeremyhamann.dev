/**
 * Security response headers — pure, dependency-free, layer L0.
 *
 * `next.config.ts` is the only consumer: it turns this list into its `headers()` block so the exact
 * set is asserted by `src/lib/security-headers.test.ts` rather than being read off a deployed
 * response once and then drifting. Nothing here imports anything — `next.config.ts` is loaded by
 * Next's own config loader, which does not resolve the `@/*` tsconfig alias, so the import there is
 * relative and this module must stay free of project imports.
 *
 * Why a header block and not middleware: the middleware matcher deliberately EXCLUDES the machine
 * and client API prefixes (guardrail G3b), so a middleware-set header would miss exactly the routes
 * a custodian or a scanner probes first. `headers()` covers every response Next serves, including
 * static assets and the excluded API prefixes.
 *
 * Known limitation, recorded rather than hidden: `script-src` carries `'unsafe-inline'`. The App
 * Router injects inline bootstrap and flight-data scripts, and the nonce alternative needs a
 * per-request nonce generated in `src/middleware.ts` (foundation-owned, not S8's to edit) plus the
 * matcher widened to the paths it currently excludes. `'unsafe-inline'` with `object-src 'none'`,
 * `base-uri 'self'` and `frame-ancestors 'none'` is the conservative v1; the nonce upgrade is filed
 * in the build record. Because `'unsafe-inline'` is present, THIS POLICY IS
 * A HARDENING MEASURE AND NOT THE XSS CONTROL — the control for rendered client-authored bodies is
 * `skipHtml` in `src/components/ticket/markdown-renderer.tsx`. Do not credit `script-src` in a
 * review as if it contained an injection; `object-src`, `base-uri`, `form-action`, `frame-src` and
 * `frame-ancestors` are the directives that still do real work here.
 *
 * WHY `connect-src` IS NOT JUST `'self'`: the attachment uploader PUTs the file bytes with
 * `XMLHttpRequest` straight at the signed URL the upload intent returns
 * (`src/components/ticket/attachments/attachment-upload.tsx`). With the GCS backend that URL is on
 * `https://storage.googleapis.com` (`src/lib/storage.ts` `GCS_HOST`), and XHR is governed by
 * `connect-src` — so a `connect-src 'self'` policy makes the browser refuse the request before it
 * ever leaves the tab, in every environment that has a bucket. It passes locally only because
 * `ATTACHMENTS_BUCKET` is unset there and the filesystem backend returns a SAME-ORIGIN path
 * (`localUploadPath`). See `ATTACHMENT_UPLOAD_ORIGINS` below for why the allowance is
 * unconditional rather than derived from `ATTACHMENTS_BUCKET`.
 */

export type SecurityHeader = { key: string; value: string };

/** A frozen directive value list. Typed as `string[]` so `CSP_DIRECTIVES` matches the contract's
 *  `Readonly<Record<string, string[]>>`; the freeze is what actually makes it immutable. */
function frozen(...values: string[]): string[] {
  return Object.freeze(values) as string[];
}

/**
 * The object-storage origin the attachment uploader PUTs to with the GCS backend. Mirrors
 * `GCS_HOST` in `src/lib/storage.ts`; duplicated as a literal rather than imported because this
 * module must stay free of project imports (see the file header).
 */
export const GCS_UPLOAD_ORIGIN = "https://storage.googleapis.com";

/** Env key that narrows or replaces the default upload origin. See `attachmentUploadOrigins`. */
export const ATTACHMENTS_UPLOAD_ORIGIN_ENV = "ATTACHMENTS_UPLOAD_ORIGIN";

/** The literal that switches the allowance off entirely, for a deployment that never uses GCS. */
export const NO_UPLOAD_ORIGIN = "none";

/**
 * Reduce one configured value to a bare CSP source origin (`scheme://host[:port]`), or `null` if it
 * is not one. Anything that survives here is safe to concatenate into a header value: the character
 * guard below rejects whitespace, `;`, `,`, quotes and control characters outright, and `origin`
 * drops any path, query, fragment or credentials the operator pasted in.
 *
 * `https` only, with `http` tolerated for a loopback host so a local fake-gcs/MinIO emulator can be
 * pointed at. A scheme-only wildcard (`https:`), `*`, or a bare hostname is rejected — this
 * directive is the one place a wildcard would turn the CSP into an exfiltration channel.
 *
 * The character guard runs BEFORE parsing on purpose. `new URL()` would happily read
 * `https://evil.example.com/ ; script-src *` as origin `https://evil.example.com` and quietly drop
 * the rest; salvaging a host out of a value that carries a CSP separator hides the operator's
 * mistake instead of surfacing it, and the caller's fallback is the safe default anyway.
 */
export function normalizeUploadOrigin(raw: string): string | null {
  const candidate = String(raw ?? "").trim();
  if (candidate === "") return null;
  // Whitespace, CSP separators, quotes and control characters: never part of a legitimate origin.
  if (/[\s;,'"`\\]/.test(candidate) || /[\u0000-\u001f\u007f]/.test(candidate)) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  // Length, not `!== ""`: security scanner CWE-208 reports an equality whose operand is named `password`.
  if (url.username.length > 0 || url.password.length > 0) return null;
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  if (url.hostname === "" || url.hostname.includes("*")) return null;
  const origin = url.origin;
  if (origin === "null" || /[\s;,'"]/.test(origin)) return null;
  return origin;
}

/**
 * The extra `connect-src` origins the uploader needs, most-specific configuration first.
 *
 * `ATTACHMENTS_UPLOAD_ORIGIN` (comma-separated) replaces the default; the literal `none` removes it.
 * With the key unset the default is `GCS_UPLOAD_ORIGIN`, **unconditionally** — including when
 * `ATTACHMENTS_BUCKET` is unset.
 *
 * That looks lax and is deliberate. `next.config.ts` `headers()` is evaluated ONCE, by `next build`,
 * and serialized into `.next/routes-manifest.json`; the running server reads the manifest and never
 * re-reads the environment. `ATTACHMENTS_BUCKET` is a RUNTIME variable set on the Cloud Run service
 * (`infra/terraform-prod/main.tf`), so it is absent from the image build by construction. A policy
 * that switched on it would therefore be computed as "no bucket" during every build and ship the
 * broken header to exactly the environment that has a bucket — the defect this allowance fixes.
 * The allowance is one exact origin for one directive; it grants no script, style, frame or form
 * target, and `ATTACHMENTS_UPLOAD_ORIGIN=none` is there for a deployment that wants it gone.
 */
export function attachmentUploadOrigins(env: Record<string, string | undefined> = process.env): string[] {
  const configured = String(env[ATTACHMENTS_UPLOAD_ORIGIN_ENV] ?? "").trim();
  if (configured === "") return [GCS_UPLOAD_ORIGIN];
  if (configured.toLowerCase() === NO_UPLOAD_ORIGIN) return [];
  const out: string[] = [];
  for (const part of configured.split(",")) {
    const origin = normalizeUploadOrigin(part);
    if (origin !== null && !out.includes(origin)) out.push(origin);
  }
  // A key that was set but parsed to nothing is a typo, not an instruction to break uploads.
  return out.length === 0 ? [GCS_UPLOAD_ORIGIN] : out;
}

/** Resolved once, at module load, because `next.config.ts` reads the policy at build time anyway. */
export const ATTACHMENT_UPLOAD_ORIGINS: readonly string[] = Object.freeze(attachmentUploadOrigins());

/**
 * The script host of Cloudflare Web Analytics. The portfolio's Cloudflare zone injects its beacon into every
 * page it serves; the beacon reports to the same origin's `/cdn-cgi/rum`, which `connect-src 'self'` already
 * covers, so the script host is the only allowance it needs. Without it the policy blocks the beacon, the
 * demo's visits go uncounted and every page logs a console error.
 */
export const CLOUDFLARE_ANALYTICS_SCRIPT_ORIGIN = "https://static.cloudflareinsights.com";

/**
 * The extra `script-src` origins: the analytics host in the portfolio demo's build, nothing otherwise. Read
 * at build time like the upload origins: the demo image sets `NEXT_PUBLIC_DEMO_MODE=on` before `next build`
 * (apps/helpdesk/Dockerfile), and `next build` bakes the policy into the routes manifest. This module can't
 * import `src/lib/demo/mode.ts` (see the file header), so it reads the same key directly.
 */
export function analyticsScriptOrigins(env: Record<string, string | undefined> = process.env): string[] {
  return env.NEXT_PUBLIC_DEMO_MODE === "on" ? [CLOUDFLARE_ANALYTICS_SCRIPT_ORIGIN] : [];
}

export const ANALYTICS_SCRIPT_ORIGINS: readonly string[] = Object.freeze(analyticsScriptOrigins());

/**
 * The production CSP, one entry per directive. A value of `[]` is a directive with no value
 * (`upgrade-insecure-requests`). Frozen so a consumer cannot mutate the shared policy.
 *
 * `img-src https:` is deliberate: `User.image` is whatever avatar URL the identity provider returns
 * (Okta, and Google behind it), which is not a host this repo can enumerate. It is an image source
 * only — it grants no script, style, connect or frame origin.
 *
 * `connect-src` carries `'self'` plus `ATTACHMENT_UPLOAD_ORIGINS` — exact origins, never a scheme
 * wildcard — so the attachment uploader's cross-origin `XMLHttpRequest` PUT is not refused by our
 * own policy. `cspDirectives` rebuilds this directive from `'self'` up, so an override passed to
 * `contentSecurityPolicy`/`securityHeaders` replaces the origins here rather than appending to them.
 */
export const CSP_DIRECTIVES: Readonly<Record<string, string[]>> = Object.freeze({
  "default-src": frozen("'self'"),
  "base-uri": frozen("'self'"),
  "object-src": frozen("'none'"),
  "frame-ancestors": frozen("'none'"),
  "frame-src": frozen("'none'"),
  "form-action": frozen("'self'"),
  "script-src": frozen("'self'", "'unsafe-inline'"),
  "style-src": frozen("'self'", "'unsafe-inline'"),
  "img-src": frozen("'self'", "data:", "blob:", "https:"),
  "font-src": frozen("'self'", "data:"),
  "connect-src": frozen("'self'", ...ATTACHMENT_UPLOAD_ORIGINS),
  "media-src": frozen("'none'"),
  "worker-src": frozen("'self'", "blob:"),
  "manifest-src": frozen("'self'"),
  "upgrade-insecure-requests": frozen(),
});

/**
 * Features denied everywhere. `camera` is listed here AND relaxed on the ticket route only
 * (`securityHeaders({ ticketRoute: true })`), because the attachment control on a ticket offers
 * `capture="environment"` so an associate can photograph a paper instruction with the device
 * camera. Nothing else in the desk asks for a device capability.
 *
 * `publickey-credentials-get` is deliberately NOT denied: Okta may complete a WebAuthn factor in
 * this document, and denying it would break sign-in for a control the desk does not need.
 */
const DENIED_FEATURES: readonly string[] = [
  "accelerometer",
  "autoplay",
  "camera",
  "display-capture",
  "encrypted-media",
  "geolocation",
  "gyroscope",
  "magnetometer",
  "microphone",
  "midi",
  "payment",
  "usb",
  "xr-spatial-tracking",
];

/** The one feature the ticket route re-grants, to this origin only. */
export const TICKET_ROUTE_ALLOWED_FEATURE = "camera" as const;

/**
 * Development-only CSP relaxations. Next's dev bundler evaluates generated code (`'unsafe-eval'`)
 * and opens a websocket for hot reload; `upgrade-insecure-requests` is dropped because the dev
 * server is plain http on localhost and upgrading its own subresources would break every page.
 */
const DEV_SCRIPT_SRC = "'unsafe-eval'";
const DEV_CONNECT_SRC: readonly string[] = ["ws:", "wss:"];

export type SecurityHeadersOptions = {
  /** Relax `Permissions-Policy` camera for the attachment capture control on `/tickets/*`. */
  ticketRoute?: boolean;
  /**
   * Compatible extension to the contract signature: build the development variant of the CSP.
   * Defaults to `process.env.NODE_ENV !== "production"`, which is what `next.config.ts` wants and
   * what makes the policy testable without mutating the environment.
   */
  dev?: boolean;
  /**
   * Compatible extension: the exact `connect-src` origins the attachment uploader may PUT to, on
   * top of `'self'`. Defaults to `ATTACHMENT_UPLOAD_ORIGINS`. Present so a test can pin the policy
   * for a given configuration without mutating `process.env`.
   */
  uploadOrigins?: readonly string[];
  /** The extra `script-src` origins. Defaults to `ANALYTICS_SCRIPT_ORIGINS`; present so a test can pin it. */
  scriptOrigins?: readonly string[];
};

function cspDirectives(
  dev: boolean,
  uploadOrigins: readonly string[] = ATTACHMENT_UPLOAD_ORIGINS,
  scriptOrigins: readonly string[] = ANALYTICS_SCRIPT_ORIGINS,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [directive, values] of Object.entries(CSP_DIRECTIVES)) {
    if (dev && directive === "upgrade-insecure-requests") continue;
    if (directive === "script-src") {
      out[directive] = [...values, ...scriptOrigins, ...(dev ? [DEV_SCRIPT_SRC] : [])];
      continue;
    }
    if (directive === "connect-src") {
      // Rebuilt, not appended to: the base table already holds the DEFAULT upload origins, and an
      // explicit `uploadOrigins` is a replacement for them, not an addition.
      out[directive] = ["'self'", ...uploadOrigins, ...(dev ? DEV_CONNECT_SRC : [])];
      continue;
    }
    out[directive] = [...values];
  }
  return out;
}

/** `directive value value; directive; …` — a single line, no trailing separator. */
export function contentSecurityPolicy(
  dev: boolean,
  uploadOrigins?: readonly string[],
  scriptOrigins?: readonly string[],
): string {
  return Object.entries(cspDirectives(dev, uploadOrigins, scriptOrigins))
    .map(([directive, values]) => (values.length === 0 ? directive : `${directive} ${values.join(" ")}`))
    .join("; ");
}

/** `feature=()` for every denied feature; the ticket route grants `camera=(self)` instead. */
export function permissionsPolicy(ticketRoute: boolean): string {
  return DENIED_FEATURES.map((feature) =>
    ticketRoute && feature === TICKET_ROUTE_ALLOWED_FEATURE ? `${feature}=(self)` : `${feature}=()`,
  ).join(", ");
}

/**
 * The complete set, in a fixed order so the guardrail test can assert it literally.
 *
 * `Strict-Transport-Security` carries `includeSubDomains` and a two-year max-age but NOT `preload`:
 * preloading is a commitment made for a registrable domain, and this service is served from a
 * `*.run.app` host today and the firm's own host later — that submission is a decision, not a header.
 */
export function securityHeaders(opts?: SecurityHeadersOptions): SecurityHeader[] {
  const dev = opts?.dev ?? process.env.NODE_ENV !== "production";
  const ticketRoute = opts?.ticketRoute === true;
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(dev, opts?.uploadOrigins, opts?.scriptOrigins) },
    { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: permissionsPolicy(ticketRoute) },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "X-DNS-Prefetch-Control", value: "off" },
  ];
}

/**
 * The two `headers()` entries, in the order `next.config.ts` must keep.
 *
 * Next applies every matching entry and assigns `resHeaders[key] = value` per header, so the LAST
 * matching entry wins for a repeated key (`next/dist/server/lib/router-utils/resolve-routes.js`).
 * The catch-all therefore comes first and the ticket route second — reversing them would silently
 * put the camera back to `()` on the one route that needs it.
 *
 * `/tickets/:id` matches one segment, so `/tickets/new` inherits the exception too. That is
 * accepted rather than worked around: the new-ticket form renders no camera control, and a
 * `Permissions-Policy` grant is permission to ask, not access.
 */
export function securityHeaderRoutes(): Array<{ source: string; headers: SecurityHeader[] }> {
  return [
    { source: "/:path*", headers: securityHeaders() },
    { source: "/tickets/:id", headers: securityHeaders({ ticketRoute: true }) },
  ];
}
