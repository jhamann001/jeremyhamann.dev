import { defineConfig, devices } from "@playwright/test";
import { validateGroupedTasksDatabase } from "./test/e2e/tasks-grouped-fixture";

validateGroupedTasksDatabase();
const port = 3108;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: /tasks-grouped\.spec\.ts/,
  globalSetup: "./test/e2e/tasks-grouped-fixture.ts",
  workers: 1, fullyParallel: false, retries: 0, forbidOnly: true,
  timeout: 60_000, expect: { timeout: 12_000 }, reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL, launchOptions: { channel: "chrome" },
    trace: "retain-on-failure", screenshot: "only-on-failure", video: "off" },
  webServer: {
    command: `npm run start -- --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/api/health`, reuseExistingServer: false, timeout: 120_000,
    env: { ...process.env, APP_ENV: "local", AUTH_DEV_LOGIN: "1", AUTH_TRUST_HOST: "true",
      CHECKLIST_STAGE_GATE: "1", TASKS_SAMPLE_ROWS: "0",
      GOOGLE_APPLICATION_CREDENTIALS: "/dev/null", GCE_METADATA_HOST: "127.0.0.1:9",
      TRANSFER_TRACKER_URL: "http://127.0.0.1:9", TRADE_REQUEST_API_URL: "http://127.0.0.1:9",
      STATEMENT_PIPELINE_URL: "", WAREHOUSE_URL: "http://127.0.0.1:9", WAREHOUSE_API_KEY: "",
      OPERATIONS_SLACK_CAPTURE_ENABLED: "false", OPERATIONS_SLACK_DELIVERY_ENABLED: "false",
      OPERATIONS_SLACK_BOT_TOKEN: "" },
  },
});
