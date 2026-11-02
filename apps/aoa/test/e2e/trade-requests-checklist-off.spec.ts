import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { signInAs, type Persona } from "./trade-requests-browser-helpers";
import { CHECKLIST_SEED_FILE } from "./trade-requests-checklist-fixture";
import type { ChecklistSeed } from "./trade-requests-checklist-seed";

for (const role of ["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE", "VIEWER"] as Persona[]) {
  test(`${role} flag off: a request link is not found and shows no checklist`, async ({ page }) => {
    const { stampedId } = JSON.parse(readFileSync(CHECKLIST_SEED_FILE, "utf8")) as ChecklistSeed;
    await page.setViewportSize({ width: 1440, height: 950 });
    await signInAs(page, role);
    await page.goto(`/trade-requests/${stampedId}`);
    await expect(page.getByText("This page could not be found.")).toBeVisible();
    await expect(page.getByTestId("trade-request-checklist")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Trade Requests workspace" })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath(`flag-off-${role}.png`), fullPage: true });
  });
}
