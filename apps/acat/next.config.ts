import type { NextConfig } from "next";

// CSP is generated per-request in src/proxy.ts so we can issue a fresh
// nonce and drop 'unsafe-inline' from script-src. Non-CSP security headers
// stay static because they don't change per-request.
const staticSecurityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

// The public demo takes no uploads, so it reads at most 128 KB of a request body; Next drops the
// rest, and the JSON then fails to parse. Bounds what one request can make the server hold. The
// firm's app keeps Next's 10 MB default for its fee-schedule and mapping uploads.
const demoBuild = process.env.NEXT_PUBLIC_DEMO_MODE === "on";

const nextConfig: NextConfig = {
  output: "standalone",
  ...(demoBuild ? { experimental: { proxyClientMaxBodySize: "128kb" } } : {}),
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: staticSecurityHeaders,
      },
    ];
  },
};

export default nextConfig;
