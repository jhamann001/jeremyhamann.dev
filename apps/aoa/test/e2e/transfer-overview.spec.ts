import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFileSync } from "node:fs";

// Mount the actual presentation and plan controls. Only their unchanged server
// action/navigation boundaries are replaced. Every fixture is synthetic and
// all network is blocked, including source integrations.
async function setup(page: Page, options: {
  readOnly?: boolean;
  legacyReview?: boolean;
  missing?: boolean;
  extraPosition?: boolean;
  approvedVersion?: number;
  planComplete?: boolean;
  fundingType?: "ACAT_FULL" | "ACAT_PARTIAL";
} = {}) {
  const scriptErrors: string[] = [];
  const networkRequests: string[] = [];
  page.on("pageerror", (error) => scriptErrors.push(error.message));
  await page.route("**/*", (route) => {
    networkRequests.push(route.request().url());
    return route.abort();
  });
  const bundle = await build({
    stdin: { contents: `
      import { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { TransferDetailSection } from './components/transfers/TransferDetailSection';
      import { TransferOverviewSummary } from './components/transfers/TransferOverviewSummary';
      import { TransferPlanDraftProvider } from './components/transfers/TransferPlanDraftProvider';
      import { DecisionChecklistCard } from './components/transfers/DecisionChecklistCard';
      import { TransferPlanPositionsCard } from './components/transfers/TransferPlanPositionsCard';
      import { TransferPlanApprovalFooter } from './components/transfers/TransferPlanApprovalFooter';
      import { Card, CardBody } from './components/ui';
      const readOnly = ${!!options.readOnly};
      const legacyReview = ${!!options.legacyReview};
      const missing = ${!!options.missing};
      const extraPosition = ${!!options.extraPosition};
      window.syntheticWrites = [];
      window.syntheticRefreshes = 0;
      window.syntheticSaveFailure = false;
      const transfer = {
        funding_type: ${JSON.stringify(options.fundingType ?? "ACAT_FULL")},
        funding_plan_complete: ${!!options.planComplete}, funding_plan_version: ${options.approvedVersion ?? 0},
        transferring_firm: missing ? null : 'Illustrative Brokerage & Clearing',
        asset_map_custodian: missing ? null : 'Illustrative Brokerage & Clearing',
        asset_map_account_type: missing ? null : 'Traditional IRA',
        asset_map_account_number: missing ? null : 'SYNTHETIC-7788',
        owner_kind: 'OPERATIONS', owner_name: 'Example Operator',
        next_step: 'Review the signed paperwork before submission',
        next_step_owner: 'Operations', pending_nudge: null,
      };
      const positions = [{
        symbol: 'SYN', description: 'Synthetic example position',
        marketValue: 15000, costBasis: 12500, isTransferring: true, ineligible: false,
      }, ...(extraPosition ? [{
        symbol: 'ALT', description: 'Another synthetic position',
        marketValue: 5000, costBasis: 4000, isTransferring: true, ineligible: false,
      }] : [])];
      function Fixture() {
        const [revision, setRevision] = useState(0);
        return <>
          <p style={{color:'var(--muted)',fontSize:11}}>SYNTHETIC LOCAL PREVIEW · NO LIVE RECORD</p>
          <h1>Example Client · Asset Transfer</h1>
          <Card><CardBody><TransferOverviewSummary
            transfer={transfer}
            receiving={missing ? {registrationType: 'Traditional IRA', status: 'TO_OPEN', apexAccountMasked: null}
              : {registrationType: 'Traditional IRA', status: 'OPEN', apexAccountMasked: '••••2267'}}
            nextTask="Collect signed paperwork" openExceptions={1} blockingExceptions={1}
            assetMapUnavailable={missing}
          /></CardBody></Card>
          <div role="status" style={{padding:16,border:'1px solid var(--border)',borderRadius:12}}>
            ACAT status unavailable. This synthetic fixture does not contact the tracker.
          </div>
          <TransferPlanDraftProvider transferId="synthetic-overview"
            initialFundingType={transfer.funding_type} initialBasisDecisions={[]}
            initialPartialPositions={positions.map(({symbol,isTransferring})=>({symbol,isTransferring}))}
            canEdit={!readOnly && !legacyReview} canApprove={legacyReview ? !readOnly : undefined}
            approvalMode={legacyReview ? "LEGACY_IN_TRANSFER_REVIEW" : undefined}
            planComplete={transfer.funding_plan_complete} approvedVersion={transfer.funding_plan_version}
            approvedAt={null} approvedBy={null}>
            <TransferDetailSection id="information" title="Information & linked records"
              description="Account, map and source details" meta={missing ? "Linked map unavailable" : "1 linked map"}>
              <Card><CardBody>
                <dl>
                  <dt>Delivering custodian</dt><dd>{missing ? "Custodian not yet recorded" : transfer.transferring_firm}</dd>
                  <dt>Statement account</dt><dd>{missing ? "Account details not yet linked" : "Traditional IRA · ••••7788"}</dd>
                  <dt>Receiving Apex account</dt><dd>{missing ? "No open match in synced data — verify" : "Traditional IRA · ••••2267"}</dd>
                </dl>
              </CardBody></Card>
            </TransferDetailSection>
            <TransferDetailSection id="funding" title="Funding plan & positions" initiallyOpen={legacyReview}
              description="Review the existing plan and explicitly approve any changes" meta="Not approved">
              <Card><CardBody><DecisionChecklistCard transferId="synthetic-overview"
                accountsOpenedAtApex={false} fundingInitiated={false} cashInFlight={false}
                canWrite={!readOnly} showReadiness={false}/></CardBody></Card>
              <TransferPlanPositionsCard positions={positions} decisions={[]}/>
              <TransferPlanApprovalFooter/>
            </TransferDetailSection>
            <TransferDetailSection id="exceptions" title="Transfer exceptions"
              initiallyOpen meta="1 open · 1 blocking">
              <Card><CardBody><p>Receiving account registration needs verification.</p>
                <p>Owner: Operations</p><a href="/decision-center?decision=synthetic-case">Resolve exception</a>
              </CardBody></Card>
            </TransferDetailSection>
          </TransferPlanDraftProvider>
          <button onClick={() => setRevision(revision + 1)}>Refresh local summary ({revision})</button>
        </>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);
    `, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, outdir: "unused-transfer-overview-output",
    format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    alias: { "@": process.cwd() },
    plugins: [{ name: "isolate-transfer-action-boundaries", setup(builder) {
      builder.onResolve({ filter: /asset-transfer\/actions$/ }, () => ({ path: "actions", namespace: "synthetic" }));
      builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "synthetic" }));
      builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "synthetic" }));
      builder.onLoad({ filter: /.*/, namespace: "synthetic" }, (args) => ({
        loader: "jsx", resolveDir: process.cwd(), contents: args.path === "actions" ? `
          export async function approveFundingPlan(id, input) {
            window.syntheticWrites.push({id, input});
            if (window.syntheticSaveFailure) return {ok:false, errors:[{field:'funding_type',message:'Synthetic approval failed. Review and retry.'}]};
            return {ok:true, version:input.baseVersion + 1, approvedAt:'2026-09-22T12:00:00Z', approvedBy:'example@example.test'};
          }
          export async function setCashInFlight() { throw new Error('Unexpected readiness write'); }
          export async function setChecklistFlag() { throw new Error('Unexpected readiness write'); }
        ` : args.path === "navigation" ? `
          const router = {refresh:()=>{window.syntheticRefreshes++;}};
          export const useRouter = () => router;
        ` : `import {createElement} from 'react'; export default function Link({children,...props}) {return createElement('a', props, children);}`,
      }));
    } }],
  });
  await page.setContent('<html><body><main id="root"></main></body></html>');
  await page.addStyleTag({ content: readFileSync("app/globals.css", "utf8") });
  await page.addStyleTag({ content: ':root {--font-sans:sans-serif;--font-serif:Georgia;--font-mono:monospace;} #root {max-width:1200px;margin:auto;padding:24px;display:flex;flex-direction:column;gap:18px;} h1{font-size:26px;} label{display:block;margin-top:16px;} input{max-width:100%;} @media(max-width:500px){#root{padding:12px;}}' });
  for (const file of bundle.outputFiles) {
    if (file.path.endsWith(".css")) await page.addStyleTag({ content: file.text });
    if (file.path.endsWith(".js")) await page.addScriptTag({ content: file.text });
  }
  await expect(page.getByRole("heading", { name: "Example Client · Asset Transfer" })).toBeVisible();
  return { scriptErrors, networkRequests };
}

