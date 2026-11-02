import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";
import { validateTradeRequestsDriftDatabase } from "./test/e2e/trade-requests-drift-fixture";

// Synthetic-only Drift and Roster check (ticket): two loopback servers from one build over the same
// synthetic database (aoa_trb09_synthetic, migrated and seeded): Drift view, roster and exclusion-overlap
// switches on (3191) and the Drift view switch off (3192). The drift and roster routes read trade_request.* in
// that database; the overlap analyzer reads client ids from a synthetic Warehouse on 3193, served over HTTPS with
// a throwaway self-signed certificate because the Trade Request Warehouse transport refuses plain HTTP.
// Never targets a deployed AOA. Run `npm run build` first.
validateTradeRequestsDriftDatabase();
for (const path of [".env", ".env.local", ".env.production", ".env.production.local"]) {
  if (existsSync(path)) throw new Error("trade_requests_drift_requires_no_dotenv_files");
}
// Playwright merges the parent env into webServer.env: replace the parent with
// an allowlist so workstation integration secrets never reach the servers.
const isolated: Record<string, string> = {};
for (const key of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TERM", "DATABASE_URL", "DIRECT_DATABASE_URL"]) {
  if (process.env[key]) isolated[key] = process.env[key]!;
}
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, isolated);

const TLS_DIR = `${process.env.TMPDIR ?? "/tmp"}/ticket-warehouse-tls`;
if (!existsSync(`${TLS_DIR}/cert.pem`)) {
  mkdirSync(TLS_DIR, { recursive: true });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${TLS_DIR}/key.pem`, "-out", `${TLS_DIR}/cert.pem`,
    "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
}
const warehouse = {
  WAREHOUSE_URL: "https://127.0.0.1:3193", WAREHOUSE_API_KEY: "synthetic-warehouse-key", NODE_EXTRA_CA_CERTS: `${TLS_DIR}/cert.pem`,
  WAREHOUSE_CONTACTS_QUESTION_ID: "6043", WAREHOUSE_INVESTMENTS_QUESTION_ID: "6040", WAREHOUSE_BALANCES_QUESTION_ID: "6042",
};

const common = {
  PATH: process.env.PATH ?? "", DATABASE_URL: process.env.DATABASE_URL!, DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL!,
  APP_ENV: "dev", AUTH_DEV_LOGIN: "1", AUTH_SECRET: "synthetic-trade-requests-drift-test-secret", AUTH_TRUST_HOST: "true",
  GOOGLE_APPLICATION_CREDENTIALS: "/dev/null", GCE_METADATA_HOST: "127.0.0.1:9", TRANSFER_TRACKER_URL: "http://127.0.0.1:9",
  TRADE_REQUEST_API_URL: "http://127.0.0.1:9", STATEMENT_PIPELINE_URL: "", WAREHOUSE_URL: "http://127.0.0.1:9", WAREHOUSE_API_KEY: "",
  EPIC_TRADE_REQUESTS_WORKSPACE: "1", EPIC_TRADE_REQUESTS_BACKEND_MOVE: "1", TRADE_REQUESTS_ROSTER_ADMIN: "1",
};

export default defineConfig({
  testDir: "./test/e2e",
  globalSetup: "./test/e2e/trade-requests-drift-fixture.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: "test-results/trade-requests-drift",
  use: { ...devices["Desktop Chrome"], launchOptions: { channel: "chrome" }, screenshot: "on", trace: "retain-on-failure", video: "off" },
  webServer: [
    {
      command: "npx tsx test/e2e/trade-requests-drift-warehouse-stub.ts", url: "https://127.0.0.1:3193/health", ignoreHTTPSErrors: true,
      timeout: 60_000, reuseExistingServer: false,
      env: { PATH: process.env.PATH ?? "", ticket_WAREHOUSE_PORT: "3193", ticket_WAREHOUSE_TLS_DIR: TLS_DIR },
    },
    {
      command: "npm run start -- --hostname 127.0.0.1 --port 3191", url: "http://127.0.0.1:3191/api/health",
      timeout: 120_000, reuseExistingServer: false,
      env: {
        ...common, ...warehouse, AUTH_URL: "http://127.0.0.1:3191", TRADE_REQUESTS_DRIFT_VIEW: "1",
        TRADE_REQUEST_DRIFT_EXCLUSION_OVERLAP_ENABLED: "1",
      },
    },
    {
      command: "npm run start -- --hostname 127.0.0.1 --port 3192", url: "http://127.0.0.1:3192/api/health",
      timeout: 120_000, reuseExistingServer: false,
      env: { ...common, AUTH_URL: "http://127.0.0.1:3192", TRADE_REQUESTS_DRIFT_VIEW: "0" },
    },
  ],
  projects: [
    { name: "trade-requests-drift-on", testMatch: /trade-requests-drift-on\.spec\.ts/, use: { baseURL: "http://127.0.0.1:3191" } },
    { name: "trade-requests-drift-off", testMatch: /trade-requests-drift-off\.spec\.ts/, use: { baseURL: "http://127.0.0.1:3192" } },
  ],
});
