import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";
import { validateTradeRequestsChecklistDatabase } from "./test/e2e/trade-requests-checklist-fixture";
import { checklistServiceUrl } from "./test/e2e/trade-requests-checklist-seed";

// Synthetic-only pre-approval checklist check. Flag off (3172) runs a copy of
// the production build; flag on (3171) runs `next dev`, because the delegated
// client's local signing key is honored only outside production builds. The
// flag-on server calls a Trade Request service on loopback (TRW08_SERVICE_URL,
// default 127.0.0.1:8171) started with the same TRW08_DELEGATED_LOCAL_KEY.
// Never targets a deployed AOA or service. Run `npm run build` first.
validateTradeRequestsChecklistDatabase();
const serviceUrl = checklistServiceUrl();
if (!process.env.TRW08_DELEGATED_LOCAL_KEY) throw new Error("trade_requests_checklist_requires_local_key");
for (const path of [".env", ".env.local", ".env.production", ".env.production.local", ".env.development", ".env.development.local"]) {
  if (existsSync(path)) throw new Error("trade_requests_checklist_requires_no_dotenv_files");
}
// Test workers re-read this file after `next dev` has replaced .next.
if (!process.env.TEST_WORKER_INDEX && !existsSync(".next/standalone/server.js")) throw new Error("trade_requests_checklist_requires_production_build");
// Playwright merges the parent env into webServer.env: replace the parent with
// an allowlist so workstation integration secrets never reach the servers.
const isolated: Record<string, string> = {};
for (const key of [
  "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TERM", "DATABASE_URL", "DIRECT_DATABASE_URL",
  "TRW08_SERVICE_URL", "TRW08_DELEGATED_LOCAL_KEY",
]) {
  if (process.env[key]) isolated[key] = process.env[key]!;
}
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, isolated);

const common = {
  PATH: process.env.PATH ?? "", DATABASE_URL: process.env.DATABASE_URL!, DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL!,
  APP_ENV: "dev", AUTH_DEV_LOGIN: "1", AUTH_SECRET: "synthetic-trade-requests-checklist-test-secret", AUTH_TRUST_HOST: "true",
  GOOGLE_APPLICATION_CREDENTIALS: "/dev/null", GCE_METADATA_HOST: "127.0.0.1:9", TRANSFER_TRACKER_URL: "http://127.0.0.1:9",
  STATEMENT_PIPELINE_URL: "", WAREHOUSE_URL: "http://127.0.0.1:9", WAREHOUSE_API_KEY: "",
};
const OFF_DIR = `${process.env.TMPDIR ?? "/tmp"}/trw08-flag-off-standalone`;

export default defineConfig({
  testDir: "./test/e2e",
  globalSetup: "./test/e2e/trade-requests-checklist-fixture.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: "list",
  outputDir: "test-results/trade-requests-checklist",
  use: { ...devices["Desktop Chrome"], launchOptions: { channel: "chrome" }, screenshot: "on", trace: "retain-on-failure", video: "off" },
  webServer: [
    {
      command: `rm -rf "${OFF_DIR}" "${OFF_DIR}.ready" && cp -R .next/standalone "${OFF_DIR}" && cp -R .next/static "${OFF_DIR}/.next/static" && cp -R public "${OFF_DIR}/public" && touch "${OFF_DIR}.ready" && node "${OFF_DIR}/server.js"`,
      url: "http://127.0.0.1:3172/api/health", timeout: 180_000, reuseExistingServer: false,
      env: { ...common, PORT: "3172", HOSTNAME: "127.0.0.1", AUTH_URL: "http://127.0.0.1:3172", TRADE_REQUEST_API_URL: "http://127.0.0.1:9", EPIC_TRADE_REQUESTS_WORKSPACE: "0" },
    },
    {
      // Waits for the copy above: `next dev` rewrites .next.
      command: `until [ -f "${OFF_DIR}.ready" ]; do sleep 1; done; npx next dev --hostname 127.0.0.1 --port 3171`, url: "http://127.0.0.1:3171/api/health",
      timeout: 180_000, reuseExistingServer: false,
      env: {
        ...common, AUTH_URL: "http://127.0.0.1:3171", EPIC_TRADE_REQUESTS_WORKSPACE: "1",
        TRADE_REQUEST_API_URL: serviceUrl, TRADE_REQUEST_DELEGATED_LOCAL_KEY: process.env.TRW08_DELEGATED_LOCAL_KEY!,
      },
    },
  ],
  projects: [
    { name: "trade-requests-checklist-flag-on", testMatch: /trade-requests-checklist-on\.spec\.ts/, use: { baseURL: "http://127.0.0.1:3171" } },
    { name: "trade-requests-checklist-flag-off", testMatch: /trade-requests-checklist-off\.spec\.ts/, use: { baseURL: "http://127.0.0.1:3172" } },
  ],
});
