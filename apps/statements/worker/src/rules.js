// The Worker's request rules, kept apart from the container binding so they can be tested in Node.

// No outside caller in the demo, as in the app's own list (demo.py, PRIVATE_PATHS): the Drive scan, the scheduler's
// routes and backfills, the machine API, MCP and its tokens, and FastAPI's generated API docs. Also the nightly
// reset, which the cron below hands the container directly, never through this check.
export const PRIVATE_PATHS =
  /^\/(scan|mcp|docs|redoc|openapi\.json|api\/(scan|schedule-status|destinations\/backfill|staleness\/backfill|mcp-tokens|v1|internal))(\/|$)/;

// Headers the app never sees. Every cf-* header goes: Cloudflare's own carry the visitor's address and location
// (CF-Connecting-IP, CF-IPCountry and the rest), and the container library routes on cf-container-target-port
// (another port inside the container). The named ones describe the visitor's connection, which only the Worker
// knows; it sets X-Forwarded-For (the pseudonym) and -Proto itself.
export const STRIPPED_HEADERS = ['forwarded', 'true-client-ip', 'x-forwarded-host', 'x-forwarded-port', 'x-real-ip'];

/** The visitor's headers as the app may see them. */
export function forwardableHeaders(headers) {
  const out = new Headers();
  for (const [name, value] of headers) {
    if (!name.startsWith('cf-') && !STRIPPED_HEADERS.includes(name)) out.append(name, value);
  }
  return out;
}

// The largest request body the demo accepts, the same as the app's own cap (demo.py, MAX_BODY_BYTES).
export const MAX_BODY_BYTES = 128 * 1024;

// Who a visitor is, for rate limits: the IPv4 address, or for IPv6 the /64 network.
export function visitorKey(ip) {
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => (g || '0').toLowerCase()).join(':')}::/64`;
}

// The path as the app's router will see it: percent-decoded, repeated slashes collapsed, lower case, so an
// encoded or doubled spelling can't slip a private path past the check. Null if malformed.
export function routedPath(pathname) {
  try {
    return decodeURIComponent(pathname).replace(/\/{2,}/g, '/').toLowerCase();
  } catch {
    return null;
  }
}

/** Whether a request's body is within the cap. A body with no declared length is refused rather than read. */
export function bodyWithinLimit(request) {
  if (request.method === 'GET' || request.method === 'HEAD' || request.body === null) return true;
  // A streamed body (chunked, or HTTP/2 without the header) declares nothing, and Number(null) would read as 0.
  const header = request.headers.get('content-length');
  if (header === null || header.trim() === '') return false;
  const declared = Number(header);
  return Number.isFinite(declared) && declared >= 0 && declared <= MAX_BODY_BYTES;
}

/**
 * What the app is told about a visitor: a stable pseudonym, never the address. The app keys its sample-run limit on
 * X-Forwarded-For (demo.py, visitor_key), and nothing else needs the address. HMAC-SHA256 of the visitor key under a
 * per-deploy secret, written as an address in the IPv6 documentation range (2001:db8::/32), which nothing routes.
 */
export async function visitorPseudonym(key, secret) {
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(key)));
  const groups = [];
  for (let i = 0; i < 6; i++) groups.push(((mac[2 * i] << 8) | mac[2 * i + 1]).toString(16));
  return `2001:db8:${groups.join(':')}`;
}

// The policy for the app's pages. Its scripts and styles are its own built files, with Google Fonts' stylesheet and
// fonts; it calls only its own API, and nothing may frame it. The theme hand-off adds its one line's hash to
// script-src (apps/demo-edge/theme-handoff.js). No 'unsafe-inline' for styles: React writes its style props through
// the DOM's style API, which the policy doesn't restrict. The portfolio's Cloudflare zone injects its Web Analytics
// beacon into every page; it reports to this origin's /cdn-cgi/rum, so its script host is the only allowance it needs.
export const CLOUDFLARE_ANALYTICS_SCRIPT_ORIGIN = 'https://static.cloudflareinsights.com';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' ${CLOUDFLARE_ANALYTICS_SCRIPT_ORIGIN}`,
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** The app's response as the visitor gets it: kept out of search engines, unsniffed, and a page under the policy. */
export function withDemoHeaders(response) {
  const out = new Response(response.body, response);
  out.headers.set('X-Robots-Tag', 'noindex, nofollow');
  out.headers.set('X-Content-Type-Options', 'nosniff');
  if ((out.headers.get('content-type') ?? '').includes('text/html')) {
    out.headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  }
  return out;
}
