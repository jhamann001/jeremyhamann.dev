import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AssetMapAccountView, AssetMapHouseholdView, AssetMapPositionView } from "@/lib/data/asset-map";
import { OperationsReadView, type OperationsEditProps } from "@/components/asset-mapping/workspace/OperationsReadView";
import { ClientServiceReadView } from "@/components/asset-mapping/workspace/ClientServiceReadView";
import { initialEditState } from "@/components/asset-mapping/workspace/edits/edit-model";
import {
  granularityLabel,
  positionColumnCount,
  transferringLabel,
} from "@/components/asset-mapping/workspace/workspace-model";

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

function household(accounts: AssetMapAccountView[], extra: Partial<AssetMapHouseholdView> = {}): AssetMapHouseholdView {
  return { id: "hh-1", clientName: "Synthetic Client A", processedAt: null, docsTotal: null, docsExtracted: null, accounts, ...extra };
}

const LOTS = [
  { acquisitionDate: "2020-01-01", quantity: 5, costBasis: 25 },
  { acquisitionDate: "2021-01-01", quantity: 5, costBasis: 25 },
];

const EDITS: OperationsEditProps = {
  state: initialEditState(),
  onEdit: () => {},
  onAskRemoveAccount: () => {},
  onAskAccountType: () => {},
  onConfirm: () => {},
  onCancel: () => {},
};

function viewProps(h: AssetMapHouseholdView, expandedLots: string[] = []) {
  return {
    household: h, liveExtras: null, collapsedAccounts: [], expandedLots,
    onToggleAccount: () => {}, onToggleLots: () => {},
  };
}

const ops = (h: AssetMapHouseholdView, o: { expandedLots?: string[]; edits?: OperationsEditProps } = {}) =>
  renderToStaticMarkup(createElement(OperationsReadView, { ...viewProps(h, o.expandedLots), edits: o.edits }))
    .replace(/ class="[^"]*"/g, "")
    .replace(/colSpan=/g, "colspan=");

