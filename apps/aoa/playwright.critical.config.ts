import { defineConfig, devices } from "@playwright/test";

const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;

/**
 * Authenticated critical-surface smoke for CI.
 *
 * This runs only against the ephemeral PostgreSQL service after the repository's
 * synthetic seed has been applied. It intentionally uses the local credentials
 * provider and never receives Okta credentials, production data, an ingest
 * token, or a persisted browser session.
 */
export default defineConfig({
  testDir: "./test/e2e",
  testMatch: /critical-surfaces\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: true,
  retries: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  timeout: 60_000,
  expect: { timeout: 12_000 },
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    launchOptions: { channel: "chrome" },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: {
    command: `npm run start -- --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      APP_ENV: "local",
      AUTH_DEV_LOGIN: "1",
      CRM_IDENTITY_READS: "1",
      CRM_RELATIONSHIPS: "1",
      CRM_REPORTING: "1",
      DATA_HEALTH: "1",
      // Synthetic accounts must never reach workstation ADC or live sources.
      GOOGLE_APPLICATION_CREDENTIALS: "/dev/null",
      GCE_METADATA_HOST: "127.0.0.1:9",
      TRANSFER_TRACKER_URL: "http://127.0.0.1:9",
      TRADE_REQUEST_API_URL: "http://127.0.0.1:9",
      STATEMENT_PIPELINE_URL: "",
      WAREHOUSE_URL: "http://127.0.0.1:9",
      WAREHOUSE_API_KEY: "",
    },
  },
  projects: [{ name: "critical-surfaces", use: { ...devices["Desktop Chrome"] } }],
});
