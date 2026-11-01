/**
 * The service worker's ROUTING DECISION — the source of truth for it, and the only copy of it.
 *
 * `public/sw.js` is plain, classic JavaScript served from `public/` as-is: no bundler runs on that
 * path, so the shipped worker cannot `import` anything. The tests used to reach this logic by reading
 * `public/sw.js`, slicing the marked section out of it and handing the string to `new Function` —
 * which security scanner reports as "Unsafe Evaluation of User Input in JavaScript" (CWE-95),
 * the same rule and the same remedy as the n8n Code nodes
 * (the build record and §4.5: "there is nothing to import" is a reason to create something
 * to import).
 *
 * So the arrangement is Wave A's, applied here:
 *
 *  - the pure section lives in this module, at column 0, between the two `sw:routing` markers;
 *  - `tools/pwa/build-sw.ts` copies that region into `public/sw.js` between its own ROUTING markers,
 *    BYTE FOR BYTE — the shipped worker is unchanged, still classic script, still no imports;
 *  - `tools/pwa/build-sw.test.ts` fails the build when the two drift apart;
 *  - `tools/pwa/sw.test.ts` IMPORTS the functions below and calls them, so nothing evaluates a string.
 *
 * Two rules for editing this file:
 *
 *  1. **The marked region is copied byte for byte** into `public/sw.js`, so it is written at column 0
 *     and in the dialect the worker is served in — `var`, function declarations, no TypeScript, no
 *     `import`. Anything a browser would not accept in a classic service worker does not belong here.
 *  2. **Everything outside the markers is the wrapper**, and the browser never sees it. The `export`
 *     list at the bottom is what lets the tests call these functions; it is not shipped.
 *
 * After any edit: `npx tsx tools/pwa/build-sw.ts` (or `--check` to see the drift without writing).
 */
/* sw:routing:begin */

/** Bump on any change to the cached SHAPE of the shell; `activate` deletes every other cache. */
var CACHE_VERSION = "v1";
var SHELL_CACHE = "wm-helpdesk-shell-" + CACHE_VERSION;