function headers(html: string): string[] {
  return [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((x) => x[1]);
}

describe("asset-mapping operations position columns", () => {
  it("operations position table shows the AC-111 columns, worded and ordered as the epic lists them", () => {
    const html = ops(household([account("a1")]));
    expect(headers(html)).toEqual([
      "Extracted Asset", "Shares", "Value", "Cost Basis", "Classification", "Rule Engine Status", "Transferring", "Routing Logic Applied",
    ]);
    expect(headers(ops(household([account("a1")]), { edits: EDITS })).slice(-2)).toEqual(["Routing Logic Applied", ""]);
  });

  it("omits the Cost Basis column for a NOT_APPLICABLE account, as the mapping app does", () => {
    const h = headers(ops(household([account("a1", { costBasisStatus: "NOT_APPLICABLE" })])));
    expect(h).toHaveLength(7);
    expect(h).not.toContain("Cost Basis");
  });

  it("cost basis shows the amount with the lot or position granularity marker", () => {
    const lot = ops(household([account("a1", { positions: [position("p1", { costBasis: 50, costBasisGranularity: "lot", lots: LOTS })] })]));
    expect(lot).toContain("$50.00");
    expect(lot).toContain("lot · 2");
    const pos = ops(household([account("a1", { positions: [position("p1", { costBasis: 50, costBasisGranularity: "position" })] })]));
    expect(pos).toMatch(/\$50\.00<span[^>]*>position<\/span>/);
  });

  it("a non-cash position with no cost basis shows not provided, and a cash position shows a dash", () => {
    const nonCash = ops(household([account("a1", { positions: [position("p1", { symbol: "SYNX", costBasis: null, lots: [] })] })]));
    expect(nonCash).toContain("not provided");
    const cash = ops(household([account("a1", { positions: [position("p1", { symbol: "CASH", costBasis: null, lots: [] })] })]));
    expect(cash).not.toContain("not provided");
    expect(cash).toContain("<td>—</td>");
  });

  it("Classification shows the asset type, or a dash when absent", () => {
    const html = ops(household([account("a1", {
      positions: [position("p1", { assetType: "Mutual Fund", transferring: true }), position("p2", { assetType: null, transferring: true })],
    })]));
    expect(html).toContain("<td>Mutual Fund</td>");
    expect(html).toMatch(/<td>—<\/td><td><span[^>]*>ACAT<\/span><\/td>/);
  });

  it("Transferring? is read-only without edits: Yes, No, or a dash", () => {
    const html = ops(household([account("a1", {
      positions: [
        position("p1", { transferring: true, effectiveNotes: "n1" }),
        position("p2", { transferring: false, effectiveNotes: "n2" }),
        position("p3", { transferring: null, effectiveNotes: "n3" }),
      ],
    })]));
    expect(html).not.toContain("<select");
    expect(html).toContain("<td>Yes</td><td>n1</td></tr>");
    expect(html).toContain("<td>No</td><td>n2</td></tr>");
    expect(html).toContain("<td>—</td><td>n3</td></tr>");
  });

  it("the lots row spans every column", () => {
    const withLots = (extra: Partial<AssetMapAccountView> = {}) =>
      household([account("a1", { positions: [position("p1", { lots: LOTS, costBasisGranularity: "lot" })], ...extra })]);
    expect(ops(withLots(), { expandedLots: ["p1"] })).toContain('colspan="8"');
    expect(ops(withLots({ costBasisStatus: "NOT_APPLICABLE" }), { expandedLots: ["p1"] })).toContain('colspan="7"');
    expect(ops(withLots(), { expandedLots: ["p1"], edits: EDITS })).toContain('colspan="9"');
  });

  it("Routing Logic Applied shows each position's routing notes inline, a dash when there are none, and no per-row toggle", () => {
    const h = household([account("a1", {
      positions: [
        position("p1", { effectiveNotes: "Synthetic route one", transferNotes: "Synthetic fallback" }),
        position("p2", { effectiveNotes: null, transferNotes: "Synthetic route two" }),
        position("p3", { effectiveNotes: null, transferNotes: null }),
      ],
    })]);
    const html = ops(h);
    const routing = [...html.matchAll(/<tr><td>[\s\S]*?<\/tr>/g)].map((row) => [...row[0].matchAll(/<td>([^<]*)<\/td>/g)].at(-1)?.[1]);
    expect(routing).toEqual(["Synthetic route one", "Synthetic route two", "—"]);
    expect(html).not.toContain("data-routing-detail");
    expect(html).not.toContain(">Routing</button>");
    expect(ops(h, { edits: EDITS })).toMatch(/<td>Synthetic route one<\/td><td><button/);
  });

  it("the client-service view keeps its list layout with no position columns", () => {
    const html = renderToStaticMarkup(createElement(ClientServiceReadView, viewProps(household([account("a1", {
      positions: [position("p1", { effectiveStatus: "REVIEW", transferring: true })],
    })]))));
    expect(html).not.toContain("Classification");
    expect(html).not.toContain("Transferring?");
    expect(html).not.toContain("<th");
  });

  it("column helpers cover every value", () => {
    expect(granularityLabel(position("p1", { costBasisGranularity: "lot", lots: LOTS }))).toBe("lot · 2");
    expect(granularityLabel(position("p1", { costBasisGranularity: "position" }))).toBe("position");
    expect(granularityLabel(position("p1", { costBasisGranularity: null }))).toBeNull();
    expect([transferringLabel(true), transferringLabel(false), transferringLabel(null)]).toEqual(["Yes", "No", "—"]);
    const applicable = account("a1");
    const notApplicable = account("a2", { costBasisStatus: "NOT_APPLICABLE" });
    expect([
      positionColumnCount(applicable, false),
      positionColumnCount(applicable, true),
      positionColumnCount(notApplicable, false),
      positionColumnCount(notApplicable, true),
    ]).toEqual([8, 9, 7, 8]);
  });
});