const section = (page: Page, name: string) => page.locator("details").filter({ has: page.locator("summary").filter({ hasText: name }) });
const toggle = (page: Page, name: string) => section(page, name).locator("summary");
const writes = (page: Page) => page.evaluate(() => (window as unknown as { syntheticWrites: unknown[] }).syntheticWrites);

test("keyboard toggles disclosures without unmounting draft controls or writing", async ({ page }) => {
  const fixture = await setup(page);
  const info = section(page, "Information & linked records");
  const funding = section(page, "Funding plan & positions");
  const summary = toggle(page, "Funding plan & positions");
  await expect(info).not.toHaveAttribute("open", "");
  await expect(section(page, "Transfer exceptions")).toHaveAttribute("open", "");
  await expect(page.getByText("ACAT status unavailable.", { exact: false })).toBeVisible();
  await toggle(page, "Information & linked records").click();
  await expect(info.getByRole("combobox")).toHaveCount(0);
  await expect(info.getByText("Traditional IRA · ••••7788")).toBeVisible();
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(funding).toHaveAttribute("open", "");
  await expect(page.getByRole("combobox", { name: "Funding type", exact: true })).toHaveCount(1);
  const input = page.locator("#funding_plan_note");
  await input.fill("Draft reference retained");
  await input.evaluate((element) => element.setAttribute("data-original-node", "yes"));
  await funding.getByRole("combobox", { name: "Funding type", exact: true }).selectOption("ACAT_PARTIAL");
  await funding.getByRole("combobox", { name: "Transferring SYN" }).selectOption("no");
  // The overview represents saved data, not browser-local funding changes.
  const savedOverview = page.getByRole("region", { name: "Transfer overview" });
  await expect(savedOverview.getByText("ACAT-Full", { exact: true })).toBeVisible();
  await expect(savedOverview.getByText("Plan not approved", { exact: true })).toBeVisible();
  await summary.focus();
  await page.keyboard.press("Space");
  await expect(funding).not.toHaveAttribute("open", "");
  await expect(input).toHaveCount(1);
  await expect(input).not.toBeVisible();
  await page.getByRole("button", { name: /Refresh local summary/ }).click();
  await expect(funding).not.toHaveAttribute("open", "");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(input).toHaveValue("Draft reference retained");
  await expect(input).toHaveAttribute("data-original-node", "yes");
  await expect(funding.getByRole("combobox", { name: "Funding type", exact: true })).toHaveValue("ACAT_PARTIAL");
  await expect(summary).toBeFocused();
  await expect(summary).toHaveCSS("outline-style", "solid");
  await expect(funding.getByRole("combobox", { name: "Transferring SYN" })).toHaveValue("no");
  await expect(page.getByRole("combobox", { name: "Funding type", exact: true })).toHaveCount(1);
  expect(await writes(page)).toEqual([]);
  expect(fixture.scriptErrors).toEqual([]);
  expect(fixture.networkRequests).toEqual([]);
});

