import { defineConfig, devices } from "@playwright/test";

// Real picker UI; synthetic server-action boundaries. No deployed acceptance.
export default defineConfig({
  testDir: "./test/e2e",
  testMatch: /transfer-acat-picker\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  use: { ...devices["Desktop Chrome"], channel: "chrome" },
});
