import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { bell } from "./trade-requests-bell-cases";
import { NO_PERMISSION, signInAs, type Persona } from "./trade-requests-browser-helpers";
import { STATUS_SEED_FILE } from "./trade-requests-status-fixture";
import { changeStatusElsewhere, readRequest, type StatusSeed } from "./trade-requests-status-seed";

const DESKTOP = { width: 1440, height: 950 };
const MOBILE = { width: 390, height: 844 };
const seed = (): StatusSeed => JSON.parse(readFileSync(STATUS_SEED_FILE, "utf8"));
const detailPath = (id: string) => `/trade-requests/${encodeURIComponent(id)}`;
const queuePath = "/trade-requests/queue";
const ACTIONS = [
  ["Needs Info", "Return to advisor for more details"],
  ["Pending Liquidation", "Mark as pending existing asset liquidation"],
  ["Reject", "Permanently reject — record will be locked"],
  ["Approve & Execute", "Approve and send to execution"],
];
const LOCKED = "This request is closed; the checklist is locked.";
const STALE = "Request was modified by another user. Please refresh and try again.";

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}

/** The checklist read every opened request makes (a server action POST from the page). */
function actionPost(page: Page, path: string) {
  return page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === path && Boolean(response.request().headers()["next-action"]));
}

async function openDirect(page: Page, role: Persona, id: string) {
  const read = actionPost(page, detailPath(id));
  await signInAs(page, role, detailPath(id));
  await read;
  return page.getByTestId("trade-request-detail");
}

async function reopenDirect(page: Page, id: string) {
  const read = actionPost(page, detailPath(id));
  await page.goto(detailPath(id));
  await read;
  return page.getByTestId("trade-request-detail");
}

async function expectActions(detail: Locator) {
  const buttons = detail.getByTestId("trade-request-status-actions").getByRole("button");
  await expect(buttons).toHaveText(ACTIONS.map(([label]) => label));
  for (const [label, title] of ACTIONS) await expect(detail.getByRole("button", { name: label, exact: true })).toHaveAttribute("title", title);
}

async function expectAuditEntry(detail: Locator, action: string, person: string, note: string) {
  await detail.getByRole("tab", { name: "Audit Trail" }).click();
  const newest = detail.getByRole("tabpanel").getByRole("listitem").first();
  await expect(newest).toContainText(action);
  await expect(newest).toContainText(person);
  await expect(newest).toContainText(note);
}

async function sessionMessages(page: Page) {
  const { summary, menu, panel } = bell(page);
  if ((await menu.getAttribute("open")) === null) await summary.click();
  await expect(menu).toHaveAttribute("open", "");
  return panel.locator('section[aria-label="Trade Requests"]');
}

