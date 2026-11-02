import { fileURLToPath } from "node:url";

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  `script-src 'self' 'unsafe-inline'${
    process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""
  }`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "X-XSS-Protection", value: "0" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output → small container image for Cloud Run.
  output: "standalone",
  // The app keeps its own lockfile inside the portfolio monorepo: trace from its own folder, so the standalone
  // output is flat (server.js and node_modules at its root) rather than nested under the repo's path.
  outputFileTracingRoot: fileURLToPath(new URL(".", import.meta.url)),
  reactStrictMode: true,
  poweredByHeader: false,
  // The Trade Request drift feeds (ticket) load @google-cloud/storage at runtime; keep it out of the webpack
  // bundle so the standalone output carries the package as published.
  serverExternalPackages: ["@google-cloud/storage"],
  // Runtime form templates must also be present in the standalone bundle.
  outputFileTracingIncludes: {
    "/api/forms/generate": [
      "./assets/forms/apex/**/template.pdf",
    ],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
