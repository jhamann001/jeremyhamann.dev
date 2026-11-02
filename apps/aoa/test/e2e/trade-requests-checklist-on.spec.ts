import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { NO_PERMISSION, signInAs, type Persona } from "./trade-requests-browser-helpers";
import { CHECKLIST_SEED_FILE } from "./trade-requests-checklist-fixture";
import type { ChecklistSeed } from "./trade-requests-checklist-seed";

const DESKTOP = { width: 1440, height: 950 };
const MOBILE = { width: 390, height: 844 };
const NAMES: Record<"ADMIN" | "OPERATIONS", string> = { ADMIN: "Dana Admin", OPERATIONS: "Riley Ops" };
const seed = (): ChecklistSeed => JSON.parse(readFileSync(CHECKLIST_SEED_FILE, "utf8"));
const detailPath = (id: string) => `/trade-requests/${encodeURIComponent(id)}`;
const READ_ONLY = "Read-only — only traders can update the checklist.";
const LOCKED = "This request is closed; the checklist is locked.";

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}

/** A server action posted from the request's page (the checklist read or a save). */
function actionPost(page: Page, id: string) {
  return page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === detailPath(id) && Boolean(response.request().headers()["next-action"]));
}

async function openChecklist(page: Page, role: Persona, id: string) {
  const read = actionPost(page, id);
  await signInAs(page, role, detailPath(id));
  await read;
  const detail = page.getByTestId("trade-request-detail");
  await detail.getByRole("tab", { name: /Pre-approval Checklist/ }).click();
  return { detail, checklist: detail.getByTestId("trade-request-checklist") };
}

const today = () => new Date().toLocaleDateString("en-US");

for (const role of ["ADMIN", "OPERATIONS"] as const) {
  test(`${role} desktop: marks items, saves text on losing focus and sees it after reopening (AC-15, AC-127, AC-130, AC-140, AC-151)`, async ({ page }) => {
    const id = seed().editable[role];
    await page.setViewportSize(DESKTOP);
    const { detail, checklist } = await openChecklist(page, role, id);
    await expect(detail.getByRole("tab", { name: /Pre-approval Checklist/ })).toHaveText("Pre-approval Checklist (7)");
    await expect(checklist).toContainText("Pre-approval checklist — confirm before you approve & execute.");
    await expect(checklist.getByText("0 of 7 complete")).toBeVisible();
    await expect(checklist.getByText(READ_ONLY)).toHaveCount(0);
    await expect(checklist.getByText(LOCKED)).toHaveCount(0);

    let saved = actionPost(page, id);
    await checklist.getByRole("button", { name: "Exclusions & restrictions applied (DNB / DNS)" }).click();
    await expect(checklist.getByRole("button", { name: "Exclusions & restrictions applied (DNB / DNS)" })).toHaveAttribute("aria-pressed", "true");
    await expect(checklist.getByText("1 of 7 complete")).toBeVisible();
    await expect(checklist.getByRole("progressbar")).toHaveAttribute("value", "1");
    await expect(detail.getByRole("tab", { name: /Pre-approval Checklist/ })).toHaveText("Pre-approval Checklist (6)");
    await saved;

    await expect(checklist.getByLabel("Transition model")).toHaveCount(0);
    saved = actionPost(page, id);
    await checklist.getByRole("button", { name: "Transition used" }).click();
    await saved;
    const field = checklist.getByLabel("Transition model");
    await expect(field).toHaveAttribute("placeholder", "e.g., National Tax Efficient – Risk 20");
    await field.fill(`Synthetic Transition ${role}`);
    saved = actionPost(page, id);
    await field.blur();
    await saved;

    saved = actionPost(page, id);
    await checklist.getByRole("button", { name: "Transition used" }).click();
    await expect(checklist.getByRole("button", { name: "Transition used" })).toHaveAttribute("aria-pressed", "false");
    await saved;
    await expect(detail.getByRole("alert")).toHaveCount(0);
    await shoot(page, `desktop-${role}-checklist-edited`);

    const reread = actionPost(page, id);
    await page.reload();
    await reread;
    await detail.getByRole("tab", { name: /Pre-approval Checklist/ }).click();
    await expect(checklist.getByRole("button", { name: "Exclusions & restrictions applied (DNB / DNS)" })).toHaveAttribute("aria-pressed", "true");
    await expect(checklist.getByRole("button", { name: "Transition used" })).toHaveAttribute("aria-pressed", "false");
    // Unchecked but with text: the field stays, and the stamp names the last change.
    await expect(checklist.getByLabel("Transition model")).toHaveValue(`Synthetic Transition ${role}`);
    await expect(checklist.getByText(`Checked by ${NAMES[role]} · ${today()}`)).toHaveCount(2);
    await expect(checklist.getByText("1 of 7 complete")).toBeVisible();
    await shoot(page, `desktop-${role}-checklist-reopened`);

    await page.setViewportSize(MOBILE);
    const box = await detail.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(MOBILE.width - 30);
    const overflow = await checklist.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(checklist.getByLabel("Transition model")).toBeVisible();
    await shoot(page, `mobile-${role}-checklist`);
  });
}

