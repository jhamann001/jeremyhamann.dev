import { expect, test, type Page } from "@playwright/test";
import { NO_PERMISSION, signInAs, type Persona } from "./trade-requests-browser-helpers";
import { byName } from "./trade-requests-new-synthetic";

test.describe.configure({ mode: "serial" });

const DESKTOP = { width: 1440, height: 950 };
const MOBILE = { width: 390, height: 844 };
const NEW = "/trade-requests/new";
const MORGAN = byName("Esta Barrows (synthetic)");
const ABDULLAH = byName("Abdullah Beatty (synthetic)");
const ALEX = byName("Maeve Brennan (synthetic)");
const PROMPT = "This client has an existing allocation on file.";

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}
const submit = (page: Page) => page.getByRole("button", { name: /^(Generate Plan & Submit|Submit Trade Request)$/ });
const headings = (page: Page) => page.getByRole("heading", { level: 3 });
const prompt = (page: Page) => page.getByRole("region", { name: PROMPT });
const risk = (page: Page) => page.getByLabel("Client Risk Score");
const rationale = (page: Page, index = 0) => page.getByLabel(/^Strategy Rationale/).nth(index);
const benchmarks = (page: Page) => page.getByRole("combobox", { name: "Benchmark / Strategy" });

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
async function compliance(page: Page, priority = "Standard") {
  await page.getByLabel(/^Priority/).selectOption(priority);
  await page.getByLabel("Liquidation Approval").selectOption("Yes");
}

test("ADVISOR: Rebalance for their own client prompts with the prior allocation; Yes fills it and a change requires rationales (AC-96 to AC-98, AC-72)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openForm(page, "ADVISOR");
  await page.getByLabel("Trade Type").selectOption("Rebalance");
  await selectAccount(page);
  await expect(prompt(page)).toBeVisible();
  await expect(prompt(page)).toContainText("Risk Level 15 — IWM (60%), EFA (40%)");
  await expect(risk(page)).toHaveCount(0);
  await expect(page.getByRole("group", { name: "ESG Filters (Direct Indexing)" })).toHaveCount(0);
  await expect(headings(page)).toHaveText(["1. Client & Account Context", "2. New Deposits (Optional)", "3. Workflow & Advisor Notes"]);
  await shoot(page, "rebalance-prompt-ADVISOR");

  await prompt(page).getByRole("button", { name: "Yes, use previous allocation" }).click();
  await expect(prompt(page)).toHaveCount(0);
  await expect(headings(page)).toHaveText([
    "1. Client & Account Context", "2. New Deposits (Optional)", "3. Mandate & Base Allocation", "4. Equity Strategy Construction",
    "5. Compliance, Exclusions & Execution", "6. Workflow & Advisor Notes",
  ]);
  await expect(risk(page)).toHaveValue("15");
  await expect(benchmarks(page)).toHaveCount(2);
  await expect(benchmarks(page).nth(0)).toHaveValue("IWM");
  await expect(benchmarks(page).nth(1)).toHaveValue("EFA");
  await expect(page.getByTestId("base-allocation-equity")).toHaveText("Equity70%");
  await compliance(page);
  await rationale(page, 0).fill("");
  await rationale(page, 1).fill("");
  await expect(page.getByText("Strategy Rationale (Reg BI) (Optional)").first()).toBeVisible();
  await expect(submit(page)).toBeEnabled();
  await page.getByLabel("% of Equity").first().fill("55");
  await page.getByLabel("% of Equity").nth(1).fill("45");
  await expect(submit(page)).toBeDisabled();
  await rationale(page, 0).fill("Trim the small-cap tilt (synthetic)");
  await rationale(page, 1).fill("Raise international (synthetic)");
  await expect(submit(page)).toBeEnabled();
  await shoot(page, "rebalance-yes-changed-ADVISOR");
});

test("ADVISOR: a client on another advisor's request has no prior allocation available, so rationales are required (AC-71)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openForm(page, "ADVISOR");
  await page.getByLabel("Trade Type").selectOption("Rebalance");
  await selectAccount(page, ABDULLAH);
  await expect(risk(page)).toBeVisible();
  await expect(prompt(page)).toHaveCount(0);
  await compliance(page);
  await risk(page).selectOption("9");
  await expect(page.getByText("Strategy Rationale (Reg BI) *")).toBeVisible();
  await expect(submit(page)).toBeDisabled();
  await rationale(page).fill("New mandate for this client (synthetic)");
  await expect(submit(page)).toBeEnabled();
  await shoot(page, "rebalance-no-access-ADVISOR");
});

