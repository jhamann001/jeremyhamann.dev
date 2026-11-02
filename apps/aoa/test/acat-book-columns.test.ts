import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data/custodian-library", () => ({
  getCustodianLibrary: vi.fn(),
  CustodianLibraryError: class CustodianLibraryError extends Error {},
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), redirect: vi.fn() }));
vi.mock("@/lib/data/acat-status", () => ({ writeAcatBookRecord: vi.fn(), readAcatMachine: vi.fn() }));
vi.mock("@/lib/data/acat-workspace", () => ({ markAcatBookStale: vi.fn() }));
vi.mock("@/app/(authenticated)/asset-transfer/acat-lane-actions", () => ({ loadUnlinkedAcatDetail: vi.fn() }));
vi.mock("@/app/(authenticated)/acat-tracking/actions", () => ({ unlinkAcatFromExistingTransfer: vi.fn() }));
vi.mock("@/components/transfers/TransferPreparationPanel", () => ({ TransferPreparationPanel: () => null }));
vi.mock("@/components/transfers/AcatLinkPicker", () => ({ AcatLinkPicker: () => null }));
vi.mock("@/components/transfers/AcatStatusCard", () => ({ AcatStatusCard: () => null }));

import { AcatBookColumnsList, AcatBookView } from "@/components/transfers/AcatBookView";
import {
  ACAT_BOOK_COLUMNS_KEY_PREFIX,
  ACAT_BOOK_PREFS_KEY_PREFIX,
  TRANSFER_TRACKER_COLUMNS,
  TRANSFER_TRACKER_DEFAULT_COLUMNS,
  filterTrackerColumns,
  loadAcatBookColumns,
  mapAcatBookRow,
  parseAcatBookColumns,
  resetTrackerColumns,
  saveAcatBookColumns,
  toggleTrackerColumn,
  trackerCellText,
  type AcatBookRow,
} from "@/lib/data/acat-book";
import { acatBookColumnsEnabled } from "@/lib/flags";

const SUITE = "acat-book-columns";
const SHOW = "SHOW_ACAT_BOOK_COLUMNS_TKT311";
const EPIC = "EPIC_ACAT_BOOK_DAY_TO_DAY_ACTIONS_TKT302";
const DAY_SHOW = "SHOW_ACAT_BOOK_DAY_TO_DAY_ACTIONS_TKT302";
const SCOPE = "ops@example.test";

const DEFAULT_LABELS = [
  "Client", "Status", "Contra", "Direction", "Advisor", "Control #", "Apex Acct", "Statement Amount",
  "ACAT Reference Date", "Days Open", "Assets", "Issues", "Recon",
];

const CATALOG_LABELS = [
  "ID", "Cedar Ridge User ID", "Cedar Ridge User IDs", "Needs client link", "Client", "Status", "Contra", "Custodian",
  "Custodian ID", "Direction", "Type", "Account Type", "Method Requested", "Transfer Workflow", "Advisor", "CRW EE?",
  "Control #", "Associated Control #", "ACAT Transfer ID", "Apex Acct", "Statement Account #", "Statement Amount",
  "DTCC #", "ACAT Reference Date", "Original Client Request Date", "Ops Submission Date to Apex", "Apex Completion Date",
  "Monitor for Residual", "Residual Follow-Up Date", "Last Updated", "Fee Charged", "Fee Amount", "Fee Memo",
  "Fee Request Submitted", "Fee Request Completed", "Fee Apex Ticket", "Fee Credit Req ID", "CRM Ticket",
  "CRM Deal ID", "Apex Ticket", "Rejection Reason", "Additional Resources", "Trade Request ID",
  "Trade Request Link", "Trade Instructions", "Notes", "Mapping Source", "Apex Source", "Deleted At",
  "Recon Completed At", "Days Open", "Assets", "Issues", "Recon", "Expected Completion", "Link",
];

function fakeStorage(seed: Record<string, string> = {}) {
  const items = new Map(Object.entries(seed));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
  };
}

function row(raw: Record<string, unknown>): AcatBookRow {
  const mapped = mapAcatBookRow(raw);
  if (!mapped) throw new Error("row did not map");
  return mapped;
}

function labelsOf(ids: readonly string[]): string[] {
  return ids.map((id) => TRANSFER_TRACKER_COLUMNS.find((c) => c.id === id)?.label ?? id);
}

