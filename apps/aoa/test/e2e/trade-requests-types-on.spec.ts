import { expect, test, type Page } from "@playwright/test";
import { NO_PERMISSION, signInAs, type Persona } from "./trade-requests-browser-helpers";
import { byName } from "./trade-requests-new-synthetic";
import { TRW13_PORTS } from "./trade-requests-types-fixture";

test.describe.configure({ mode: "serial" });

const DESKTOP = { width: 1440, height: 950 };
const MOBILE = { width: 390, height: 844 };
const NEW = "/trade-requests/new";
const MORGAN = byName("Esta Barrows (synthetic)");
const ABDULLAH = byName("Abdullah Beatty (synthetic)");

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}
const submit = (page: Page) => page.getByRole("button", { name: /^(Generate Plan & Submit|Submit Trade Request)$/ });
const headings = (page: Page) => page.getByRole("heading", { level: 3 });
const tradeType = (page: Page) => page.getByLabel("Trade Type");
const priority = (page: Page) => page.getByLabel(/^Priority/);
const esg = (page: Page) => page.getByRole("group", { name: "ESG Filters (Direct Indexing)" });

async function openForm(page: Page, role: Persona) {
  await signInAs(page, role, NEW);
  await expect(page.getByRole("heading", { level: 2, name: "New Trade Request" })).toBeVisible();
}
async function selectAccount(page: Page, client = MORGAN, numbers = [client.accounts[0].number]) {
  await page.getByRole("button", { name: /^Client \/ Household/ }).click();
  const list = page.getByRole("listbox", { name: "Client list" });
  await list.getByRole("option", { name: new RegExp(`^${client.name.replace(/[()]/g, "\\$&")}`) }).click();
  await page.keyboard.press("Escape");
  const accounts = page.getByRole("group", { name: "Select Accounts" });
  for (const number of numbers) await accounts.getByRole("checkbox", { name: new RegExp(number) }).check();
}

test("ADVISOR: Raise Cash gates Submit on priority, amount and reason; the deadline is optional (AC-35, AC-131, AC-132)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openForm(page, "ADVISOR");
  await expect(priority(page).locator("option")).toHaveText(["Select a priority", "Urgent", "Standard", "Low"]);
  await expect(tradeType(page).locator("option")).toHaveText(["Initial Funding", "Rebalance", "Cash Deposit", "Raise Cash", "Liquidate"]);
  await tradeType(page).selectOption("Raise Cash");
  await expect(headings(page)).toHaveText(["1. Client & Account Context", "2. Workflow & Advisor Notes"]);
  await selectAccount(page);
  await expect(headings(page)).toHaveText(["1. Client & Account Context", "2. Cash Raise Details", "3. Workflow & Advisor Notes"]);
  await expect(page.getByText("Target amount of cash to generate from selling securities")).toBeVisible();
  await expect(page.getByText("Date the cash must be settled, if applicable")).toBeVisible();
  await expect(page.getByText("Purpose of the cash generation request")).toBeVisible();
  await expect(submit(page)).toBeDisabled();
  await priority(page).selectOption("Urgent");
  await expect(submit(page)).toBeDisabled();
  await page.getByLabel(/^Cash Amount to Raise/).fill("$50,000");
  await expect(submit(page)).toBeDisabled();
  await page.getByLabel(/^Reason for Cash Raise/).fill("Client distribution (synthetic)");
  await expect(submit(page)).toBeEnabled();
  await page.getByLabel("Liquidity Deadline").fill("2026-11-02");
  await expect(page.getByLabel("Liquidity Deadline")).toHaveValue("2026-11-02");
  await expect(submit(page)).toBeEnabled();
  await page.getByLabel("Advisor Compliance & Execution Notes").fill("Lowest basis lots first (synthetic).");
  await shoot(page, "raise-cash-ADVISOR");
});