test("OPERATIONS: a reviewer sees any client's prior allocation; No starts fresh; Cash Deposit also needs amount and account (AC-99, AC-34)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openForm(page, "OPERATIONS");
  await page.getByLabel("Trade Type").selectOption("Cash Deposit");
  await selectAccount(page, ABDULLAH, ABDULLAH.accounts.map((a) => a.number));
  await expect(prompt(page)).toContainText("Risk Level 9 — SPY (100%)");
  await prompt(page).getByRole("button", { name: "No, start fresh" }).click();
  await expect(risk(page)).toHaveValue("");
  await expect(benchmarks(page)).toHaveCount(1);
  await expect(benchmarks(page).first()).toHaveValue("SPY");
  await expect(page.getByLabel("% of Equity")).toHaveValue("100");
  await expect(rationale(page)).toHaveValue("");
  await compliance(page, "Urgent");
  await risk(page).selectOption("9");
  await rationale(page).fill("Deposit into the existing mandate (synthetic)");
  await expect(submit(page)).toBeDisabled();
  await page.getByLabel(/^Deposit Amount/).fill("$150,000");
  await expect(submit(page)).toBeDisabled();
  await page.getByLabel(/^Account Holding Deposit/).selectOption(ABDULLAH.accounts[1].number);
  await expect(submit(page)).toBeEnabled();
  await shoot(page, "cash-deposit-fresh-OPERATIONS");
});

test("ADMIN: Initial Funding base allocation, three-strategy cap, money-market warning, counter and the 100% gate (AC-33, AC-38, AC-73, AC-74, AC-95, AC-135, AC-136, AC-145, AC-147)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openForm(page, "ADMIN");
  await expect(benchmarks(page)).toHaveCount(1);
  await expect(benchmarks(page).first()).toHaveValue("SPY");
  await expect(page.getByTestId("equity-total")).toHaveText("100% / 100%");
  await selectAccount(page, ALEX);
  await compliance(page);
  await expect(page.getByTestId("base-allocation-equity")).toHaveText("Equity—");
  await risk(page).selectOption("6");
  await expect(page.getByTestId("base-allocation-equity")).toHaveText("Equity43%");
  await expect(page.getByTestId("base-allocation-fixed")).toHaveText("Fixed Inc.49.5%");
  await expect(page.getByTestId("base-allocation-cash")).toHaveText("Cash7.5%");
  await expect(submit(page)).toBeDisabled();
  await rationale(page).fill("Core exposure (synthetic)");
  await expect(page.getByText("25 / 5,000")).toBeVisible();
  await expect(submit(page)).toBeEnabled();

  await page.getByRole("button", { name: "+ Add Another Equity Strategy (1/3)" }).click();
  await page.getByRole("button", { name: "+ Add Another Equity Strategy (2/3)" }).click();
  await expect(page.getByRole("button", { name: /Add Another Equity Strategy/ })).toHaveCount(0);
  await expect(page.getByTestId("equity-total")).toHaveText("100% / 100%");
  await expect(submit(page)).toBeDisabled();
  await benchmarks(page).nth(1).click();
  await page.getByRole("option", { name: "EFA – Developed International" }).click();
  await expect(benchmarks(page).nth(1)).toHaveValue("EFA");
  await benchmarks(page).nth(2).fill("SPAXX");
  await expect(page.getByRole("alert").filter({ hasText: "SPAXX doesn’t match" }))
    .toContainText(/SPAXX doesn’t match the selected .+ account\. Expected: VMSXX\. Provide a Strategy Rationale below to override\./);
  await page.getByLabel("% of Equity").first().fill("50");
  await page.getByLabel("% of Equity").nth(1).fill("30");
  await page.getByLabel("% of Equity").nth(2).fill("10");
  await expect(page.getByTestId("equity-total")).toHaveText("90% / 100% — must equal 100%");
  await page.getByLabel("% of Equity").nth(2).fill("20");
  await rationale(page, 1).fill("International (synthetic)");
  await expect(submit(page)).toBeDisabled();
  await rationale(page, 2).fill("Parking cash until the mandate is final (synthetic)");
  await expect(submit(page)).toBeEnabled();
  await shoot(page, "initial-funding-three-strategies-ADMIN");

  await rationale(page).fill("x".repeat(5_000));
  await rationale(page).press("End");
  await page.keyboard.type("more");
  await expect(rationale(page)).toHaveValue("x".repeat(5_000));
  await expect(page.getByText("5,000 / 5,000")).toBeVisible();
  await page.getByRole("button", { name: "Remove equity strategy" }).nth(2).click();
  await expect(page.getByRole("button", { name: "+ Add Another Equity Strategy (2/3)" })).toBeVisible();
  await expect(submit(page)).toHaveAttribute("type", "button");
});

test("mobile layout keeps the allocation tiles and strategy rows in their columns without overflow (AC-153)", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await openForm(page, "ADVISOR");
  await page.getByLabel("Trade Type").selectOption("Rebalance");
  await selectAccount(page);
  await expect(prompt(page)).toBeVisible();
  await shoot(page, "mobile-prompt-ADVISOR");
  await prompt(page).getByRole("button", { name: "Yes, use previous allocation" }).click();
  await expect(risk(page)).toHaveValue("15");
  const tiles = await page.locator("form [class*='tiles']").first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  expect(tiles).toBe(3);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await shoot(page, "mobile-allocation-ADVISOR");
});

for (const role of ["CLIENT_SERVICE", "VIEWER"] as Persona[]) {
  test(`${role} gets the permission screen on the New Request address`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await signInAs(page, role);
    await page.goto(NEW);
    await expect(page.getByText(NO_PERMISSION, { exact: true })).toBeVisible();
    await expect(page.getByLabel("Client Risk Score")).toHaveCount(0);
    await shoot(page, `permission-${role}`);
  });
}
