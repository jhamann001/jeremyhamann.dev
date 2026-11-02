import { expect, test } from "@playwright/test";
import { signInAs, type Persona } from "./trade-requests-browser-helpers";
import { bellCases } from "./trade-requests-bell-cases";

bellCases("on");

for (const role of ["ADMIN", "OPERATIONS", "ADVISOR"] as Persona[]) {
  test(`${role} keeps the same bell inside the Trade Requests workspace`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 950 });
    await signInAs(page, role, "/trade-requests");
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    const summary = page.locator('summary[aria-label^="Notifications"]');
    await summary.click();
    await expect(page.getByText("Operations notifications", { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`workspace-${role}.png`), fullPage: true });
  });
}
