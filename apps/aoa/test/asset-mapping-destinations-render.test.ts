import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AssetMapAccountView, AssetMapHouseholdView, AssetMapPositionView } from "@/lib/data/asset-map";
import type { AssetMapDestination, AssetMapDestinationsView } from "@/lib/data/asset-map-destinations";
import { OperationsReadView } from "@/components/asset-mapping/workspace/OperationsReadView";
import {
  DestinationsPanel,
  ExportCsvButton,
  TransferTargetControl,
} from "@/components/asset-mapping/workspace/destinations/DestinationsPanel";
import { initialDestinationState, type DestinationState } from "@/components/asset-mapping/workspace/destinations/destination-model";

const D1 = "22222222-2222-4222-8222-222222222222";
const D2 = "33333333-3333-4333-8333-333333333333";
const L1 = "44444444-4444-4444-8444-444444444444";
const L2 = "55555555-5555-4555-8555-555555555555";
const ACC = "66666666-6666-4666-8666-666666666666";

function position(id: string, extra: Partial<AssetMapPositionView> = {}): AssetMapPositionView {
  return {
    id, symbol: `SYN${id.toUpperCase()}`, description: "Synthetic Fund", assetType: "ETF", quantity: 10, marketValue: 100,
    transferEligible: "ACAT", effectiveStatus: null, transferNotes: null, effectiveNotes: null,
    costBasis: 50, costBasisGranularity: "position", transferring: null, lots: [], ...extra,
  };
}

function account(id: string, extra: Partial<AssetMapAccountView> = {}): AssetMapAccountView {
  return {
    id, custodian: "Synthetic Custodian", accountType: "Individual", accountTypeOther: null,
    accountNumberMasked: "••••1234", accountHolder: "Synthetic Client A", statementDate: "2026-09-01",
    statementAgeDays: 5, isStale: false, totalValue: 100, isRollover: false, isInherited: false,
    inheritedNotes: null, apexRestriction: null, costBasisStatus: null, validationStatus: null,
    validationIssues: [], custodianIntel: null, positions: [position(`${id}p`)], ...extra,
  };
}

function household(accounts: AssetMapAccountView[]): AssetMapHouseholdView {
  return { id: "hh-1", clientName: "Synthetic Client A", processedAt: null, docsTotal: null, docsExtracted: null, accounts };
}

function destination(id: string, extra: Partial<AssetMapDestination> = {}): AssetMapDestination {
  return {
    id, owner: "Synthetic Owner", targetAccountType: "Individual", existingApexNumber: null, needsToBeOpened: true,
    existingCount: 0, suggestedApexNumber: null, sources: [], ...extra,
  };
}

const SOURCE_L1 = { linkId: L1, custodian: "Synthetic Custodian", accountNumberMasked: "••••••••1234", accountId: ACC };
const SOURCE_L2 = { linkId: L2, custodian: "Other Custodian", accountNumberMasked: "••••5678", accountId: null };

function view(destinations: AssetMapDestination[]): AssetMapDestinationsView {
  return { destinations, accountNumbers: { [ACC]: "••••••••1234" }, overriddenPositionIds: [] };
}

const TWO = view([
  destination(D1, { sources: [SOURCE_L1] }),
  destination(D2, { owner: "Synthetic Second", targetAccountType: "Roth IRA", existingApexNumber: "SYN00001", needsToBeOpened: false, existingCount: 1, sources: [SOURCE_L2] }),
]);

function state(extra: Partial<DestinationState> = {}): DestinationState {
  return { ...initialDestinationState(), status: "loaded", view: TWO, ...extra };
}

const noop = () => {};
const panel = (s: DestinationState, defaultAdding?: boolean) =>
  renderToStaticMarkup(createElement(DestinationsPanel, { state: s, onSave: noop, onRetry: noop, defaultAdding }));

function selectHtml(html: string, label: string): string[] {
  return [...html.matchAll(new RegExp(`<select aria-label="${label}"[^>]*>(.*?)</select>`, "g"))].map((m) => m[1]);
}