test("ADMIN from the queue: approves with the unchecked-items warning and a note; the decided request has no actions (AC-43, AC-105, AC-88, AC-89, AC-11, AC-13)", async ({ page }) => {
  const { approveId } = seed();
  await page.setViewportSize(DESKTOP);
  await signInAs(page, "ADMIN", queuePath);
  const read = actionPost(page, `${queuePath}/${approveId}`);
  await page.getByRole("row", { name: `View request ${approveId}` }).click();
  await expect(page).toHaveURL(new RegExp(`${queuePath}/${approveId}$`));
  await read;
  const detail = page.getByTestId("trade-request-detail");
  await expect(detail.getByRole("tab", { name: /Pre-approval Checklist/ })).toHaveText("Pre-approval Checklist (5)");
  await expectActions(detail);
  await shoot(page, "desktop-ADMIN-queue-actions");

  await detail.getByRole("button", { name: "Approve & Execute" }).click();
  await expect(detail.getByTestId("trade-request-approve-warning")).toHaveText(
    "5 checklist items are still unchecked. You can approve anyway — confirm below — or finish the pre-approval checklist first.",
  );
  const note = detail.getByLabel("Add Note for Audit/Advisor:");
  await expect(note).toBeFocused();
  await expect(note).toHaveAttribute("placeholder", "e.g., Client needs to sign form first...");
  await expect(detail.getByTestId("trade-request-status-actions")).toHaveCount(0);
  await note.fill("Synthetic approval note");
  await expect(detail.getByRole("button", { name: "Confirm" })).toBeEnabled();
  await shoot(page, "desktop-ADMIN-approve-warning");

  await detail.getByRole("button", { name: "Confirm" }).click();
  await expect(detail).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${queuePath}$`));
  await expect(page.getByRole("row", { name: `View request ${approveId}` })).toContainText("Approved");
  expect((await readRequest(approveId)).status).toBe("Approved");
  await shoot(page, "desktop-ADMIN-queue-after-approve");

  const reopened = await reopenDirect(page, approveId);
  await expect(reopened.getByTestId("trade-request-status-actions")).toHaveCount(0);
  await expect(reopened.locator("footer").getByRole("button")).toHaveText(["Close"]);
  await reopened.getByRole("tab", { name: /Pre-approval Checklist/ }).click();
  await expect(reopened.getByText(LOCKED)).toBeVisible();
  await expectAuditEntry(reopened, "Status changed to Approved", "Dana Admin", "Synthetic approval note");
  await shoot(page, "desktop-ADMIN-approved-audit");
});

test("OPERATIONS from a direct link: Needs Info without a note records \"No additional notes.\" and keeps the actions (AC-43, AC-106, AC-11)", async ({ page }) => {
  const { needsInfoId } = seed();
  await page.setViewportSize(DESKTOP);
  const detail = await openDirect(page, "OPERATIONS", needsInfoId);
  await expectActions(detail);
  await detail.getByRole("button", { name: "Needs Info" }).click();
  await expect(detail.getByTestId("trade-request-approve-warning")).toHaveCount(0);
  await detail.getByRole("button", { name: "Confirm" }).click();
  await expect(page).toHaveURL(new RegExp(`${queuePath}$`));
  await expect(page.getByRole("row", { name: `View request ${needsInfoId}` })).toContainText("Needs Info");

  const reopened = await reopenDirect(page, needsInfoId);
  await expectActions(reopened);
  await expectAuditEntry(reopened, "Status changed to Needs Info", "Riley Ops", "No additional notes.");
  await shoot(page, "desktop-OPERATIONS-needs-info-audit");
});

test("ADMIN: a stale change shows the service's message in the action panel and the session message in the bell (AC-101, AC-102)", async ({ page }) => {
  const { staleId } = seed();
  await page.setViewportSize(DESKTOP);
  const detail = await openDirect(page, "ADMIN", staleId);
  await changeStatusElsewhere(staleId, "Pending Current Asset Liquidation");
  await detail.getByRole("button", { name: "Reject" }).click();
  await detail.getByRole("button", { name: "Confirm" }).click();
  await expect(detail.locator("footer").getByRole("alert")).toHaveText(STALE);
  await expect(detail.getByTestId("trade-request-status-form")).toBeVisible();
  expect((await readRequest(staleId)).status).toBe("Pending Current Asset Liquidation");
  await shoot(page, "desktop-ADMIN-stale-failure");

  await detail.getByRole("button", { name: "Cancel" }).click();
  await expect(detail.locator("footer").getByRole("alert")).toHaveCount(0);
  await detail.getByRole("button", { name: "Close" }).first().click();
  const group = await sessionMessages(page);
  await expect(group.getByText(`Status update failed: ${STALE}`, { exact: true })).toBeVisible();
  await shoot(page, "desktop-ADMIN-stale-session-message");
});

test("OPERATIONS: a change that cannot reach the server shows \"Action failed. Please try again.\" and the session message (AC-101, AC-102)", async ({ page }) => {
  const { failId } = seed();
  await page.setViewportSize(DESKTOP);
  const detail = await openDirect(page, "OPERATIONS", failId);
  await page.route(`**${detailPath(failId)}`, (route) =>
    (route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort() : route.continue()));
  await detail.getByRole("button", { name: "Pending Liquidation" }).click();
  await detail.getByRole("button", { name: "Confirm" }).click();
  await expect(detail.locator("footer").getByRole("alert")).toHaveText("Action failed. Please try again.");
  await expect(detail.getByRole("button", { name: "Confirm" })).toBeEnabled();
  expect((await readRequest(failId)).status).toBe("Pending Review");
  await page.unroute(`**${detailPath(failId)}`);
  await detail.getByRole("button", { name: "Cancel" }).click();
  await detail.getByRole("button", { name: "Close" }).first().click();
  const group = await sessionMessages(page);
  await expect(group.getByText("Status update failed: Action failed. Please try again.", { exact: true })).toBeVisible();
  await shoot(page, "desktop-OPERATIONS-failure-session-message");
});

test("ADMIN on an approved request, from the queue and from its link, sees no status action (AC-13)", async ({ page }) => {
  const { approvedId } = seed();
  await page.setViewportSize(DESKTOP);
  const detail = await openDirect(page, "ADMIN", approvedId);
  await expect(detail.getByTestId("trade-request-status-actions")).toHaveCount(0);
  await expect(detail.locator("footer").getByRole("button")).toHaveText(["Close"]);
  await detail.getByRole("button", { name: "Close" }).first().click();
  await expect(page).toHaveURL(new RegExp(`${queuePath}$`));
  await page.getByRole("row", { name: `View request ${approvedId}` }).click();
  await expect(page.getByTestId("trade-request-detail").getByTestId("trade-request-status-actions")).toHaveCount(0);
  await shoot(page, "desktop-ADMIN-approved-no-actions");
});

for (const viewport of [["desktop", DESKTOP], ["mobile", MOBILE]] as const) {
  test(`ADVISOR ${viewport[0]}: no status actions on an undecided request`, async ({ page }) => {
    const { advisorId } = seed();
    await page.setViewportSize(viewport[1]);
    const detail = await openDirect(page, "ADVISOR", advisorId);
    await expect(detail.getByRole("tab", { name: "Request Details" })).toBeVisible();
    await expect(detail.getByTestId("trade-request-status-actions")).toHaveCount(0);
    for (const [label] of ACTIONS) await expect(detail.getByRole("button", { name: label, exact: true })).toHaveCount(0);
    await shoot(page, `${viewport[0]}-ADVISOR-no-actions`);
  });
}

for (const role of ["ADMIN", "OPERATIONS"] as const) {
  test(`${role} mobile: the actions and the note form with the warning fit the dialog`, async ({ page }) => {
    const { mobileId } = seed();
    await page.setViewportSize(MOBILE);
    const detail = await openDirect(page, role, mobileId);
    await expectActions(detail);
    const box = await detail.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(MOBILE.width - 30);
    const footer = detail.locator("footer");
    const overflow = await footer.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    for (const [label] of ACTIONS) {
      const button = (await detail.getByRole("button", { name: label, exact: true }).boundingBox())!;
      expect(button.x).toBeGreaterThanOrEqual(box!.x);
      expect(button.x + button.width).toBeLessThanOrEqual(box!.x + box!.width);
    }
    await shoot(page, `mobile-${role}-actions`);
    await detail.getByRole("button", { name: "Approve & Execute" }).click();
    await expect(detail.getByTestId("trade-request-approve-warning")).toContainText("5 checklist items are still unchecked.");
    const form = (await detail.getByTestId("trade-request-status-form").boundingBox())!;
    expect(form.x).toBeGreaterThanOrEqual(box!.x);
    expect(form.x + form.width).toBeLessThanOrEqual(box!.x + box!.width);
    expect(await footer.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
    await shoot(page, `mobile-${role}-approve-form`);
    await detail.getByRole("button", { name: "pre-approval checklist" }).click();
    await expect(detail.getByRole("tab", { name: /Pre-approval Checklist/ })).toHaveAttribute("aria-selected", "true");
    await expect(detail.getByTestId("trade-request-status-actions")).toBeVisible();
    expect((await readRequest(mobileId)).status).toBe("Pending Review");
  });
}

for (const role of ["CLIENT_SERVICE", "VIEWER"] as Persona[]) {
  test(`${role} following a request link sees the permission screen and no status actions`, async ({ page }) => {
    const { advisorId } = seed();
    await page.setViewportSize(DESKTOP);
    await signInAs(page, role);
    await page.goto(detailPath(advisorId));
    await expect(page.getByText(NO_PERMISSION, { exact: true })).toBeVisible();
    await expect(page.getByTestId("trade-request-status-actions")).toHaveCount(0);
    await shoot(page, `desktop-${role}-refused`);
  });
}
