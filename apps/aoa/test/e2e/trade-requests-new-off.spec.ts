import { expect, test } from "@playwright/test";
import { signInAs, type Persona } from "./trade-requests-browser-helpers";

for (const role of ["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE", "VIEWER"] as Persona[]) {
  test(`${role} gets not found on the New Request address with the flag off`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 950 });
    await signInAs(page, role);
    await page.goto("/trade-requests/new");
    await expect(page.getByText("This page could not be found.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "New Trade Request" })).toHaveCount(0);
    await expect(page.getByText("Connecting to Warehouse API...")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath(`flag-off-${role}.png`), fullPage: true });
  });
}
