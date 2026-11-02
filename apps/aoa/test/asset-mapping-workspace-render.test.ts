import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  AssetMapAccountView,
  AssetMapHouseholdLiveExtras,
  AssetMapHouseholdView,
  AssetMapPositionView,
  AssetMapRunSummary,
} from "@/lib/data/asset-map";
import { OperationsReadView } from "@/components/asset-mapping/workspace/OperationsReadView";
import { ClientServiceReadView } from "@/components/asset-mapping/workspace/ClientServiceReadView";
import { ConnectionErrorCard } from "@/components/asset-mapping/workspace/ConnectionErrorCard";
import { ScheduleBadge } from "@/components/asset-mapping/workspace/ScheduleBadge";
import { RunSwitcher } from "@/components/asset-mapping/workspace/RunSwitcher";
import { COPY } from "@/components/asset-mapping/workspace/workspace-model";
import { utcDateTimeLabel } from "@/lib/display-date";

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

type ViewOptions = {
  liveExtras?: AssetMapHouseholdLiveExtras | null;
  collapsedAccounts?: string[];
  expandedLots?: string[];
};

function props(h: AssetMapHouseholdView, o: ViewOptions = {}) {
  return {
    household: h,
    liveExtras: o.liveExtras ?? null,
    collapsedAccounts: o.collapsedAccounts ?? [],
    expandedLots: o.expandedLots ?? [],
    onToggleAccount: () => {},
    onToggleLots: () => {},
  };
}

const ops = (h: AssetMapHouseholdView, o?: ViewOptions) => renderToStaticMarkup(createElement(OperationsReadView, props(h, o)));
const cs = (h: AssetMapHouseholdView, o?: ViewOptions) => renderToStaticMarkup(createElement(ClientServiceReadView, props(h, o)));

function tile(html: string, label: string): string | undefined {
  return html.match(new RegExp(`${label}</div><div[^>]*>(\\d+)</div>`))?.[1];
}

describe("account card details render (ticket)", () => {
  it("a collapsed card keeps validation, rollover, inherited, and Apex warnings visible", () => {
    const a1 = account("a1", {
      validationStatus: "WARNING", validationIssues: ["synthetic issue"], isRollover: true, isInherited: true,
      inheritedNotes: "Synthetic beneficiary note", apexRestriction: "Synthetic restriction",
    });
    const html = ops(household([a1]), { collapsedAccounts: ["a1"] });
    expect(html).toContain("Extraction Validation Warning");
    expect(html).toContain("synthetic issue");
    expect(html).toContain(COPY.rolloverFallback);
    expect(html).toContain("Synthetic beneficiary note");
    expect(html).toContain("Apex Policy Engine Hard-Block");
    expect(html).not.toContain('data-scroll="horizontal"');
  });

  it("a collapsed card with no warnings renders only its header", () => {
    const html = ops(household([account("a1")]), { collapsedAccounts: ["a1"] });
    expect(html).toContain('data-expanded="false"');
    expect(html).not.toMatch(/class="[^"]*notice/);
  });

  it("the cost-basis banner names the securities with no basis", () => {
    const a1 = account("a1", {
      costBasisStatus: "PARTIAL",
      positions: [
        position("p1"),
        position("p2", { costBasis: null, lots: [] }),
        position("p3", { symbol: "CASH", description: "Cash", costBasis: null }),
      ],
    });
    const banner = "Cost basis missing for 1 of 2 securities: <strong>SYNP2</strong>";
    expect(ops(household([a1]))).toContain(banner);
    expect(ops(household([a1]), { collapsedAccounts: ["a1"] })).toContain(banner);
  });

  it("complete and tax-advantaged accounts show their cost-basis pills", () => {
    const html = ops(household([
      account("a1", { costBasisStatus: "COMPLETE" }),
      account("a2", { costBasisStatus: "NOT_APPLICABLE" }),
    ]));
    expect(html).toContain('data-tone="ok">Cost basis: complete</span>');
    expect(html).toContain('data-tone="neutral">Cost basis: n/a · tax-advantaged</span>');
  });

  it("an empty account holder shows Owner not identified", () => {
    expect(ops(household([account("a1", { accountHolder: null })]))).toContain("Owner not identified");
  });

  it("tax lots show long-term, short-term, and no label for free text", () => {
    const a1 = account("a1", {
      statementDate: "2026-09-01",
      positions: [position("p1", {
        lots: [
          { acquisitionDate: "2025-08-31", quantity: 2, costBasis: 40 },
          { acquisitionDate: "2025-09-01", quantity: 1, costBasis: 20 },
          { acquisitionDate: "Various", quantity: 1, costBasis: null },
        ],
      })],
    });
    const html = ops(household([a1]), { expandedLots: ["p1"] });
    expect(html).toContain("Acquired 2025-08-31 · 2 sh · basis $40.00 · long-term</li>");
    expect(html).toContain("Acquired 2025-09-01 · 1 sh · basis $20.00 · short-term</li>");
    expect(html).toContain("Acquired Various · 1 sh · basis —</li>");
  });

  it("run switcher shows each run's processed date once", () => {
    const runs: AssetMapRunSummary[] = [0, 1].map((i) => ({
      id: `run-${i}`, clientName: "Synthetic Client A", runNumber: 2 - i, processedAt: `2026-09-0${i + 1}T00:00:00.000Z`,
      supersededBy: null, totalAccounts: 1, totalPositions: 2, status: "ok",
    }));
    const html = renderToStaticMarkup(createElement(RunSwitcher, { runs, selectedId: "run-0", onSelect: () => {} }));
    expect(html.split("9/1/2026").length - 1).toBe(1);
    expect(html.split("9/2/2026").length - 1).toBe(1);
  });
});

