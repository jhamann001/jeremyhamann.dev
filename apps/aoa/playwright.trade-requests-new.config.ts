import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { validateNewRequestBrowserDatabase } from "./test/e2e/trade-requests-new-fixture";
import { QUESTIONS, TRW11_PORTS, activeAccountsSnapshot } from "./test/e2e/trade-requests-new-synthetic";

// Synthetic-only New Request check: AOA flag on (3151, dev server) and off
// (3152, production build), a local Trade Request service (8151) on its own
// local database, and a loopback Warehouse stub (9151) with a generated
// synthetic household snapshot.
// Nothing deployed is contacted.
validateNewRequestBrowserDatabase();
for (const path of [".env", ".env.local", ".env.production", ".env.production.local"]) {
  if (existsSync(path)) throw new Error("trade_requests_new_browser_requires_no_dotenv_files");
}
const serviceDir = process.env.TRW11_SERVICE_DIR || join(homedir(), "src/trw/svc-ticket");
const serviceDb = process.env.TRW11_SERVICE_DB || "trw_local_tkt_372";
if (!/^trw_local_[a-z0-9_]+$/.test(serviceDb)) throw new Error("trade_requests_new_browser_requires_local_service_database");
if (!existsSync(join(serviceDir, "server/dist/index.js"))) throw new Error("trade_requests_new_browser_requires_built_service");

const isolated: Record<string, string> = {};
for (const key of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TERM", "DATABASE_URL", "DIRECT_DATABASE_URL"]) {
  if (process.env[key]) isolated[key] = process.env[key]!;
}
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, isolated);

const snapshotDir = join(tmpdir(), "trw11-active-accounts");
mkdirSync(snapshotDir, { recursive: true });
const snapshotFile = join(snapshotDir, "2026-10-16.json");
writeFileSync(snapshotFile, JSON.stringify(activeAccountsSnapshot()));

const devCopy = join(tmpdir(), "trw11-aoa-dev");
const localKey = process.env.TRW11_LOCAL_KEY ?? (process.env.TRW11_LOCAL_KEY = randomBytes(24).toString("hex"));
const serviceUrl = `http://127.0.0.1:${TRW11_PORTS.service}`;

const aoa = {
  PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: process.env.DATABASE_URL!, DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL!,
  APP_ENV: "dev", AUTH_DEV_LOGIN: "1", AUTH_SECRET: "synthetic-trade-requests-new-browser-secret", AUTH_TRUST_HOST: "true",
  GOOGLE_APPLICATION_CREDENTIALS: "/dev/null", GCE_METADATA_HOST: "127.0.0.1:9", TRANSFER_TRACKER_URL: "http://127.0.0.1:9",
  TRADE_REQUEST_API_URL: serviceUrl, TRADE_REQUEST_DELEGATED_LOCAL_KEY: localKey,
  STATEMENT_PIPELINE_URL: "", WAREHOUSE_URL: "http://127.0.0.1:9", WAREHOUSE_API_KEY: "",
};

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: /trade-requests-new-(on|off)\.spec\.ts/,
  globalSetup: "./test/e2e/trade-requests-new-fixture.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: "list",
  outputDir: "test-results/trade-requests-new",
  use: { ...devices["Desktop Chrome"], launchOptions: { channel: "chrome" }, screenshot: "on", trace: "retain-on-failure", video: "off" },
  webServer: [
    {
      command: "npx tsx test/e2e/trade-requests-new-warehouse-stub.ts", url: `http://127.0.0.1:${TRW11_PORTS.warehouse}/health`,
      timeout: 60_000, reuseExistingServer: false,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TRW11_WAREHOUSE_PORT: String(TRW11_PORTS.warehouse) },
    },
    {
      command: "node server/dist/index.js", cwd: serviceDir, url: `${serviceUrl}/api/health`, timeout: 60_000, reuseExistingServer: false,
      env: {
        PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "development", PORT: String(TRW11_PORTS.service),
        DB_HOST: "/tmp", DB_NAME: serviceDb, DB_USER: process.env.USER ?? "", DB_PASSWORD: "",
        GOOGLE_CLIENT_ID: "local", GOOGLE_CLIENT_SECRET: "local", SESSION_SECRET: "trw11-local-session", CLIENT_ORIGIN: serviceUrl,
        AOA_DELEGATED_AUDIENCE: `${serviceUrl}/api/aoa`, AOA_DELEGATED_CALLER_SA: "aoa-local@delegated.invalid", AOA_DELEGATED_LOCAL_KEY: localKey,
        WAREHOUSE_URL: `http://127.0.0.1:${TRW11_PORTS.warehouse}`, WAREHOUSE_API_KEY: "synthetic",
        WAREHOUSE_CONTACTS_QUESTION_ID: QUESTIONS.contacts, WAREHOUSE_INVESTMENTS_QUESTION_ID: QUESTIONS.investments,
        WAREHOUSE_BALANCES_QUESTION_ID: QUESTIONS.balances,
        MERIDIAN_SNAPSHOT_SOURCE: "file", MERIDIAN_SNAPSHOT_FILE: snapshotFile,
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
        `npx next dev --hostname 127.0.0.1 --port ${TRW11_PORTS.on}`,
      ].join(" && "),
      url: `http://127.0.0.1:${TRW11_PORTS.on}/api/health`,
      timeout: 240_000, reuseExistingServer: false,
      env: { ...aoa, AUTH_URL: `http://127.0.0.1:${TRW11_PORTS.on}`, EPIC_TRADE_REQUESTS_WORKSPACE: "1" },
    },
    {
      command: `npm run start -- --hostname 127.0.0.1 --port ${TRW11_PORTS.off}`, url: `http://127.0.0.1:${TRW11_PORTS.off}/api/health`,
      timeout: 120_000, reuseExistingServer: false,
      env: { ...aoa, AUTH_URL: `http://127.0.0.1:${TRW11_PORTS.off}`, EPIC_TRADE_REQUESTS_WORKSPACE: "0" },
    },
  ],
  projects: [
    { name: "trade-requests-new-flag-on", testMatch: /trade-requests-new-on\.spec\.ts/, use: { baseURL: `http://127.0.0.1:${TRW11_PORTS.on}` } },
    { name: "trade-requests-new-flag-off", testMatch: /trade-requests-new-off\.spec\.ts/, use: { baseURL: `http://127.0.0.1:${TRW11_PORTS.off}` } },
  ],
});