describe("asset-mapping destinations rendering", () => {
  it("shows the heading, count line, add button, and suggestion note", () => {
    const html = panel(state());
    expect(html).toContain("Accounts to be opened at Apex");
    expect(html).toContain("2 destinations · 1 to open");
    expect(html).toContain("+ Add new account");
    expect(html).toContain("Suggestions checked against each owner&#x27;s open accounts at Apex");
  });

  it("the accounts-to-be-opened section is a disclosure that starts collapsed, with the heading and count line in its summary", () => {
    const html = panel(state());
    expect(html).toMatch(/^<details class="[^"]*disclosure[^"]*" data-section="destinations"><summary/);
    expect(html).not.toMatch(/^<details[^>]*\bopen\b/);
    expect(html).toMatch(/<summary[^>]*><strong>Accounts to be opened at Apex<\/strong><span[^>]*>2 destinations · 1 to open<\/span><\/summary>/);
  });

  it("shows each destination with its owner, type control, tag, and needs-to-be-opened control", () => {
    const html = panel(state());
    expect(html).toContain("Synthetic Owner ·");
    expect(html).toContain("Synthetic Second ·");
    const types = selectHtml(html, "Account type to open");
    expect(types).toHaveLength(2);
    expect(types[0]).toContain('<option value="Individual" selected="">Individual</option>');
    expect(types[1]).toContain('<option value="Roth IRA" selected="">Roth IRA</option>');
    expect(html).toContain("new account");
    expect(html).toContain("existing · SYN00001");
    const needs = selectHtml(html, "Needs to be opened\\?");
    expect(needs).toHaveLength(2);
    expect(needs[0]).toContain('<option value="yes" selected="">Yes — new account</option>');
    expect(needs[1]).toContain('<option value="no" selected="">No — use existing</option>');
  });

  it("shows existing-found and new-suggested Apex text", () => {
    const html = panel(state());
    expect(html).toContain("Existing Roth IRA account found — SYN00001");
    expect(html).toContain("No open Individual account for Synthetic Owner — suggest opening a new one");
  });

  it("shows each source with its custodian, masked number, and a move control listing the other destinations and New account", () => {
    const html = panel(state());
    expect(html).toContain("Synthetic Custodian");
    expect(html).toContain("••••••••1234");
    expect(html).toContain("fed by 1 source account");
    const moves = selectHtml(html, "Move to destination");
    expect(moves).toHaveLength(2);
    expect(moves[0]).toContain(`<option value="${D2}">Synthetic Second · Roth IRA</option>`);
    expect(moves[0]).not.toContain(`value="${D1}"`);
    expect(moves[0]).toContain("+ New account…");
    expect(moves[1]).toContain(`<option value="${D1}">Synthetic Owner · Individual</option>`);
    expect(moves[1]).not.toContain(`value="${D2}"`);
  });

  it("shows the add form with Owner name, the eight types, and Add", () => {
    const html = panel(state(), true);
    expect(html).toContain('placeholder="Owner name"');
    const types = selectHtml(html, "New account type");
    expect(types).toHaveLength(1);
    expect(types[0].match(/<option /g)).toHaveLength(8);
    expect(types[0]).toContain('<option value="Individual" selected="">Individual</option>');
    expect(html).toMatch(/<button type="submit"[^>]*>Add<\/button>/);
  });

  it("shows the empty text when there are no destinations", () => {
    const html = panel(state({ view: view([]) }));
    expect(html).toContain("No destinations yet — they auto-seed when the client is scanned.");
    expect(html).toContain("0 destinations · 0 to open");
  });

  it("pending controls show Saving…", () => {
    const html = panel(state({ pending: [`type:${D1}`, "add"] }));
    expect(html).toContain('aria-busy="true">Saving…</span>');
    expect(selectHtml(html, "Account type to open")).toHaveLength(1);
    expect(html).not.toContain("+ Add new account");
  });

  it("a failed save leaves the control in place and shows the failure text", () => {
    const html = panel(state({ failure: { key: `type:${D1}`, text: "Failed to update destination", seq: 1 } }));
    const types = selectHtml(html, "Account type to open");
    expect(types).toHaveLength(2);
    expect(types[0]).toContain('<option value="Individual" selected="">Individual</option>');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Failed to update destination");
  });

  it("shows the load error with Try Again when the destinations read fails", () => {
    const html = panel({ ...initialDestinationState(), status: "failed" });
    expect(html).toContain("Destinations could not be loaded.");
    expect(html).toContain("Try Again");
    expect(html).not.toContain("+ Add new account");
  });

  it("the operations view renders the destinations section and Transfers to only when passed (flag off or staff shows neither)", () => {
    const h = household([account(ACC)]);
    const base = {
      household: h, liveExtras: null, collapsedAccounts: [], expandedLots: [],
      onToggleAccount: noop, onToggleLots: noop,
    };
    const without = renderToStaticMarkup(createElement(OperationsReadView, base));
    expect(without).not.toContain("Accounts to be opened at Apex");
    expect(without).not.toContain('aria-label="Transfers to"');
    expect(renderToStaticMarkup(createElement(OperationsReadView, { ...base, destinations: null, accountTransfer: undefined }))).toBe(without);
    const s = state();
    const withProps = renderToStaticMarkup(createElement(OperationsReadView, {
      ...base,
      destinations: createElement(DestinationsPanel, { state: s, onSave: noop, onRetry: noop }),
      accountTransfer: (acc: AssetMapAccountView) => createElement(TransferTargetControl, { account: acc, state: s, onSave: noop }),
    }));
    expect(withProps).toContain("Accounts to be opened at Apex");
    expect(withProps).toContain('aria-label="Transfers to"');
    expect(withProps.indexOf("Liquidate")).toBeLessThan(withProps.indexOf("Accounts to be opened at Apex"));
    expect(withProps.indexOf("Accounts to be opened at Apex")).toBeLessThan(withProps.indexOf('aria-label="Transfers to"'));
  });

  it("Transfers to lists every destination with the current one selected and New account", () => {
    const html = renderToStaticMarkup(createElement(TransferTargetControl, { account: account(ACC), state: state(), onSave: noop }));
    const options = selectHtml(html, "Transfers to");
    expect(options).toHaveLength(1);
    expect(options[0]).toContain(`<option value="${D1}" selected="">Synthetic Owner · Individual</option>`);
    expect(options[0]).toContain(`<option value="${D2}">Synthetic Second · Roth IRA (SYN00001)</option>`);
    expect(options[0]).toContain("+ New account…");
    const unmatched = renderToStaticMarkup(createElement(TransferTargetControl, { account: account("other-account"), state: state(), onSave: noop }));
    expect(unmatched).toBe("");
  });

  it("Export CSV is disabled until destinations load", () => {
    const off = renderToStaticMarkup(createElement(ExportCsvButton, { ready: false, onExport: noop }));
    const on = renderToStaticMarkup(createElement(ExportCsvButton, { ready: true, onExport: noop }));
    expect(off).toContain('disabled=""');
    expect(off).toContain("Export CSV");
    expect(on).not.toContain("disabled");
    expect(on).toContain("Export CSV");
  });
});