test("failed approval keeps draft values and errors through collapse; explicit retry saves once", async ({ page }) => {
  const fixture = await setup(page, { extraPosition: true });
  await toggle(page, "Funding plan & positions").click();
  const funding = section(page, "Funding plan & positions");
  await funding.getByRole("combobox", { name: "Funding type", exact: true }).selectOption("ACAT_PARTIAL");
  await funding.getByRole("combobox", { name: "Transferring ALT" }).selectOption("no");
  await funding.getByRole("textbox", { name: /Approval note/ }).fill("Synthetic review note");
  await expect(page.getByRole("region", { name: "Transfer overview" }).getByText("ACAT-Full", { exact: true })).toBeVisible();
  await expect(funding.getByRole("status")).toContainText("Unsaved plan changes");
  expect(await writes(page)).toEqual([]);
  await page.evaluate(() => { (window as unknown as { syntheticSaveFailure: boolean }).syntheticSaveFailure = true; });
  await funding.getByRole("button", { name: "Approve funding plan" }).click();
  await expect(funding.getByRole("alert")).toHaveText("Synthetic approval failed. Review and retry.");
  await toggle(page, "Funding plan & positions").click();
  await toggle(page, "Funding plan & positions").click();
  await expect(funding.getByRole("alert")).toBeVisible();
  await expect(funding.getByRole("status")).toContainText("Unsaved plan changes");
  await expect(funding.getByRole("textbox", { name: /Approval note/ })).toHaveValue("Synthetic review note");
  await expect(funding.getByRole("combobox", { name: "Transferring ALT" })).toHaveValue("no");
  expect(await writes(page)).toHaveLength(1);
  await page.evaluate(() => { (window as unknown as { syntheticSaveFailure: boolean }).syntheticSaveFailure = false; });
  await funding.getByRole("button", { name: "Approve funding plan" }).click();
  await expect(funding.getByText(/Approved version 1 by example@example.test/)).toBeVisible();
  await expect(funding.getByRole("button", { name: "Approve revised plan" })).toBeDisabled();
  await expect(funding.getByRole("status")).toBeEmpty();
  await expect(funding.getByRole("alert")).toHaveCount(0);
  expect(await writes(page)).toEqual(Array(2).fill({id:"synthetic-overview", input:{
    approvalMode: "PREPARATION", baseVersion:0, fundingType:"ACAT_PARTIAL", basisDecisions:[],
    partialPositions:[{symbol:"SYN", isTransferring:true},{symbol:"ALT", isTransferring:false}], note:"Synthetic review note",
  }}));
  expect(await page.evaluate(() => (window as unknown as { syntheticRefreshes: number }).syntheticRefreshes)).toBe(1);
  expect(fixture.scriptErrors).toEqual([]);
  expect(fixture.networkRequests).toEqual([]);
});

