import { expect, test } from "@playwright/test";
import { NO_PERMISSION, signInAs, type Persona } from "./trade-requests-browser-helpers";

const DESKTOP = { width: 1440, height: 950 };
const MOBILE = { width: 390, height: 844 };
async function shoot(page: import("@playwright/test").Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}

for (const role of ["ADMIN", "OPERATIONS", "ADVISOR"] as Persona[]) {
  test(`${role} desktop opens the native workspace from navigation`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await signInAs(page, role);
    const entry = page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Trade Requests" });
    await expect(entry).toHaveAttribute("href", "/trade-requests");
    expect(await entry.getAttribute("target")).toBeNull();
    await entry.click();
    await expect(page).toHaveURL(/\/trade-requests$/);
    await expect(page.getByRole("heading", { level: 1, name: /^Welcome back, / })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Dev sign-in" })).toHaveCount(0);
    const sub = page.getByRole("navigation", { name: "Trade Requests workspace" });
    await expect(sub.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
    await expect(sub.getByRole("link", { name: "New Request" })).toHaveAttribute("href", "/trade-requests/new");
    await expect(sub.getByRole("link", { name: "Trading Queue" })).toHaveAttribute("href", "/trade-requests/queue");
    await expect(page.locator("iframe, frame, object, embed")).toHaveCount(0);
    await shoot(page, `desktop-${role}`);
  });

  test(`${role} mobile menu offers the Trade Requests entry`, async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await signInAs(page, role);
    await page.getByRole("button", { name: "Menu" }).click();
    const entry = page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Trade Requests" });
    await expect(entry).toBeVisible();
    await expect(entry).toHaveAttribute("href", "/trade-requests");
    await entry.click();
    await expect(page.getByRole("heading", { level: 1, name: /^Welcome back, / })).toBeVisible();
    const sub = page.getByRole("navigation", { name: "Trade Requests workspace" });
    await expect(sub).toHaveCSS("overflow-x", "auto");
    await expect(sub.getByRole("link")).toHaveCount(3);
    await shoot(page, `mobile-${role}`);
  });
}

for (const role of ["CLIENT_SERVICE", "VIEWER"] as Persona[]) {
  test(`${role} desktop has no entry and sees the permission screen`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await signInAs(page, role);
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await expect(nav.getByRole("link", { name: "Deals" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Trade Requests" })).toHaveCount(0);
    await page.goto("/trade-requests");
    await expect(page.getByText(NO_PERMISSION, { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Go Home" })).toHaveAttribute("href", "/command-center");
    await expect(page.getByRole("navigation", { name: "Trade Requests workspace" })).toHaveCount(0);
    await shoot(page, `desktop-${role}`);
  });

  test(`${role} mobile menu has no Trade Requests entry`, async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await signInAs(page, role);
    await page.getByRole("button", { name: "Menu" }).click();
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await expect(nav.getByRole("link", { name: "Deals" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Trade Requests" })).toHaveCount(0);
    await shoot(page, `mobile-${role}`);
  });
}
