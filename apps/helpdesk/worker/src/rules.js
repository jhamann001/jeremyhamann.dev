// The Worker's request rules, kept apart from the container binding so they can be tested in Node.

// No outside caller in the demo: the mail workflow's outbox and intake routes (the stand-ins call them over
// loopback inside the container), the client API, the MCP server, web push, the machine export (staff export
// at /api/tickets/export), and uploads (off in the demo; any id, since an encoded slash decodes into the path).
export const PRIVATE_PATHS = /^\/api\/((integrations|ingest|client|mcp|push|export)(\/|$)|attachments\/.+\/upload(\/|$))/;

// The headers the app never sees: every cf-* header (the visitor's address and location, and the container
// library's port routing) and the connection headers only the Worker knows; Auth.js reads its origin from the
// forwarding ones. The Worker sets X-Forwarded-For (the pseudonym) and -Proto itself.
export { forwardableHeaders, STRIPPED_HEADERS } from '../../../demo-edge/visitor-headers.js';

// The largest request body the demo accepts. The app's own text caps are far below it.
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
 * What the app is told about a visitor: a stable pseudonym, never the address. The app keys its rate limits on
 * X-Forwarded-For and records it in the audit log, which every visitor can read as the compliance persona, so a
 * real address there would show one visitor's IP to the next. HMAC-SHA256 of the visitor key under a per-deploy
 * secret, written as an address in the IPv6 documentation range (2001:db8::/32), which the app's parser accepts
 * and nothing routes.
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
