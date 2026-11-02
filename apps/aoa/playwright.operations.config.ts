import { defineConfig, devices } from "@playwright/test";
import { validateOperationsBrowserDatabase } from "./test/e2e/operations-fixture";

validateOperationsBrowserDatabase();
const port = 3102;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: /operations-(history|fees)\.spec\.ts/,
  globalSetup: "./test/e2e/operations-fixture.ts",
  fullyParallel: false, workers: 1, retries: 0, forbidOnly: true,
  timeout: 60_000, expect: { timeout: 12_000 }, reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL, launchOptions: { channel: "chrome" }, trace: "retain-on-failure", screenshot: "only-on-failure", video: "off" },
  webServer: {
    command: `npm run start -- --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/api/health`, timeout: 120_000, reuseExistingServer: false,
    env: {
      ...process.env, APP_ENV: "dev", AUTH_DEV_LOGIN: "1",
      OPERATIONS_TOOLS: "1", OPERATIONS_TRADE_RECONCILIATION: "1", OPERATIONS_FEE_REQUESTS: "1",
      OPERATIONS_SLACK_CAPTURE_ENABLED: "false", OPERATIONS_SLACK_DELIVERY_ENABLED: "false", OPERATIONS_SLACK_BOT_TOKEN: "",
      GOOGLE_APPLICATION_CREDENTIALS: "/dev/null", GCE_METADATA_HOST: "127.0.0.1:9",
      TRANSFER_TRACKER_URL: "http://127.0.0.1:9", TRADE_REQUEST_API_URL: "http://127.0.0.1:9", STATEMENT_PIPELINE_URL: "",
      WAREHOUSE_URL: "http://127.0.0.1:9", WAREHOUSE_API_KEY: "",
    },
  },
  projects: [{ name: "operations-workspace" }],
});