describe("asset-mapping workspace rendering", () => {
  it("operations view shows status tiles, staleness, DTCC, ACAT timeline, routing notes, Apex hard-block, and inherited copy", () => {
    const html = ops(household([account("a1", {
      isStale: true, statementAgeDays: 12, isInherited: true, apexRestriction: "Synthetic restriction",
      custodianIntel: { dtccNumber: "0123", acatTimeline: "Synthetic 5-7 business days" },
      positions: [
        position("p1", { effectiveNotes: "Synthetic routing note" }),
        position("p2"),
        position("p3", { transferEligible: "REVIEW" }),
        position("p4", { transferEligible: "UNSUPPORTED" }),
        position("p5", { transferEligible: "LIQUIDATE" }),
      ],
    })]));
    expect(tile(html, "Total Positions")).toBe("5");
    expect(tile(html, "ACAT Eligible")).toBe("2");
    expect(tile(html, "Manual Review")).toBe("1");
    expect(tile(html, "Unsupported")).toBe("1");
    expect(tile(html, "Liquidate")).toBe("1");
    expect(html).toContain("12d old");
    expect(html).toContain("DTCC: 0123");
    expect(html).toContain("Synthetic 5-7 business days");
    expect(html).toContain("Synthetic routing note");
    expect(html).toContain("Apex Policy Engine Hard-Block");
    expect(html).toContain(COPY.inheritedFallback);
  });

  it("operations view hides a collapsed account's positions and shows an expanded account's positions", () => {
    const html = ops(household([account("a1"), account("a2")]), { collapsedAccounts: ["a1"] });
    expect(html).not.toContain("SYNA1P");
    expect(html).toContain("SYNA2P");
  });

  it("each scanned account is collapsible as a whole: expanded by default, and collapsing hides its positions but keeps its header, total, and warnings", () => {
    const a1 = account("a1", { isInherited: true, apexRestriction: "Synthetic restriction", totalValue: 4321 });
    const open = ops(household([a1]));
    expect(open).toContain('data-account-card="" data-expanded="true"');
    expect(open).toMatch(/<button type="button" class="[^"]*accountHead[^"]*" aria-expanded="true" title="Collapse account">/);
    expect(open).toContain("Apex Policy Engine Hard-Block");
    const closed = ops(household([a1]), { collapsedAccounts: ["a1"] });
    expect(closed).toContain('data-expanded="false"');
    expect(closed).toMatch(/aria-expanded="false" title="Expand account">/);
    expect(closed).toContain("Synthetic Custodian");
    expect(closed).toContain("$4,321.00");
    expect(closed).toContain("Apex Policy Engine Hard-Block");
    expect(closed).toContain("Inherited / Beneficiary Account");
    expect(closed).not.toContain('data-scroll="horizontal"');
  });

  it("the document ingestion section is a disclosure that starts collapsed", () => {
    const html = ops(household([account("a1")], { docsTotal: 3, docsExtracted: 2 }));
    expect(html).toMatch(/<details class="[^"]*disclosure[^"]*" data-section="documents"><summary/);
    expect(html).not.toMatch(/data-section="documents"[^>]*\bopen\b/);
    expect(html).toMatch(/<summary[^>]*><strong>Document Ingestion — 3 total, 2 extracted<\/strong><\/summary>/);
  });

  it("the household rail fits inside the shell scroll area instead of the whole window", () => {
    const css = readFileSync("components/asset-mapping/workspace/AssetMappingWorkspace.module.css", "utf8");
    const rail = css.match(/(?:^|\n)\.rail\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rail).toMatch(/max-height:\s*calc\(100dvh - 112px\)/);
    expect(rail).not.toMatch(/max-height:\s*calc\(100v?h - 24px\)/);
    expect(rail).toMatch(/overflow-y:\s*auto/);
  });

  it("operations view shows tax lots only when the position's lots are expanded", () => {
    const h = household([account("a1", { positions: [position("p1", { lots: [{ acquisitionDate: "2020-01-02", quantity: 2, costBasis: 40 }] })] })]);
    const closed = ops(h);
    expect(closed).toContain("Show 1 tax lots");
    expect(closed).not.toContain("Tax lots (as printed on statement)");
    const open = ops(h, { expandedLots: ["p1"] });
    expect(open).toContain("Hide tax lots");
    expect(open).toContain("Tax lots (as printed on statement)");
    expect(open).toContain("Acquired 2020-01-02");
  });

  it("operations view wraps the position table in the horizontal scroll container", () => {
    expect(ops(household([account("a1")]))).toContain('data-scroll="horizontal"');
    const css = readFileSync("components/asset-mapping/workspace/AssetMappingWorkspace.module.css", "utf8");
    expect(css).toMatch(/\.tableScroll\s*\{[^}]*overflow-x:\s*auto/);
  });

  it("layout rules keep the rail narrow and sticky, header and run rows on one line, and the positions table dense", () => {
    const css = readFileSync("components/asset-mapping/workspace/AssetMappingWorkspace.module.css", "utf8");
    const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule(".rail")).toMatch(/flex:\s*0 0 240px/);
    expect(rule(".rail")).toMatch(/position:\s*sticky/);
    expect(rule(".railCollapsed")).toMatch(/position:\s*sticky/);
    expect(rule(".headerRow")).toMatch(/white-space:\s*nowrap/);
    expect(rule(".runs")).toMatch(/white-space:\s*nowrap/);
    expect(rule(".tiles")).toMatch(/repeat\(6, minmax\(0, 1fr\)\)/);
    expect(rule(".positions th")).toMatch(/padding:\s*6px 8px/);
    expect(rule(".positions td")).toMatch(/padding:\s*6px 8px/);
    expect(rule(".transferSelect")).toMatch(/min-width:\s*96px/);
  });

  it("operations view shows document ingestion rows and the live rollover note", () => {
    const html = ops(household([account("a1", { isRollover: true })], { docsTotal: 3, docsExtracted: 2 }), {
      liveExtras: {
        docResults: [
          { filename: "synthetic-statement.pdf", status: "extracted", reason: null, accountsExtracted: 1, positionsExtracted: 4 },
          { filename: "synthetic-rejected.pdf", status: "rejected", reason: "Synthetic reason", accountsExtracted: null, positionsExtracted: null },
        ],
        rolloverNotes: { a1: "Synthetic live rollover note" },
      },
    });
    expect(html).toContain("Document Ingestion — 3 total, 2 extracted");
    expect(html).toContain("synthetic-rejected.pdf");
    expect(html).toContain("rejected");
    expect(html).toContain("1 acct, 4 pos");
    expect(html).toContain("Synthetic live rollover note");
    expect(html).not.toContain(COPY.rolloverFallback);
  });

  it("client-service view always shows Transfer Readiness, Ready to ACAT, and Action Plan, and hides the conditional sections for a clean household", () => {
    const html = cs(household([account("a1")]));
    expect(html).toContain("Transfer Readiness");
    expect(html).toContain("% of the household value is ready for ACAT transfer.");
    expect(html).toContain("Ready to ACAT");
    expect(html).toContain("Action Plan (Exceptions &amp; Manual Items)");
    expect(html).not.toContain("Rollover Required");
    expect(html).not.toContain("Extraction Quality Notice");
    expect(html).not.toContain("Unsupported Accounts");
    expect(html).not.toContain("Documents Not Processed");
  });

  it("client-service view shows Rollover, Extraction Quality Notice, Unsupported, and Documents Not Processed when present", () => {
    const html = cs(household([
      account("roll", { isRollover: true }),
      account("warn", { validationStatus: "WARNING" }),
      account("apex", { apexRestriction: "Synthetic restriction" }),
    ]), {
      liveExtras: {
        docResults: [{ filename: "synthetic-rejected.pdf", status: "rejected", reason: "Synthetic reason", accountsExtracted: null, positionsExtracted: null }],
        rolloverNotes: {},
      },
    });
    expect(html).toContain("Rollover Required");
    expect(html).toContain("Requires Rollover");
    expect(html).toContain(COPY.rolloverFallback);
    expect(html).toContain("Extraction Quality Notice");
    expect(html).toContain("Unsupported Accounts");
    expect(html).toContain("Documents Not Processed");
    expect(html).toContain("synthetic-rejected.pdf");
  });

  it("client-service view lists accounts inside expanded Action Plan and Unsupported groups", () => {
    const h = household([
      account("act", { positions: [position("x1", { transferEligible: "REVIEW", symbol: "SYNREV" })] }),
      account("apex", { apexRestriction: "Synthetic restriction", positions: [position("x2", { transferEligible: "LIQUIDATE", symbol: "SYNLIQ" })] }),
    ]);
    const closed = cs(h);
    expect(closed).not.toContain("SYNREV");
    expect(closed).not.toContain("SYNLIQ");
    const open = cs(h, { collapsedAccounts: ["act", "apex"] });
    expect(open).toContain("Unsupported: Synthetic restriction");
    expect(open).toContain("SYNREV");
    expect(open).toContain("SYNLIQ");
  });

  it("connection error card shows Connection Error and Try Again", () => {
    const html = renderToStaticMarkup(createElement(ConnectionErrorCard, { onRetry: () => {} }));
    expect(html).toContain("<h2>Connection Error</h2>");
    expect(html).toContain("Try Again");
  });

  it("schedule badge shows Live with the interval and Asleep with the resume time", () => {
    const base = { scanIntervalMinutes: 15, businessDays: "Mon–Fri", businessHours: "8:00 AM – 7:00 PM ET" };
    expect(renderToStaticMarkup(createElement(ScheduleBadge, { schedule: { ...base, active: true } }))).toContain("Live · every 15 min");
    expect(renderToStaticMarkup(createElement(ScheduleBadge, { schedule: { ...base, active: false } }))).toContain("Asleep · resumes Mon–Fri 8:00 AM");
    expect(renderToStaticMarkup(createElement(ScheduleBadge, { schedule: null }))).toBe("");
  });

  it("routing statuses render with one distinct tone each and ACH/WIRE gets its own info tile", () => {
    const html = ops(household([account("a1", {
      positions: [
        position("p1"),
        position("p2", { transferEligible: "REVIEW" }),
        position("p3", { transferEligible: "LIQUIDATE" }),
        position("p4", { transferEligible: "UNSUPPORTED" }),
        position("p5", { transferEligible: "ACAT", effectiveStatus: "ACH/WIRE" }),
      ],
    })]));
    const pills = [...html.matchAll(/data-tone="([a-z]+)">(ACAT|REVIEW|LIQUIDATE|UNSUPPORTED|ACH\/WIRE)<\/span>/g)].map((x) => `${x[2]}=${x[1]}`);
    expect(pills).toEqual(["ACAT=ok", "REVIEW=caution", "LIQUIDATE=attention", "UNSUPPORTED=blocked", "ACH/WIRE=info"]);
    expect(tile(html, "ACH/WIRE")).toBe("1");
    expect(tile(html, "Total Positions")).toBe("5");
    const tiles = [...html.matchAll(/data-tone="([a-z]+)"><div[^>]*>([^<]+)<\/div>/g)].map((x) => `${x[2]}=${x[1]}`);
    expect(tiles).toEqual(["ACAT Eligible=ok", "Manual Review=caution", "Unsupported=blocked", "Liquidate=attention", "ACH/WIRE=info"]);
  });

  it("account notices carry their own tone: validation and inherited caution, rollover rollover, Apex blocked", () => {
    const html = ops(household([account("a1", {
      isRollover: true, isInherited: true, apexRestriction: "Synthetic restriction",
      validationStatus: "WARNING", validationIssues: ["synthetic issue"],
    })]));
    const notices = [...html.matchAll(/class="[^"]*notice[^"]*" data-tone="([a-z]+)">(?:<span[^>]*>([^<]+)<\/span>)?/g)].map((x) => `${x[2] ?? "rollover note"}=${x[1]}`);
    expect(notices).toEqual([
      "Extraction Validation Warning=caution",
      "rollover note=rollover",
      "Inherited / Beneficiary Account=caution",
      "Apex Policy Engine Hard-Block=blocked",
    ]);
    expect(html).toContain('data-tone="rollover">Rollover</span>');
    expect(html).toContain('data-tone="caution">WARNING</span>');
  });

  it("account header is a two-row grid spanning the card header: identity and value first, holder details and actions second", () => {
    const html = ops(household([account("a1", { custodianIntel: { dtccNumber: "0123", acatTimeline: "Synthetic 5-7 business days" } })]));
    const grid = html.slice(html.indexOf("data-account-grid"));
    const order = ["accountHead", "Synthetic Custodian", "accountValue", "$100.00", "accountMeta", "DTCC: 0123", "accountActions"].map((x) => grid.indexOf(x));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const css = readFileSync("components/asset-mapping/workspace/AssetMappingWorkspace.module.css", "utf8");
    expect(css).toMatch(/\.accountGrid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/);
    expect(css).toMatch(/\.accountGrid\s*\{[^}]*flex:\s*1 1 auto/);
    expect(css).toMatch(/\.accountValue\s*\{[^}]*justify-self:\s*end/);
  });

  it("schedule badge is an ok pill when Live and a neutral pill when Asleep", () => {
    const base = { scanIntervalMinutes: 15, businessDays: "Mon–Fri", businessHours: "8:00 AM – 7:00 PM ET" };
    expect(renderToStaticMarkup(createElement(ScheduleBadge, { schedule: { ...base, active: true } }))).toMatch(/data-tone="ok">.*Live · every 15 min/);
    expect(renderToStaticMarkup(createElement(ScheduleBadge, { schedule: { ...base, active: false } }))).toMatch(/data-tone="neutral">.*Asleep/);
  });

  it("run switcher shows one segment per run up to four runs and a Run select from five runs", () => {
    const runs = (n: number): AssetMapRunSummary[] => Array.from({ length: n }, (_, i) => ({
      id: `run-${i}`, clientName: "Synthetic Client A", runNumber: n - i, processedAt: `2026-09-0${i + 1}T00:00:00.000Z`,
      supersededBy: null, totalAccounts: 1, totalPositions: 2, status: "ok",
    }));
    const four = renderToStaticMarkup(createElement(RunSwitcher, { runs: runs(4), selectedId: "run-1", onSelect: () => {} }));
    expect(four.match(/<button type="button" class="[^"]*segment[^"]*" aria-pressed="(true|false)"/g)).toHaveLength(4);
    expect(four.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(four).not.toContain("<select");
    const five = renderToStaticMarkup(createElement(RunSwitcher, { runs: runs(5), selectedId: "run-1", onSelect: () => {} }));
    expect(five).toContain('<select aria-label="Run"');
    expect(five.match(/<option /g)).toHaveLength(5);
    expect(five).not.toContain("aria-pressed");
    expect(renderToStaticMarkup(createElement(RunSwitcher, { runs: runs(1), selectedId: "run-0", onSelect: () => {} }))).toBe("");
  });

  it("operations view shows the cost-basis pill and the extraction validation warning", () => {
    const html = ops(household([
      account("acc-a", {
        costBasisStatus: "PARTIAL", validationStatus: "WARNING", validationIssues: ["synthetic issue"],
        positions: [position("a1", { costBasis: 75 }), position("a2", { costBasis: null, lots: [] })],
      }),
      account("acc-b", { costBasisStatus: "MISSING" }),
      account("acc-c", { costBasisStatus: "COMPLETE", validationStatus: "PASS" }),
    ]));
    expect(html).toContain("Cost basis: partial · 1 missing");
    expect(html).toContain("Cost basis: missing");
    expect(html).toContain("Extraction Validation Warning");
    expect(html).toContain("synthetic issue");
    expect(html.split("Extraction Validation Warning").length - 1).toBe(1);
    expect(html).toContain('data-tone="ok">Cost basis: complete</span>');
  });
});

