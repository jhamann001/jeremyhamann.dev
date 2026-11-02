import { defineConfig, devices } from "@playwright/test";
import { validateAcatReviewBrowserDatabase } from "./test/e2e/acat-link-review-fixture";

validateAcatReviewBrowserDatabase();
const port = 3114;
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "./test/e2e", testMatch: /acat-link-review\.spec\.ts/,
  globalSetup: "./test/e2e/acat-link-review-fixture.ts",
  fullyParallel: false, workers: 1, retries: 0, forbidOnly: true,
  timeout: 60_000, expect: { timeout: 15_000 }, reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL, launchOptions: { channel: "chrome" }, trace: "retain-on-failure", screenshot: "only-on-failure", video: "off" },
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/api/health`, timeout: 120_000, reuseExistingServer: false,
    env: { ...process.env, APP_ENV: "local", AUTH_DEV_LOGIN: "1", AUTH_SECRET: "synthetic-acat-browser-session-secret-local-only",
      ACAT_LINK_REVIEW: "1", ACAT_AUTO_LINK: "0", AOA_WRITES_PAUSED: "0",
      TRANSFER_LINKAGE_URL: "", TRANSFER_LINKAGE_INSTALLATION_ID: "synthetic-acat-link-browser", TRANSFER_LINKAGE_ENVIRONMENT: "synthetic",
      GOOGLE_APPLICATION_CREDENTIALS: "/dev/null", GCE_METADATA_HOST: "127.0.0.1:9",
      TRANSFER_TRACKER_URL: "http://127.0.0.1:9", TRADE_REQUEST_API_URL: "http://127.0.0.1:9", STATEMENT_PIPELINE_URL: "",
      WAREHOUSE_URL: "http://127.0.0.1:9", WAREHOUSE_API_KEY: "",
      OPERATIONS_SLACK_CAPTURE_ENABLED: "false", OPERATIONS_SLACK_DELIVERY_ENABLED: "false", OPERATIONS_SLACK_BOT_TOKEN: "",
    },
  },
  projects: [{ name: "acat-link-review-synthetic" }],
});
