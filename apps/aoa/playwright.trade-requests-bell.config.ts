import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";
import { validateTradeRequestsBellDatabase } from "./test/e2e/trade-requests-bell-fixture";

// Synthetic-only: two loopback servers from one build, epic flag on (3121) and
// off (3122). The bell shell makes no Trade Request call, so the service URL is
// a closed loopback port. Never targets deployed AOA.
validateTradeRequestsBellDatabase();
for (const path of [".env", ".env.local", ".env.production", ".env.production.local"]) {
  if (existsSync(path)) throw new Error("trade_requests_bell_requires_no_dotenv_files");
}
// Playwright merges the parent env into webServer.env: replace the parent with
// an allowlist so workstation integration secrets never reach the servers.
const isolated: Record<string, string> = {};
for (const key of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TERM", "DATABASE_URL", "DIRECT_DATABASE_URL"]) {
  if (process.env[key]) isolated[key] = process.env[key]!;
}
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, isolated);

const common = {
  PATH: process.env.PATH ?? "", DATABASE_URL: process.env.DATABASE_URL!, DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL!,
  APP_ENV: "dev", AUTH_DEV_LOGIN: "1", AUTH_SECRET: "synthetic-trade-requests-bell-test-secret", AUTH_TRUST_HOST: "true",
  GOOGLE_APPLICATION_CREDENTIALS: "/dev/null", GCE_METADATA_HOST: "127.0.0.1:9", TRANSFER_TRACKER_URL: "http://127.0.0.1:9",
  TRADE_REQUEST_API_URL: "http://127.0.0.1:9", STATEMENT_PIPELINE_URL: "", WAREHOUSE_URL: "http://127.0.0.1:9", WAREHOUSE_API_KEY: "",
};

export default defineConfig({
  testDir: "./test/e2e",
  globalSetup: "./test/e2e/trade-requests-bell-fixture.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 12_000 },
  reporter: "list",
  outputDir: "test-results/trade-requests-bell",
  use: { ...devices["Desktop Chrome"], launchOptions: { channel: "chrome" }, screenshot: "on", trace: "retain-on-failure", video: "off" },
  webServer: [
    {
      command: "npm run start -- --hostname 127.0.0.1 --port 3121", url: "http://127.0.0.1:3121/api/health",
      timeout: 120_000, reuseExistingServer: false,
      env: { ...common, AUTH_URL: "http://127.0.0.1:3121", EPIC_TRADE_REQUESTS_WORKSPACE: "1" },
    },
    {
      command: "npm run start -- --hostname 127.0.0.1 --port 3122", url: "http://127.0.0.1:3122/api/health",
      timeout: 120_000, reuseExistingServer: false,
      env: { ...common, AUTH_URL: "http://127.0.0.1:3122", EPIC_TRADE_REQUESTS_WORKSPACE: "0" },
    },
  ],
  projects: [
    { name: "trade-requests-bell-flag-on", testMatch: /trade-requests-bell-on\.spec\.ts/, use: { baseURL: "http://127.0.0.1:3121" } },
    { name: "trade-requests-bell-flag-off", testMatch: /trade-requests-bell-off\.spec\.ts/, use: { baseURL: "http://127.0.0.1:3122" } },
  ],
});
