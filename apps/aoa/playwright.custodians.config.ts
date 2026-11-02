import { defineConfig, devices } from "@playwright/test";

// Component-only synthetic browser checks. No server, database, credentials or
// production source. Page authentication/data access are covered by unit tests;
// this does NOT substitute for authenticated deployed feature acceptance.
export default defineConfig({
  testDir: "./test/e2e",
  testMatch: /custodian-library\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  use: { ...devices["Desktop Chrome"], channel: "chrome" },
});
