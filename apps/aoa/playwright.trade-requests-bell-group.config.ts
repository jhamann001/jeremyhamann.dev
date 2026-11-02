import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";
import { bellGroupServiceUrl, validateTradeRequestsBellGroupDatabase } from "./test/e2e/trade-requests-bell-group-fixture";

// Synthetic-only check of the bell's Trade Request group. Flag off (3162) runs
// a copy of the production build; flag on (3161) runs `next dev`, because the
// delegated client's local signing key is honored only outside production
// builds. The flag-on server calls a Trade Request service on loopback
// (TRW16_SERVICE_URL, default 127.0.0.1:8161) whose local database
// (TRW16_SERVICE_DATABASE_URL) the fixture seeds. Never targets a deployed AOA
// or service. Run `npm run build` first. TRW-05's bell specs run on the same
// servers, because this work order changes the menu they verified.
validateTradeRequestsBellGroupDatabase();
const serviceUrl = bellGroupServiceUrl();
if (!process.env.TRW16_DELEGATED_LOCAL_KEY) throw new Error("trade_requests_bell_group_requires_local_key");
for (const path of [".env", ".env.local", ".env.production", ".env.production.local", ".env.development", ".env.development.local"]) {
  if (existsSync(path)) throw new Error("trade_requests_bell_group_requires_no_dotenv_files");
}
// Test workers re-read this file after `next dev` has replaced .next.
if (!process.env.TEST_WORKER_INDEX && !existsSync(".next/standalone/server.js")) throw new Error("trade_requests_bell_group_requires_production_build");
// Playwright merges the parent env into webServer.env: replace the parent with
// an allowlist so workstation integration secrets never reach the servers.
const isolated: Record<string, string> = {};
for (const key of [
  "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TERM", "DATABASE_URL", "DIRECT_DATABASE_URL",
  "TRW16_SERVICE_URL", "TRW16_SERVICE_DATABASE_URL", "TRW16_DELEGATED_LOCAL_KEY",
]) {
  if (process.env[key]) isolated[key] = process.env[key]!;
}
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, isolated);

const common = {
  PATH: process.env.PATH ?? "", DATABASE_URL: process.env.DATABASE_URL!, DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL!,
  APP_ENV: "dev", AUTH_DEV_LOGIN: "1", AUTH_SECRET: "synthetic-trade-requests-bell-group-test-secret", AUTH_TRUST_HOST: "true",
  GOOGLE_APPLICATION_CREDENTIALS: "/dev/null", GCE_METADATA_HOST: "127.0.0.1:9", TRANSFER_TRACKER_URL: "http://127.0.0.1:9",
  STATEMENT_PIPELINE_URL: "", WAREHOUSE_URL: "http://127.0.0.1:9", WAREHOUSE_API_KEY: "",
};
const OFF_DIR = `${process.env.TMPDIR ?? "/tmp"}/trw16-flag-off-standalone`;
const ON = "http://127.0.0.1:3161";
const OFF = "http://127.0.0.1:3162";

export default defineConfig({
  testDir: "./test/e2e",
  globalSetup: "./test/e2e/trade-requests-bell-group-fixture.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: "list",
  outputDir: "test-results/trade-requests-bell-group",
  use: { ...devices["Desktop Chrome"], launchOptions: { channel: "chrome" }, screenshot: "on", trace: "retain-on-failure", video: "off" },
  webServer: [
    {
      command: `rm -rf "${OFF_DIR}" "${OFF_DIR}.ready" && cp -R .next/standalone "${OFF_DIR}" && cp -R .next/static "${OFF_DIR}/.next/static" && cp -R public "${OFF_DIR}/public" && touch "${OFF_DIR}.ready" && node "${OFF_DIR}/server.js"`,
      url: `${OFF}/api/health`, timeout: 180_000, reuseExistingServer: false,
      env: { ...common, PORT: "3162", HOSTNAME: "127.0.0.1", AUTH_URL: OFF, TRADE_REQUEST_API_URL: "http://127.0.0.1:9", EPIC_TRADE_REQUESTS_WORKSPACE: "0" },
    },
    {
      // Waits for the copy above: `next dev` rewrites .next.
      command: `until [ -f "${OFF_DIR}.ready" ]; do sleep 1; done; npx next dev --hostname 127.0.0.1 --port 3161`, url: `${ON}/api/health`,
      timeout: 180_000, reuseExistingServer: false,
      env: {
        ...common, AUTH_URL: ON, EPIC_TRADE_REQUESTS_WORKSPACE: "1",
        TRADE_REQUEST_API_URL: serviceUrl, TRADE_REQUEST_DELEGATED_LOCAL_KEY: process.env.TRW16_DELEGATED_LOCAL_KEY!,
      },
    },
  ],
  projects: [
    { name: "bell-group-flag-on", testMatch: /trade-requests-bell-group-on\.spec\.ts/, use: { baseURL: ON } },
    { name: "bell-group-flag-off", testMatch: /trade-requests-bell-group-off\.spec\.ts/, use: { baseURL: OFF } },
    { name: "trw05-bell-flag-on", testMatch: /trade-requests-bell-on\.spec\.ts/, use: { baseURL: ON } },
    { name: "trw05-bell-flag-off", testMatch: /trade-requests-bell-off\.spec\.ts/, use: { baseURL: OFF } },
  ],
});