test("a reloaded invalidated plan can be approved without changing securities, including after a failed attempt", async ({ page }) => {
  const fixture = await setup(page, {
    approvedVersion: 5, planComplete: false, fundingType: "ACAT_PARTIAL", extraPosition: true,
  });
  await toggle(page, "Funding plan & positions").click();
  const funding = section(page, "Funding plan & positions");
  const approve = funding.getByRole("button", { name: "Approve revised plan", exact: true });
  await expect(funding.getByRole("status")).toContainText("Approval required");
  await expect(funding.getByRole("status")).not.toContainText("Unsaved plan changes");
  await expect(approve).toBeEnabled();
  expect(await writes(page)).toEqual([]);

  await page.evaluate(() => { (window as unknown as { syntheticSaveFailure: boolean }).syntheticSaveFailure = true; });
  await approve.click();
  await expect(funding.getByRole("alert")).toHaveText("Synthetic approval failed. Review and retry.");
  await expect(funding.getByRole("status")).toContainText("Approval required");
  await expect(approve).toBeEnabled();
  await expect(funding.getByRole("combobox", { name: "Transferring SYN", exact: true })).toHaveValue("yes");
  await expect(funding.getByRole("combobox", { name: "Transferring ALT", exact: true })).toHaveValue("yes");
  await funding.getByRole("textbox", { name: /Approval note/ }).fill("Reviewed the saved instructions after the source changed.");
  await page.evaluate(() => { (window as unknown as { syntheticSaveFailure: boolean }).syntheticSaveFailure = false; });
  await approve.click();
  await expect(funding.getByText(/Approved version 6 by example@example.test/)).toBeVisible();
  await expect(funding.getByRole("status")).toBeEmpty();
  await expect(funding.getByRole("alert")).toHaveCount(0);
  await expect(approve).toBeDisabled();
  const savedPlan = {
    approvalMode: "PREPARATION", baseVersion: 5, fundingType: "ACAT_PARTIAL", basisDecisions: [],
    partialPositions: [{ symbol: "SYN", isTransferring: true }, { symbol: "ALT", isTransferring: true }],
  };
  expect(await writes(page)).toEqual([
    { id: "synthetic-overview", input: { ...savedPlan, note: "" } },
    { id: "synthetic-overview", input: { ...savedPlan, note: "Reviewed the saved instructions after the source changed." } },
  ]);
  expect(await page.evaluate(() => (window as unknown as { syntheticRefreshes: number }).syntheticRefreshes)).toBe(1);
  expect(fixture.scriptErrors).toEqual([]);
  expect(fixture.networkRequests).toEqual([]);
});