describe("manual account-type badge render (ticket)", () => {
  const AT = "2026-10-06T14:05:00.000Z";
  const when = utcDateTimeLabel(AT);

  it("an overridden account shows a manual badge with who and when in the card header, even collapsed (ticket)", () => {
    expect(when).toContain("10/6/2026");
    const h = household([account("a1", { accountTypeOverride: { by: "saver@example.invalid", at: AT } })]);
    for (const html of [ops(h), ops(h, { collapsedAccounts: ["a1"] })]) {
      expect(html).toContain('data-account-type-manual=""');
      expect(html).toContain(`Manual · saver@example.invalid · ${when}`);
      const grid = html.slice(html.indexOf("data-account-grid"));
      expect(grid.slice(0, grid.indexOf("</button>"))).toContain("data-account-type-manual");
    }
  });

  it("an override with no nameable person shows who-less manual badge (ticket)", () => {
    const html = ops(household([account("a1", { accountTypeOverride: { by: null, at: AT } })]));
    expect(html).toContain(`>Manual · ${when}<`);
    expect(html).not.toContain("Manual ·  ·");
  });

  it("an account with no override shows no manual badge (ticket)", () => {
    const html = ops(household([account("a1", { accountTypeOverride: null }), account("a2")]));
    expect(html).toContain('data-account-card=""');
    expect(html).not.toContain("data-account-type-manual");
  });
});

