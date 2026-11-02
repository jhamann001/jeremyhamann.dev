import { expect, test, type Page } from "@playwright/test";

const ROOT = "[data-reporting-progressive-list]";
const ROWS = `${ROOT} [data-list-row-id]`;
const FILTER = "PN Fixture";
const METRICS = `${ROOT} [class*="reportMetrics"]`;
async function signIn(page: Page) {
  await page.addInitScript(() => Object.defineProperty(window, "IntersectionObserver", { value: undefined, configurable: true }));
  await page.goto("/?callbackUrl=%2Fhouseholds");
  await page.getByRole("button", { name: "Riley Ops · OPERATIONS (sees all)", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Households", exact: true })).toBeVisible();
}
async function ready(page: Page, count = 100) {
  await expect(page.getByRole("heading", { name: "Reporting", exact: true })).toBeVisible();
  await expect(page.locator(`${ROOT}[data-list-ready="true"]`)).toHaveCount(1);
  await expect(page.locator(ROWS)).toHaveCount(count);
}
async function offset(page: Page, id: string) {
  return page.locator(`[data-list-row-id="${id}"]`).evaluate(element => element.getBoundingClientRect().top -
    document.querySelector("[data-list-scroll-container]")!.getBoundingClientRect().top);
}
async function append(page: Page, label: string, count: number) {
  await page.getByRole("button", { name: `Load more ${label}`, exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(count);
}

test("Reporting appends100/200/300/350 without changing metrics or exporting records", async ({ page }) => {
  await signIn(page); await page.goto("/reporting?search=PN%20Fixture"); await ready(page);
  const metrics = await page.locator(METRICS).innerText();
  expect(metrics).toContain("350");
  const historyLength = await page.evaluate(() => history.length);
  for (const count of [200, 300, 350]) await append(page, "households & aum", count);
  await expect(page.locator(METRICS)).toHaveText(metrics, { useInnerText: true });
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await expect(page.getByText("Showing 1–350 of 350", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /export/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /export/i })).toHaveCount(0);
  const ids = await page.locator(ROWS).evaluateAll(elements => elements.map(element => element.getAttribute("data-list-row-id")));
  expect(new Set(ids).size).toBe(350);
  await page.reload(); await ready(page, 350);
  await expect(page.getByRole("textbox", { name: "Search households or advisors", exact: true })).toHaveValue(FILTER);
  const stored = await page.evaluate(() => JSON.stringify({ session: Object.entries(sessionStorage), local: Object.entries(localStorage), state: history.state }));
  expect(stored).not.toContain("PN Fixture Household");
  expect(stored).not.toContain("PN Fixture Person");
  expect(stored).not.toContain("synthetic-person-");
});

test("Reporting dataset tabs restore each query/range/disclosure and household drilldown returns", async ({ page }) => {
  await signIn(page); await page.goto("/reporting?search=PN%20Fixture"); await ready(page);
  await append(page, "households & aum", 200);
  const definitions = page.locator("details").filter({ has: page.locator("summary", { hasText: "Metric definitions and known exclusions" }) });
  await definitions.locator("summary").click();
  await expect(definitions).toHaveAttribute("open", "");
  await page.getByRole("navigation", { name: "Report datasets" }).getByRole("link", { name: "Client engagement", exact: true }).click();
  await expect(page).toHaveURL(/dataset=client_engagement/);
  await page.getByRole("textbox", { name: "Search households or advisors", exact: true }).fill(FILTER);
  await page.getByRole("button", { name: "Apply", exact: true }).click(); await ready(page);
  const engagementMetrics = await page.locator(METRICS).innerText();
  await append(page, "client engagement", 200);
  await expect(page.locator(METRICS)).toHaveText(engagementMetrics, { useInnerText: true });
  await page.getByRole("navigation", { name: "Report datasets" }).getByRole("link", { name: "Households & AUM", exact: true }).click();
  await ready(page, 200);
  await expect(page.getByRole("textbox", { name: "Search households or advisors", exact: true })).toHaveValue(FILTER);
  await expect(definitions).toHaveAttribute("open", "");
  const selected = page.locator(ROWS).nth(150), id = await selected.getAttribute("data-list-row-id");
  await selected.scrollIntoViewIfNeeded(); const saved = await offset(page, id!);
  await selected.getByRole("link", { name: /PN Fixture Household/ }).click();
  const back = page.getByRole("link", { name: "‹ Back to results", exact: true });
  await expect(back).toHaveAttribute("href", /^\/reporting\?/);
  await page.goBack(); await ready(page, 200);
  await expect.poll(async () => Math.abs(await offset(page, id!) - saved)).toBeLessThan(8);
  await page.goForward(); await expect(back).toBeVisible(); await back.click(); await ready(page, 200);
  await expect.poll(async () => Math.abs(await offset(page, id!) - saved)).toBeLessThan(8);
  await page.getByRole("navigation", { name: "Report datasets" }).getByRole("link", { name: "Client engagement", exact: true }).click();
  await ready(page, 200);
  await expect(page.getByRole("textbox", { name: "Search households or advisors", exact: true })).toHaveValue(FILTER);
});
