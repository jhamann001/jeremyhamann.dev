import { expect, test } from "@playwright/test";
import { NO_PERMISSION, TRADE_REQUESTS_EXTERNAL, signInAs, type Persona } from "./trade-requests-browser-helpers";

for (const role of ["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE", "VIEWER"] as Persona[]) {
  test(`${role} keeps today's external link and /trade-requests is not found`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 950 });
    await signInAs(page, role);
    const entry = page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: /Trade Requests/ });
    await expect(entry).toHaveAttribute("href", TRADE_REQUESTS_EXTERNAL);
    await expect(entry).toHaveAttribute("target", "_blank");
    await expect(entry).toContainText("↗");
    const response = await page.goto("/trade-requests");
    test.info().annotations.push({ type: "status", description: String(response?.status()) });
    await expect(page.getByText("This page could not be found.")).toBeVisible();
    await expect(page.getByText(NO_PERMISSION)).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Trade Requests workspace" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Home" })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath(`flag-off-${role}.png`), fullPage: true });
  });
}
