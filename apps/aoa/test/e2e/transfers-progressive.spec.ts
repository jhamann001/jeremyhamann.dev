import { expect, test } from "@playwright/test";
const ROWS = '[data-list-row-id^="PN-TRANSFER-"]';
test("Transfer board appends bounded interleaved cards and restores safe board return", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "IntersectionObserver", { value: undefined, configurable: true }));
  await page.goto("/?callbackUrl=%2Fhouseholds");
  await page.getByRole("button", { name: "Riley Ops · OPERATIONS (sees all)", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Households", exact: true })).toBeVisible();
  await page.goto("/asset-transfer?q=PN+Transfer+Fixture");
  await expect(page.locator(ROWS)).toHaveCount(150);
  await expect(page.locator('[data-list-ready="true"]')).toHaveCount(1);
  await expect(page.getByText("50 of 135 loaded", { exact: true })).toHaveCount(3);
  await page.getByRole("button", { name: "Load more transfers", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(300);
  const selected = page.locator('[data-list-row-id="PN-TRANSFER-0270"]');
  await selected.scrollIntoViewIfNeeded();
  const offset = await selected.evaluate(row => row.getBoundingClientRect().top - document.querySelector('[data-list-scroll-container]')!.getBoundingClientRect().top);
  await selected.click();
  const back = page.getByRole("link", { name: "‹ All transfers", exact: true });
  await expect(back).toHaveAttribute("href", "/asset-transfer?q=PN+Transfer+Fixture");
  await back.click();
  await expect(page.locator(ROWS)).toHaveCount(300);
  await expect.poll(async () => Math.abs(await selected.evaluate(row => row.getBoundingClientRect().top - document.querySelector('[data-list-scroll-container]')!.getBoundingClientRect().top) - offset)).toBeLessThan(8);
  await page.getByRole("button", { name: "Load more transfers", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(405);
  await page.getByRole("textbox", { name: "Search transfers by client name" }).fill("PN Transfer Fixture 0405");
  await expect(page.getByRole("link", { name: /PN Transfer Fixture 0405/ })).toHaveCount(2);
  const storage = await page.evaluate(() => JSON.stringify(Object.entries(sessionStorage)));
  expect(storage).not.toContain("PN Transfer Fixture Household");
});

test("Transfer current-owner navigation stays usable and changed access clears separate search results", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "IntersectionObserver", { value: undefined, configurable: true }));
  await page.goto("/?callbackUrl=%2Fhouseholds");
  await page.getByRole("button", { name: "Riley Ops · OPERATIONS (sees all)", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Households", exact: true })).toBeVisible();
  await page.goto("/asset-transfer?q=PN+Transfer+Fixture");
  await expect(page.locator(ROWS)).toHaveCount(150);
  await expect(page.locator('[data-list-ready="true"]')).toHaveCount(1);
  await page.getByRole("navigation", { name: "Filter transfers by owner" }).getByRole("link", { name: "All", exact: true }).click();
  await page.getByRole("button", { name: "Load more transfers", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(300);
  await page.getByRole("textbox", { name: "Search transfers by client name" }).fill("PN Transfer Fixture 0405");
  await expect(page.getByRole("link", { name: /PN Transfer Fixture 0405/ })).toHaveCount(1);
  await page.route("**/api/navigation/transfers?**", async route => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("page") === "3" && !query.has("mode")) {
      const original = await route.fetch();
      await route.fulfill({ status: 409, contentType: "application/json", headers: {
        "Cache-Control": "private, no-store", "X-AOA-Navigation-Scope": original.headers()["x-aoa-navigation-scope"],
      }, body: JSON.stringify({ error: "transfers_changed" }) });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Load more transfers", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Search transfers by client name" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /PN Transfer Fixture 0405/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(150);
  await expect(page.getByRole("textbox", { name: "Search transfers by client name" })).toHaveValue("");
});
