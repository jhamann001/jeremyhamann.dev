// The Worker's request rules, kept apart from the container and Durable Object bindings so they can be tested in
// Node. The address, path and body rules are the help desk Worker's (apps/helpdesk/worker/src/rules.js).

// No outside caller in the demo: the CRM, custodian and Slack feeds (/api/ingest), the scheduled jobs (/api/cron)
// and the AI probe. The app's middleware answers them 404 in demo mode too; the Worker never lets them through.
export const PRIVATE_PATHS = /^\/api\/((ingest|cron)(\/|$)|health\/ai(\/|$))/;

// The headers the app never sees: every cf-* header and the forwarding ones only the Worker may set.
export { forwardableHeaders, STRIPPED_HEADERS } from '../../../demo-edge/visitor-headers.js';

// The largest request body the demo accepts: a receipt CSV or a form post. Uploads are off in the demo.
export const MAX_BODY_BYTES = 512 * 1024;

// Methods that can change something; the stricter per-visitor write limit counts these.
export const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// The portfolio's Cloudflare zone injects its Web Analytics beacon into every page; the beacon reports to this
// origin's /cdn-cgi/rum (connect-src 'self'), so its script host is the only allowance it needs.
export const CLOUDFLARE_ANALYTICS_SCRIPT_ORIGIN = 'https://static.cloudflareinsights.com';

// Who a visitor is, for rate limits: the IPv4 address, or for IPv6 the /64 network.
export function visitorKey(ip) {
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => (g || '0').toLowerCase()).join(':')}::/64`;
}

// The path as the app's router will see it: percent-decoded, repeated slashes collapsed, lower case, so an encoded
// or doubled spelling can't slip a private path past the check. Null if malformed.
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
  const header = request.headers.get('content-length');
  if (header === null || header.trim() === '') return false;
  const declared = Number(header);
  return Number.isFinite(declared) && declared >= 0 && declared <= MAX_BODY_BYTES;
}

/**
 * What the app is told about a visitor: a stable pseudonym, never the address (the help desk's rule). HMAC-SHA256 of
 * the visitor key under a per-deploy secret, written as an address in the IPv6 documentation range (2001:db8::/32).
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

/**
 * The app's Content-Security-Policy with the analytics beacon's script host added to the directive that governs
 * scripts (script-src-elem, else script-src, else a new script-src copied from default-src). Unchanged if absent.
 */
export function withAnalyticsScript(csp) {
  if (!csp) return csp;
  const directives = csp.split(';').map((d) => d.trim()).filter(Boolean);
  const index = (name) => directives.findIndex((d) => d.toLowerCase().split(/\s+/)[0] === name);
  const target = [index('script-src-elem'), index('script-src')].find((i) => i !== -1);
  if (target !== undefined) {
    if (!directives[target].split(/\s+/).includes(CLOUDFLARE_ANALYTICS_SCRIPT_ORIGIN)) {
      directives[target] = `${directives[target]} ${CLOUDFLARE_ANALYTICS_SCRIPT_ORIGIN}`;
    }
  } else {
    const fallback = index('default-src');
    const sources = fallback === -1 ? ["'self'"] : directives[fallback].split(/\s+/).slice(1);
    directives.push(`script-src ${sources.join(' ')} ${CLOUDFLARE_ANALYTICS_SCRIPT_ORIGIN}`);
  }
  return directives.join('; ');
}
