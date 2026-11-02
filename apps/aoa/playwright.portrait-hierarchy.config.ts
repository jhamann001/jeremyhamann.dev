import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";
import { validateProgressiveDatabaseEnvironment } from "./test/e2e/progressive-fixture";

// Validate the actual fixture target before starting a server. Writes run with
// APP_ENV=local; only the loopback web server models dev-only presentation flags.
validateProgressiveDatabaseEnvironment();
for (const path of [".env", ".env.local", ".env.production", ".env.production.local"]) {
  if (existsSync(path)) throw new Error("portrait_hierarchy_requires_no_dotenv_files");
}
const variant = process.env.PORTRAIT_HIERARCHY_VARIANT ?? "all";
if (!["none", "relationships", "documents", "all"].includes(variant)) {
  throw new Error("portrait_hierarchy_unknown_flag_variant");
}
// This selects an assertion profile, not application behavior. The dev layout
// opts into Contact; the scoped production candidate keeps the default layout.
const contact = process.env.PORTRAIT_HIERARCHY_CONTACT ?? "1";
if (!["0", "1"].includes(contact)) throw new Error("portrait_hierarchy_unknown_contact_expectation");
const baseURL = "http://127.0.0.1:3106";
const relationships = variant === "relationships" || variant === "all";
const documents = variant === "documents" || variant === "all";
// Playwright merges parent env into webServer.env: replace that parent with an
// allowlist too, so workstation integration secrets never reach the child.
const isolatedEnvironment: Record<string, string> = {
  APP_ENV: "local", PORTRAIT_HIERARCHY_VARIANT: variant, PORTRAIT_HIERARCHY_CONTACT: contact,
};
for (const key of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM", "DATABASE_URL", "DIRECT_DATABASE_URL", "INGEST_DATABASE_URL", "SEED_INGEST_URL"]) {
  if (process.env[key]) isolatedEnvironment[key] = process.env[key]!;
}
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, isolatedEnvironment);
const serverEnvironment = {
  PATH: process.env.PATH ?? "",
  DATABASE_URL: process.env.DATABASE_URL!,
  DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL!,
  APP_ENV: "dev",
  AUTH_DEV_LOGIN: "1",
  AUTH_SECRET: "synthetic-portrait-hierarchy-browser-test-secret",
  AUTH_URL: baseURL,
  AUTH_TRUST_HOST: "true",
  CRM_IDENTITY_READS: "1",
  CRM_RELATIONSHIPS: relationships ? "1" : "0",
  CRM_DOCUMENTS: documents ? "1" : "0",
  CLIENT_PORTRAIT_EXPERIMENTS: variant === "none" ? "0" : "1",
  GOOGLE_APPLICATION_CREDENTIALS: "/dev/null",
  GCE_METADATA_HOST: "127.0.0.1:9",
  TRANSFER_TRACKER_URL: "http://127.0.0.1:9",
  TRADE_REQUEST_API_URL: "http://127.0.0.1:9",
  STATEMENT_PIPELINE_URL: "",
  WAREHOUSE_URL: "http://127.0.0.1:9",
  WAREHOUSE_API_KEY: "",
};

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: /portrait-hierarchy\.spec\.ts/,
  globalSetup: "./test/e2e/portrait-hierarchy-fixture.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 12_000 },
  reporter: "list",
  outputDir: `test-results/portrait-hierarchy-${variant}-contact-${contact}`,
  use: {
    baseURL,
    launchOptions: { channel: "chrome" },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: {
    command: `${JSON.stringify(process.execPath)} node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3106`,
    url: `${baseURL}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: serverEnvironment,
  },
  projects: [
    { name: `portrait-${variant}-desktop`, use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: `portrait-${variant}-mobile`, use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } },
  ],
});
