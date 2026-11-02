import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./test/e2e", testMatch: /acat-cache\.spec\.ts/,
  fullyParallel: false, forbidOnly: true, retries: 0, reporter: "list",
  use: { ...devices["Desktop Chrome"], channel: "chrome" },
});
