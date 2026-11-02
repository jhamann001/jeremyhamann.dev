import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.DATA_JOBS_TEST_URL ?? "http://127.0.0.1:3103";
const target = new URL(baseURL);
if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !target.port || target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
  throw new Error("data_jobs_browser_test_requires_loopback_server");
}

/** The separately started app must use local synthetic Postgres and AUTH_DEV_LOGIN.
 * Only monitoring response JSON is mocked; authentication and rendered UI are real.
 * No application fixture endpoint, provider request, or database mutation is added.
 */
export default defineConfig({
  testDir: ".", testMatch: "data-jobs-monitor.spec.ts", fullyParallel: false,
  workers: 1, forbidOnly: true, retries: 0, timeout: 60_000,
  expect: { timeout: 12_000 }, reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL, launchOptions: { channel: "chrome" },
    trace: "retain-on-failure", screenshot: "only-on-failure", video: "off" },
});
