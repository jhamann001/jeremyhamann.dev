import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL;
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;

if (!baseURL) {
  throw new Error(
    "PLAYWRIGHT_BASE_URL is required; point it at the deployed development service.",
  );
}

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    launchOptions: executablePath ? { executablePath } : undefined,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "deployed-smoke",
      testMatch: /deployed-smoke\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
