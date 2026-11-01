/**
 * The service worker's routing decision — unit-tested by IMPORTING it.
 *
 * `public/sw.js` is plain JavaScript served as-is: there is no bundler on that path, so it cannot
 * import a tested module and a transcription of its logic into TypeScript would be a second
 * implementation that drifts. This file used to solve that by reading `public/sw.js`, slicing out the
 * section between the ROUTING markers and evaluating it with `new Function` — which security scanner reports as
 * "Unsafe Evaluation of User Input in JavaScript" (CWE-95).
 *
 * The arrangement now is the one the build record prescribes and Wave A used for the n8n
 * Code nodes: `tools/pwa/sw-logic.js` IS the routing decision, `tools/pwa/build-sw.ts` copies its
 * marked region into `public/sw.js` byte for byte, and `tools/pwa/build-sw.test.ts` fails the build
 * if the two ever differ. So the functions called below are still the code that runs in the browser,
 * not a copy of it — and nothing evaluates a string.
 *
 * The claim these tests defend is the one in the worker's own docstring and in CONTRACT §10 B10:
 * **the cache holds the app shell and static assets only** — never `/api`, never the HTML of an
 * authenticated page, never a response carrying a cookie. A cached ticket is a read of client
 * material that no audit row records, on a device that survives sign-out.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PRECACHE_PATHS,
  SHELL_CACHE,
  STATIC_PREFIXES,
  decideFetchStrategy,
  isApiPath,
  mayStoreResponse,
  parsePushPayload,
} from "./sw-logic.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SW_PATH = path.join(ROOT, "public", "sw.js");

/**
 * The shipped worker as TEXT. The assertions in "the shipped worker, as source" below are about the
 * parts of the file that are NOT the routing module — the lifecycle listeners, the fetch handler and
 * the two push handlers — which have no pure section to import and are asserted as source, the shape
 * `reports-surface-probe.test.ts` established.
 */
const source = readFileSync(SW_PATH, "utf8");

type RequestDescription = {
  method: string;
  sameOrigin: boolean;
  pathname: string;
  mode: string;
  destination: string;
};
type ResponseDescription = {
  ok: boolean;
  status: number;
  type: string;
  hasSetCookie: boolean;
  redirected: boolean;
};

/** The module is plain JavaScript, so its exports arrive untyped; these are the shapes it accepts. */
const routing = {
  decideFetchStrategy: decideFetchStrategy as (req: RequestDescription) => string,
  mayStoreResponse: mayStoreResponse as (res: ResponseDescription) => boolean,
  parsePushPayload: parsePushPayload as (
    text: string | null,
  ) => { title: string; body: string; url: string; tag: string },
  isApiPath: isApiPath as (pathname: string) => boolean,
  SHELL_CACHE: SHELL_CACHE as string,
  PRECACHE_PATHS: PRECACHE_PATHS as string[],
  STATIC_PREFIXES: STATIC_PREFIXES as string[],
};

const GET = (over: Partial<RequestDescription>): RequestDescription => ({
  method: "GET",
  sameOrigin: true,
  pathname: "/",
  mode: "cors",
  destination: "empty",
  ...over,
});

