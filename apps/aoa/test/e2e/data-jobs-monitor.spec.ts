import { expect, test, type Page } from "@playwright/test";
import type { JobListResponse, JobRun, JobSummary } from "../../lib/data-jobs/contracts";
import { signInOperations } from "./operations-browser-helpers";

const observedAt = "2026-09-18T14:00:00.000Z";
function execution(index: number): JobRun {
  return {
    id: `synthetic-attempt-${index}`, jobId: "synthetic-aum", logicalRunId: `synthetic-logical-${index}`,
    retryOf: index === 1 ? "synthetic-attempt-2" : null, correlation: "exact",
    status: index === 2 ? "FAILED" : "SUCCEEDED", evidence: "provider_execution",
    startedAt: observedAt, finishedAt: observedAt, observedAt, durationMs: 5000,
    recordsProcessed: null, recordsRejected: null, code: null,
    executionUrl: `https://example.invalid/workflow/synthetic/executions/${index}`,
  };
}

function summary(id: string, name: string, status: JobSummary["status"]): JobSummary {
  return {
    definition: { id, name, source: "Synthetic source", environment: "dev", provider: "n8n", providerId: "synthetic-provider", trigger: "Schedule trigger", runner: "Synthetic n8n", destination: "Synthetic mirror", consumers: ["Synthetic report"], owner: "Synthetic Operations", jobUrl: "https://example.invalid/workflows/synthetic", expectedEnabled: true, graceSeconds: 300, maxRunSeconds: 600 },
    status, reason: "Synthetic provider evidence used only by this local browser test.",
    observation: { jobId: id, observedAt, enabled: true, schedule: { kind: "scheduled", expression: "0 9 * * 1-5", timezone: "America/New_York", nextRunAt: "2026-09-21T13:00:00.000Z", nextRunBasis: "calculated", nextRetryAt: null }, coverage: "partial", windowStart: "2026-09-11T14:00:00.000Z", windowEnd: observedAt, code: null },
    monitoringStale: false, latestRun: execution(1), lastSuccessAt: observedAt, lastFailureAt: observedAt,
    incidents: [{ kind: "failure", openedAt: observedAt, resolvedAt: observedAt, delivery: "DISABLED" }],
    stats: { windowStart: "2026-09-11T14:00:00.000Z", windowEnd: observedAt, executions: 2, succeeded: 1, failed: 1, acknowledged: 0, running: 0, successRate: null, rateLabel: "Rate unavailable because history is partial; not confirmed AOA commits." },
  };
}

async function mockMonitoring(page: Page) {
  const state = { listRequests: 0, historyRequests: 0, failList: false, failureStatus: 503, failHistory: false, historyCursors: [] as string[], listQueries: [] as string[] };
  await page.route("**/api/data-health/jobs**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/runs")) {
      state.historyRequests += 1;
      if (state.failHistory) { await route.fulfill({ status: 403, json: { error: "Synthetic access denied" } }); return; }
      const cursor = url.searchParams.get("cursor") ?? "";
      state.historyCursors.push(cursor);
      const start = cursor ? 26 : 1;
      await route.fulfill({ json: { runs: Array.from({ length: 25 }, (_, index) => execution(index + start)), nextCursor: cursor ? null : "history-page-2" } });
      return;
    }
    state.listRequests += 1;
    state.listQueries.push(url.search);
    if (state.failList) {
      await route.fulfill({ status: state.failureStatus, json: { error: "Synthetic inaccessible database detail must not be shown" } });
      return;
    }
    const q = url.searchParams.get("q") ?? "";
    const status = url.searchParams.get("status");
    const cursor = url.searchParams.get("cursor");
    let jobs = [summary("synthetic-aum", "Synthetic AUM import", "FAILED")];
    if (cursor) jobs = [summary("synthetic-crm", "Synthetic CRM import", "HEALTHY")];
    if (q || status) jobs = [summary("synthetic-aum", "Synthetic AUM import", "FAILED"), summary("synthetic-crm", "Synthetic CRM import", "HEALTHY")].filter((job) => (!q || job.definition.name.toLowerCase().includes(q.toLowerCase())) && (!status || job.status === status));
    const response: JobListResponse = { generatedAt: new Date(Date.parse(observedAt) + state.listRequests * 1000).toISOString(), jobs, total: q || status ? jobs.length : 2, nextCursor: !q && !status && !cursor ? "jobs-page-2" : null, collector: { lastCompletedAt: observedAt, stale: false, alertsEnabled: false } };
    await route.fulfill({ json: response });
  });
  return state;
}

async function ready(page: Page) {
  await signInOperations(page, "/data-health/jobs");
  await expect(page.getByRole("heading", { name: "Data sources & jobs", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Synthetic AUM import/ })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  // This test suite must not navigate to an external provider or load external assets.
  await page.route("**/*", async (route) => {
    const hostname = new URL(route.request().url()).hostname;
    if (hostname === "127.0.0.1") await route.continue();
    else await route.abort();
  });
});

