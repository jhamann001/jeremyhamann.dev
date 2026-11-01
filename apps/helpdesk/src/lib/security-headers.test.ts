/**
 * Guardrail over the exact response-header set.
 *
 * These assertions are deliberately literal. A security header that silently loses a directive is
 * indistinguishable from one that was never set, and the only other place this policy exists is a
 * deployed response nobody re-reads. Changing a value here should require changing this file, which
 * is what makes the change show up in a diff.
 */
import { describe, expect, it } from "vitest";
import {
  ANALYTICS_SCRIPT_ORIGINS,
  analyticsScriptOrigins,
  ATTACHMENT_UPLOAD_ORIGINS,
  attachmentUploadOrigins,
  CLOUDFLARE_ANALYTICS_SCRIPT_ORIGIN,
  CSP_DIRECTIVES,
  contentSecurityPolicy,
  GCS_UPLOAD_ORIGIN,
  normalizeUploadOrigin,
  permissionsPolicy,
  securityHeaderRoutes,
  securityHeaders,
  TICKET_ROUTE_ALLOWED_FEATURE,
} from "@/lib/security-headers";
import { GCS_HOST } from "@/lib/storage";

function byKey(headers: ReturnType<typeof securityHeaders>): Map<string, string> {
  return new Map(headers.map((h) => [h.key, h.value] as const));
}

function cspMap(value: string): Map<string, string[]> {
  return new Map(
    value.split("; ").map((part) => {
      const [directive, ...values] = part.split(" ");
      return [directive, values] as const;
    }),
  );
}

