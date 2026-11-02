import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { BROWSER_RUN_ID, browserDecisionId, browserTransferId, validateAcatReviewBrowserDatabase } from "./acat-link-review-fixture";

const PATH = `/acat-link-review?run=${BROWSER_RUN_ID}`;
const owner = new PrismaClient({ datasourceUrl: validateAcatReviewBrowserDatabase().href });
async function signIn(page: Page, persona = "Riley Ops · OPERATIONS (sees all)") {
  await page.goto(`/?callbackUrl=${encodeURIComponent(PATH)}`);
  await expect(page.getByRole("heading", { name: "Dev sign-in" })).toBeVisible();
  await page.getByRole("button", { name: persona, exact: true }).click();
  await expect(page).toHaveURL(/\/acat-link-review/);
}
const card = (page: Page, suffix: string) => page.getByRole("heading", { name: `Synthetic Browser ${suffix}`, exact: true }).locator("../..");
test.afterAll(async () => owner.$disconnect());

test("Ops rejection persists through hold/resume and a fresh page load", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Review ACAT links", exact: true })).toBeVisible();
  const item = card(page, "Reject");
  await item.getByLabel("Review note").fill("Synthetic browser: this pair is incorrect.");
  await item.getByRole("button", { name: "Reject pair", exact: true }).click();
  await expect(item.getByText("Review: reject", { exact: true })).toBeVisible();
  await item.getByRole("button", { name: "Hold automatic linking", exact: true }).click();
  await expect(item.getByRole("button", { name: "Resume automatic linking", exact: true })).toBeVisible();
  await expect(item.getByText("Review: reject", { exact: true })).toBeVisible();
  await item.getByRole("button", { name: "Resume automatic linking", exact: true }).click();
  await expect(item.getByRole("button", { name: "Hold automatic linking", exact: true })).toBeVisible();
  await page.reload();
  await expect(item.getByText("Review: reject", { exact: true })).toBeVisible();
  expect(await owner.acatLinkDecision.findUniqueOrThrow({ where: { id: browserDecisionId("reject") } })).toMatchObject({ disposition: "REJECT", review_version: 3, outcome: "PENDING" });
  expect(await owner.acatLinkReviewEvent.findMany({ where: { decision_id: browserDecisionId("reject") }, orderBy: { revision: "asc" }, select: { action: true } }))
    .toEqual([{ action: "REJECT" }, { action: "HOLD" }, { action: "RESUME" }]);
  expect(await owner.transfer.findUniqueOrThrow({ where: { id: browserTransferId("reject") } })).toMatchObject({ acat_auto_link_hold: false, acat_record_id: null });
  await item.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("acat-review-persisted-rejection.png"), fullPage: true });
});

test("a source outage blocks confirmed apply and fresh preparation without false success", async ({ page }) => {
  await signIn(page);
  const item = card(page, "Blocked");
  await item.getByRole("button", { name: "Confirm this pair", exact: true }).click();
  await expect(item.getByText("Review: accept", { exact: true })).toBeVisible();
  await item.getByRole("button", { name: "Apply confirmed link", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("The link could not be applied. Refresh the evidence and review the records.");
  expect(await owner.transfer.findUniqueOrThrow({ where: { id: browserTransferId("blocked") } })).toMatchObject({ acat_record_id: null, acat_transfer_id: null, stage: "DECISION" });
  expect(await owner.acatLinkDecision.findUniqueOrThrow({ where: { id: browserDecisionId("blocked") } })).toMatchObject({ disposition: "ACCEPT", outcome: "PENDING" });
  expect(await owner.auditLog.count({ where: { entityId: browserTransferId("blocked"), action: "acat_link.apply" } })).toBe(0);
  await page.screenshot({ path: test.info().outputPath("acat-review-source-unavailable.png"), fullPage: true });
  await page.getByRole("button", { name: "Prepare fresh review", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("The complete source evidence could not be loaded. Existing links were preserved.");
});

test("VIEWER cannot view saved review evidence or mutation controls", async ({ page }) => {
  const before = await owner.acatLinkReviewEvent.count({ where: { decision_id: { in: [browserDecisionId("reject"), browserDecisionId("blocked")] } } });
  await signIn(page, "Val Viewer · VIEWER (sees none)");
  await expect(page.getByRole("heading", { name: "Review ACAT links", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reject pair", exact: true })).toHaveCount(0);
  await expect(page.getByText(/404|could not be found/).first()).toBeVisible();
  expect(await owner.acatLinkReviewEvent.count({ where: { decision_id: { in: [browserDecisionId("reject"), browserDecisionId("blocked")] } } })).toBe(before);
  await page.screenshot({ path: test.info().outputPath("acat-review-viewer-denied.png"), fullPage: true });
});