test("OPERATIONS: Liquidate needs an option and, for Specific Positions, the positions (AC-36, AC-37)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openForm(page, "OPERATIONS");
  await tradeType(page).selectOption("Liquidate");
  await selectAccount(page);
  await priority(page).selectOption("Standard");
  await expect(headings(page)).toHaveText(["1. Client & Account Context", "2. Liquidation Details", "3. Workflow & Advisor Notes"]);
  await expect(page.getByLabel(/^Liquidate Options/).locator("option")).toHaveText(["Select liquidation option", "Entire Account", "Specific Positions"]);
  await expect(submit(page)).toBeDisabled();
  await page.getByLabel(/^Liquidate Options/).selectOption("Entire Account");
  await expect(submit(page)).toBeEnabled();
  await page.getByLabel(/^Liquidate Options/).selectOption("Specific Positions");
  await expect(submit(page)).toBeDisabled();
  await page.getByLabel(/^Positions to Liquidate/).fill("AAPL, MSFT, TSLA");
  await expect(submit(page)).toBeEnabled();
  await shoot(page, "liquidate-specific-OPERATIONS");
});

test("ADMIN: Cash Deposit shows the deposit inputs, rebalance-all explanation and execution-plan note (AC-133, AC-134)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openForm(page, "ADMIN");
  await tradeType(page).selectOption("Cash Deposit");
  await selectAccount(page, ABDULLAH, ABDULLAH.accounts.map((a) => a.number));
  await expect(headings(page)).toHaveText([
    "1. Client & Account Context", "2. Deposit Details", "3. Mandate & Base Allocation", "4. Equity Strategy Construction",
    "5. Compliance, Exclusions & Execution", "6. Workflow & Advisor Notes",
  ]);
  await expect(page.getByLabel(/^Account Holding Deposit/).locator("option"))
    .toHaveText(["Select account...", ...ABDULLAH.accounts.map((a) => a.number)]);
  await page.getByLabel(/^Deposit Amount/).fill("$150,000");
  await page.getByLabel(/^Account Holding Deposit/).selectOption(ABDULLAH.accounts[1].number);
  const option = page.getByRole("checkbox", { name: "Also rebalance all selected accounts to target allocation" });
  await expect(option).not.toBeChecked();
  await expect(page.getByText("Only the deposit account will receive trades. Other selected accounts remain unchanged.")).toBeVisible();
  await option.check();
  await expect(page.getByText("The engine will redistribute holdings across all selected accounts for this client to match the target allocation.")).toBeVisible();
  await expect(page.getByRole("note")).toHaveText(
    "Execution plan: A detailed plan is not generated on submit for cash deposits. After you submit, a trader will verify holdings and generate the execution plan.",
  );
  await shoot(page, "cash-deposit-ADMIN");
});

test("ADVISOR: with the no-plan copy switch off, Initial Funding keeps \"Generate Plan & Submit\" (ticket)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openForm(page, "ADVISOR");
  await expect(tradeType(page)).toHaveValue("Initial Funding");
  await expect(page.getByRole("button", { name: "Generate Plan & Submit" })).toBeVisible();
});

