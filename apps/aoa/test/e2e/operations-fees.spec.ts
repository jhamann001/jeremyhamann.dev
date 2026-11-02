import { expect, test, type Page } from "@playwright/test";
import { manualOperationsLoading, signInOperations } from "./operations-browser-helpers";

const PATH = "/operations/fee-requests";
const API = "/api/operations/fee-requests";
const ROWS = "[data-request-id]";
const SCROLLER = "[data-list-scroll-container]";
const id = (index: number) => `fee_history_synthetic_${String(index).padStart(4, "0")}`;
async function ready(page: Page, count = 100) {
  await expect(page.getByRole("heading", { name: "Fee Credits & Service Guarantees", exact: true })).toBeVisible();
  await expect(page.locator('[data-list-ready="true"]')).toHaveCount(1);
  await expect(page.locator(ROWS)).toHaveCount(count);
}
async function loadMore(page: Page, count: number) {
  const start = Date.now();
  await page.getByRole("button", { name: "Load more requests", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(count);
  test.info().annotations.push({ type: "local-fees-append-ms", description: String(Date.now() - start) });
}
async function offset(page: Page, requestId: string) {
  return page.locator(`[data-request-id="${requestId}"]`).evaluate((row) => row.getBoundingClientRect().top - document.querySelector("[data-list-scroll-container]")!.getBoundingClientRect().top);
}
test.afterEach(async () => {
  const measurements = test.info().annotations.filter(({ type }) => type.startsWith("local-fees"));
  if (measurements.length) {
    await test.info().attach("local-fee-measurements", { body: JSON.stringify(measurements), contentType: "application/json" });
    console.info("Synthetic fee-request measurements:", JSON.stringify(measurements));
  }
});

test("new request is collapsed, keyboard accessible, and retains form values and submission key while hidden", async ({ page }) => {
  await manualOperationsLoading(page);
  await signInOperations(page, PATH);
  await ready(page);
  const opener = page.getByRole("button", { name: "+ New request", exact: true });
  await expect(opener).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("textbox", { name: "Client", exact: true })).toBeHidden();
  const key = await page.locator('input[name="submissionKey"]').inputValue();
  await opener.focus(); await page.keyboard.press("Enter");
  await page.locator('input[name="feeAmount"]').fill("12.34");
  await page.getByRole("checkbox", { name: "Wire", exact: true }).check();
  await page.getByRole("button", { name: "Close new request form", exact: true }).click();
  await expect(page.locator('input[name="feeAmount"]')).toBeHidden();
  await page.getByRole("button", { name: "+ New request", exact: true }).click();
  await expect(page.locator('input[name="feeAmount"]')).toHaveValue("12.34");
  await expect(page.getByRole("checkbox", { name: "Wire", exact: true })).toBeChecked();
  expect(await page.locator('input[name="submissionKey"]').inputValue()).toBe(key);
  await page.goto(`${PATH}?message=submission-failed`);
  await expect(page.getByRole("button", { name: "Close new request form", exact: true })).toHaveAttribute("aria-expanded", "true");
});

test("all requests are reachable in bounded pages without history entries or stored client rows", async ({ page }) => {
  await manualOperationsLoading(page);
  const start = Date.now();
  await signInOperations(page, PATH);
  await ready(page);
  test.info().annotations.push({ type: "local-fees-first-100-ms", description: String(Date.now() - start) });
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue("");
  await expect(page.getByText("1–100 of 215 matching requests", { exact: true })).toBeVisible();
  const history = await page.evaluate(() => window.history.length);
  await loadMore(page, 200); await loadMore(page, 215);
  await expect(page.getByText("All matching requests are shown.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.history.length)).toBe(history);
  const rowIds = await page.locator(ROWS).evaluateAll((rows) => rows.map((row) => row.getAttribute("data-request-id")));
  expect(new Set(rowIds).size).toBe(215);
  const last = page.locator(`[data-request-id="${id(215)}"]`);
  await last.locator("summary").first().click();
  await expect(last.getByText("SYNTHETIC-TICKET-42", { exact: true })).toBeVisible();
  const persisted = await page.evaluate(() => JSON.stringify({ session: Object.entries(sessionStorage), local: Object.entries(localStorage), history: window.history.state }));
  for (const text of ["Fee Paging Synthetic client", "SYNTHETIC-TICKET-42", "Synthetic request detail for paging verification", "SYNTHETIC0042"]) expect(persisted).not.toContain(text);
});

test("tabs, full-population filters and sort survive reload and Back", async ({ page }) => {
  await manualOperationsLoading(page);
  await signInOperations(page, PATH); await ready(page);
  await page.getByLabel("Status", { exact: true }).selectOption("CREDITED");
  await page.getByLabel("Sort by", { exact: true }).selectOption("amount");
  await page.getByLabel("Order", { exact: true }).selectOption("asc");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await ready(page, 5);
  expect(await page.locator(ROWS).first().getAttribute("data-request-id")).toBe(id(211));
  await page.getByRole("button", { name: "Reset filters", exact: true }).click(); await ready(page);
  await page.getByRole("button", { name: "Service guarantees & exceptions", exact: true }).click(); await ready(page, 15);
  await page.getByRole("combobox", { name: "Request type", exact: true }).selectOption("BILLING_EXCEPTION");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click(); await ready(page, 5);
  await page.reload(); await ready(page, 5);
  await expect(page.getByRole("combobox", { name: "Request type", exact: true })).toHaveValue("BILLING_EXCEPTION");
  await page.goBack(); await ready(page, 15);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 900 }, { width: 768, height: 900 }]) {
  test(`waiver and billing restart months are visible in the list and each record at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await manualOperationsLoading(page);
    await signInOperations(page, `${PATH}?tab=exceptions`);
    await ready(page, 15);
    const examples = [
      { index: 216, start: "September 2026", restart: "December 2026" },
      { index: 218, start: "September 2026", restart: "No scheduled restart" },
      { index: 219, start: "November 2026", restart: "February 2027" },
    ];
    for (const example of examples) {
      const selected = page.locator(`[data-request-id="${id(example.index)}"]`);
      const summary = selected.locator("summary").first();
      await expect(selected).not.toHaveAttribute("open", "");
      await expect(summary.getByText("Waiver start", { exact: true })).toBeVisible();
      await expect(summary.getByText(example.start, { exact: true })).toBeVisible();
      await expect(summary.getByText("Billing restart", { exact: true })).toBeVisible();
      await expect(summary.getByText(example.restart, { exact: true })).toBeVisible();
      for (const text of ["Waiver start", example.start, "Billing restart", example.restart]) {
        expect(await summary.getByText(text, { exact: true }).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      }
      await summary.scrollIntoViewIfNeeded();
      const bounds = await summary.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    }
    await page.locator(`[data-request-id="${id(216)}"]`).scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath(`waiver-dates-list-${viewport.width}.png`), fullPage: true });
    for (const example of examples) {
      const selected = page.locator(`[data-request-id="${id(example.index)}"]`);
      await selected.locator("summary").first().click();
      const body = selected.locator(":scope > div").first();
      await expect(body.getByText("Waiver start", { exact: true }).locator("..")).toHaveText(`Waiver start${example.start}`);
      await expect(body.getByText("Billing restart", { exact: true }).locator("..")).toHaveText(`Billing restart${example.restart}`);
      await expect(body.getByText(example.start, { exact: true })).toBeVisible();
      await expect(body.getByText(example.restart, { exact: true })).toBeVisible();
      await selected.getByRole("link", { name: "Open request page →" }).click();
      await expect(page.locator(ROWS)).toHaveCount(1);
      const record = page.locator(`[data-request-id="${id(example.index)}"]`);
      await expect(record).toHaveAttribute("open", "");
      const recordBody = record.locator(":scope > div").first();
      await expect(recordBody.getByText(example.start, { exact: true })).toBeVisible();
      await expect(recordBody.getByText(example.restart, { exact: true })).toBeVisible();
      if (example.index === 216) {
        await page.screenshot({ path: test.info().outputPath(`waiver-dates-record-${viewport.width}.png`), fullPage: true });
      }
      await page.getByRole("link", { name: "← Back to requests", exact: true }).click();
      await ready(page, 15);
    }
  });
}

test("expanded request, page range and scroll restore across detail Back, app Back and refresh", async ({ page }) => {
  await manualOperationsLoading(page);
  await signInOperations(page, PATH); await ready(page); await loadMore(page, 200);
  const selected = page.locator(`[data-request-id="${id(180)}"]`);
  await selected.locator("summary").first().click();
  await selected.getByRole("link", { name: "Open request page →" }).scrollIntoViewIfNeeded();
  const before = await offset(page, id(180));
  await selected.getByRole("link", { name: "Open request page →" }).click();
  await expect(page).toHaveURL(new RegExp(`request=${id(180)}`));
  await expect(page.locator(ROWS)).toHaveCount(1);
  const start = Date.now();
  await page.goBack(); await ready(page, 200);
  await expect(selected).toHaveAttribute("open", "");
  await expect.poll(async () => Math.abs(await offset(page, id(180)) - before)).toBeLessThan(10);
  test.info().annotations.push({ type: "local-fees-return-ms", description: String(Date.now() - start) });
  await page.goForward(); await expect(page.locator(ROWS)).toHaveCount(1);
  await page.getByRole("link", { name: "← Back to requests", exact: true }).click(); await ready(page, 200);
  await expect(selected).toHaveAttribute("open", "");
  await page.reload(); await ready(page, 200);
  await expect.poll(async () => Math.abs(await offset(page, id(180)) - before)).toBeLessThan(10);
});

test("append retry keeps existing rows and changed snapshots clear the old results before refresh", async ({ page }) => {
  await manualOperationsLoading(page); await signInOperations(page, PATH); await ready(page);
  let failures = 1;
  await page.route(`**${API}?**`, async (route) => {
    if (new URL(route.request().url()).searchParams.get("page") === "2" && failures-- > 0) await route.fulfill({ status: 503, json: { error: "unavailable" } });
    else await route.continue();
  });
  await page.getByRole("button", { name: "Load more requests", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible(); await expect(page.locator(ROWS)).toHaveCount(100);
  await page.getByRole("button", { name: "Retry", exact: true }).click(); await expect(page.locator(ROWS)).toHaveCount(200);
  await page.unroute(`**${API}?**`);
  await page.route(`**${API}?**`, async (route) => {
    if (new URL(route.request().url()).searchParams.get("page") === "3") await route.fulfill({ status: 409, json: { error: "changed" } });
    else await route.continue();
  });
  await page.getByRole("button", { name: "Load more requests", exact: true }).click(); await expect(page.locator(ROWS)).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh results", exact: true }).click(); await ready(page);
});

test("near-end scrolling fetches only the next bounded page", async ({ page }) => {
  await signInOperations(page, PATH); await ready(page);
  const pages: string[] = [];
  page.on("request", (request) => { const url = new URL(request.url()); if (url.pathname === API) pages.push(url.searchParams.get("page") ?? ""); });
  await page.locator(SCROLLER).evaluate((container) => { container.scrollTop = container.scrollHeight; });
  await expect(page.locator(ROWS)).toHaveCount(200);
  expect(pages).toEqual(["2"]);
});

test("an inline workflow action returns to its filtered exception workspace", async ({ page }) => {
  await manualOperationsLoading(page);
  await signInOperations(page, `${PATH}?tab=exceptions&type=BILLING_EXCEPTION`);
  await ready(page, 5);
  const selected = page.locator(`[data-request-id="${id(217)}"]`);
  await selected.locator("summary").first().click();
  await selected.getByRole("button", { name: "Approve request", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`message=workflow-updated&request=${id(217)}`));
  await expect(page.locator(ROWS)).toHaveCount(1);
  await expect(page.getByText("The request workflow was updated.", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "← Back to requests", exact: true }).click();
  await expect(page).toHaveURL(new RegExp("tab=exceptions&type=BILLING_EXCEPTION"));
  await ready(page, 5);
  await expect(selected).toHaveAttribute("open", "");
  await expect(selected.getByText("This waiver is approved. AOA records the decision but does not alter billing.", { exact: true })).toBeVisible();
});

test("dev Slack preview distinguishes saved evidence from current flags and never links to production", async ({ page }) => {
  await signInOperations(page, `${PATH}?request=${id(1)}`);
  const panel = page.getByRole("region", { name: "Slack readiness · development only", exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.locator("details")).not.toHaveAttribute("open", "");
  await panel.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(panel.getByText("Preview only — no message sent by this view.", { exact: true })).toBeVisible();
  await expect(panel.getByText("PENDING", { exact: true })).toBeVisible();
  await expect(panel.getByText("OFF", { exact: true })).toHaveCount(2);
  await expect(panel.getByText("Blocked in development", { exact: true })).toBeVisible();
  await expect(panel.locator("pre")).toContainText(`Request ID: ${id(1)}`);
  await expect(panel.locator("pre")).toContainText("https://aoa.jeremyhamann.dev/");
  await expect(panel.locator('a[href^="https://"]')).toHaveCount(0);
  await expect(panel.getByRole("button")).toHaveCount(0);
  await expect(panel.getByRole("link", { name: "Open this request in development" })).toHaveAttribute("href", `${PATH}?request=${id(1)}#request-${id(1)}`);
  await page.reload();
  await panel.locator("summary").click();
  await expect(panel.getByText("PENDING", { exact: true })).toBeVisible();
  await page.goto(`${PATH}?request=${id(215)}`);
  await panel.locator("summary").click();
  await expect(panel.getByText("No notification record exists for this request.", { exact: true })).toBeVisible();
  await expect(panel.getByText("Production message template · NOT SENT by this preview", { exact: true })).toBeVisible();
});
