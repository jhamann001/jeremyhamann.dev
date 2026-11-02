import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { signInAs, type Persona } from "./trade-requests-browser-helpers";
import { STATUS_SEED_FILE } from "./trade-requests-status-fixture";
import type { StatusSeed } from "./trade-requests-status-seed";

for (const role of ["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE", "VIEWER"] as Persona[]) {
  test(`${role} flag off: the queue and a request link are not found and show no status actions`, async ({ page }) => {
    const { approveId } = JSON.parse(readFileSync(STATUS_SEED_FILE, "utf8")) as StatusSeed;
    await page.setViewportSize({ width: 1440, height: 950 });
    await signInAs(page, role);
    for (const path of [`/trade-requests/${approveId}`, `/trade-requests/queue/${approveId}`, "/trade-requests/queue"]) {
      await page.goto(path);
      await expect(page.getByText("This page could not be found.")).toBeVisible();
      await expect(page.getByTestId("trade-request-status-actions")).toHaveCount(0);
      await expect(page.getByRole("navigation", { name: "Trade Requests workspace" })).toHaveCount(0);
    }
    await page.screenshot({ path: test.info().outputPath(`flag-off-${role}.png`), fullPage: true });
  });
}