function viewProps(over: Record<string, unknown> = {}) {
  return {
    rows: [row({ id: "r1", status: "Submitted", direction: "Out" })],
    linkedTransferIds: {}, linkedByRecordId: {}, userName: null, prefsScope: "synthetic",
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ACAT book tracker columns", () => {
  it("columns flag needs the show and epic flags", () => {
    vi.stubEnv(SHOW, "1");
    vi.stubEnv(EPIC, "1");
    expect(acatBookColumnsEnabled()).toBe(true);
    vi.stubEnv(DAY_SHOW, "0");
    expect(acatBookColumnsEnabled()).toBe(true);
    for (const name of [SHOW, EPIC]) {
      const other = name === SHOW ? EPIC : SHOW;
      for (const value of [undefined, "", "0", "true"]) {
        vi.unstubAllEnvs();
        vi.stubEnv(other, "1");
        vi.stubEnv(name, value);
        expect(acatBookColumnsEnabled(), `${name}=${String(value)}`).toBe(false);
      }
    }
    markCase(SUITE, "columns-flag");
  });

  it("default columns match the tracker set", () => {
    expect(labelsOf(parseAcatBookColumns(null))).toEqual(DEFAULT_LABELS);
    expect(parseAcatBookColumns('{"columns":["client"],"density":"compact"}')).toEqual([...TRANSFER_TRACKER_DEFAULT_COLUMNS]);
    expect(ACAT_BOOK_COLUMNS_KEY_PREFIX).not.toBe(ACAT_BOOK_PREFS_KEY_PREFIX);
    markCase(SUITE, "default-set");
  });

  it("catalog lists every tracker column and Link", () => {
    expect(TRANSFER_TRACKER_COLUMNS.map((c) => c.label)).toEqual(CATALOG_LABELS);
    expect(TRANSFER_TRACKER_COLUMNS.at(-1)?.label).toBe("Link");
    expect(TRANSFER_TRACKER_DEFAULT_COLUMNS).not.toContain("link");
    markCase(SUITE, "catalog");
  });

  it("column search narrows labels and reports no match", () => {
    expect(filterTrackerColumns("fee").map((c) => c.label)).toEqual([
      "Fee Charged", "Fee Amount", "Fee Memo", "Fee Request Submitted", "Fee Request Completed",
      "Fee Apex Ticket", "Fee Credit Req ID",
    ]);
    expect(filterTrackerColumns("  DTCC ").map((c) => c.label)).toEqual(["DTCC #"]);
    const html = renderToStaticMarkup(createElement(AcatBookColumnsList, { columns: [], query: "zzz", onToggle: () => undefined }));
    expect(html).toContain("No matching columns.");
    expect(html).not.toContain('type="checkbox"');
    markCase(SUITE, "column-search");
  });

  it("saved columns restore and toggle in tracker order", () => {
    const storage = fakeStorage();
    saveAcatBookColumns(storage, SCOPE, ["notes", "clientName"]);
    expect(loadAcatBookColumns(storage, SCOPE)).toEqual(["clientName", "notes"]);
    expect([...storage.items.keys()]).toEqual([`aoa.acat-book.columns.v1.${SCOPE}`]);
    expect(loadAcatBookColumns(storage, "other@example.test")).toEqual([...TRANSFER_TRACKER_DEFAULT_COLUMNS]);
    const viewSaved = fakeStorage({ [`aoa.acat-book.view.v1.${SCOPE}`]: '{"columns":["client"],"density":"compact"}' });
    expect(loadAcatBookColumns(viewSaved, SCOPE)).toEqual([...TRANSFER_TRACKER_DEFAULT_COLUMNS]);
    expect(parseAcatBookColumns(JSON.stringify(["notes", "clientName", "bogus"]))).toEqual(["clientName", "notes"]);
    expect(parseAcatBookColumns("[]")).toEqual([]);
    expect(parseAcatBookColumns("not json")).toEqual([...TRANSFER_TRACKER_DEFAULT_COLUMNS]);
    expect(toggleTrackerColumn(["clientName", "notes"], "status")).toEqual(["clientName", "status", "notes"]);
    expect(toggleTrackerColumn(["clientName", "notes"], "notes")).toEqual(["clientName"]);
    markCase(SUITE, "saved-set");
  });

  it("reset restores the default columns", () => {
    const reset = resetTrackerColumns();
    expect(reset).toEqual([...TRANSFER_TRACKER_DEFAULT_COLUMNS]);
    expect(reset).not.toBe(TRANSFER_TRACKER_DEFAULT_COLUMNS);
    const storage = fakeStorage();
    saveAcatBookColumns(storage, SCOPE, ["notes"]);
    saveAcatBookColumns(storage, SCOPE, resetTrackerColumns());
    expect(loadAcatBookColumns(storage, SCOPE)).toEqual([...TRANSFER_TRACKER_DEFAULT_COLUMNS]);
    const html = renderToStaticMarkup(createElement(AcatBookView, viewProps({ columnsEnabled: true })));
    expect(html).toContain('title="Reset to default columns"');
    expect(html).toContain("Search columns…");
    markCase(SUITE, "reset");
  });

  it("missing book values show the tracker empty text", () => {
    const empty = row({ id: "r1", status: "Submitted" });
    for (const column of [
      "daysOpen", "issueCount", "assetCount", "statementAmount", "originalClientRequestDate", "expectedCompletionDate",
      "needsClientLink", "reconStatus", "lastUpdated", "acatTransferId", "transferringContra",
    ] as const) {
      expect(trackerCellText(column, empty), column).toBe("—");
    }
    markCase(SUITE, "missing-values");
  });

  it("zero, false, and days open match the tracker", () => {
    const full = row({
      id: "r2", status: "Submitted", statementAmount: 5467768, lastActivityAt: "2026-07-01T15:00:00.000Z",
      custodianName: "Schwab", assetMap: { total: 0 }, issueCount: 0, needsClientLink: false, daysOpen: 12,
      originalClientRequestDate: "2026-06-30", feeAmount: "54677.68", residualMonitoringRequired: true,
      reconStatus: "Needs Review",
    });
    expect(trackerCellText("issueCount", full)).toBe("0");
    expect(trackerCellText("needsClientLink", full)).toBe("false");
    expect(trackerCellText("daysOpen", full)).toBe("12d");
    expect(trackerCellText("statementAmount", full)).toBe("$54,677.68");
    expect(trackerCellText("lastUpdated", full)).toBe("07-01-2026");
    expect(trackerCellText("originalClientRequestDate", full)).toBe("06-30-2026");
    expect(trackerCellText("feeAmount", full)).toBe("$54,677.68");
    expect(trackerCellText("residualMonitoringRequired", full)).toBe("true");
    expect(trackerCellText("assetCount", full)).toBe("0");
    expect(trackerCellText("transferringContra", full)).toBe("Schwab");
    expect(trackerCellText("reconStatus", full)).toBe("Needs Review");
    expect(trackerCellText("statementAmount", row({ id: "r3", statementAmount: 0 }))).toBe("—");
    markCase(SUITE, "zero-false-days");
  });

  it("columns on renders the tracker default headers", () => {
    const html = renderToStaticMarkup(createElement(AcatBookView, viewProps({ columnsEnabled: true })));
    expect(html).toContain('data-count="13"');
    expect(html).toContain(">OUT<");
    expect(html).toContain('<th scope="col">Days Open</th>');
    expect(html).toContain('<th scope="col">Recon</th>');
    expect(html).toContain('<th scope="col">Statement Amount</th>');
    expect(html).not.toContain('<th scope="col">Account</th>');
    expect(html).not.toContain('<th scope="col">Link</th>');
    expect(html).toContain(">Comfortable<");
    expect(html).toContain(">Compact<");
    expect(html).toContain('aria-label="View"');
    expect(html).not.toContain("<summary>Columns");
    expect(html).toContain("data-hue=");
    expect(html).not.toContain("<legend>Columns</legend>");
    markCase(SUITE, "columns-on");
  });

  it("columns menu overlays", () => {
    const css = readFileSync("components/transfers/AcatBookView.module.css", "utf8");
    const menuAt = css.indexOf(".columnMenu");
    expect(css.slice(menuAt, css.indexOf("}", menuAt))).toContain("position: absolute");
    const fitAt = css.indexOf(".columnHead .search");
    const fit = css.slice(fitAt, css.indexOf("}", fitAt));
    expect(fit).toContain("min-width: 0");
    expect(fit).toContain("width: 0");
    const resetFitAt = css.indexOf(".columnHead .action");
    expect(css.slice(resetFitAt, css.indexOf("}", resetFitAt))).toContain("flex-shrink: 0");
    expect(css.slice(css.indexOf(".search {"), css.indexOf("}", css.indexOf(".search {")))).toContain("min-width: 220px");
    const tsx = readFileSync("components/transfers/AcatBookView.tsx", "utf8");
    const start = tsx.indexOf("function closeColumnMenu");
    const body = tsx.slice(start, tsx.indexOf("}", start));
    expect(body).toContain("setColumnsOpen(false)");
    expect(body).not.toContain("saveColumns");
    const effectAt = tsx.indexOf('addEventListener("mousedown"');
    const effect = tsx.slice(tsx.lastIndexOf("useEffect", effectAt), tsx.indexOf("}, [columnsOpen]);", effectAt));
    expect(effect).toContain("mousedown");
    expect(effect).toContain("Escape");
    expect(effect).not.toContain("saveColumns");
    const html = renderToStaticMarkup(createElement(AcatBookView, viewProps({ columnsEnabled: true })));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-count="13"');
    expect(html).toContain("hidden");
    markCase(SUITE, "columns-menu-overlays");
  });

  it("columns off keeps today's view", () => {
    const html = renderToStaticMarkup(createElement(AcatBookView, viewProps()));
    expect(html).not.toContain("data-count=");
    expect(html).toContain("<legend>Columns</legend>");
    expect(html).toContain('<th scope="col">Account</th>');
    expect(html).toContain('<th scope="col">ACAT date</th>');
    expect(html).toContain('<th scope="col">Link</th>');
    expect(html).toContain("Density");
    expect(html).not.toContain("Search columns…");
    expect(html).not.toContain('<th scope="col">Days Open</th>');
    markCase(SUITE, "columns-off");
  });
});
