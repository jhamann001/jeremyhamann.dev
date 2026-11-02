import { defineConfig, devices } from "@playwright/test";
import { assertNoFormsDotenvFiles, formsBrowserEnvironment } from "./test/e2e/forms-fixture";

// Fail BEFORE spawning the application. Do not let workstation credentials or
// implicit dotenv values reach either the test runner or its Next.js child.
assertNoFormsDotenvFiles(process.cwd());
const isolatedEnvironment = formsBrowserEnvironment();
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, isolatedEnvironment);

const baseURL = "http://127.0.0.1:3103";

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: /form-library(?:-[a-z-]+)?\.spec\.ts/,
  globalSetup: "./test/e2e/forms-fixture.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    launchOptions: { channel: "chrome" },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: {
    command: `${JSON.stringify(process.execPath)} node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3103`,
    url: `${baseURL}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: isolatedEnvironment,
  },
  projects: [{ name: "forms-synthetic" }],
});
