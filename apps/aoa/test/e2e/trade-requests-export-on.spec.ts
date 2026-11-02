import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { pdfPageTexts } from "../helpers/pdf-text";
import { NO_PERMISSION, PERSONAS, signInAs, type Persona } from "./trade-requests-browser-helpers";
import { BULK_CLIENT, SEED_TOTAL, SEEDED } from "./trade-requests-export-seed";

const DESKTOP = { width: 1440, height: 950 };
const MOBILE = { width: 390, height: 844 };
const NAMES: Record<string, string> = { ADMIN: "Dana Admin", OPERATIONS: "Riley Ops", ADVISOR: "Avery Stone" };
const NEWEST_FIRST_STATUSES = [...SEEDED].reverse().map((seed) => seed.path.at(-1) ?? "Pending Review");

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}

const exportButton = (page: Page) => page.getByRole("button", { name: /Export Compliance Log|Preparing Export\.\.\./ });

async function openQueue(page: Page, role: Persona) {
  await signInAs(page, role, "/trade-requests/queue");
  await expect(page.getByRole("heading", { level: 1, name: "Global Trading Queue" })).toBeVisible();
  await expect(page.getByRole("row", { name: /^View request / })).toHaveCount(SEED_TOTAL);
}

async function exportFile(page: Page, item: "PDF Report" | "CSV Spreadsheet") {
  await exportButton(page).click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: new RegExp(item) }).click()]);
  return { filename: download.suggestedFilename(), bytes: await readFile((await download.path())!) };
}

function parseCsv(text: string) {
  const [first, header, ...lines] = text.split("\n");
  const cells = (line: string) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map(([, value]) => value.replace(/""/g, '"'));
  const columns = header.split(",");
  const rows = lines.map((line) => Object.fromEntries(cells(line).map((value, index) => [columns[index], value])));
  return { first, columns, rows };
}

async function bellTradeRequestTexts(page: Page) {
  const menu = page.locator("details", { has: page.locator('summary[aria-label^="Notifications"]') });
  if ((await menu.getAttribute("open")) === null) await menu.locator("summary").click();
  return menu.locator('section[aria-label="Trade Requests"] button:has(time) span').allTextContents();
}

function serviceSql(sql: string) {
  execFileSync("psql", ["-h", "/tmp", "-d", process.env.TRW10_SERVICE_DB ?? "trw_local_tkt_371", "-v", "ON_ERROR_STOP=1", "-qAtc", sql]);
}