test("unauthenticated monitoring endpoints return uncached JSON401 without a login redirect", async ({ request }) => {
  for (const path of ["/api/data-health/jobs", "/api/data-health/jobs/synthetic-aum/runs"]) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status()).toBe(401);
    expect(response.headers()["content-type"]).toContain("application/json");
    expect(response.headers()["cache-control"]).toContain("no-store");
  }
});

test("source evidence is separate from provider rates and expires during failed polling", async ({ page }) => {
  const at = new Date("2026-09-18T18:00:00.000Z");
  await page.clock.install({ time: at });
  const job = summary("prod-account-aum", "Synthetic AUM source evidence", "HEALTHY");
  job.definition = { ...job.definition, environment: "prod", provider: "cloud-scheduler" };
  job.applicationEvidence = {
    schemaVersion: 1, sourceKey: "ACCOUNT_AUM", environment: "prod", observedAt: at.toISOString(), coverage: "snapshot_only",
    status: "PARTIAL", code: "partial_commit_recorded", correlation: "source_only", latestCommitAt: at.toISOString(),
    lastAttemptAt: at.toISOString(), lastFailureAt: null, lastFailureSource: null, recordsCommitted: 100, recordsRejected: 5,
    businessAsOf: "2026-09-17", commitTrigger: "scheduled_primary", latestFeedWarning: null, stages: [],
    freshness: { status: "CURRENT", checkedAt: at.toISOString(), basis: "committed_snapshot_date", expectedBusinessAsOf: "2026-09-17", code: "committed_snapshot_current" },
  };
  job.applicationEvidenceStale = false;
  let fail = false;
  await page.route("**/api/data-health/jobs**", async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/runs")) return route.fulfill({ json: { runs: [], nextCursor: null } });
    if (fail) return route.fulfill({ status: 503, json: { error: "synthetic" } });
    return route.fulfill({ json: { generatedAt: at.toISOString(), jobs: [job], nextCursor: null, total: 1, collector: { lastCompletedAt: at.toISOString(), stale: false, alertsEnabled: false } } });
  });
  await signInOperations(page, "/data-health/jobs");
  const toggle = page.getByRole("button", { name: /Synthetic AUM source evidence/ });
  await expect(toggle).toContainText("Partial source result");
  await toggle.click();
  const evidence = page.getByRole("region", { name: "AOA source completion evidence" });
  await expect(evidence).toContainText("Current at last check");
  await expect(evidence).toContainText("100 / 5");
  await expect(evidence).toContainText("not linked to a specific provider execution");
  fail = true;
  await page.clock.fastForward(16 * 60000);
  await expect(page.getByRole("heading", { name: "Job monitoring is temporarily unavailable" })).toBeVisible();
  await expect(toggle).toContainText("Source unverified");
  await expect(evidence).not.toContainText("Current at last check");
  await expect(evidence).toContainText("Last-known timestamps are historical only");
  await expect(evidence).toContainText("100 / 5");
});

test("real local authenticated registry reads return unobserved dev jobs without running providers", async ({ page }) => {
  await signInOperations(page, "/data-health/jobs");
  await expect(page.getByRole("heading", { name: "Data sources & jobs", exact: true })).toBeVisible();
  // No route mock in this test: the app reads the isolated synthetic database.
  const response = await page.request.get("/api/data-health/jobs");
  expect(response.status()).toBe(200);
  const data = await response.json() as JobListResponse;
  expect(data.total).toBe(12);
  expect(data.jobs).toHaveLength(12);
  expect(data.jobs.every((job) => job.definition.environment === "dev" && job.status === "UNKNOWN" && job.observation === null && job.latestRun === null)).toBe(true);
  expect(data.collector).toEqual({ lastCompletedAt: null, stale: true, alertsEnabled: false });
  const history = await page.request.get(`/api/data-health/jobs/${encodeURIComponent(data.jobs[0].definition.id)}/runs`);
  expect(history.status()).toBe(200);
  expect(await history.json()).toEqual({ runs: [], nextCursor: null });
  await expect(page.getByText("Monitoring is stale or has not started.", { exact: true })).toBeVisible();
});