describe("securityHeaders", () => {
  it("emits exactly the eight headers, in a fixed order", () => {
    expect(securityHeaders({ dev: false }).map((h) => h.key)).toEqual([
      "Content-Security-Policy",
      "Strict-Transport-Security",
      "X-Frame-Options",
      "X-Content-Type-Options",
      "Referrer-Policy",
      "Permissions-Policy",
      "Cross-Origin-Opener-Policy",
      "X-DNS-Prefetch-Control",
    ]);
  });

  it("sets the fixed values the contract names", () => {
    const h = byKey(securityHeaders({ dev: false }));
    expect(h.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
    expect(h.get("X-Frame-Options")).toBe("DENY");
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    expect(h.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(h.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(h.get("X-DNS-Prefetch-Control")).toBe("off");
  });

  it("HSTS carries includeSubDomains and never preload", () => {
    const hsts = byKey(securityHeaders({ dev: false })).get("Strict-Transport-Security") ?? "";
    expect(hsts).toContain("includeSubDomains");
    expect(hsts).not.toContain("preload");
    const maxAge = Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? "0");
    expect(maxAge).toBeGreaterThanOrEqual(31_536_000);
  });

  it("no header value can inject a second header or a body", () => {
    for (const { key, value } of [...securityHeaders({ dev: false }), ...securityHeaders({ dev: true })]) {
      expect(`${key}${value}`).not.toMatch(/[\r\n]/);
      expect(value.trim()).toBe(value);
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

describe("Content-Security-Policy", () => {
  it("frame-ancestors is 'none' and clickjacking is blocked twice", () => {
    const csp = cspMap(contentSecurityPolicy(false));
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(byKey(securityHeaders({ dev: false })).get("X-Frame-Options")).toBe("DENY");
  });

  it("pins the production directive set", () => {
    const csp = cspMap(contentSecurityPolicy(false));
    expect([...csp.keys()]).toEqual(Object.keys(CSP_DIRECTIVES));
    expect(csp.get("default-src")).toEqual(["'self'"]);
    expect(csp.get("base-uri")).toEqual(["'self'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("frame-src")).toEqual(["'none'"]);
    expect(csp.get("form-action")).toEqual(["'self'"]);
    expect(csp.get("connect-src")).toEqual(["'self'", ...ATTACHMENT_UPLOAD_ORIGINS]);
    expect(csp.get("upgrade-insecure-requests")).toEqual([]);
  });

  it("production never allows 'unsafe-eval', a websocket origin, or a wildcard script/style source", () => {
    const csp = cspMap(contentSecurityPolicy(false));
    const value = contentSecurityPolicy(false);
    expect(value).not.toContain("'unsafe-eval'");
    expect(value).not.toContain("ws:");
    expect(csp.get("script-src")).toEqual(["'self'", "'unsafe-inline'", ...ANALYTICS_SCRIPT_ORIGINS]);
    expect(csp.get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(csp.get("script-src")).not.toContain("*");
    expect(csp.get("style-src")).not.toContain("*");
  });

  it("img-src is the only https: wildcard, and it is a wildcard for images only", () => {
    const csp = cspMap(contentSecurityPolicy(false));
    expect(csp.get("img-src")).toEqual(["'self'", "data:", "blob:", "https:"]);
    for (const [directive, values] of csp) {
      if (directive === "img-src") continue;
      expect(values, `${directive} must not carry a scheme wildcard`).not.toContain("https:");
    }
  });

  it("development adds exactly the bundler's needs and drops the http-breaking upgrade", () => {
    const dev = cspMap(contentSecurityPolicy(true));
    expect(dev.get("script-src")).toEqual(["'self'", "'unsafe-inline'", ...ANALYTICS_SCRIPT_ORIGINS, "'unsafe-eval'"]);
    expect(dev.get("connect-src")).toEqual(["'self'", ...ATTACHMENT_UPLOAD_ORIGINS, "ws:", "wss:"]);
    expect(dev.has("upgrade-insecure-requests")).toBe(false);
    // Everything that is not a bundler concession is identical in both modes.
    const prod = cspMap(contentSecurityPolicy(false));
    for (const [directive, values] of prod) {
      if (["script-src", "connect-src", "upgrade-insecure-requests"].includes(directive)) continue;
      expect(dev.get(directive), directive).toEqual(values);
    }
  });

  it("the exported directive table cannot be mutated by a consumer", () => {
    expect(Object.isFrozen(CSP_DIRECTIVES)).toBe(true);
    expect(() => {
      (CSP_DIRECTIVES as Record<string, string[]>)["script-src"] = ["*"];
    }).toThrow();
    expect(CSP_DIRECTIVES["script-src"]).toEqual(["'self'", "'unsafe-inline'"]);
  });
});

/** The portfolio demo's Cloudflare zone injects a Web Analytics beacon; only the demo build allows its script. */
describe("script-src and the Cloudflare analytics beacon", () => {
  it("is allowed in the demo build and nowhere else", () => {
    expect(analyticsScriptOrigins({ NEXT_PUBLIC_DEMO_MODE: "on" })).toEqual([CLOUDFLARE_ANALYTICS_SCRIPT_ORIGIN]);
    expect(analyticsScriptOrigins({})).toEqual([]);
    expect(analyticsScriptOrigins({ NEXT_PUBLIC_DEMO_MODE: "off" })).toEqual([]);
    expect(analyticsScriptOrigins({ NEXT_PUBLIC_DEMO_MODE: "ON" })).toEqual([]);
  });

  it("is one exact https origin, never a wildcard or a path", () => {
    expect(normalizeUploadOrigin(CLOUDFLARE_ANALYTICS_SCRIPT_ORIGIN)).toBe(CLOUDFLARE_ANALYTICS_SCRIPT_ORIGIN);
  });

  it("adds to script-src only: connect-src stays 'self' plus the upload origins", () => {
    const demo = cspMap(contentSecurityPolicy(false, ATTACHMENT_UPLOAD_ORIGINS, [CLOUDFLARE_ANALYTICS_SCRIPT_ORIGIN]));
    const plain = cspMap(contentSecurityPolicy(false, ATTACHMENT_UPLOAD_ORIGINS, []));
    expect(demo.get("script-src")).toEqual(["'self'", "'unsafe-inline'", CLOUDFLARE_ANALYTICS_SCRIPT_ORIGIN]);
    expect(plain.get("script-src")).toEqual(["'self'", "'unsafe-inline'"]);
    for (const [directive, values] of plain) {
      if (directive === "script-src") continue;
      expect(demo.get(directive), directive).toEqual(values);
    }
  });

  it("reaches the header through securityHeaders", () => {
    const value = byKey(securityHeaders({ dev: false, scriptOrigins: [CLOUDFLARE_ANALYTICS_SCRIPT_ORIGIN] })).get(
      "Content-Security-Policy",
    );
    expect(cspMap(value ?? "").get("script-src")).toContain(CLOUDFLARE_ANALYTICS_SCRIPT_ORIGIN);
  });
});

/**
 * Regression guard for the defect that made "Attach a file" fail 100% of the time in every
 * environment with a bucket: `connect-src 'self'` refused the uploader's cross-origin XHR PUT
 * before it left the browser, and the only symptom was `xhr.onerror` — indistinguishable, to the
 * person debugging it, from bucket IAM or a missing CORS rule.
 */
describe("connect-src and the attachment upload origin", () => {
  it("allows the GCS origin the signed PUT URL is actually built on", () => {
    const connect = cspMap(contentSecurityPolicy(false)).get("connect-src") ?? [];
    expect(connect).toContain("'self'");
    expect(connect).toContain(GCS_UPLOAD_ORIGIN);
  });

  it("the allowed origin is the storage module's host, not a second opinion about it", () => {
    // If `GCS_HOST` ever moves, this fails here rather than in a browser six weeks later.
    expect(GCS_UPLOAD_ORIGIN).toBe(`https://${GCS_HOST}`);
    expect(new URL(`https://${GCS_HOST}/bucket/key?X-Goog-Signature=x`).origin).toBe(GCS_UPLOAD_ORIGIN);
  });

  it("the allowance is unconditional, because headers() is evaluated at BUILD time", () => {
    // `ATTACHMENTS_BUCKET` is a runtime Cloud Run variable and is absent from the image build, so a
    // policy derived from it would always compute "no bucket" and ship the broken header.
    expect(attachmentUploadOrigins({})).toEqual([GCS_UPLOAD_ORIGIN]);
    expect(attachmentUploadOrigins({ ATTACHMENTS_BUCKET: undefined })).toEqual([GCS_UPLOAD_ORIGIN]);
    expect(attachmentUploadOrigins({ ATTACHMENTS_BUCKET: "wm-helpdesk-attachments" })).toEqual([GCS_UPLOAD_ORIGIN]);
  });

  it("is present in development too — the dev relaxations add to it, they do not replace it", () => {
    const connect = cspMap(contentSecurityPolicy(true)).get("connect-src") ?? [];
    expect(connect).toEqual(["'self'", ...ATTACHMENT_UPLOAD_ORIGINS, "ws:", "wss:"]);
  });

  it("stays an exact origin — never a scheme wildcard, a host wildcard or a path", () => {
    for (const origin of ATTACHMENT_UPLOAD_ORIGINS) {
      expect(origin).toMatch(/^https:\/\/[a-z0-9.-]+(:\d+)?$/);
      expect(origin).not.toContain("*");
      expect(new URL(origin).pathname).toBe("/");
    }
  });

  it("leaks into no other directive — connect-src is the only one that gained an origin", () => {
    const prod = cspMap(contentSecurityPolicy(false));
    for (const [directive, values] of prod) {
      if (directive === "connect-src") continue;
      for (const origin of ATTACHMENT_UPLOAD_ORIGINS) {
        expect(values, `${directive} must not carry the upload origin`).not.toContain(origin);
      }
    }
  });

  it("ATTACHMENTS_UPLOAD_ORIGIN narrows the default to a private bucket host", () => {
    expect(attachmentUploadOrigins({ ATTACHMENTS_UPLOAD_ORIGIN: "https://uploads.example.com" })).toEqual([
      "https://uploads.example.com",
    ]);
    const csp = cspMap(contentSecurityPolicy(false, ["https://uploads.example.com"]));
    expect(csp.get("connect-src")).toEqual(["'self'", "https://uploads.example.com"]);
    expect(csp.get("connect-src")).not.toContain(GCS_UPLOAD_ORIGIN);
  });

  it("accepts a comma-separated list and de-duplicates it", () => {
    expect(
      attachmentUploadOrigins({
        ATTACHMENTS_UPLOAD_ORIGIN: " https://a.example.com , https://b.example.com , https://a.example.com ",
      }),
    ).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  it("the literal 'none' removes the allowance entirely", () => {
    expect(attachmentUploadOrigins({ ATTACHMENTS_UPLOAD_ORIGIN: "none" })).toEqual([]);
    expect(attachmentUploadOrigins({ ATTACHMENTS_UPLOAD_ORIGIN: "NONE" })).toEqual([]);
    expect(cspMap(contentSecurityPolicy(false, [])).get("connect-src")).toEqual(["'self'"]);
  });

  it("a key that parses to nothing falls back to the default rather than breaking uploads", () => {
    expect(attachmentUploadOrigins({ ATTACHMENTS_UPLOAD_ORIGIN: "not a url" })).toEqual([GCS_UPLOAD_ORIGIN]);
    expect(attachmentUploadOrigins({ ATTACHMENTS_UPLOAD_ORIGIN: "  " })).toEqual([GCS_UPLOAD_ORIGIN]);
  });

  it("normalizeUploadOrigin refuses everything that would widen the directive", () => {
    for (const bad of [
      "*",
      "https:",
      "https://*",
      "https://*.googleapis.com",
      "data:",
      "blob:",
      "storage.googleapis.com",
      "http://storage.googleapis.com",
      "https://user:pw@storage.googleapis.com",
      "javascript:alert(1)",
      "https://evil.example.com/ ; script-src *",
      "",
    ]) {
      expect(normalizeUploadOrigin(bad), bad).toBeNull();
    }
  });

  it("normalizeUploadOrigin reduces a pasted signed URL to its bare origin", () => {
    expect(normalizeUploadOrigin("https://storage.googleapis.com/bucket/key?X-Goog-Signature=abc")).toBe(
      GCS_UPLOAD_ORIGIN,
    );
    expect(normalizeUploadOrigin("https://uploads.example.com:8443/path")).toBe("https://uploads.example.com:8443");
    // Loopback over http is the one non-https tolerance, for a local fake-gcs emulator.
    expect(normalizeUploadOrigin("http://localhost:4443")).toBe("http://localhost:4443");
    expect(normalizeUploadOrigin("http://127.0.0.1:4443/storage")).toBe("http://127.0.0.1:4443");
  });

  it("an operator-supplied origin can never inject a second directive or a header", () => {
    for (const origin of [...ATTACHMENT_UPLOAD_ORIGINS, normalizeUploadOrigin("https://uploads.example.com/x")]) {
      expect(origin).not.toBeNull();
      expect(String(origin)).not.toMatch(/[\s;,'"\r\n]/);
    }
    const value = contentSecurityPolicy(false, ["https://uploads.example.com"]);
    expect(value).not.toMatch(/[\r\n]/);
    expect(value.split("; ").filter((d) => d.startsWith("connect-src "))).toHaveLength(1);
  });
});

describe("Permissions-Policy", () => {
  it("denies camera, microphone and geolocation by default", () => {
    const value = permissionsPolicy(false);
    for (const feature of ["camera", "microphone", "geolocation"]) {
      expect(value).toContain(`${feature}=()`);
    }
    expect(value).not.toContain("=(self)");
    expect(value).not.toContain("=(*)");
  });

  it("the ticket route re-grants camera to this origin and nothing else", () => {
    const value = permissionsPolicy(true);
    expect(value).toContain(`${TICKET_ROUTE_ALLOWED_FEATURE}=(self)`);
    expect(value).toContain("microphone=()");
    expect(value).toContain("geolocation=()");
    expect(value.match(/=\(self\)/g)).toHaveLength(1);

    const denied = permissionsPolicy(false).split(", ");
    const allowed = value.split(", ");
    expect(allowed).toHaveLength(denied.length);
    expect(allowed.filter((f, i) => f !== denied[i])).toEqual(["camera=(self)"]);
  });

  it("WebAuthn is never denied — the identity provider may need it during sign-in", () => {
    expect(permissionsPolicy(false)).not.toContain("publickey-credentials-get");
  });
});

describe("securityHeaderRoutes", () => {
  it("the catch-all comes first so the ticket route's camera grant wins the last-write", () => {
    const routes = securityHeaderRoutes();
    expect(routes.map((r) => r.source)).toEqual(["/:path*", "/tickets/:id"]);
    const catchAll = byKey(routes[0].headers).get("Permissions-Policy") ?? "";
    const ticket = byKey(routes[1].headers).get("Permissions-Policy") ?? "";
    expect(catchAll).toContain("camera=()");
    expect(ticket).toContain("camera=(self)");
  });

  it("every route carries the full set, not a subset", () => {
    const expected = securityHeaders({ dev: false }).map((h) => h.key);
    for (const route of securityHeaderRoutes()) {
      expect(route.headers.map((h) => h.key)).toEqual(expected);
    }
  });

  it("no header value contains a path-to-regexp parameter token Next would interpolate", () => {
    // Next compiles header VALUES through compileNonPath when the source has params; a literal
    // ":id" or ":path" in a value would be substituted with the matched segment.
    for (const route of securityHeaderRoutes()) {
      for (const { value } of route.headers) {
        expect(value).not.toMatch(/:id\b/);
        expect(value).not.toMatch(/:path\b/);
      }
    }
  });
});
