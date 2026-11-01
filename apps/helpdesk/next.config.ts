import type { NextConfig } from "next";
import { securityHeaderRoutes } from "./src/lib/security-headers";

// The import above is RELATIVE on purpose: Next loads this file with its own config loader, which
// does not resolve the `@/*` tsconfig alias. `src/lib/security-headers.ts` imports nothing, so this
// stays a leaf import and the config keeps loading in every mode (dev, build, standalone start).

const nextConfig: NextConfig = {
  // Self-contained server (.next/standalone) for the container image: the Dockerfile copies it plus .next/static
  // and public/ into a minimal non-root runner.
  output: "standalone",
  // This app installs on its own (its own lockfile and node_modules, outside the repo's npm workspace), so
  // tracing starts here. Left to infer, Next sees the repo root's lockfile and traces from there.
  outputFileTracingRoot: __dirname,

  /**
   * Security response headers. The set, its order and the one
   * Permissions-Policy exception are asserted in `src/lib/security-headers.test.ts`; this block
   * only mounts them.
   *
   * Order is load-bearing: Next assigns each matching entry's headers over the previous one, so the
   * `/tickets/:id` entry must stay LAST for its `camera=(self)` grant to survive the catch-all.
   * `securityHeaderRoutes()` returns them already ordered — do not re-sort here.
   *
   * These cover every response Next serves, including `/api/ingest/**`, `/api/export/**`,
   * `/api/integrations/**` and `/api/client/**`, which the middleware matcher deliberately excludes
   * (guardrail G3b) and which a middleware-set header would therefore miss.
   */
  async headers() {
    return securityHeaderRoutes();
  },
};

export default nextConfig;