/** Fetched and stored at install. Not one of these is an authenticated document. */
var PRECACHE_PATHS = [
  "/offline.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

/** Content-hashed build output and committed icons: safe to answer from cache first. */
var STATIC_PREFIXES = ["/_next/static/", "/icons/"];

/** Individually named static files. `/_next/image` is absent on purpose — it is query-driven. */
var STATIC_EXACT = ["/offline.html", "/manifest.webmanifest", "/favicon.ico"];

var OFFLINE_PATH = "/offline.html";

/** `/api` and everything under it. Written as a helper so "/apiary" can never match. */
function isApiPath(pathname) {
  return pathname === "/api" || pathname.indexOf("/api/") === 0;
}

/**
 * The whole routing decision, as a pure function of a description of the request.
 *
 * @param {{method: string, sameOrigin: boolean, pathname: string, mode: string, destination: string}} req
 * @returns {"navigate"|"static"|"passthrough"}
 */
function decideFetchStrategy(req) {
  // A mutation is never cached and never replayed. Anything that is not a plain GET goes to the
  // network untouched, including the POST to /api/push/subscribe.
  if (req.method !== "GET") return "passthrough";
  // Someone else's origin is someone else's cache-control. We hold nothing from it.
  if (req.sameOrigin !== true) return "passthrough";
  // Records travel over /api. This branch is the one that keeps client data off the device.
  if (isApiPath(req.pathname)) return "passthrough";
  // A document request is network-first with an offline fallback — never stored.
  if (req.mode === "navigate" || req.destination === "document") return "navigate";
  for (var i = 0; i < STATIC_EXACT.length; i++) {
    if (STATIC_EXACT[i] === req.pathname) return "static";
  }
  for (var j = 0; j < STATIC_PREFIXES.length; j++) {
    if (req.pathname.indexOf(STATIC_PREFIXES[j]) === 0) return "static";
  }
  // Everything else — /_next/image, a font from a route segment, an attachment download — goes to
  // the network and stays there. The allowlist is the policy; this is its fail-closed default.
  return "passthrough";
}

/**
 * May this response be written to the shell cache?
 *
 * The `hasSetCookie` test is belt-and-braces and is honest about it: the Fetch standard strips
 * `Set-Cookie` from a basic filtered response, so a service worker usually cannot see one. The real
 * protection is that `decideFetchStrategy` only ever returns "static" for a closed allowlist of
 * paths that no session response is served from. This check is what catches the day somebody widens
 * that list.
 *
 * `redirected` is NOT belt-and-braces — it closes the hole the allowlist cannot see. The allowlist is
 * a list of PATHS, but a redirect moves the resource off that list while the cache KEY stays on it: a
 * same-origin 307 is followed transparently and the final response still arrives as
 * `{ok: true, status: 200, type: "basic"}`, so `/offline.html` redirected to `/sign-in?callbackUrl=…`
 * would be written to the shell cache as the offline page — authenticated HTML, complete with a CSRF
 * token that is stale the moment it is stored, served until someone hand-bumps `CACHE_VERSION`. A
 * redirected response is therefore never the response the allowlist admitted, whatever it contains.
 *
 * @param {{ok: boolean, status: number, type: string, hasSetCookie: boolean, redirected: boolean}} res
 * @returns {boolean}
 */
function mayStoreResponse(res) {
  if (res.ok !== true || res.status !== 200) return false;
  // Stored under the requested path, but fetched from somewhere else: the key would lie.
  if (res.redirected === true) return false;
  if (res.type !== "basic" && res.type !== "default") return false;
  if (res.hasSetCookie === true) return false;
  return true;
}

/**
 * Turns a push message body into what `showNotification` needs.
 *
 * The payload is B1's `pushPayload()` — `{title, body, url, tag}`, PII-light by contract: a
 * kind label, a WM number and a deep link, never a subject and never body text. Anything malformed
 * degrades to the generic line rather than throwing, because a push that throws is a push the user
 * never sees and nobody can debug.
 *
 * @param {string|null} text
 * @returns {{title: string, body: string, url: string, tag: string}}
 */
function parsePushPayload(text) {
  var fallback = { title: "WM Help Desk", body: "You have a new notification.", url: "/inbox", tag: "wmhd" };
  if (typeof text !== "string" || text.length === 0) return fallback;
  var data;
  try {
    data = JSON.parse(text);
  } catch {
    return fallback;
  }
  if (data === null || typeof data !== "object") return fallback;
  // A leading "/" is not enough: "//host" and "/\host" are PROTOCOL-RELATIVE and navigate off
  // origin. The second character has to be a path character for this to be our own URL.
  var candidate = typeof data.url === "string" ? data.url : "";
  var sameOrigin =
    candidate.charAt(0) === "/" && candidate.charAt(1) !== "/" && candidate.charAt(1) !== "\\";
  var url = sameOrigin ? candidate : fallback.url;
  return {
    title: typeof data.title === "string" && data.title.length > 0 ? data.title : fallback.title,
    body: typeof data.body === "string" && data.body.length > 0 ? data.body : fallback.body,
    // Only a same-origin ABSOLUTE PATH is ever opened. A payload that arrives carrying "https://…"
    // is a push service, or anything that can reach one, choosing a destination for us.
    url: url,
    tag: typeof data.tag === "string" && data.tag.length > 0 ? data.tag : fallback.tag,
  };
}

/* sw:routing:end */

export {
  CACHE_VERSION,
  SHELL_CACHE,
  PRECACHE_PATHS,
  STATIC_PREFIXES,
  STATIC_EXACT,
  OFFLINE_PATH,
  isApiPath,
  decideFetchStrategy,
  mayStoreResponse,
  parsePushPayload,
};