test("ADMIN exports the whole firm as CSV, ignoring the search and leaving the queue as it was (AC-19, AC-54, AC-112)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openQueue(page, "ADMIN");
  await page.getByRole("searchbox", { name: "Search trade requests" }).fill("Aufderhar");
  await expect(page.getByRole("row", { name: /^View request / })).toHaveCount(2);
  await exportButton(page).click();
  await expect(page.getByRole("menuitem")).toHaveText(["PDF ReportFormatted for compliance review", "CSV SpreadsheetFor data analysis & archival"]);
  await shoot(page, "export-menu-desktop-ADMIN");
  await exportButton(page).click();
  const { filename, bytes } = await exportFile(page, "CSV Spreadsheet");

  expect(filename).toMatch(/^Compliance_Export_\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = parseCsv(bytes.toString("utf8"));
  expect(csv.first).toMatch(/^# Report Exported By: Dana Admin \(admin@example\.com\) \| Exported At: \d{4}-\d{2}-\d{2}T[\d:.]+Z \| Record Count: 6$/);
  expect(csv.columns.slice(15, 19)).toEqual([
    "Standing Advisor Exclusions (current)", "Standing Client Exclusions (current)",
    "Standing Account Advisor Exclusions (current)", "Standing Account Client Exclusions (current)",
  ]);
  expect(csv.columns.at(-1)).toBe("Audit Hash");
  expect(csv.rows.map((row) => row.Status)).toEqual(NEWEST_FIRST_STATUSES);
  const created = csv.rows.map((row) => Date.parse(row["Created At (ISO)"]));
  expect([...created].sort((a, b) => b - a)).toEqual(created);
  for (const row of csv.rows) {
    const richardson = row["Client ID"] === "HH-001";
    expect(row["Standing Advisor Exclusions (current)"]).toBe(richardson ? "SYNA (DNB - Synthetic concentrated position)" : "");
    expect(row["Standing Client Exclusions (current)"]).toBe(richardson ? "SYNC (DNB+DNS)" : "");
    expect(row["Standing Account Advisor Exclusions (current)"]).toBe(row["Selected Accounts"].split("; ").includes("NEAX-1399") ? "NEAX-1399: SYND (DNS)" : "");
    expect(row["Audit Hash"]).toMatch(/^[0-9a-f]{64}$/);
  }
  expect(csv.rows.find((row) => row["Selected Accounts"] === "IGIO-2095")?.["Submitted By"]).toBe("Riley Ops");

  await expect(page.getByRole("searchbox", { name: "Search trade requests" })).toHaveValue("Aufderhar");
  await expect(page.getByRole("row", { name: /^View request / })).toHaveCount(2);
  await expect(exportButton(page)).toHaveText(/Export Compliance Log/);
  expect(await bellTradeRequestTexts(page)).toContain(
    "Some exported accounts could not be resolved to current account IDs (1). Account-level exclusions may be partial.",
  );
  await shoot(page, "export-csv-done-ADMIN");
});

test("ADVISOR exports the Compliance Export Report PDF with stored statuses (AC-141)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openQueue(page, "ADVISOR");
  const { filename, bytes } = await exportFile(page, "PDF Report");
  expect(filename).toMatch(/^Compliance_Report_\d{4}-\d{2}-\d{2}\.pdf$/);
  const pages = await pdfPageTexts(new Uint8Array(bytes));
  const cover = pages[0];
  expect(cover).toEqual(expect.arrayContaining([
    "Compliance Export Report", "Exported By: Avery Stone (avery@example.com)", "Total Records: 6", "Summary by Status", "CONFIDENTIAL",
    "This document contains confidential compliance data. Distribution is restricted to authorized personnel only.",
  ]));
  expect(cover.find((text) => text.startsWith("Date: "))).toMatch(/^Date: [A-Z][a-z]+ \d{1,2}, \d{4}$/);
  expect(cover.find((text) => text.startsWith("Report ID: "))).toMatch(/^Report ID: RPT-\d{14}$/);
  expect(cover.slice(cover.indexOf("Count") + 1, cover.indexOf("CONFIDENTIAL"))).toEqual([
    "Approved", "1", "Completed", "1", "Needs Info", "1", "Pending Current Asset Liquidation", "1", "Pending Review", "1", "Rejected", "1",
  ]);
  const body = pages.slice(1).flat();
  expect(body[0]).toMatch(/^#1  REQ-\S+  —  The Richardson Family$/);
  expect(body[1]).toBe("COMPLETED");
  expect(body).toContain("PENDING CURRENT ASSET LIQUIDATION");
  expect(body).toContain("SYNA (DNB - Synthetic concentrated position)");
  expect(body).toContain("NEAX-1399: SYND (DNS)");
  expect(body).toContain("Audit Trail");
  pages.forEach((texts, index) => {
    expect(texts.some((text) => /^Exported: \d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(text))).toBe(true);
    expect(texts).toContain(`Page ${index + 1} of ${pages.length}`);
  });
  await shoot(page, "export-pdf-done-ADVISOR");
});

test("the export menu works from the keyboard", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openQueue(page, "ADMIN");
  await exportButton(page).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: /PDF Report/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: /CSV Spreadsheet/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(exportButton(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Enter")]);
  expect(download.suggestedFilename()).toMatch(/^Compliance_Export_/);
});

test("OPERATIONS sees Preparing Export... while the export runs (P2-105)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openQueue(page, "OPERATIONS");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/trade-requests/export", async (route) => {
    await held;
    await route.continue();
  });
  await exportButton(page).click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: /CSV Spreadsheet/ }).click();
  await expect(exportButton(page)).toHaveText("Preparing Export...");
  await expect(exportButton(page)).toBeDisabled();
  await shoot(page, "export-running-OPERATIONS");
  release();
  const download = await downloaded;
  const text = await readFile((await download.path())!, "utf8");
  expect(text.split("\n")[0]).toContain(`# Report Exported By: ${NAMES.OPERATIONS} (${PERSONAS.OPERATIONS})`);
  await expect(exportButton(page)).toBeEnabled();
});

