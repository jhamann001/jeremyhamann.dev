import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { pdfPageTexts } from "../helpers/pdf-text";
import { NO_PERMISSION, signInAs, type Persona } from "./trade-requests-browser-helpers";
import { DETAIL_SEED_FILE } from "./trade-requests-detail-fixture";
import type { DetailSeed } from "./trade-requests-detail-seed";

const DESKTOP = { width: 1440, height: 950 };
const MOBILE = { width: 390, height: 844 };
const seed = (): DetailSeed => JSON.parse(readFileSync(DETAIL_SEED_FILE, "utf8"));
const detailPath = (id: string) => `/trade-requests/${encodeURIComponent(id)}`;

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}

function dialog(page: Page) {
  return page.getByTestId("trade-request-detail");
}

for (const role of ["ADMIN", "OPERATIONS", "ADVISOR"] as Persona[]) {
  test(`${role} desktop: direct link shows Request Details, Audit Trail and the checklist tab (AC-9, AC-42)`, async ({ page }) => {
    const { householdId } = seed();
    await page.setViewportSize(DESKTOP);
    await signInAs(page, role, detailPath(householdId));
    const detail = dialog(page);
    await expect(detail.getByRole("heading", { level: 2 })).toHaveText(`The Richardson Family (${householdId})`);
    await expect(detail.getByRole("tab")).toHaveText(["Request Details", "Audit Trail", /^Pre-approval Checklist( \(\d\))?$/]);
    const details = detail.getByRole("tabpanel");
    await expect(details.getByText("Needs Info", { exact: true })).toBeVisible();
    await expect(details.getByText("Clients (Household)")).toBeVisible();
    await expect(details.getByText("The Richardson Family & David Park")).toBeVisible();
    await expect(details.getByText("NEAX-1399", { exact: true })).toBeVisible();
    await expect(details.getByText("Level 14 / 25")).toBeVisible();
    await expect(details.getByText("New York (NY) - Muni Preference")).toBeVisible();
    await expect(details.getByText("Other: Synthetic screen")).toBeVisible();
    await expect(detail.getByRole("alert")).toHaveCount(0);
    await shoot(page, `desktop-${role}-details`);

    await detail.getByRole("tab", { name: "Audit Trail" }).click();
    const items = detail.getByRole("tabpanel").getByRole("listitem");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText("Status changed to Needs Info");
    await expect(items.nth(0)).toContainText("Riley Ops");
    await expect(items.nth(0)).toContainText("AOA");
    await expect(items.nth(1)).toContainText("Created Request");
    await shoot(page, `desktop-${role}-audit`);

    await detail.getByRole("button", { name: "Close" }).last().click();
    await expect(page).toHaveURL(/\/trade-requests\/queue$/);
  });

  test(`${role} mobile: the detail keeps its layout inside the viewport (AC-153)`, async ({ page }) => {
    const { householdId } = seed();
    await page.setViewportSize(MOBILE);
    await signInAs(page, role, detailPath(householdId));
    const detail = dialog(page);
    await expect(detail.getByRole("heading", { level: 2 })).toBeVisible();
    const box = await detail.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(15);
    expect(box!.width).toBeLessThanOrEqual(MOBILE.width - 30);
    expect(box!.height).toBeLessThanOrEqual(MOBILE.height * 0.9 + 1);
    await expect(detail.getByRole("button", { name: "Download PDF" })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Close" }).last()).toBeInViewport();
    await shoot(page, `mobile-${role}-details`);
    await detail.getByRole("tab", { name: "Audit Trail" }).click();
    await expect(detail.getByRole("tabpanel").getByRole("listitem").first()).toBeVisible();
    await shoot(page, `mobile-${role}-audit`);
  });
}

test("OPERATIONS downloads the request PDF with standing account-level exclusions (AC-58, D-01)", async ({ page }) => {
  const { householdId } = seed();
  await page.setViewportSize(DESKTOP);
  await signInAs(page, "OPERATIONS", detailPath(householdId));
  const detail = dialog(page);
  const [download] = await Promise.all([page.waitForEvent("download"), detail.getByRole("button", { name: "Download PDF" }).click()]);
  expect(download.suggestedFilename()).toMatch(new RegExp(`^Trade_Request_The_Richardson_Family_&_David_Park_${householdId}_\\d{4}-\\d{2}-\\d{2}\\.pdf$`));
  const file = test.info().outputPath(download.suggestedFilename());
  await download.saveAs(file);
  const pages = await pdfPageTexts(readFileSync(file));
  const text = pages.flat();
  expect(text.slice(0, 3)).toEqual([
    `${householdId}  —  The Richardson Family & David Park`,
    "NEEDS INFO",
    "Exported by Riley Ops (ops@example.com)",
  ]);
  expect(text).toContain("NEAX-1399: SYNA (DNB - Synthetic concentrated position)");
  expect(text).toContain("ACCT-3002: SYNB (DNB+DNS)");
  expect(text).toContain("Status changed to Needs Info");
  expect(pages[0].some((line) => line.startsWith("Exported: "))).toBe(true);
  expect(pages[0]).toContain(`Page 1 of ${pages.length}`);
  await expect(detail.getByRole("alert")).toHaveCount(0);
});

test("ADVISOR sees the PDF failure line when the export cannot finish (AC-100)", async ({ page }) => {
  const { householdId } = seed();
  await page.setViewportSize(DESKTOP);
  await signInAs(page, "ADVISOR", detailPath(householdId));
  await page.route(`**${detailPath(householdId)}`, (route) =>
    (route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort() : route.continue()));
  const detail = dialog(page);
  await detail.getByRole("button", { name: "Download PDF" }).click();
  const failure = detail.getByRole("alert");
  await expect(failure).toBeVisible();
  await expect(failure).not.toHaveText("");
  await shoot(page, "desktop-ADVISOR-pdf-failure");
});

test("a rejected request shows the locked banner on every view (AC-115)", async ({ page }) => {
  const { rejectedId } = seed();
  await page.setViewportSize(DESKTOP);
  await signInAs(page, "ADMIN", detailPath(rejectedId));
  const detail = dialog(page);
  for (const name of ["Request Details", "Audit Trail", "Pre-approval Checklist"]) {
    await detail.getByRole("tab", { name }).click();
    await expect(detail.getByRole("alert")).toHaveText("Request Rejected and LockedFor SEC compliance, this record is permanently locked. The advisor must submit a new request.");
  }
  await detail.getByRole("tab", { name: "Request Details" }).click();
  await expect(detail.getByText("Positions to Liquidate")).toBeVisible();
  await shoot(page, "desktop-ADMIN-rejected");
  await page.setViewportSize(MOBILE);
  await shoot(page, "mobile-ADMIN-rejected");
});

test("a link to a request that does not exist shows not found with Back to Queue (AC-10)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await signInAs(page, "OPERATIONS", "/trade-requests/REQ-SYNTHETIC-MISSING");
  const card = page.getByTestId("trade-request-not-found");
  await expect(card.getByText("Request not found. It may have been removed or you may not have access.")).toBeVisible();
  await expect(card.getByRole("link", { name: "Back to Queue" })).toHaveAttribute("href", "/trade-requests/queue");
  await expect(card.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(dialog(page)).toHaveCount(0);
  await shoot(page, "desktop-OPERATIONS-not-found");
});

test("a link that fails for another reason shows the failure with Retry and Back to Queue (AC-83)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await signInAs(page, "ADVISOR", `/trade-requests/${"X".repeat(60)}`);
  const card = page.getByTestId("trade-request-load-failed");
  await expect(card.getByRole("alert")).toHaveText("Validation failed: ID is too long");
  await expect(card.getByRole("link", { name: "Back to Queue" })).toHaveAttribute("href", "/trade-requests/queue");
  await card.getByRole("button", { name: "Retry" }).click();
  await expect(card.getByRole("alert")).toHaveText("Validation failed: ID is too long");
  await shoot(page, "desktop-ADVISOR-load-failed");
  await page.setViewportSize(MOBILE);
  await shoot(page, "mobile-ADVISOR-load-failed");
});

for (const role of ["CLIENT_SERVICE", "VIEWER"] as Persona[]) {
  test(`${role} following a request link sees the permission screen`, async ({ page }) => {
    const { householdId } = seed();
    await page.setViewportSize(DESKTOP);
    await signInAs(page, role);
    await page.goto(detailPath(householdId));
    await expect(page.getByText(NO_PERMISSION, { exact: true })).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    await shoot(page, `desktop-${role}-refused`);
  });
}
