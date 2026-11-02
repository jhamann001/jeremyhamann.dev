import { defineConfig, devices } from "@playwright/test";
import { validateProgressiveDatabaseEnvironment } from "./test/e2e/progressive-fixture";

// Fail before spawning Next.js, not merely before fixture writes. A deployed
// database URL must never reach even the local web server's health/read path.
validateProgressiveDatabaseEnvironment();

const port = 3101;
const baseURL = `http://127.0.0.1:${port}`;

/** Synthetic-only authenticated navigation tests; never target deployed AOA. */
export default defineConfig({
  testDir: "./test/e2e",
  testMatch: /(?:households|clients|audit|transfers|reporting|deals|crm|household-history|directory-contention)-progressive\.spec\.ts/,
  globalSetup: "./test/e2e/progressive-fixture.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 12_000 },
  reporter: "list",
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
      // Deliberately differ from the hydration regression's browser timezone.
      TZ: "UTC",
      APP_ENV: "local",
      AUTH_DEV_LOGIN: "1",
      GLOBAL_SEARCH: "1",
      CRM_IDENTITY_READS: "1",
      CRM_RELATIONSHIPS: "1",
      CRM_REPORTING: "1",
      DATA_HEALTH: "1",
      // Existing shell badges can call a source connector after paint. Keep
      // this synthetic browser harness disconnected from workstation ADC and
      // from the application's production fallback service URLs.
      GOOGLE_APPLICATION_CREDENTIALS: "/dev/null",
      GCE_METADATA_HOST: "127.0.0.1:9",
      TRANSFER_TRACKER_URL: "http://127.0.0.1:9",
      TRADE_REQUEST_API_URL: "http://127.0.0.1:9",
      STATEMENT_PIPELINE_URL: "",
      WAREHOUSE_URL: "http://127.0.0.1:9",
      WAREHOUSE_API_KEY: "",
    },
  },
  projects: [{ name: "households-progressive" }],
});