for (const viewport of [["desktop", DESKTOP], ["mobile", MOBILE]] as const) {
  test(`ADVISOR ${viewport[0]}: the checklist is read-only with the reviewer's stamps (AC-86, AC-130, AC-140)`, async ({ page }) => {
    const { stampedId } = seed();
    await page.setViewportSize(viewport[1]);
    const { detail, checklist } = await openChecklist(page, "ADVISOR", stampedId);
    await expect(detail.getByRole("tab", { name: /Pre-approval Checklist/ })).toHaveText("Pre-approval Checklist (5)");
    await expect(checklist.getByText("2 of 7 complete")).toBeVisible();
    await expect(checklist.getByText(READ_ONLY)).toBeVisible();
    await expect(checklist.getByText(`Checked by Riley Ops · ${today()}`)).toHaveCount(3);
    for (const button of await checklist.getByRole("button").all()) await expect(button).toBeDisabled();
    await expect(checklist.getByLabel("Template name(s)")).toBeDisabled();
    await expect(checklist.getByLabel("Template name(s)")).toHaveValue("Synthetic Template A");
    await shoot(page, `${viewport[0]}-ADVISOR-checklist-read-only`);
  });
}

test("ADMIN on an approved request sees the locked checklist (AC-48, AC-87)", async ({ page }) => {
  const { approvedId } = seed();
  await page.setViewportSize(DESKTOP);
  const { checklist } = await openChecklist(page, "ADMIN", approvedId);
  await expect(checklist.getByText(LOCKED)).toBeVisible();
  await expect(checklist.getByText(READ_ONLY)).toHaveCount(0);
  await expect(checklist.getByText("2 of 7 complete")).toBeVisible();
  for (const button of await checklist.getByRole("button").all()) await expect(button).toBeDisabled();
  await expect(checklist.getByLabel("Template name(s)")).toBeDisabled();
  await shoot(page, "desktop-ADMIN-checklist-locked");
  await page.setViewportSize(MOBILE);
  await shoot(page, "mobile-ADMIN-checklist-locked");
});

test("OPERATIONS: a checklist that cannot be loaded shows every item unchecked, the other views unaffected (AC-84, AC-150)", async ({ page }) => {
  const { stampedId } = seed();
  await page.setViewportSize(DESKTOP);
  await page.route(`**${detailPath(stampedId)}`, (route) =>
    (route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort() : route.continue()));
  await signInAs(page, "OPERATIONS", detailPath(stampedId));
  const detail = page.getByTestId("trade-request-detail");
  await expect(detail.getByRole("tabpanel")).toContainText("Positions to Liquidate");
  await detail.getByRole("tab", { name: /Pre-approval Checklist/ }).click();
  const checklist = detail.getByTestId("trade-request-checklist");
  await expect(checklist.getByText("0 of 7 complete")).toBeVisible();
  await expect(checklist.getByText(/Checked by/)).toHaveCount(0);
  await expect(detail.getByRole("alert")).toHaveCount(0);
  // Stored text is unknown, so items with a text field stay read-only.
  await expect(checklist.getByRole("button", { name: "Meridian templates created for all accounts" })).toBeDisabled();
  await expect(checklist.getByRole("button", { name: "Asset location completed" })).toBeEnabled();
  await detail.getByRole("tab", { name: "Audit Trail" }).click();
  await expect(detail.getByRole("tabpanel").getByRole("listitem").first()).toContainText("Created Request");
  await detail.getByRole("tab", { name: "Request Details" }).click();
  await expect(detail.getByRole("tabpanel")).toContainText("Positions to Liquidate");
  await shoot(page, "desktop-OPERATIONS-checklist-load-failed");
});

test("OPERATIONS: a failed save keeps the change until the request is reopened (AC-85)", async ({ page }) => {
  const { saveFailId } = seed();
  await page.setViewportSize(DESKTOP);
  const { detail, checklist } = await openChecklist(page, "OPERATIONS", saveFailId);
  await page.route(`**${detailPath(saveFailId)}`, (route) =>
    (route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort() : route.continue()));
  await checklist.getByRole("button", { name: "Asset location completed" }).click();
  await page.waitForTimeout(1_000);
  await expect(checklist.getByRole("button", { name: "Asset location completed" })).toHaveAttribute("aria-pressed", "true");
  await expect(checklist.getByText("1 of 7 complete")).toBeVisible();
  await expect(detail.getByRole("alert")).toHaveCount(0);
  await shoot(page, "desktop-OPERATIONS-checklist-save-failed");
  await page.unroute(`**${detailPath(saveFailId)}`);
  const reread = actionPost(page, saveFailId);
  await page.reload();
  await reread;
  await detail.getByRole("tab", { name: /Pre-approval Checklist/ }).click();
  await expect(checklist.getByRole("button", { name: "Asset location completed" })).toHaveAttribute("aria-pressed", "false");
  await expect(checklist.getByText("0 of 7 complete")).toBeVisible();
});

for (const role of ["CLIENT_SERVICE", "VIEWER"] as Persona[]) {
  test(`${role} following a request link sees the permission screen and no checklist`, async ({ page }) => {
    const { stampedId } = seed();
    await page.setViewportSize(DESKTOP);
    await signInAs(page, role);
    await page.goto(detailPath(stampedId));
    await expect(page.getByText(NO_PERMISSION, { exact: true })).toBeVisible();
    await expect(page.getByTestId("trade-request-checklist")).toHaveCount(0);
    await shoot(page, `desktop-${role}-refused`);
  });
}