test.describe("no-plan copy switch on (ticket)", () => {
  test.use({ baseURL: `http://127.0.0.1:${TRW13_PORTS.noPlanCopy}` });

  test("ADMIN: the Cash Deposit note, rebalance-all text and Initial Funding label promise no engine or plan (AC-12, AC-13, AC-90)", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openForm(page, "ADMIN");
    await expect(tradeType(page)).toHaveValue("Initial Funding");
    await expect(page.getByRole("button", { name: "Submit Trade Request" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Generate Plan & Submit" })).toHaveCount(0);
    await tradeType(page).selectOption("Cash Deposit");
    await selectAccount(page, ABDULLAH, ABDULLAH.accounts.map((a) => a.number));
    await page.getByRole("checkbox", { name: "Also rebalance all selected accounts to target allocation" }).check();
    await expect(page.getByText("A trader will rebalance all selected accounts for this client to the target allocation.")).toBeVisible();
    await expect(page.getByRole("note")).toHaveText("After you submit, a trader will verify holdings and place the trades.");
    await expect(page.getByText(/engine/i)).toHaveCount(0);
    await shoot(page, "cash-deposit-no-plan-copy-ADMIN");
  });
});

test("ADVISOR: Rebalance shows New Deposits once an account is selected; ESG None/Other behave (AC-93, AC-94, AC-137, AC-139, AC-148)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openForm(page, "ADVISOR");
  await tradeType(page).selectOption("Rebalance");
  await expect(page.getByText("New Deposits (Optional)", { exact: false })).toHaveCount(0);
  await selectAccount(page);
  await expect(headings(page)).toHaveText([
    "1. Client & Account Context", "2. New Deposits (Optional)", "3. Mandate & Base Allocation", "4. Equity Strategy Construction",
    "5. Compliance, Exclusions & Execution", "6. Workflow & Advisor Notes",
  ]);
  await expect(page.getByText("If cash is being deposited alongside the rebalance, enter the details below. Leave blank if no deposits.")).toBeVisible();
  await expect(page.getByLabel("Account Holding Deposit").locator("option")).toHaveText(["No deposit", MORGAN.accounts[0].number]);

  await expect(page.getByLabel("State Residence").locator("option"))
    .toHaveText(["Other / Not Applicable", "New York (NY) - Muni Preference", "California (CA) - Muni Preference"]);
  await expect(page.getByLabel("Liquidation Approval").locator("option")).toHaveText(["Select...", "Yes", "No"]);
  const labels = ["Fossil Fuels", "Tobacco", "Weapons", "Alcohol", "Gambling", "Other", "None"];
  await expect(esg(page).getByRole("checkbox")).toHaveCount(7);
  for (const label of labels) await expect(esg(page).getByRole("checkbox", { name: label, exact: true })).toBeVisible();
  await expect(esg(page).getByRole("checkbox", { name: "None" })).toBeChecked();
  await esg(page).getByRole("checkbox", { name: "Tobacco" }).check();
  await expect(esg(page).getByRole("checkbox", { name: "None" })).not.toBeChecked();
  await esg(page).getByRole("checkbox", { name: "Other", exact: true }).check();
  await page.getByPlaceholder("Specify custom ESG filter...").fill("Palm oil (synthetic)");
  await shoot(page, "rebalance-esg-other-ADVISOR");
  await esg(page).getByRole("checkbox", { name: "None" }).check();
  await expect(esg(page).getByRole("checkbox", { name: "Tobacco" })).not.toBeChecked();
  await expect(esg(page).getByRole("checkbox", { name: "Other", exact: true })).not.toBeChecked();
  await expect(page.getByPlaceholder("Specify custom ESG filter...")).toHaveCount(0);
  await esg(page).getByRole("checkbox", { name: "Other", exact: true }).check();
  await expect(page.getByPlaceholder("Specify custom ESG filter...")).toHaveValue("");

  await tradeType(page).selectOption("Raise Cash");
  await expect(esg(page)).toHaveCount(0);
  await tradeType(page).selectOption("Liquidate");
  await expect(esg(page)).toHaveCount(0);
});

test("mobile layout keeps the two-column grids and offers the trade-type inputs without overflow (AC-153)", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await openForm(page, "ADVISOR");
  await tradeType(page).selectOption("Cash Deposit");
  await selectAccount(page);
  const columns = await page.locator("form [class*='grid2']").first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  expect(columns).toBe(2);
  await expect(page.getByRole("checkbox", { name: "Also rebalance all selected accounts to target allocation" })).toBeVisible();
  await expect(esg(page).getByRole("checkbox", { name: "None" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await shoot(page, "mobile-cash-deposit-ADVISOR");
  await tradeType(page).selectOption("Raise Cash");
  await expect(page.getByLabel("Liquidity Deadline")).toBeVisible();
  await shoot(page, "mobile-raise-cash-ADVISOR");
});

for (const role of ["CLIENT_SERVICE", "VIEWER"] as Persona[]) {
  test(`${role} gets the permission screen on the New Request address`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await signInAs(page, role);
    await page.goto(NEW);
    await expect(page.getByText(NO_PERMISSION, { exact: true })).toBeVisible();
    await expect(page.getByLabel("Trade Type")).toHaveCount(0);
    await shoot(page, `permission-${role}`);
  });
}