test("compact cards lazy-load paginated history, filter, and keep expansion during refresh", async ({ page }, testInfo) => {
  const state = await mockMonitoring(page);
  await ready(page);
  expect(state.historyRequests).toBe(0);
  const card = page.getByRole("button", { name: /Synthetic AUM import/ });
  await expect(card).toHaveAttribute("aria-expanded", "false");
  await card.focus();
  await page.keyboard.press("Enter");
  await expect(card).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#job-panel-synthetic-aum tbody tr")).toHaveCount(25);
  const desktopScreenshot = testInfo.outputPath("data-jobs-desktop.png");
  await page.screenshot({ path: desktopScreenshot });
  await testInfo.attach("data-jobs-desktop", { path: desktopScreenshot, contentType: "image/png" });
  expect(state.historyRequests).toBe(1);
  await page.getByRole("button", { name: "Load older executions", exact: true }).click();
  await expect(page.locator("#job-panel-synthetic-aum tbody tr")).toHaveCount(50);
  expect(state.historyCursors).toEqual(["", "history-page-2"]);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(card).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#job-panel-synthetic-aum tbody tr")).toHaveCount(50);
  await page.getByRole("button", { name: "Load more jobs", exact: true }).click();
  await expect(page.getByRole("button", { name: /Synthetic CRM import/ })).toBeVisible();
  await page.getByLabel("Find a source or job").fill("CRM");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Synthetic CRM import/ })).toBeVisible();
  await page.getByLabel("Execution health").selectOption("FAILED");
  await expect(page.getByRole("heading", { name: "No jobs match these filters" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(card).toHaveAttribute("aria-expanded", "true");
  expect(state.listQueries.some((query) => query.includes("q=CRM") && query.includes("status=FAILED"))).toBe(true);
});

test("refresh polling preserves keyboard focus and stops fetching while hidden", async ({ page }) => {
  const state = await mockMonitoring(page);
  await page.clock.install();
  await ready(page);
  const card = page.getByRole("button", { name: /Synthetic AUM import/ });
  await card.click();
  await expect(page.locator("#job-panel-synthetic-aum tbody tr")).toHaveCount(25);
  const input = page.getByLabel("Find a source or job");
  await input.fill("unsent search text");
  await input.focus();
  const before = state.listRequests;
  await page.clock.fastForward(31_000);
  await expect.poll(() => state.listRequests).toBeGreaterThan(before);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("unsent search text");
  await expect(card).toHaveAttribute("aria-expanded", "true");
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  const hiddenCount = state.listRequests;
  await page.clock.fastForward(61_000);
  expect(state.listRequests).toBe(hiddenCount);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect.poll(() => state.listRequests).toBeGreaterThan(hiddenCount);
});

test("failed refresh retains clearly stale observations and recovers without leaking errors", async ({ page }) => {
  const state = await mockMonitoring(page);
  await ready(page);
  state.failList = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const warning = page.getByRole("alert").filter({ hasText: "Job monitoring is temporarily unavailable" });
  await expect(warning).toContainText("Previously loaded observations are shown");
  await expect(page.getByRole("button", { name: /Synthetic AUM import/ })).toBeVisible();
  await expect(page.getByText("Synthetic inaccessible database detail must not be shown")).toHaveCount(0);
  state.failList = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(warning).toHaveCount(0);
});

test("narrow-content cards remain compact and execution history scrolls within its panel", async ({ page }, testInfo) => {
  // The existing shared app shell retains a 248px sidebar on phones. This test
  // verifies the new page at a narrow usable content width, not mobile-shell support.
  await page.setViewportSize({ width: 680, height: 844 });
  await mockMonitoring(page);
  await ready(page);
  const card = page.getByRole("button", { name: /Synthetic AUM import/ });
  await card.click();
  await expect(page.locator("#job-panel-synthetic-aum tbody tr")).toHaveCount(25);
  const history = page.getByRole("region", { name: "Execution history, scroll horizontally for all columns" });
  expect(await history.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const narrowScreenshot = testInfo.outputPath("data-jobs-narrow-content.png");
  await page.screenshot({ path: narrowScreenshot });
  await testInfo.attach("data-jobs-narrow-content", { path: narrowScreenshot, contentType: "image/png" });
  await card.click();
  await expect(card).toHaveAttribute("aria-expanded", "false");
  await expect(history).toHaveCount(0);
});

test("list access denial clears earlier observations instead of retaining them as stale", async ({ page }) => {
  const state = await mockMonitoring(page);
  await ready(page);
  state.failList = true;
  state.failureStatus = 403;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Job monitoring is temporarily unavailable" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Synthetic AUM import/ })).toHaveCount(0);
});

test("history access denial also clears the enclosing job registry", async ({ page }) => {
  const state = await mockMonitoring(page);
  await ready(page);
  const card = page.getByRole("button", { name: /Synthetic AUM import/ });
  await card.click();
  await expect(page.locator("#job-panel-synthetic-aum tbody tr")).toHaveCount(25);
  state.failHistory = true;
  await page.getByRole("button", { name: "Refresh history", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Job monitoring is temporarily unavailable" })).toBeVisible();
  await expect(card).toHaveCount(0);
  await expect(page.locator("#job-panel-synthetic-aum tbody tr")).toHaveCount(0);
});
