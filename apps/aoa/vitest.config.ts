import { defineConfig } from "vitest/config";

// Unit tests for pure functions (auth role mapping, workflow tone/label maps).
// `node` environment — these tests touch no DOM. The `@/` alias mirrors the
// tsconfig `paths` mapping so imports resolve the same way as the app build.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    alias: { "@": import.meta.dirname },
  },
  // tsconfig sets `jsx: "preserve"` (Next compiles the JSX itself), which Vite's
  // transform cannot parse — so any test importing a `.tsx` module dies at
  // transform time ("content contains invalid JS syntax"). Overriding the JSX
  // runtime here lets a test import a SERVER COMPONENT page and exercise its
  // gating ORDER — see test/performance-report-audit.test.ts, which proves a
  // REFUSED request writes no audit row. "automatic" needs no React import in
  // scope, tsconfig is untouched (Next still compiles the app), and no pre-existing
  // test imports JSX, so this is purely additive. NB `oxc`, not `esbuild`: Vite 8
  // transforms with Oxc.
  oxc: { jsx: { runtime: "automatic" } },
});
