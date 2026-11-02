import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { validateTradeRequestsExportDatabase } from "./test/e2e/trade-requests-export-fixture";
import { TRW10_PORTS, serviceUrl } from "./test/e2e/trade-requests-export-seed";

// Synthetic-only queue export check: AOA flag on (3191, dev server) and off
// (3192, production build) and a local Trade Request service (8191) on its own
// local database with the service's synthetic seed clients. Nothing deployed
// is contacted. Run `npm run build` first.
validateTradeRequestsExportDatabase();
for (const path of [".env", ".env.local", ".env.production", ".env.production.local"]) {
  if (existsSync(path)) throw new Error("trade_requests_export_browser_requires_no_dotenv_files");
}
const serviceDir = process.env.TRW10_SERVICE_DIR || join(homedir(), "src/trw/svc-ticket");
const serviceDb = process.env.TRW10_SERVICE_DB || "trw_local_tkt_371";
if (!/^trw_local_[a-z0-9_]+$/.test(serviceDb)) throw new Error("trade_requests_export_browser_requires_local_service_database");
if (!existsSync(join(serviceDir, "server/dist/index.js"))) throw new Error("trade_requests_export_browser_requires_built_service");
// Test workers re-read this file after the servers are up.
if (!process.env.TEST_WORKER_INDEX && !existsSync(".next/BUILD_ID")) throw new Error("trade_requests_export_requires_production_build");

const isolated: Record<string, string> = {};
for (const key of [
  "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TERM", "DATABASE_URL", "DIRECT_DATABASE_URL",
  "TRW10_LOCAL_KEY", "TRW10_SERVICE_DB",
]) {
  if (process.env[key]) isolated[key] = process.env[key]!;
}
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, isolated);
process.env.TRW10_LOCAL_KEY ??= randomBytes(24).toString("hex");
process.env.TRW10_SERVICE_DB = serviceDb;
const localKey = process.env.TRW10_LOCAL_KEY;
const service = serviceUrl();
const devCopy = join(tmpdir(), "trw10-aoa-dev");

const aoa = {
  PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: process.env.DATABASE_URL!, DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL!,
  APP_ENV: "dev", AUTH_DEV_LOGIN: "1", AUTH_SECRET: "synthetic-trade-requests-export-browser-secret", AUTH_TRUST_HOST: "true",
  GOOGLE_APPLICATION_CREDENTIALS: "/dev/null", GCE_METADATA_HOST: "127.0.0.1:9", TRANSFER_TRACKER_URL: "http://127.0.0.1:9",
  TRADE_REQUEST_API_URL: service, TRADE_REQUEST_DELEGATED_LOCAL_KEY: localKey,
  STATEMENT_PIPELINE_URL: "", WAREHOUSE_URL: "http://127.0.0.1:9", WAREHOUSE_API_KEY: "",
};

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: /trade-requests-export-(on|off)\.spec\.ts/,
  globalSetup: "./test/e2e/trade-requests-export-fixture.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: "list",
  outputDir: "test-results/trade-requests-export",
  use: { ...devices["Desktop Chrome"], launchOptions: { channel: "chrome" }, screenshot: "on", trace: "retain-on-failure", video: "off", acceptDownloads: true },
  webServer: [
    {
      command: "node server/dist/index.js", cwd: serviceDir, url: `${service}/api/health`, timeout: 60_000, reuseExistingServer: false,
      env: {
        PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "development", PORT: String(TRW10_PORTS.service),
        DB_HOST: "/tmp", DB_NAME: serviceDb, DB_USER: process.env.USER ?? "", DB_PASSWORD: "",
        GOOGLE_CLIENT_ID: "local", GOOGLE_CLIENT_SECRET: "local", SESSION_SECRET: "trw10-local-session", CLIENT_ORIGIN: service,
        AOA_DELEGATED_AUDIENCE: `${service}/api/aoa`, AOA_DELEGATED_CALLER_SA: "aoa-local@delegated.invalid", AOA_DELEGATED_LOCAL_KEY: localKey,
        RATE_LIMIT_USER_MAX: "100000",
      },
    },
    {
      // Local HS256 delegation is compiled out of production builds, so the
      // flag-on server is a dev server, run from a copy so it cannot touch
      // the production build the flag-off server uses.
      command: [
        `rsync -a --delete --exclude .next --exclude node_modules --exclude test-results --exclude .git ./ ${devCopy}/`,
        `ln -sfn "$PWD/node_modules" ${devCopy}/node_modules`,
        `cd ${devCopy}`,
        `npx next dev --hostname 127.0.0.1 --port ${TRW10_PORTS.on}`,
      ].join(" && "),
      url: `http://127.0.0.1:${TRW10_PORTS.on}/api/health`,
      timeout: 240_000, reuseExistingServer: false,
      env: { ...aoa, AUTH_URL: `http://127.0.0.1:${TRW10_PORTS.on}`, EPIC_TRADE_REQUESTS_WORKSPACE: "1" },
    },
    {
      command: `npm run start -- --hostname 127.0.0.1 --port ${TRW10_PORTS.off}`, url: `http://127.0.0.1:${TRW10_PORTS.off}/api/health`,
      timeout: 120_000, reuseExistingServer: false,
      env: { ...aoa, TRADE_REQUEST_API_URL: "http://127.0.0.1:9", TRADE_REQUEST_DELEGATED_LOCAL_KEY: "", AUTH_URL: `http://127.0.0.1:${TRW10_PORTS.off}`, EPIC_TRADE_REQUESTS_WORKSPACE: "0" },
    },
  ],
  projects: [
    { name: "trade-requests-export-flag-on", testMatch: /trade-requests-export-on\.spec\.ts/, use: { baseURL: `http://127.0.0.1:${TRW10_PORTS.on}` } },
    { name: "trade-requests-export-flag-off", testMatch: /trade-requests-export-off\.spec\.ts/, use: { baseURL: `http://127.0.0.1:${TRW10_PORTS.off}` } },
  ],
});