describe("decideFetchStrategy", () => {
  it("never touches an /api request, by any method, in any mode", () => {
    for (const pathname of ["/api", "/api/tickets", "/api/push/subscribe", "/api/client/tickets", "/api/mcp"]) {
      expect(routing.decideFetchStrategy(GET({ pathname })), pathname).toBe("passthrough");
      expect(routing.decideFetchStrategy(GET({ pathname, mode: "navigate", destination: "document" }))).toBe(
        "passthrough",
      );
    }
  });

  it("does not mistake a path that merely starts with the letters api", () => {
    expect(routing.isApiPath("/apiary")).toBe(false);
    expect(routing.isApiPath("/api")).toBe(true);
    expect(routing.isApiPath("/api/x")).toBe(true);
    expect(routing.decideFetchStrategy(GET({ pathname: "/apiary" }))).toBe("passthrough");
  });

  it("passes every non-GET straight through", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
      expect(routing.decideFetchStrategy(GET({ method, pathname: "/_next/static/chunk.js" })), method).toBe(
        "passthrough",
      );
    }
  });

  it("passes every cross-origin request straight through", () => {
    expect(routing.decideFetchStrategy(GET({ sameOrigin: false, pathname: "/_next/static/chunk.js" }))).toBe(
      "passthrough",
    );
  });

  it("treats a document as network-first, never as something to store", () => {
    for (const pathname of ["/", "/dashboard", "/tickets/abc123", "/compliance/audit", "/inbox"]) {
      expect(routing.decideFetchStrategy(GET({ pathname, mode: "navigate", destination: "document" })), pathname).toBe(
        "navigate",
      );
    }
    // Any authenticated HTML is a "navigate", and "navigate" is the one strategy that never writes.
    expect(routing.decideFetchStrategy(GET({ pathname: "/tickets/x", destination: "document" }))).toBe("navigate");
  });

  it("serves the immutable build output and the committed icons cache-first", () => {
    for (const pathname of [
      "/_next/static/chunks/main-abc123.js",
      "/_next/static/css/app.css",
      "/icons/icon-192.png",
      "/offline.html",
      "/manifest.webmanifest",
      "/favicon.ico",
    ]) {
      expect(routing.decideFetchStrategy(GET({ pathname })), pathname).toBe("static");
    }
  });

  it("does NOT cache anything outside the allowlist, including /_next/image and attachments", () => {
    for (const pathname of [
      "/_next/image",
      "/_next/data/build/dashboard.json",
      "/api/attachments/abc/download",
      "/tickets/wm/1042",
      "/sw.js",
    ]) {
      expect(routing.decideFetchStrategy(GET({ pathname })), pathname).toBe("passthrough");
    }
  });
});

describe("mayStoreResponse", () => {
  const base = { ok: true, status: 200, type: "basic", hasSetCookie: false, redirected: false };

  it("stores only an ok, same-origin, cookie-free, unredirected 200", () => {
    expect(routing.mayStoreResponse(base)).toBe(true);
    expect(routing.mayStoreResponse({ ...base, hasSetCookie: true })).toBe(false);
    expect(routing.mayStoreResponse({ ...base, status: 206, ok: true })).toBe(false);
    expect(routing.mayStoreResponse({ ...base, ok: false, status: 404 })).toBe(false);
    expect(routing.mayStoreResponse({ ...base, type: "opaque" })).toBe(false);
    expect(routing.mayStoreResponse({ ...base, type: "cors" })).toBe(false);
  });

  /**
   * The allowlist is a list of PATHS; a redirect moves the RESOURCE off it while the cache key stays
   * on it. A followed same-origin 307 to /sign-in arrives looking exactly like a good shell asset —
   * ok, 200, basic, and (per the Fetch standard's filtering) with no visible Set-Cookie — so every
   * other check here passes it. This is the check that does not.
   */
  it("refuses a response that came back from somewhere other than the path asked for", () => {
    expect(routing.mayStoreResponse({ ...base, redirected: true })).toBe(false);
    // The live shape of the bug: /offline.html 307'd to the sign-in page by the middleware matcher.
    expect(routing.mayStoreResponse({ ok: true, status: 200, type: "basic", hasSetCookie: false, redirected: true })).toBe(
      false,
    );
    // An opaqueredirect (what `redirect: "manual"` yields) is rejected on ok/type, redirected false.
    expect(routing.mayStoreResponse({ ok: false, status: 0, type: "opaqueredirect", hasSetCookie: false, redirected: false })).toBe(
      false,
    );
    // A missing flag is not a pass: an undefined `redirected` still has to satisfy every other check.
    expect(routing.mayStoreResponse({ ...base, redirected: undefined as unknown as boolean })).toBe(true);
  });
});

describe("parsePushPayload", () => {
  it("passes through B1's PII-light payload", () => {
    const payload = { title: "WM Help Desk", body: "Assigned — HD-1042", url: "/tickets/wm/1042", tag: "wmhd-ASSIGNED-1042" };
    expect(routing.parsePushPayload(JSON.stringify(payload))).toEqual(payload);
  });

  it("degrades to a generic line rather than throwing", () => {
    for (const text of [null, "", "not json", "[]", "null", "42"]) {
      const out = routing.parsePushPayload(text as string | null);
      expect(out.title, JSON.stringify(text)).toBe("WM Help Desk");
      expect(out.url).toBe("/inbox");
    }
  });

  it("only ever opens a same-origin absolute path", () => {
    for (const url of ["https://evil.example/steal", "//evil.example", "/\\\\evil.example", "javascript:alert(1)", "tickets/1", ""]) {
      expect(routing.parsePushPayload(JSON.stringify({ url })).url, url).toBe("/inbox");
    }
    expect(routing.parsePushPayload(JSON.stringify({ url: "/tickets/wm/7" })).url).toBe("/tickets/wm/7");
  });
});

