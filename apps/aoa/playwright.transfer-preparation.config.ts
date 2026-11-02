import { defineConfig, devices } from "@playwright/test";

// Actual component and resolver with synthetic action responses. No application
// server, credentials, database or live Tracker requests.
export default defineConfig({
  testDir: "./test/e2e",
  testMatch: /transfer-preparation\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  use: { ...devices["Desktop Chrome"], channel: "chrome" },
});
