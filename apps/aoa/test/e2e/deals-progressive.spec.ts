import { expect, test, type Page } from "@playwright/test";

const QUERY = "PN Deal Fixture";
const PATH = `/deals?q=${encodeURIComponent(QUERY)}`;
const ROWS = '[data-list-row-id^="PN-DEAL-"]';
const SCROLLER = "[data-list-scroll-container]";
const row = (page: Page, id: string) => page.locator(`[data-list-row-id="${id}"]`);

async function signIn(page: Page) {
  await page.goto("/?callbackUrl=%2Fhouseholds");
  await expect(page.getByRole("heading", { name: "Dev sign-in" })).toBeVisible();
  await page.getByRole("button", { name: "Riley Ops · OPERATIONS (sees all)", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Households", exact: true })).toBeVisible();
}
async function manual(page: Page) {
  await page.addInitScript(() => Object.defineProperty(window, "IntersectionObserver", { value: undefined, configurable: true }));
}
async function openList(page: Page) {
  await page.goto(PATH);
  await expect(page.getByRole("heading", { name: "Deals", exact: true })).toBeVisible();
  await expect(page.locator('[data-list-ready="true"]')).toHaveCount(1);
  await expect(page.locator(ROWS)).toHaveCount(100);
  await expect(page.getByText("Showing 1–100 of 350", { exact: true })).toBeVisible();
}
async function append(page: Page, count: number) {
  await page.getByRole("button", { name: "Load more deals", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(count);
  await expect(page.getByText(`Showing 1–${count} of 350`, { exact: true })).toBeVisible();
}
async function offset(page: Page, id: string) {
  return row(page, id).evaluate(element => element.getBoundingClientRect().top -
    document.querySelector("[data-list-scroll-container]")!.getBoundingClientRect().top);
}

test("Deals appends a bounded range and exports all matches from the first page", async ({ page }) => {
  await manual(page); await signIn(page); await openList(page);
  const historyLength = await page.evaluate(() => history.length);
  const [download] = await Promise.all([
    page.waitForEvent("download"), page.getByRole("button", { name: "Export filtered deals as CSV" }).click(),
  ]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const csv = Buffer.concat(chunks).toString("utf8");
  expect(csv).toContain("PN Deal Fixture Deal 0350");
  expect(csv).not.toContain("PN Deal Fixture Deal 0351");
  expect(csv.trim().split(/\r?\n/)).toHaveLength(351);
  await expect(page.locator(ROWS)).toHaveCount(100);
  for (const count of [200, 300, 350]) await append(page, count);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await expect(page.getByRole("button", { name: "Load more deals", exact: true })).toHaveCount(0);
  const ids = await page.locator(ROWS).evaluateAll(elements => elements.map(element => element.getAttribute("data-list-row-id")));
  expect(new Set(ids).size).toBe(350);
  const persisted = await page.evaluate(() => JSON.stringify({ local: Object.entries(localStorage), session: Object.entries(sessionStorage), state: history.state }));
  expect(persisted).not.toContain("PN Deal Household");
  expect(persisted).not.toContain("synthetic-deal-private-");
  expect(persisted).not.toContain("PN Deal Fixture Deal");
});

test("Deals browser/in-app return and refresh restore the page-two anchor", async ({ page }) => {
  await manual(page); await signIn(page); await openList(page); await append(page, 200);
  const id = "PN-DEAL-0180";
  await row(page, id).scrollIntoViewIfNeeded();
  const savedOffset = await offset(page, id);
  await row(page, id).getByText("PN Deal Fixture Person 0180", { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/deals/${id}$`));
  await expect(page.getByRole("link", { name: "‹ Back to results", exact: true })).toHaveAttribute("href", expect.stringContaining("q=PN+Deal+Fixture"));
  await page.goBack();
  await expect(page.locator(ROWS)).toHaveCount(200);
  await expect.poll(async () => Math.abs(await offset(page, id) - savedOffset)).toBeLessThan(8);
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/deals/${id}$`));
  await page.reload();
  await page.getByRole("link", { name: "‹ Back to results", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(200);
  await expect.poll(async () => Math.abs(await offset(page, id) - savedOffset)).toBeLessThan(8);
  await page.reload();
  await expect(page.locator(ROWS)).toHaveCount(200);
  await expect.poll(async () => Math.abs(await offset(page, id) - savedOffset)).toBeLessThan(8);
});

test("Deals filters/sort are URL-backed and modal close preserves the filter", async ({ page }) => {
  await manual(page); await signIn(page); await openList(page);
  await page.getByRole("button", { name: /^Funded\s+\d+$/ }).click();
  await expect(page).toHaveURL(/stage=WON/);
  await expect(page.locator(ROWS)).toHaveCount(70);
  await page.getByRole("button", { name: "Amount", exact: true }).click();
  await expect(page).toHaveURL(/sort=amount/);
  await page.getByRole("button", { name: "Amount ▲", exact: true }).click();
  await expect(page).toHaveURL(/dir=desc/);
  await expect(page.locator(ROWS).first()).toHaveAttribute("data-list-row-id", "PN-DEAL-0348");
  await page.getByRole("link", { name: "+ New deal", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Deal details" })).toBeVisible();
  await expect(page).toHaveURL(/new=1/);
  await page.getByRole("button", { name: "Close deal details", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Deal details" })).toHaveCount(0);
  await expect(page).toHaveURL(/stage=WON/);
  await expect(page).toHaveURL(/dir=desc/);
  await expect(page.locator(ROWS)).toHaveCount(70);
  await page.getByRole("button", { name: /^Removed\s+\d+$/ }).click();
  await expect(page).toHaveURL(/archived=1/);
  await expect(page.locator(ROWS)).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Export filtered deals as CSV" })).toHaveCount(0);
});

test("Deals next-page auth failure immediately clears rows and KPI metadata", async ({ page }) => {
  await manual(page); await signIn(page); await openList(page);
  await page.route("**/api/navigation/deals?**", async route => {
    if (new URL(route.request().url()).searchParams.get("page") === "2") {
      await route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"unauthorized"}' });
    } else await route.continue();
  });
  // Hold the fresh RSC refresh long enough to prove old confidential rows were
  // discarded, not just replaced with a successful response from the fixture.
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
  await page.route(url => url.pathname === "/deals", async route => {
    if (route.request().headers()["rsc"] === "1") await refreshGate;
    await route.continue();
  });
  try {
    await page.getByRole("button", { name: "Load more deals", exact: true }).click();
    await expect(page.locator(ROWS)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Export filtered deals as CSV" })).toBeDisabled();
    await expect(page.getByRole("button", { name: /^All\s+0$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Removed\s/ })).toHaveCount(0);
    await expect(page.getByText("0 · $0", { exact: true })).toHaveCount(5);
  } finally { releaseRefresh(); }
});

test("Deals observer requests only one next page and preserves shell scroll", async ({ page }) => {
  await signIn(page); await openList(page);
  const requested: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/navigation/deals") requested.push(request.url()); });
  const before = await page.locator(SCROLLER).evaluate(container => { container.scrollTop = container.scrollHeight; return container.scrollTop; });
  await expect(page.locator(ROWS)).toHaveCount(200);
  expect(requested.map(url => new URL(url).searchParams.get("page"))).toEqual(["2"]);
  expect(Math.abs(await page.locator(SCROLLER).evaluate(container => container.scrollTop) - before)).toBeLessThan(3);
});
