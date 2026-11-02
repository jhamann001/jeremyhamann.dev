import { expect, test, type Page } from "@playwright/test";
import { manualOperationsLoading, signInOperations } from "./operations-browser-helpers";

const PATH = "/operations/trade-reconciliation";
const API = "/api/operations/trade-reconciliation/history";
const ROWS = "[data-history-id]";
const SCROLLER = "[data-list-scroll-container]";
const id = (n: number) => `browserrecon${String(n).padStart(8, "0")}`;
test("saved run corrects stale 100% and displays saved Notes in summary and detail", async ({ page }) => {
  await signInOperations(page, `${PATH}?run=${id(1)}`);
  await expect(page.getByText("Meridian match rate", { exact: true })).toBeVisible();
  await expect(page.getByText("80.00%", { exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Notes", exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic order cancelled before Apex submission", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Detail", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: "Notes", exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic order cancelled before Apex submission", { exact: true })).toBeVisible();
});
async function openHistory(page: Page) {
  const started = Date.now();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(100);
  test.info().annotations.push({ type: "local-history-first-100-ms", description: String(Date.now() - started) });
}
async function loadMore(page: Page, count: number) {
  const started = Date.now();
  await page.getByRole("button", { name: "Load more history", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(count);
  test.info().annotations.push({ type: "local-history-append-ms", description: String(Date.now() - started) });
}
async function offset(page: Page, run: string) {
  return page.locator(`[data-history-id="${run}"]`).evaluate((row) => row.getBoundingClientRect().top - document.querySelector("[data-list-scroll-container]")!.getBoundingClientRect().top);
}
test.afterEach(async () => {
  const measurements = test.info().annotations.filter(({ type }) => type.startsWith("local-"));
  if (measurements.length) {
    await test.info().attach("local-history-measurements", { body: JSON.stringify(measurements), contentType: "application/json" });
    console.info("Synthetic Operations browser measurements:", JSON.stringify(measurements));
  }
});

test("run submission stays busy, prevents another click, and resets after a source failure redirect", async ({ page }) => {
  await signInOperations(page, PATH);
  await page.getByLabel("Run date", { exact: true }).fill("2026-09-17");
  const submit = page.getByRole("button", { name: "Run reconciliation", exact: true });
  await expect(submit).toBeEnabled();

  let submissions = 0;
  let releaseResponse = () => {};
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  await page.route((url) => url.pathname === PATH, async (route) => {
    // Sidebar read actions also POST to this URL; intercept only this form.
    if (route.request().method() !== "POST" ||
      !route.request().postData()?.includes('runDate"')) return route.continue();
    submissions += 1;
    await responseGate;
    // Model the server action's failure redirect without invoking the action,
    // touching warehouse sources, or storing a reconciliation run.
    await route.fulfill({
      status: 303,
      contentType: "text/plain",
      headers: { "x-action-redirect": `${PATH}?date=2026-09-17&message=run-failed;push` },
      body: "",
    });
  });

  try {
    await submit.click();
    const pending = page.getByRole("button", { name: "Running reconciliation…", exact: true });
    await expect(pending).toBeVisible();
    await expect(pending).toBeDisabled();
    await expect(pending).toHaveAttribute("aria-busy", "true");
    await expect(pending).toHaveCSS("background-color", "rgb(232, 227, 216)");
    await expect(pending.locator('[aria-hidden="true"]')).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Reconciliation is running." })).toHaveCount(1);
    await expect(pending.getByRole("status")).toHaveCount(0);
    await expect.poll(() => submissions).toBe(1);
    // Native click respects disabled, unlike dispatchEvent, which bypasses it.
    await pending.evaluate((button) => (button as HTMLButtonElement).click());
    expect(submissions).toBe(1);
  } finally {
    releaseResponse();
  }

  await expect(page).toHaveURL(/message=run-failed/);
  await expect(page.getByRole("alert")).toHaveText("The source query or save failed. No incomplete run was stored.");
  await expect(submit).toBeEnabled();
  await expect(submit).toHaveAttribute("aria-busy", "false");
  await expect(submit.locator('[aria-hidden="true"]')).toHaveCount(0);
  expect(submissions).toBe(1);
});

test("starts blank, reaches every old run with bounded pages, and retains no row cache", async ({ page }) => {
  await manualOperationsLoading(page);
  const reads: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname === API) reads.push(request.url()); });
  await signInOperations(page, PATH);
  await expect(page.getByText("No reconciliation loaded.", { exact: true })).toBeVisible();
  expect(reads).toEqual([]);
  await openHistory(page);
  const before = await page.evaluate(() => history.length);
  for (const count of [200, 300, 315]) await loadMore(page, count);
  await expect(page.getByText("End of reconciliation history.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(before);
  expect(reads.map((url) => new URL(url).searchParams.get("page"))).toEqual(["1", "2", "3", "4"]);
  const persisted = await page.evaluate(() => JSON.stringify({ local: Object.entries(localStorage), session: Object.entries(sessionStorage), state: history.state }));
  expect(persisted).not.toContain('"matched"');
  expect(persisted).not.toContain('"rate"');
  expect(persisted).not.toContain("Synthetic oldest run note");
  await page.locator(`[data-history-id="${id(1)}"] a`).click();
  await expect(page.getByRole("textbox", { name: "Run note", exact: true })).toHaveValue("Synthetic oldest run note");
});

test("browser Back, refresh, and in-app History restore pages and the scroll anchor", async ({ page }) => {
  await manualOperationsLoading(page);
  await signInOperations(page, PATH);
  await openHistory(page);
  await loadMore(page, 200);
  const selected = id(136);
  await page.locator(`[data-history-id="${selected}"]`).scrollIntoViewIfNeeded();
  const before = await offset(page, selected);
  await page.locator(`[data-history-id="${selected}"] a`).click();
  await expect(page).toHaveURL(new RegExp(`run=${selected}`));
  await expect(page.getByRole("textbox", { name: "Run note", exact: true })).toBeVisible();
  const started = Date.now();
  await page.goBack();
  await expect(page.locator(ROWS)).toHaveCount(200);
  await expect.poll(async () => Math.abs(await offset(page, selected) - before)).toBeLessThan(8);
  test.info().annotations.push({ type: "local-history-return-ms", description: String(Date.now() - started) });
  await page.goForward();
  await expect(page.getByRole("textbox", { name: "Run note", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(200);
  await expect.poll(async () => Math.abs(await offset(page, selected) - before)).toBeLessThan(8);
  await page.reload();
  await expect(page.locator(ROWS)).toHaveCount(200);
  await expect.poll(async () => Math.abs(await offset(page, selected) - before)).toBeLessThan(8);
  await page.locator(`[data-history-id="${selected}"] a`).click();
  await expect(page.getByRole("textbox", { name: "Run note", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(200);
  await expect.poll(async () => Math.abs(await offset(page, selected) - before)).toBeLessThan(8);
  await page.locator(`[data-history-id="${selected}"] a`).click();
  await expect(page.getByRole("textbox", { name: "Run note", exact: true })).toBeVisible();
});

test("period filters apply to full history and survive reload and Back", async ({ page }) => {
  await manualOperationsLoading(page);
  await signInOperations(page, `${PATH}?tab=history&history=monthly`);
  await expect(page.getByRole("tab", { name: "Monthly", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(ROWS)).toHaveCount(11);
  const monthly = await (await page.request.get(`${API}?view=monthly`)).json();
  expect(monthly.rows.reduce((sum: number, row: { matched: number }) => sum + row.matched, 0)).toBe(315 * 8);
  await page.getByRole("tab", { name: "Quarterly", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(4);
  await page.reload();
  await expect(page.getByRole("tab", { name: "Quarterly", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(ROWS)).toHaveCount(4);
  await page.goBack();
  await expect(page.getByRole("tab", { name: "Monthly", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(ROWS)).toHaveCount(11);
});

test("append failure retains rows, retry succeeds, and changed history clears stale rows", async ({ page }) => {
  await manualOperationsLoading(page);
  await signInOperations(page, PATH);
  await openHistory(page);
  let failures = 1;
  await page.route(`**${API}?**`, async (route) => {
    if (new URL(route.request().url()).searchParams.get("page") === "2" && failures-- > 0) await route.fulfill({ status: 503, json: { error: "history_unavailable" } });
    else await route.continue();
  });
  await page.getByRole("button", { name: "Load more history", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry history" })).toBeVisible();
  await expect(page.locator(ROWS)).toHaveCount(100);
  await page.getByRole("button", { name: "Retry history" }).click();
  await expect(page.locator(ROWS)).toHaveCount(200);
  await page.unroute(`**${API}?**`);
  await page.route(`**${API}?**`, async (route) => {
    if (new URL(route.request().url()).searchParams.get("page") === "3") await route.fulfill({ status: 409, json: { error: "history_changed" } });
    else await route.continue();
  });
  await page.getByRole("button", { name: "Load more history", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh history" }).click();
  await expect(page.locator(ROWS)).toHaveCount(100);
});

test("near-end scrolling appends one page and an unauthorized read clears mounted rows", async ({ page }) => {
  await signInOperations(page, PATH);
  await openHistory(page);
  await page.locator(SCROLLER).evaluate((container) => { container.scrollTop = container.scrollHeight; });
  await expect(page.locator(ROWS)).toHaveCount(200);
  await page.route(`**${API}?**`, (route) => route.fulfill({ status: 401, json: { error: "unauthorized" } }));
  await page.getByRole("button", { name: "Load more history", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(0);
  const stored = await page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith("aoa.navigation")));
  expect(stored).toEqual([]);
});