describe("the shipped worker, as source", () => {
  it("precaches only the shell, and no authenticated HTML", () => {
    expect(routing.PRECACHE_PATHS).toEqual([
      "/offline.html",
      "/manifest.webmanifest",
      "/icons/icon-192.png",
      "/icons/icon-512.png",
      "/icons/apple-touch-icon.png",
    ]);
    for (const p of routing.PRECACHE_PATHS) {
      expect(routing.decideFetchStrategy(GET({ pathname: p })), p).toBe("static");
    }
    expect(routing.PRECACHE_PATHS).not.toContain("/");
    expect(routing.PRECACHE_PATHS).not.toContain("/dashboard");
  });

  it("names a versioned cache it can clean up", () => {
    expect(routing.SHELL_CACHE).toMatch(/^wm-helpdesk-shell-v\d+$/);
    expect(source).toContain("caches.delete(name)");
    expect(source).toContain('name.indexOf("wm-helpdesk-") !== 0');
  });

  it("stores nothing on the navigation path", () => {
    const handler = source.slice(source.indexOf("function handleNavigate"), source.indexOf("function handleStatic"));
    expect(handler).toContain("caches.match(OFFLINE_PATH)");
    expect(handler).not.toContain("cache.put");
    expect(handler).not.toContain("caches.open");
  });

  it("plumbs `redirected` from the real Response into the guard, and never follows one at install", () => {
    const describe_ = source.slice(source.indexOf("function describeResponse"), source.indexOf("self.addEventListener(\"install\""));
    expect(describe_).toMatch(/redirected:\s*response\.redirected === true/);
    // The precache response is consumed by nothing but the cache, so a 307 is best left unfollowed.
    expect(source).toContain('redirect: "manual"');
    expect(source).toMatch(/new Request\(path, \{ cache: "reload", redirect: "manual" \}\)/);
  });

  it("checks mayStoreResponse before every write it makes", () => {
    const puts = (source.match(/cache\.put\(/g) ?? []).length;
    const guards = (source.match(/mayStoreResponse\(/g) ?? []).length;
    expect(puts).toBeGreaterThan(0);
    // One guard per write, plus the two definitions/uses that are not writes is over-counting the
    // wrong way round — so this asserts the guard is never the scarcer of the two.
    expect(guards).toBeGreaterThanOrEqual(puts);
  });

  it("posts to the desk with same-origin credentials and nothing else", () => {
    const fetches = source.match(/fetch\((?:"|')([^"']+)/g) ?? [];
    for (const f of fetches) expect(f, f).not.toMatch(/https?:/);
    expect(source).toContain('fetch("/api/push/subscribe"');
    expect(source).toContain('credentials: "same-origin"');
  });

  it("is classic script with no imports and no dynamic code", () => {
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/^\s*export\s/m);
    expect(source).not.toMatch(/\bimportScripts\s*\(/);
    expect(source).not.toMatch(/\beval\s*\(/);
    expect(source).not.toMatch(/new\s+Function\s*\(/);
  });

  it("and neither does this test — the routing decision is imported, never evaluated", () => {
    // The CWE-95 finding this file carried was a `new Function` over the section it had just sliced
    // out of the worker. Nothing reintroduces it: `tools/pwa/build-sw.test.ts` proves the imported
    // module and the shipped region are the same bytes, so importing is not the weaker test.
    //
    // This assertion reads THIS FILE's own source, so the construct is named above without its call
    // parenthesis on purpose — write it out in a comment here and this test fails, which is a little
    // blunt but is the price of the guard being unfoolable.
    const self_ = readFileSync(fileURLToPath(import.meta.url), "utf8");
    expect(self_).not.toMatch(/new\s+Function\s*\(/);
    expect(self_).not.toMatch(/\beval\s*\(/);
  });
});
