import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { signInAs, type Persona } from "./trade-requests-browser-helpers";
import { DETAIL_SEED_FILE } from "./trade-requests-detail-fixture";
import type { DetailSeed } from "./trade-requests-detail-seed";

for (const role of ["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE", "VIEWER"] as Persona[]) {
  test(`${role} flag off: a request link is not found`, async ({ page }) => {
    const { householdId } = JSON.parse(readFileSync(DETAIL_SEED_FILE, "utf8")) as DetailSeed;
    await page.setViewportSize({ width: 1440, height: 950 });
    await signInAs(page, role);
    await page.goto(`/trade-requests/${householdId}`);
    await expect(page.getByText("This page could not be found.")).toBeVisible();
    await expect(page.getByTestId("trade-request-detail")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Trade Requests workspace" })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath(`flag-off-${role}.png`), fullPage: true });
  });
}