for (const planComplete of [false, true]) {
  test(`version-zero ${planComplete ? "legacy completion" : "unapproved plan"} can be approved without an edit`, async ({ page }) => {
    const fixture = await setup(page, { approvedVersion: 0, planComplete });
    await toggle(page, "Funding plan & positions").click();
    const funding = section(page, "Funding plan & positions");
    await expect(funding.getByRole("status")).toContainText("Approval required");
    if (planComplete) await expect(funding.getByRole("status")).toContainText("no versioned approval");
    expect(await writes(page)).toEqual([]);
    await funding.getByRole("button", { name: "Approve funding plan", exact: true }).click();
    await expect(funding.getByText(/Approved version 1 by example@example.test/)).toBeVisible();
    await expect(funding.getByRole("status")).toBeEmpty();
    await expect(funding.getByRole("button", { name: "Approve revised plan", exact: true })).toBeDisabled();
    expect(await writes(page)).toEqual([{ id: "synthetic-overview", input: {
      approvalMode: "PREPARATION", baseVersion: 0, fundingType: "ACAT_FULL", basisDecisions: [],
      partialPositions: [{ symbol: "SYN", isTransferring: true }], note: "",
    } }]);
    expect(fixture.scriptErrors).toEqual([]);
    expect(fixture.networkRequests).toEqual([]);
  });
}

test("legacy review keeps saved instructions read-only and binds explicit approval mode through failure and retry", async ({ page }) => {
  const fixture = await setup(page, {
    legacyReview: true, approvedVersion: 0, planComplete: false, fundingType: "ACAT_PARTIAL", extraPosition: true,
  });
  const funding = section(page, "Funding plan & positions");
  await expect(funding).toHaveAttribute("open", "");
  await expect(funding.getByRole("combobox")).toHaveCount(0);
  await expect(funding.getByRole("table")).toContainText("SYN");
  await expect(funding.getByRole("table")).toContainText("ALT");
  await expect(funding).toContainText("Preparation");
  const approve = funding.getByRole("button", { name: /^Approve/ });
  await expect(approve).toBeEnabled();
  expect(await writes(page)).toEqual([]);
  await funding.getByRole("textbox", { name: /Approval note/ }).fill("Reviewed saved in-flight instructions.");
  await page.evaluate(() => { (window as unknown as { syntheticSaveFailure: boolean }).syntheticSaveFailure = true; });
  await approve.click();
  await expect(funding.getByRole("alert")).toHaveText("Synthetic approval failed. Review and retry.");
  await expect(funding.getByRole("textbox", { name: /Approval note/ })).toHaveValue("Reviewed saved in-flight instructions.");
  await expect(funding.getByRole("combobox")).toHaveCount(0);
  await expect(approve).toBeEnabled();
  await page.evaluate(() => { (window as unknown as { syntheticSaveFailure: boolean }).syntheticSaveFailure = false; });
  await approve.click();
  await expect(funding.getByText(/Approved version 1 by example@example.test/)).toBeVisible();
  await expect(funding.getByRole("alert")).toHaveCount(0);
  await expect(funding.getByRole("status")).toBeEmpty();
  await expect(approve).toBeDisabled();
  await expect(funding.getByRole("combobox")).toHaveCount(0);
  expect(await writes(page)).toEqual(Array(2).fill({ id: "synthetic-overview", input: {
    approvalMode: "LEGACY_IN_TRANSFER_REVIEW", baseVersion: 0,
    fundingType: "ACAT_PARTIAL", basisDecisions: [],
    partialPositions: [{ symbol: "SYN", isTransferring: true }, { symbol: "ALT", isTransferring: true }],
    note: "Reviewed saved in-flight instructions.",
  } }));
  expect(await page.evaluate(() => (window as unknown as { syntheticRefreshes: number }).syntheticRefreshes)).toBe(1);
  expect(fixture.scriptErrors).toEqual([]);
  expect(fixture.networkRequests).toEqual([]);
});

test("a note-only edit does not enable another approval of a valid unchanged plan", async ({ page }) => {
  const fixture = await setup(page, { approvedVersion: 3, planComplete: true, fundingType: "ACAT_PARTIAL" });
  await toggle(page, "Funding plan & positions").click();
  const funding = section(page, "Funding plan & positions");
  const approve = funding.getByRole("button", { name: "Approve revised plan", exact: true });
  await expect(approve).toBeDisabled();
  await expect(funding.getByRole("status")).toBeEmpty();
  await funding.getByRole("textbox", { name: /Approval note/ }).fill("A note is not a revised plan.");
  await expect(approve).toBeDisabled();
  await expect(funding.getByRole("status")).toBeEmpty();
  expect(await writes(page)).toEqual([]);
  expect(fixture.scriptErrors).toEqual([]);
  expect(fixture.networkRequests).toEqual([]);
});

