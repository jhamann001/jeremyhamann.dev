/**
 * WM Help Desk service worker (`pwa-push`).
 *
 * WHAT IT IS ALLOWED TO CACHE, and nothing else: the build's immutable static assets
 * (`/_next/static/**`), the committed icons, the manifest and the offline page. That is the app
 * SHELL. It is a deliberate, closed allowlist rather than a "cache what succeeds" heuristic, because
 * of one rule this desk cannot bend:
 *
 *   **No ticket ever lands in a device cache.** Every read of client material is an audited event
 *  ; a cached page is a read nobody can see, on a device this design has no control over, that
 *   survives sign-out. So: never `/api/**` (that is where records travel), never the HTML of an
 *   authenticated page, never a response that sets a cookie, never a cross-origin response.
 *
 * Navigation is network-FIRST and its response is never stored — the only thing the cache does for a
 * navigation is answer `/offline.html` when the network is gone, so a phone in a lift says so instead
 * of showing the browser's dinosaur.
 *
 * This file is plain, classic (non-module) JavaScript because it is served from `public/` as-is:
 * there is no bundler on this path, so there are no imports and no TypeScript.
 *
 * THE SECTION BETWEEN THE ROUTING MARKERS BELOW IS GENERATED. Its source is `tools/pwa/sw-logic.js`,
 * and `tools/pwa/build-sw.ts` copies that module's marked region in here byte for byte; edit the
 * module and re-run the build (`npx tsx tools/pwa/build-sw.ts`), never this region by hand.
 * `tools/pwa/build-sw.test.ts` fails when the two drift apart and `tools/pwa/sw.test.ts` imports the
 * module and calls it — one implementation, no transcription, and nothing evaluates source text
 * (security scanner CWE-95; the build record).
 *
 * Registration happens only in a production build (`src/components/shell/pwa-install-prompt.tsx`);
 * in development a stale shell cache is a debugging trap and buys nothing.
 */
/* global self, caches, fetch, Request, Response, URL, Promise */

// --- WM-PWA ROUTING (pure) — BEGIN ---

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

// --- WM-PWA ROUTING (pure) — END ---

function describeRequest(request) {
  var url = new URL(request.url);
  return {
    method: request.method,
    sameOrigin: url.origin === self.location.origin,
    pathname: url.pathname,
    mode: request.mode,
    destination: request.destination,
  };
}

function describeResponse(response) {
  return {
    ok: response.ok,
    status: response.status,
    type: response.type,
    // `Response.redirected` is true when the response came back from a URL other than the one asked
    // for. An opaqueredirect response reports false, but it is already rejected on `ok`/`type`.
    redirected: response.redirected === true,
    hasSetCookie: response.headers.has("set-cookie"),
  };
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then(function (cache) {
        // `reload` so an install never adopts an HTTP-cached copy of the offline page. `manual` so a
        // redirect is not followed at all here: nothing consumes this response except the cache, so
        // the safest shape for a 307 is an opaqueredirect that `mayStoreResponse` rejects outright.
        return Promise.all(
          PRECACHE_PATHS.map(function (path) {
            return fetch(new Request(path, { cache: "reload", redirect: "manual" }))
              .then(function (response) {
                if (!mayStoreResponse(describeResponse(response))) return undefined;
                return cache.put(path, response);
              })
              .catch(function () {
                // One missing asset must not fail the whole install: the worker is still useful.
                return undefined;
              });
          }),
        );
      })
      .then(function () {
        return self.skipWaiting();
      }),
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (names) {
        return Promise.all(
          names.map(function (name) {
            // Ours and stale, or somebody else's on this origin: either way it is not this version.
            if (name === SHELL_CACHE) return undefined;
            if (name.indexOf("wm-helpdesk-") !== 0) return undefined;
            return caches.delete(name);
          }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

function handleNavigate(request) {
  return fetch(request).catch(function () {
    return caches.match(OFFLINE_PATH).then(function (cached) {
      if (cached) return cached;
      return new Response("Offline", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    });
  });
}

function handleStatic(request) {
  return caches.match(request).then(function (cached) {
    if (cached) return cached;
    // Redirects are FOLLOWED here, unlike at install: this response is handed to the page, and an
    // opaqueredirect answer to a script or stylesheet is a network error rather than a working asset.
    // The write is what must not happen — `mayStoreResponse` refuses a redirected response, so a
    // static path that starts redirecting degrades to an uncached passthrough, never a mis-keyed one.
    return fetch(request).then(function (response) {
      if (mayStoreResponse(describeResponse(response))) {
        var copy = response.clone();
        caches.open(SHELL_CACHE).then(function (cache) {
          cache.put(request, copy);
        });
      }
      return response;
    });
  });
}

self.addEventListener("fetch", function (event) {
  var strategy = decideFetchStrategy(describeRequest(event.request));
  if (strategy === "navigate") {
    event.respondWith(handleNavigate(event.request));
    return;
  }
  if (strategy === "static") {
    event.respondWith(handleStatic(event.request));
    return;
  }
  // "passthrough": do not call respondWith at all, so the browser's own networking is untouched.
});

self.addEventListener("push", function (event) {
  var text = null;
  try {
    text = event.data ? event.data.text() : null;
  } catch {
    text = null;
  }
  var payload = parsePushPayload(text);
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      // Replace rather than stack: three updates on one ticket are one thing to look at.
      renotify: false,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: payload.url },
    }),
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var target = event.notification.data && event.notification.data.url ? event.notification.data.url : "/inbox";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windows) {
      for (var i = 0; i < windows.length; i++) {
        var client = windows[i];
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          if ("navigate" in client) {
            return client.navigate(target).then(function (navigated) {
              return navigated ? navigated.focus() : client.focus();
            });
          }
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

/**
 * The push service may rotate a subscription without the page being open. Re-subscribing with the
 * SAME application server key and telling the desk about it is the difference between push quietly
 * dying on a device and staying live. The POST carries the session cookie; if there is no session
 * the route answers 401 and the next sign-in re-subscribes from the page.
 */
self.addEventListener("pushsubscriptionchange", function (event) {
  event.waitUntil(
    (function () {
      var oldSub = event.oldSubscription || null;
      var key = oldSub && oldSub.options ? oldSub.options.applicationServerKey : null;
      if (!key) return Promise.resolve();
      return self.registration.pushManager
        .subscribe({ userVisibleOnly: true, applicationServerKey: key })
        .then(function (sub) {
          var json = sub.toJSON();
          return fetch("/api/push/subscribe", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, replaces: oldSub.endpoint }),
          });
        })
        .catch(function () {
          return undefined;
        });
    })(),
  );
});
