import { configDefaults, defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // A production build copies the source, tests included, into .next/standalone.
    exclude: [...configDefaults.exclude, ".next/**"],
    // PDF round-trip tests take one to two seconds alone and can pass the 5 s default
    // when the whole suite runs in parallel.
    testTimeout: 20_000,
    // Let Vite resolve NextAuth's extensionless Next.js imports in the
    // real-cookie proxy integration suite, as Next does in the app build.
    server: { deps: { inline: ["next-auth", "@auth/core"] } },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
