import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    // `tools/**` (S10b's Help Center toolchain) and `scripts/**` (S9's macro converter, S10b's
    // legacy help desk archive tooling) are in the same tsconfig as `src/**` and must be in the same test
    // run: a CLI path filter cannot reach a file outside `include`, so without this their ~475
    // tests never ran in CI. See the build record.
    // `prisma/**` is here for the same reason: `prisma/machine-users.test.ts` (step 0 of the reference
    // seed) is outside `src/**`, and a CLI path filter cannot reach a file the config does not include.
    // `integrations/**` joined them in round 3: `integrations/n8n/workflows.test.ts` holds the
    // source-level guard that the Gmail intake node never routes on the sender-written `To:` header
    //, and a security
    // regression guard CI does not execute is not a guard. `integrations/n8n/vitest.config.mts` is
    // now redundant and its own docstring says to delete it; that is its owner's file to remove.
    // Wave B adds no new ROOT: `tools/pwa/**` (B10's PNG and VAPID generators), `scripts/legacy-desk-import/**`
    // and `integrations/n8n/**` all fall under the globs already listed, and `infra/**`
    // holds Terraform rather than TypeScript. This note is here so nobody adds a redundant entry —
    // Wave A learned the hard way that a test file outside `include` is a test that never runs, and the
    // opposite mistake (four overlapping globs) is how that happens twice.
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "tools/**/*.test.ts",
      "scripts/**/*.test.ts",
      "prisma/**/*.test.ts",
      "integrations/**/*.test.ts",
    ],
  },
  oxc: {
    jsx: { runtime: "automatic" },
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
});
