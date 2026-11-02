import { expect, test } from "@playwright/test";
import { signInAs, type Persona } from "./trade-requests-browser-helpers";

for (const role of ["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE", "VIEWER"] as Persona[]) {
  test(`${role} flag off: no queue, no export menu, export read not found`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 950 });
    await signInAs(page, role);
    await page.goto("/trade-requests/queue");
    await expect(page.getByText("This page could not be found.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Export Compliance Log" })).toHaveCount(0);
    expect((await page.request.get("/api/trade-requests/export")).status()).toBe(404);
    await page.screenshot({ path: test.info().outputPath(`flag-off-export-${role}.png`), fullPage: true });
  });
}
