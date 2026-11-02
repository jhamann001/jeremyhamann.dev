import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AssetMapAccountView, AssetMapHouseholdView, AssetMapPositionView } from "@/lib/data/asset-map";
import { OperationsReadView, type OperationsEditProps } from "@/components/asset-mapping/workspace/OperationsReadView";
import { UndoBar } from "@/components/asset-mapping/workspace/edits/EditFeedback";
import { initialEditState, type EditState } from "@/components/asset-mapping/workspace/edits/edit-model";

const POS = "99999999-9999-4999-8999-999999999999";
const ACC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function position(id: string, extra: Partial<AssetMapPositionView> = {}): AssetMapPositionView {
  return {
    id, symbol: "SYNX", description: "Synthetic Fund", assetType: "ETF", quantity: 10, marketValue: 100,
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
    validationIssues: [], custodianIntel: null, positions: [position(POS)], ...extra,
  };
}

function household(accounts: AssetMapAccountView[] = [account(ACC)]): AssetMapHouseholdView {
  return { id: "hh-1", clientName: "Synthetic Client A", processedAt: null, docsTotal: null, docsExtracted: null, accounts };
}

function edits(state: Partial<EditState> = {}): OperationsEditProps {
  return {
    state: { ...initialEditState(), ...state },
    onEdit: () => {},
    onAskRemoveAccount: () => {},
    onAskAccountType: () => {},
    onConfirm: () => {},
    onCancel: () => {},
  };
}

function ops(h: AssetMapHouseholdView, e?: OperationsEditProps | null) {
  return renderToStaticMarkup(createElement(OperationsReadView, {
    household: h,
    liveExtras: null,
    collapsedAccounts: [],
    expandedLots: [],
    onToggleAccount: () => {},
    onToggleLots: () => {},
    edits: e,
  })).replace(/ class="[^"]*"/g, "");
}