for (const width of [1440, 390]) {
  test(`approval follows securities and saves the complete draft once at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1050 });
    const fixture = await setup(page, { extraPosition: true });
    await toggle(page, "Funding plan & positions").click();
    const funding = section(page, "Funding plan & positions");
    await expect(funding.getByRole("status")).toContainText("Approval required");
    await funding.getByRole("combobox", { name: "Funding type", exact: true }).selectOption("ACAT_PARTIAL");
    await funding.getByRole("combobox", { name: "Transferring ALT", exact: true }).selectOption("no");
    await expect(funding.getByRole("status")).toContainText("Unsaved plan changes");
    await expect(funding.getByRole("status")).toContainText(/funding type.*securit/i);
    const approve = funding.getByRole("button", { name: "Approve funding plan", exact: true });
    await expect(approve).toHaveCount(1);
    await expect(funding.getByRole("table")).toBeVisible();
    const positionsBox = await funding.getByRole("table").boundingBox();
    const noteBox = await funding.getByRole("textbox", { name: /Approval note/ }).boundingBox();
    const approveBox = await approve.boundingBox();
    expect(positionsBox).not.toBeNull();
    expect(noteBox).not.toBeNull();
    expect(approveBox).not.toBeNull();
    expect(noteBox!.y).toBeGreaterThanOrEqual(positionsBox!.y + positionsBox!.height);
    expect(approveBox!.y).toBeGreaterThanOrEqual(positionsBox!.y + positionsBox!.height);
    expect(await writes(page)).toEqual([]);
    await funding.getByRole("textbox", { name: /Approval note/ }).fill("One explicit review");
    await approve.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`transfer-approval-footer-dirty-${width}.png`), fullPage: true });
    await approve.click();
    await expect(funding.getByText(/Approved version 1 by example@example.test/)).toBeVisible();
    await expect(funding.getByRole("status")).toBeEmpty();
    await expect(funding.getByRole("button", { name: "Approve revised plan" })).toBeDisabled();
    expect(await writes(page)).toEqual([{ id: "synthetic-overview", input: {
      approvalMode: "PREPARATION", baseVersion: 0, fundingType: "ACAT_PARTIAL", basisDecisions: [],
      partialPositions: [{ symbol: "SYN", isTransferring: true }, { symbol: "ALT", isTransferring: false }],
      note: "One explicit review",
    } }]);
    expect(await page.evaluate(() => (window as unknown as { syntheticRefreshes: number }).syntheticRefreshes)).toBe(1);
    expect(fixture.scriptErrors).toEqual([]);
    expect(fixture.networkRequests).toEqual([]);
  });
}

for (const width of [1440, 390]) {
  test(`summary, blocker visibility and disclosure layout at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1050 });
    const fixture = await setup(page, { missing: true });
    await expect(page.getByRole("region", { name: "Transfer overview" }).getByText(/No open match in synced data/)).toBeVisible();
    await expect(page.getByText(/Receiving account registration needs verification/)).toBeVisible();
    await expect(page.getByText(/ACAT status unavailable/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`transfer-overview-${width}.png`), fullPage: true });
    await toggle(page, "Funding plan & positions").click();
    await section(page, "Funding plan & positions").getByRole("combobox", { name: "Funding type", exact: true }).selectOption("ACAT_PARTIAL");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`transfer-plan-expanded-${width}.png`), fullPage: true });
    // Review companion to the collapsed preview: every fixture section open,
    // with the partial-transfer positions visible, but nothing approved/saved.
    await toggle(page, "Information & linked records").click();
    await expect(page.locator("details:not([open])")).toHaveCount(0);
    await expect(section(page, "Information & linked records").getByRole("combobox")).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Funding type", exact: true })).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`transfer-all-expanded-${width}.png`), fullPage: true });
    await toggle(page, "Transfer exceptions").click();
    await expect(toggle(page, "Transfer exceptions")).toContainText("1 open · 1 blocking");
    expect(await writes(page)).toEqual([]);
    expect(fixture.scriptErrors).toEqual([]);
    expect(fixture.networkRequests).toEqual([]);
  });
}

test("read-only controls remain read-only after opening every working section", async ({ page }) => {
  const fixture = await setup(page, { readOnly: true, approvedVersion: 5, planComplete: false });
  await toggle(page, "Information & linked records").click();
  await toggle(page, "Funding plan & positions").click();
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Approve/ })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /Approval note/ })).toHaveCount(0);
  await expect(section(page, "Funding plan & positions").getByRole("status")).toHaveCount(0);
  expect(await writes(page)).toEqual([]);
  expect(fixture.scriptErrors).toEqual([]);
});
