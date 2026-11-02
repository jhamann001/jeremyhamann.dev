import { defineConfig, devices } from "@playwright/test";

// Synthetic component-only regression checks. Real disclosure, summary and
// draft controls, but no application server, database or external requests.
// These do not claim authenticated deployed-feature acceptance.
export default defineConfig({
  testDir: "./test/e2e",
  testMatch: /transfer-overview\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  use: { ...devices["Desktop Chrome"], channel: "chrome" },
});
