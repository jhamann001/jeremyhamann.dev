import { expect, test, type Locator, type Page } from "@playwright/test";
import { GROUP_TRANSFERS } from "./tasks-grouped-fixture";
import { signInOperations } from "./operations-browser-helpers";

const PAPERWORK = "Prepare partial-ACAT paperwork and arrange the client wet-signature package";
const SUBMIT = "Review the completed paperwork, then submit the partial ACAT";
const TRACK = "Track the partial ACAT through completion";
const group = (page: Page, id: string) => page.getByTestId(`transfer-group-${id}`);
const status = (card: Locator, title: string) => card.getByRole("combobox", { name: `Status for ${title}`, exact: true });

test.beforeEach(async ({ page }) => {
  await signInOperations(page, "/tasks");
  await expect(page.getByRole("button", { name: "By client and transfer", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("one client has three distinct account/deal checklists in workflow order", async ({ page }) => {
  const roth = group(page, GROUP_TRANSFERS.roth);
  const trad = group(page, GROUP_TRANSFERS.traditional);
  const roth2 = group(page, GROUP_TRANSFERS.secondRoth);
  for (const card of [roth, trad, roth2]) await expect(card).toBeVisible();
  await expect(page.getByText("Paulette Transfer Test", { exact: true })).toBeVisible();
  await expect(roth.getByRole("heading", { name: "Roth IRA", exact: true })).toBeVisible();
  await expect(trad.getByRole("heading", { name: "Traditional IRA", exact: true })).toBeVisible();
  await expect(roth2.getByRole("heading", { name: "Roth IRA", exact: true })).toBeVisible();
  for (const [card, suffix] of [[roth, "1234"], [trad, "5678"], [roth2, "9012"]] as const) {
    await expect(card.getByText(`Account ••••${suffix}`, { exact: false })).toBeVisible();
    await expect(card.getByRole("list", { name: "Workflow checklist", exact: true }).getByRole("listitem")).toHaveCount(3);
    const titles = card.getByRole("list", { name: "Workflow checklist", exact: true }).getByRole("listitem");
    await expect(titles.nth(0)).toContainText(PAPERWORK);
    await expect(titles.nth(1)).toContainText(SUBMIT);
    await expect(titles.nth(2)).toContainText(TRACK);
  }
  await expect(roth).toContainText("1 of 3 saved tasks done");
  await expect(roth).toContainText("Current step 2");
  await expect(trad).toContainText("Next unfinished step 1");
  await expect(roth.getByRole("link", { name: /^Deal:/ })).toHaveAttribute("href", "/deals/DEV-ticket-GROUP-DEAL-ROTH1-20260928");
  await expect(trad.getByRole("link", { name: /^Deal:/ })).toHaveAttribute("href", "/deals/DEV-ticket-GROUP-DEAL-TRAD-20260928");
  await expect(roth2.getByRole("link", { name: /^Deal:/ })).toHaveAttribute("href", "/deals/DEV-ticket-GROUP-DEAL-ROTH2-20260928");
  await expect(page.locator("body")).not.toContainText("TEST-GROUP-1234");
  await roth.screenshot({ path: "test-results/tasks-grouped-desktop.png" });
});

test("filtering retains completed predecessors and truthful transfer progress", async ({ page }) => {
  await page.getByRole("group", { name: "Filter tasks by status" }).getByRole("button", { name: /^To do/ }).click();
  const roth = group(page, GROUP_TRANSFERS.roth);
  await expect(roth).toContainText("1 of 3 saved tasks done");
  await expect(roth).toContainText("1 match the filter · 2 shown for context");
  await expect(status(roth, PAPERWORK)).toHaveValue("done");
  await expect(status(roth, SUBMIT)).toHaveValue("in_progress");
  await expect(status(roth, TRACK)).toHaveValue("todo");
  await expect(roth.getByText("Context · outside the selected status filter", { exact: true })).toHaveCount(2);
});

test("blocking exception is shown only on its specific transfer", async ({ page }) => {
  const question = "Confirm synthetic Roth IRA 9012 paperwork";
  await expect(group(page, GROUP_TRANSFERS.secondRoth)).toContainText(question);
  await expect(group(page, GROUP_TRANSFERS.roth)).not.toContainText(question);
  await expect(group(page, GROUP_TRANSFERS.traditional)).not.toContainText(question);
  const exception = group(page, GROUP_TRANSFERS.secondRoth).getByRole("region", { name: "Exceptions and other tasks" });
  await expect(exception.getByRole("link", { name: "View decision →", exact: true })).toHaveCount(0);
  await expect(exception).toContainText("Decision recorded");
  await expect(exception.locator('a[href*="/decision-center"]')).toHaveCount(0);
  await expect(group(page, GROUP_TRANSFERS.roth)).toContainText(/approv/i);
});

test("saved task update persists without moving transfer cards after refresh or navigation", async ({ page }) => {
  const trad = group(page, GROUP_TRANSFERS.traditional);
  const client = page.getByTestId(/^client-group-/).filter({ has: trad });
  const cards = client.getByTestId(/^transfer-group-/);
  const cardOrder = () => cards.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-testid")));
  await expect(cards).toHaveCount(3);
  const originalOrder = await cardOrder();
  await expect(status(trad, PAPERWORK)).toHaveValue("todo");
  await expect(trad).toContainText("0 of 3 saved tasks done");
  try {
    await status(trad, PAPERWORK).selectOption("done");
    // The progress count comes from the refreshed server response, so this
    // waits for the save rather than only the select's immediate DOM value.
    await expect(trad).toContainText("1 of 3 saved tasks done");
    await expect(status(trad, PAPERWORK)).toHaveValue("done");
    await expect.poll(cardOrder).toEqual(originalOrder);
    await page.reload();
    await expect(status(trad, PAPERWORK)).toHaveValue("done");
    await expect(trad).toContainText("1 of 3 saved tasks done");
    await expect(trad).toContainText("Next unfinished step 2");
    await expect.poll(cardOrder).toEqual(originalOrder);

    await trad.getByRole("link", { name: "View transfer →", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/asset-transfer/${GROUP_TRANSFERS.traditional}$`));
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: /^Tasks\b/ }).click();
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(trad).toContainText("1 of 3 saved tasks done");
    await expect(status(trad, PAPERWORK)).toHaveValue("done");
    await expect.poll(cardOrder).toEqual(originalOrder);
    await expect(status(group(page, GROUP_TRANSFERS.secondRoth), PAPERWORK)).toHaveValue("todo");
  } finally {
    if (new URL(page.url()).pathname !== "/tasks") await page.goto("/tasks");
    await expect(status(trad, PAPERWORK)).toBeEnabled();
    await status(trad, PAPERWORK).selectOption("todo");
    await expect(trad).toContainText("0 of 3 saved tasks done");
    await page.reload();
    await expect(status(trad, PAPERWORK)).toHaveValue("todo");
    await expect(trad).toContainText("0 of 3 saved tasks done");
    await expect.poll(cardOrder).toEqual(originalOrder);
  }
});

test("flat view retains account identity and exact transfer navigation", async ({ page }) => {
  await page.getByRole("button", { name: "Flat list", exact: true }).click();
  const rows = page.getByRole("row").filter({ hasText: PAPERWORK });
  await expect(rows).toHaveCount(3);
  for (const suffix of ["1234", "5678", "9012"]) await expect(rows.filter({ hasText: `••••${suffix}` })).toHaveCount(1);
  const roth = rows.filter({ hasText: "••••1234" });
  await expect(roth.getByRole("link", { name: "View transfer →", exact: true })).toHaveAttribute("href", `/asset-transfer/${GROUP_TRANSFERS.roth}`);
  await page.getByRole("button", { name: "By client and transfer", exact: true }).click();
  await expect(group(page, GROUP_TRANSFERS.roth)).toBeVisible();
});

test("narrow layout keeps distinct account context and task controls usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const roth = group(page, GROUP_TRANSFERS.roth);
  await expect(roth).toBeVisible();
  await expect(status(roth, PAPERWORK)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await roth.screenshot({ path: "test-results/tasks-grouped-mobile.png" });
});

test("viewer can read grouped tasks but cannot change their status or priority", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:3108" });
  const page = await context.newPage();
  await page.goto("/?callbackUrl=%2Ftasks");
  await page.getByRole("button", { name: "Val Viewer · VIEWER (sees none)", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  const roth = group(page, GROUP_TRANSFERS.roth);
  await expect(roth).toBeVisible();
  await expect(status(roth, PAPERWORK)).toBeDisabled();
  await expect(status(roth, SUBMIT)).toBeDisabled();
  await expect(roth.getByRole("combobox", { name: `Priority for ${PAPERWORK}`, exact: true })).toBeDisabled();
  await context.close();
});