describe("asset-mapping edit controls rendering", () => {
  it("with edits on, the account total stays the far-right header cell and the Override Account Type row gets its own full-width line", () => {
    const html = ops(household([account(ACC, { totalValue: 4321 })]), edits());
    const start = html.lastIndexOf("<div", html.indexOf("data-account-grid"));
    let depth = 0;
    let end = start;
    for (const tag of html.slice(start).matchAll(/<\/?div\b/g)) {
      depth += tag[0] === "<div" ? 1 : -1;
      if (depth === 0) { end = start + tag.index + "</div>".length; break; }
    }
    const grid = html.slice(start, end);
    const value = grid.indexOf("$4,321.00");
    const editRow = grid.indexOf("data-account-edit-row");
    expect(value).toBeGreaterThan(0);
    expect(editRow).toBeGreaterThan(value);
    expect(grid.indexOf('aria-label="Override Account Type"')).toBeGreaterThan(editRow);
    expect(html.slice(end).startsWith("</div>")).toBe(true);
    const css = readFileSync("components/asset-mapping/workspace/AssetMappingWorkspace.module.css", "utf8");
    expect(css).toMatch(/\.accountGrid > \.editRow\s*\{[^}]*grid-column:\s*1 \/ -1/);
    expect(css).toMatch(/\.accountGrid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/);
    expect(css).toMatch(/\.accountValue\s*\{[^}]*justify-self:\s*end/);
  });

  it("operations view hides edit controls when no edit props are passed (flag off or staff)", () => {
    const html = ops(household([account(ACC, { positions: [position(POS, { effectiveStatus: "LIQUIDATE", transferring: true })] })]));
    expect(html).not.toContain("<select");
    expect(html).not.toContain("Delete this position");
    expect(html).not.toContain('aria-label="Actions"');
    expect(html).toContain(">LIQUIDATE<");
    expect(html).toContain("<td>Yes</td>");
  });

  it("operations view with edits shows the status control with all five statuses and the saved one selected", () => {
    const html = ops(household([account(ACC, { positions: [position(POS, { effectiveStatus: "LIQUIDATE" })] })]), edits());
    expect(html).toContain('aria-label="Override Status"');
    for (const s of ["ACAT", "LIQUIDATE", "UNSUPPORTED", "REVIEW", "ACH/WIRE"]) expect(html).toContain(`<option value="${s}"`);
    expect(html).toContain('<option value="LIQUIDATE" selected="">');
  });

  it("operations view with edits shows the Transferring? control with Yes, No, and Clear", () => {
    const html = ops(household([account(ACC, { positions: [position(POS, { transferring: true })] })]), edits());
    expect(html).toContain('aria-label="Transferring?"');
    expect(html).toContain('<option value="YES" selected="">Yes</option>');
    expect(html).toContain('<option value="NO">No</option>');
    expect(html).toContain('<option value="CLEAR">Clear</option>');
  });

  it("operations view with edits shows the account type control with all 24 types", () => {
    const html = ops(household(), edits());
    const select = html.match(/<select aria-label="Override Account Type"[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? "";
    expect(select.match(/<option value="[^"]+"/g)).toHaveLength(24);
    expect(select).toContain('<option value="Other">Other…</option>');
    expect(select).toContain('<option value="Individual" selected="">Individual</option>');
  });

  it("operations view with edits shows Delete this position and Delete this account", () => {
    const html = ops(household(), edits());
    expect(html).toContain('title="Delete this position"');
    expect(html).toContain('title="Delete this account"');
    expect(html).toContain('aria-label="Actions"');
  });

  it("the status control is tinted by the tone of the selected status", () => {
    const tones = (["ACAT", "REVIEW", "LIQUIDATE", "UNSUPPORTED", "ACH/WIRE"] as const).map((status) => {
      const html = ops(household([account(ACC, { positions: [position(POS, { effectiveStatus: status })] })]), edits());
      return html.match(/<select aria-label="[^"]*" data-tone="([a-z]+)"/)?.[1];
    });
    expect(tones).toEqual(["ok", "caution", "attention", "blocked", "info"]);
  });

  it("Delete this account sits in the account overflow menu", () => {
    const html = ops(household(), edits());
    const menu = html.slice(html.indexOf('data-menu="account"'), html.indexOf("</details>", html.indexOf('data-menu="account"')));
    expect(menu).toContain('<summary aria-label="More account actions" title="More account actions">⋯</summary>');
    expect(menu).toContain("Delete this account");
    expect(ops(household())).not.toContain('data-menu="account"');
  });

  it("account removal confirmation shows the delete-and-undo question with Delete account and Cancel", () => {
    const html = ops(household(), edits({ confirm: { kind: "removeAccount", accountId: ACC, label: "Synthetic Custodian Individual" } }));
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("Delete &quot;Synthetic Custodian Individual&quot; and all its positions? You can undo this.");
    expect(html).toContain(">Delete account</button>");
    expect(html).toContain(">Cancel</button>");
  });

  it("account type confirmation shows the from and to types, the classified-again text, and Change type", () => {
    const html = ops(household(), edits({ confirm: { kind: "accountType", accountId: ACC, from: "Individual", accountType: "IRA", accountTypeOther: null } }));
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("Change account classification from &quot;Individual&quot; to &quot;IRA&quot;?");
    expect(html).toContain("This will re-run the rule engine for every position in this account. Manual position-level overrides will be preserved.");
    expect(html).toContain(">Change type</button>");
  });

  it("pending controls show Updating…, Saving…, and Reclassifying…", () => {
    const html = ops(household(), edits({
      pending: [`positionStatus:${POS}`, `positionTransferring:${POS}`, `accountType:${ACC}`],
    }));
    expect(html).toContain("Updating…");
    expect(html).toContain("Saving…");
    expect(html).toContain("Reclassifying…");
    expect(html).not.toContain('aria-label="Override Status"');
  });

  it("a failed save leaves the original control with the last saved value and shows the failure text", () => {
    const html = ops(
      household([account(ACC, { positions: [position(POS, { effectiveStatus: "ACAT" })] })]),
      edits({ failure: { key: `positionStatus:${POS}`, text: "Failed to update status", seq: 1 } }),
    );
    expect(html).toContain('aria-label="Override Status"');
    expect(html).toContain('<option value="ACAT" selected="">');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Failed to update status");
  });

  it("the Undo bar shows the deleted message and an Undo button", () => {
    const html = renderToStaticMarkup(createElement(UndoBar, { message: "Deleted position SYNX", onUndo: () => {} }));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Deleted position SYNX");
    expect(html).toContain(">Undo</button>");
  });

  it("a forbidden attempt shows the visible rejection text", () => {
    const html = ops(household(), edits({ failure: { key: `removeAccount:${ACC}`, text: "Operations role required", seq: 2 } }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Operations role required");
  });
});
