import { defineConfig, devices } from "@playwright/test";

// Actual UI with synthetic action responses; PDF rendering/archive integration
// is covered separately. No live client data, credentials or external requests.
export default defineConfig({
  testDir: "./test/e2e", testMatch: /transfer-form-panel\.spec\.ts/,
  fullyParallel: false, forbidOnly: true, retries: 0, reporter: "list",
  use: { ...devices["Desktop Chrome"], channel: "chrome" },
});