test("a failed export produces no file and leaves the menu usable (AC-57)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openQueue(page, "ADMIN");
  await page.route("**/api/trade-requests/export", (route) => route.fulfill({ json: { ok: false, outcome: "failed", message: "Synthetic failure" } }));
  let downloads = 0;
  page.on("download", () => { downloads += 1; });
  await exportButton(page).click();
  await page.getByRole("menuitem", { name: /PDF Report/ }).click();
  await expect(exportButton(page)).toBeEnabled();
  await expect(exportButton(page)).toHaveText(/Export Compliance Log/);
  expect(downloads).toBe(0);
  expect(await bellTradeRequestTexts(page)).toContain("Export failed: Synthetic failure");
});

test("over 5,000 requests the export holds the newest 5,000 (AC-19, AC-20)", async ({ page }) => {
  test.setTimeout(300_000);
  serviceSql(`DELETE FROM trade_requests WHERE client_id = '${BULK_CLIENT}'`);
  serviceSql(`INSERT INTO trade_requests (id, client_id, client_name, advisor_id, trade_type, trade_amount, status, selected_accounts, created_at, updated_at)
    SELECT 'REQ-LLA63E' || lpad(g::text, 5, '0'), '${BULK_CLIENT}', 'Bulk Synthetic', (SELECT id FROM users WHERE email = '${PERSONAS.ADVISOR}'),
      'Raise Cash', '1000', 'Pending Review', '{}', now() - interval '30 days' - g * interval '1 second', now() - interval '30 days'
    FROM generate_series(1, 5000) AS g`);
  try {
    await page.setViewportSize(DESKTOP);
    await signInAs(page, "ADMIN", "/trade-requests/queue");
    await expect(page.getByRole("row", { name: /^View request / })).toHaveCount(50);
    const { bytes } = await exportFile(page, "CSV Spreadsheet");
    const csv = parseCsv(bytes.toString("utf8"));
    expect(csv.first).toMatch(/\| Record Count: 5000$/);
    expect(csv.rows).toHaveLength(5000);
    expect(csv.rows.slice(0, SEED_TOTAL).map((row) => row.Status)).toEqual(NEWEST_FIRST_STATUSES);
    expect(csv.rows[SEED_TOTAL]["Request ID"]).toBe("REQ-TRW10B00001");
    expect(csv.rows.at(-1)?.["Request ID"]).toBe("REQ-VIY32C45000");
    expect(await bellTradeRequestTexts(page)).toEqual(expect.arrayContaining([
      "Export capped at 5,000 requests. The file may be incomplete — contact ops for a full report if needed.",
    ]));
    await expect(page.getByRole("row", { name: /^View request / })).toHaveCount(50);
  } finally {
    serviceSql(`DELETE FROM trade_requests WHERE client_id = '${BULK_CLIENT}'`);
  }
});

test("the export menu stays in the queue toolbar with a request open, and on a request's direct link", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openQueue(page, "ADVISOR");
  const row = page.getByRole("row", { name: /^View request / }).first();
  const id = (await row.getAttribute("data-request-id"))!;
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/trade-requests/queue/${id}$`));
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "Export Compliance Log", includeHidden: true })).toBeAttached();
  await page.goto(`/trade-requests/${id}`);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "Export Compliance Log", includeHidden: true })).toBeAttached();
});

test("ADVISOR mobile: the export control wraps under the title and its menu stays on screen (AC-153)", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await openQueue(page, "ADVISOR");
  const heading = await page.getByRole("heading", { level: 1, name: "Global Trading Queue" }).boundingBox();
  const button = await exportButton(page).boundingBox();
  expect(button!.y).toBeGreaterThan(heading!.y + heading!.height - 1);
  await exportButton(page).click();
  for (const item of await page.getByRole("menuitem").all()) {
    const box = (await item.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(MOBILE.width);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await shoot(page, "export-menu-mobile-ADVISOR");
  await exportButton(page).click();
  const { filename } = await exportFile(page, "CSV Spreadsheet");
  expect(filename).toMatch(/^Compliance_Export_/);
});

for (const role of ["CLIENT_SERVICE", "VIEWER"] as Persona[]) {
  test(`${role} gets no queue and no export`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await signInAs(page, role);
    await page.goto("/trade-requests/queue");
    await expect(page.getByText(NO_PERMISSION)).toBeVisible();
    await expect(page.getByRole("button", { name: "Export Compliance Log" })).toHaveCount(0);
    expect((await page.request.get("/api/trade-requests/export")).status()).toBe(403);
    await shoot(page, `export-refused-${role}`);
  });
}
