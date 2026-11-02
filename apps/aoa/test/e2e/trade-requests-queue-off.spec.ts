import { expect, test } from "@playwright/test";
import { TRADE_REQUESTS_EXTERNAL, signInAs, type Persona } from "./trade-requests-browser-helpers";

for (const role of ["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE", "VIEWER"] as Persona[]) {
  test(`${role} flag off: queue address and workspace reads are not found`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 950 });
    await signInAs(page, role);
    const entry = page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: /Trade Requests/ });
    await expect(entry).toHaveAttribute("href", TRADE_REQUESTS_EXTERNAL);
    for (const path of ["/trade-requests", "/trade-requests/queue"]) {
      await page.goto(path);
      await expect(page.getByText("This page could not be found.")).toBeVisible();
      await expect(page.getByRole("heading", { name: /Welcome back|Global Trading Queue/ })).toHaveCount(0);
    }
    expect((await page.request.get("/api/trade-requests/requests")).status()).toBe(404);
    expect((await page.request.get("/api/trade-requests/counts")).status()).toBe(404);
    await page.screenshot({ path: test.info().outputPath(`flag-off-queue-${role}.png`), fullPage: true });
  });
}