describe("client service summary (ticket)", () => {
  it("rollover account lists the first five assets to roll over, a more line, and its exceptions", () => {
    const assets = Array.from({ length: 7 }, (_, i) => position(`r${i + 1}`, { symbol: `SYNROLL${i + 1}` }));
    const html = cs(household([account("roll", {
      isRollover: true,
      positions: [...assets, position("rx", { transferEligible: "LIQUIDATE", symbol: "SYNROLLEX" })],
    })]));
    expect(html).toContain("Assets to roll over");
    for (let i = 1; i <= 5; i++) expect(html).toContain(`>SYNROLL${i}<`);
    expect(html).not.toContain(">SYNROLL6<");
    expect(html).not.toContain(">SYNROLL7<");
    expect(html).toContain("and 2 more");
    expect(html).toContain("Exceptions");
    expect(html).toContain(">SYNROLLEX<");
  });

  it("collapsed Action Plan row shows its position count and hides it when expanded", () => {
    const h = household([account("act", {
      positions: [position("x1", { transferEligible: "REVIEW" }), position("x2"), position("x3")],
    })]);
    expect(cs(h)).toContain("3 positions");
    expect(cs(household([account("one", { positions: [position("y1", { transferEligible: "REVIEW" })] })]))).toContain("1 position<");
    expect(cs(h, { collapsedAccounts: ["act"] })).not.toContain("3 positions");
  });

  it("expanded rows show their data-quality issues", () => {
    const issues = { validationStatus: "WARNING", validationIssues: ["Synthetic total mismatch"] };
    const h = household([
      account("warn", issues),
      account("apex", { ...issues, apexRestriction: "Synthetic restriction", validationIssues: ["Synthetic apex issue"] }),
    ]);
    const open = cs(h, { collapsedAccounts: ["warn", "apex"] });
    expect(open.split("Data quality issues").length - 1).toBe(2);
    expect(open).toContain("Synthetic total mismatch");
    expect(open).toContain("Synthetic apex issue");
    const closed = cs(h);
    expect(closed).not.toContain("Synthetic total mismatch");
    expect(closed).not.toContain("Synthetic apex issue");
    const roll = cs(household([account("roll", { ...issues, isRollover: true, validationIssues: ["Synthetic rollover issue"] })]));
    expect(roll).toContain("Synthetic rollover issue");
  });

  it("owner lines name the holder and show the empty-holder wording", () => {
    const html = cs(household([
      account("named"),
      account("blank", { accountHolder: "  ", isRollover: true }),
      account("none", { accountHolder: null, apexRestriction: "Synthetic restriction" }),
      account("act", { accountHolder: "", positions: [position("z1", { transferEligible: "REVIEW" })] }),
    ]));
    expect(html).toContain("Owner: Synthetic Client A");
    expect(html.split("Owner not identified").length - 1).toBe(3);
  });

  it("shows the all-assets-cleared cue only when every asset is cleared", () => {
    expect(cs(household([account("a1"), account("roll", { isRollover: true })]))).toContain("All assets cleared");
    expect(cs(household([account("a1"), account("act", { positions: [position("q1", { transferEligible: "REVIEW" })] })]))).not.toContain("All assets cleared");
    expect(cs(household([account("apex", { apexRestriction: "Synthetic restriction" })]))).not.toContain("All assets cleared");
    expect(cs(household([account("empty", { positions: [] })]))).not.toContain("All assets cleared");
  });

  it("readiness sentence states the rollover, needs-review, and unsupported account counts", () => {
    const html = cs(household([
      account("roll", { isRollover: true }),
      account("act1", { positions: [position("n1", { transferEligible: "REVIEW" })] }),
      account("act2", { validationStatus: "WARNING" }),
      account("apex", { apexRestriction: "Synthetic restriction" }),
    ]));
    expect(html).toContain("1 account requires rollover, 2 accounts need review, and 1 account is unsupported.");
    expect(cs(household([account("a1")]))).toContain("0 accounts require rollover, 0 accounts need review, and 0 accounts are unsupported.");
  });
});
