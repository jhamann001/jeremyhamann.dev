import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetMapHouseholdView, AssetMapRunSummary } from "@/lib/data/asset-map";
import type { WorkspaceState } from "@/components/asset-mapping/workspace/workspace-model";

const m = vi.hoisted(() => ({ initial: vi.fn(), docAlert: null as { householdId: string | null; text: string } | null }));
vi.mock("@/app/(authenticated)/asset-mapping/actions", () => ({
  loadAssetMapHousehold: vi.fn(), loadAssetMapHouseholdList: vi.fn(), loadAssetMapHouseholdLiveExtras: vi.fn(),
  loadAssetMapSchedule: vi.fn(), loadAssetMapDriveSaveReviewer: vi.fn(),
  saveAssetMapPositionStatus: vi.fn(), saveAssetMapPositionTransferring: vi.fn(), saveAssetMapAccountType: vi.fn(),
  removeAssetMapPosition: vi.fn(), restoreAssetMapPosition: vi.fn(), removeAssetMapAccount: vi.fn(), restoreAssetMapAccount: vi.fn(),
  loadAssetMapDestinations: vi.fn(), addAssetMapDestination: vi.fn(), setAssetMapDestinationNeedsOpen: vi.fn(),
  setAssetMapDestinationType: vi.fn(), removeAssetMapDestination: vi.fn(), reassignAssetMapSource: vi.fn(),
  applyClientLink: vi.fn(), loadClientLinkBatch: vi.fn(), loadClientLinkConfig: vi.fn(), loadClientLinkQueue: vi.fn(),
  loadRunClientLink: vi.fn(), previewClientLink: vi.fn(), previewClientLinkRevert: vi.fn(), retryClientLinkLookup: vi.fn(),
  searchClientDirectory: vi.fn(),
}));
vi.mock("@/components/asset-mapping/workspace/workspace-model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/asset-mapping/workspace/workspace-model")>();
  return { ...actual, initialWorkspaceState: (id: string | null) => m.initial(id) ?? actual.initialWorkspaceState(id) };
});
vi.mock("@/components/asset-mapping/workspace/documents/documents-model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/asset-mapping/workspace/documents/documents-model")>();
  return { ...actual, initialDocumentsState: () => ({ ...actual.initialDocumentsState(), alert: m.docAlert ?? actual.initialDocumentsState().alert }) };
});

import { AssetMappingWorkspace } from "@/components/asset-mapping/workspace/AssetMappingWorkspace";
import { initialWorkspaceState, workspaceReducer } from "@/components/asset-mapping/workspace/workspace-model";
import {
  CompletionPill, DocumentAlert, DriveSavedNotice, HouseholdDocumentActions, RunScanControl, scanMessageTone,
} from "@/components/asset-mapping/workspace/documents/DocumentControls";
import { initialDocumentsState, scanMessageFor, type EffectiveReview } from "@/components/asset-mapping/workspace/documents/documents-model";

const RUN: AssetMapRunSummary = {
  id: "11111111-1111-4111-8111-111111111111", clientName: "Synthetic Client A", runNumber: null,
  processedAt: "2026-10-01T00:00:00.000Z", supersededBy: null, totalAccounts: 0, totalPositions: 0, status: "neutral",
};
const HOUSEHOLD: AssetMapHouseholdView = {
  id: RUN.id, clientName: "Synthetic Client A", processedAt: null, docsTotal: null, docsExtracted: null, accounts: [],
};
const NOT_CURRENT: EffectiveReview = { current: false, reviewedAt: null, reviewer: null };

function loadedState(view: WorkspaceState["view"] = "operations"): WorkspaceState {
  let s = workspaceReducer(initialWorkspaceState(RUN.id), { type: "listLoaded", runs: [RUN] });
  s = workspaceReducer(s, { type: "householdLoaded", household: HOUSEHOLD });
  s = workspaceReducer(s, { type: "liveExtrasLoaded", extras: { docResults: [], rolloverNotes: {} } });
  return { ...s, view };
}

function workspace(
  documents: { enabled: boolean; canOperate: boolean } | undefined,
  view: WorkspaceState["view"] = "operations",
  o: { railOpen?: boolean; canEditDestinations?: boolean } = {},
) {
  const s = loadedState(view);
  m.initial.mockReturnValue(o.railOpen ? workspaceReducer(s, { type: "toggleRail" }) : s);
  return renderToStaticMarkup(createElement(AssetMappingWorkspace, {
    initialRunId: RUN.id, canEdit: false, canLink: false, canEditDestinations: o.canEditDestinations ?? false, documents,
  }));
}


describe("household header processed date (ticket)", () => {
  const RUN_B: AssetMapRunSummary = { ...RUN, id: "22222222-2222-4222-8222-222222222222", processedAt: "2026-09-01T00:00:00.000Z" };
  const processed: AssetMapHouseholdView = { ...HOUSEHOLD, processedAt: "2026-10-01T00:00:00.000Z" };

  function header(runs: AssetMapRunSummary[]) {
    let s = workspaceReducer(initialWorkspaceState(RUN.id), { type: "listLoaded", runs });
    s = workspaceReducer(s, { type: "householdLoaded", household: processed });
    m.initial.mockReturnValue(s);
    return renderToStaticMarkup(createElement(AssetMappingWorkspace, {
      initialRunId: RUN.id, canEdit: false, canLink: false, canEditDestinations: false, documents: undefined,
    }));
  }

  it("the household header shows the processed date when the household has a single run", () => {
    const html = header([RUN]);
    expect(html).toContain('data-household-processed="">Processed 10/1/2026</span>');
    const identity = html.slice(html.indexOf('data-header-row="identity"'), html.indexOf('data-header-row="actions"'));
    expect(identity).toContain("Processed 10/1/2026");
  });

  it("the processed date appears once while the run switcher shows", () => {
    const html = header([RUN, RUN_B]);
    expect(html.split("10/1/2026").length - 1).toBe(1);
    expect(html).toContain('role="group" aria-label="Runs"');
    expect(html).not.toContain("data-household-processed");
  });
});

function actions(view: "operations" | "client-service", canOperate: boolean, review = NOT_CURRENT) {
  return renderToStaticMarkup(createElement(HouseholdDocumentActions, {
    view, canOperate, busy: initialDocumentsState().busy, review,
    onPdf: () => {}, onMarkCompleted: () => {}, onSaveToDrive: () => {},
  }));
}

beforeEach(() => {
  m.initial.mockReset();
  m.docAlert = null;
});

describe("asset-mapping documents rendering", () => {
  it("the household header puts name, completion and value on one row and view, Export menu and Mark as Completed on the next", () => {
    const html = workspace({ enabled: true, canOperate: true });
    const identity = html.slice(html.indexOf('data-header-row="identity"'), html.indexOf('data-header-row="actions"'));
    expect(identity).toContain("<h1>Synthetic Client A</h1>");
    expect(identity).toContain('data-tone="neutral">Not completed</span>');
    expect(identity).toContain("Total Household Value");
    const actionsRow = html.slice(html.indexOf('data-header-row="actions"'));
    const order = ["Operations", 'data-menu="export"', "Copy link", "Export PDF", "Mark as Completed"].map((x) => actionsRow.indexOf(x));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(actionsRow).not.toContain("Save to Drive");
    expect(html).not.toContain(">Share</button>");
  });

  it("the Export menu holds Copy link, Export CSV and Export PDF, each only when its feature is on", () => {
    const menu = (html: string) => html.slice(html.indexOf('data-menu="export"'), html.indexOf("</details>", html.indexOf('data-menu="export"')));
    const all = menu(workspace({ enabled: true, canOperate: true }, "operations", { canEditDestinations: true }));
    expect(all).toMatch(/<summary[^>]*>Export<\/summary>/);
    expect(all.indexOf("Copy link")).toBeLessThan(all.indexOf("Export CSV"));
    expect(all.indexOf("Export CSV")).toBeLessThan(all.indexOf("Export PDF"));
    const off = menu(workspace({ enabled: false, canOperate: false }));
    expect(off).toContain("Copy link");
    expect(off).not.toContain("Export CSV");
    expect(off).not.toContain("Export PDF");
    expect(menu(workspace({ enabled: true, canOperate: true }, "client-service", { canEditDestinations: true }))).not.toContain("Export CSV");
  });

  it("client-service view puts Save to Drive where Mark as Completed sits", () => {
    const html = workspace({ enabled: true, canOperate: true }, "client-service");
    const actionsRow = html.slice(html.indexOf('data-header-row="actions"'));
    expect(actionsRow.indexOf("Save to Drive")).toBeGreaterThan(actionsRow.indexOf("</details>"));
    expect(html).not.toContain("Mark as Completed");
  });

  it("the schedule badge and Run scan sit on the section row above the household header", () => {
    const html = workspace({ enabled: true, canOperate: true });
    const bar = html.indexOf("data-section-bar");
    expect(bar).toBeGreaterThan(0);
    expect(html.indexOf(">Run scan</button>")).toBeGreaterThan(bar);
    expect(html.indexOf(">Run scan</button>")).toBeLessThan(html.indexOf("<h1>"));
    const flagsOff = workspace({ enabled: false, canOperate: false });
    expect(flagsOff).not.toContain("data-section-bar");
    expect(flagsOff).not.toContain("Not completed");
    expect(flagsOff).not.toContain("Run scan");
  });

  it("completion pill and document notices carry status tones", () => {
    expect(renderToStaticMarkup(createElement(CompletionPill, { review: NOT_CURRENT }))).toContain('data-tone="neutral">Not completed');
    expect(renderToStaticMarkup(createElement(CompletionPill, { review: { current: true, reviewedAt: "2026-10-04T17:00:00+00:00", reviewer: null } })))
      .toContain('data-tone="ok">Completed');
    expect(renderToStaticMarkup(createElement(CompletionPill, { review: { current: true, reviewedAt: null, reviewer: null } }))).toContain("Not completed");
    expect((["success", "warn", "error"] as const).map(scanMessageTone)).toEqual(["ok", "caution", "danger"]);
    const failed = renderToStaticMarkup(createElement(RunScanControl, {
      busy: false, message: scanMessageFor({ kind: "failed", status: 500, detail: "Scan failed." }), onRun: () => {}, onDismiss: () => {},
    }));
    expect(failed).toContain('data-variant="error" data-tone="danger"');
    const saved = renderToStaticMarkup(createElement(DriveSavedNotice, {
      notice: { householdId: RUN.id, filename: "Synthetic.pdf", webViewLink: "https://drive.example.test/f", reviewer: "ops.person@example.invalid" },
    }));
    expect(saved).toContain('data-tone="ok"');
    const css = readFileSync("components/asset-mapping/workspace/AssetMappingWorkspace.module.css", "utf8");
    expect(css).toMatch(/\.docAlert\s*\{[^}]*background:\s*var\(--status-danger-bg\)/);
  });

  it("client-service view shows Export PDF and Save to Drive", () => {
    const html = workspace({ enabled: true, canOperate: true }, "client-service");
    expect(html).toContain("Export PDF");
    expect(html).toContain("Save to Drive");
    expect(html).not.toContain("Mark as Completed");
  });

  it("client-service view shows the household PDF action for a signed-in user", () => {
    const html = actions("client-service", false);
    expect(html).toContain("Export PDF");
    expect(html).not.toContain("Save to Drive");
  });

  it("hides manual scan and Drive save when the user cannot operate", () => {
    for (const view of ["operations", "client-service"] as const) {
      const html = workspace({ enabled: true, canOperate: false }, view);
      expect(html).toContain("Export PDF");
      expect(html).not.toContain("Run scan");
      expect(html).not.toContain("Save to Drive");
      expect(html).not.toContain("Mark as Completed");
    }
  });

  it("Mark as Completed is disabled and shows the reviewer once the review is current", () => {
    const html = actions("operations", true, { current: true, reviewedAt: "2026-10-04T17:00:00+00:00", reviewer: "ops.person@example.invalid" });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Reviewed by ops\.person@example\.invalid"[^>]*>Reviewed by ops\.person at Oct 4, 1:00 PM<\/button>/);
  });

  it("the saved notice shows the filename, the reviewer, and Open in Drive", () => {
    const html = renderToStaticMarkup(createElement(DriveSavedNotice, {
      notice: { householdId: RUN.id, filename: "Synthetic_Client_A_report_2026-10-04_130000.pdf", webViewLink: "https://drive.example.test/f", reviewer: "ops.person@example.invalid" },
    }));
    expect(html).toContain('role="status"');
    expect(html).toContain("Saved to Drive");
    expect(html).toContain("Synthetic_Client_A_report_2026-10-04_130000.pdf");
    expect(html).toContain("Reviewed by ops.person@example.invalid");
    expect(html).toContain('<a href="https://drive.example.test/f" target="_blank" rel="noopener noreferrer">Open in Drive</a>');
  });

  it("a failure renders an alert, not the 5-second edit failure text", () => {
    const html = renderToStaticMarkup(createElement(DocumentAlert, { text: "Save to Drive failed (502)", onDismiss: () => {} }));
    expect(html).toMatch(/^<div role="alert" class="[^"]*docAlert[^"]*">/);
    expect(html).not.toContain("editError");
    expect(html).toContain("Save to Drive failed (502)");
    expect(html).toContain("Dismiss");
  });

  it("Run scan stays available after a failed scan and shows the failure text", () => {
    const html = renderToStaticMarkup(createElement(RunScanControl, {
      busy: false,
      message: scanMessageFor({ kind: "failed", status: 500, detail: "Scan failed. Check server logs for details." }),
      onRun: () => {}, onDismiss: () => {},
    }));
    expect(html).toContain("Scan failed. Check server logs for details.");
    expect(html).toMatch(/<button[^>]*title="Run Drive input folder scan now"[^>]*>Run scan<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*title="Run Drive input folder scan now"/);
  });

  it("while a scan is running, Run scan is disabled and shows the spinner", () => {
    const html = renderToStaticMarkup(createElement(RunScanControl, { busy: true, message: null, onRun: () => {}, onDismiss: () => {} }));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-busy="true"[^>]*title="Run Drive input folder scan now"[^>]*><span class="[^"]*scanSpinner[^"]*" aria-hidden="true"><\/span>Run scan<\/button>/);
    expect(html).not.toContain('role="status"');
  });

  it("Export All Clients PDF renders in the household list footer", () => {
    const html = workspace({ enabled: true, canOperate: true }, "operations", { railOpen: true });
    const rail = html.slice(html.indexOf("<aside"), html.indexOf("</aside>"));
    expect(rail).toMatch(/railFoot[^"]*"><button[^>]*>Export All Clients PDF<\/button>/);
  });

  it("the scan toolbar, the alert, and the Export All footer render with no household content", () => {
    m.docAlert = { householdId: null, text: "Export failed (502)" };
    m.initial.mockReturnValue(workspaceReducer(initialWorkspaceState(null), { type: "listLoaded", runs: [RUN] }));
    const html = renderToStaticMarkup(createElement(AssetMappingWorkspace, {
      initialRunId: null, canEdit: false, canLink: false, canEditDestinations: false, documents: { enabled: true, canOperate: true },
    }));
    const main = html.slice(html.indexOf("</aside>"));
    const empty = main.indexOf("Choose a client from the sidebar");
    expect(html).not.toContain("<h1>");
    expect(empty).toBeGreaterThan(0);
    expect(main.indexOf(">Run scan</button>")).toBeGreaterThan(0);
    expect(main.indexOf(">Run scan</button>")).toBeLessThan(empty);
    expect(main.indexOf('role="alert"')).toBeGreaterThan(main.indexOf(">Run scan</button>"));
    expect(main.indexOf('role="alert"')).toBeLessThan(empty);
    expect(main).toContain("Export failed (502)");
    const rail = html.slice(html.indexOf("<aside"), html.indexOf("</aside>"));
    expect(rail).toMatch(/railFoot[^"]*"><button[^>]*>Export All Clients PDF<\/button>/);
  });

  it("renders no documents control when the documents flag is off", () => {
    for (const documents of [undefined, { enabled: false, canOperate: true }]) {
      const html = workspace(documents);
      expect(html).toContain("Synthetic Client A");
      for (const text of ["Export PDF", "Export All Clients PDF", "Mark as Completed", "Save to Drive", "Run scan", 'role="alert"']) {
        expect(html).not.toContain(text);
      }
    }
  });
});

describe("read-only workspace for Advisor and Client Service (ticket)", () => {
  function readOnly(view: WorkspaceState["view"]) {
    m.initial.mockReset();
    m.initial.mockReturnValue(workspaceReducer(loadedState(view), { type: "toggleRail" }));
    return renderToStaticMarkup(createElement(AssetMappingWorkspace, {
      initialRunId: RUN.id, canOperate: false, canEdit: false, canLink: false, canEditDestinations: false,
      documents: { enabled: true, canOperate: false },
    }));
  }

  it("shows only the Client Service view with no view toggle, even if the state says Operations", () => {
    for (const view of ["operations", "client-service"] as const) {
      const html = readOnly(view);
      expect(html).toContain('data-view-label="client-service">Client Service</span>');
      expect(html).not.toContain("aria-pressed");
      expect(html).not.toContain(">Operations</button>");
      expect(html).toBe(readOnly("client-service"));
    }
  });

  it("keeps both PDFs and hides Run scan, Mark as Completed, Save to Drive and the spreadsheet export", () => {
    const html = readOnly("operations");
    expect(html).toContain("Export PDF");
    expect(html).toMatch(/railFoot[^"]*"><button[^>]*>Export All Clients PDF<\/button>/);
    for (const text of ["Run scan", "Mark as Completed", "Save to Drive", "Export CSV"]) {
      expect(html).not.toContain(text);
    }
  });

  it("Operations keeps the toggle and the operations controls", () => {
    const html = workspace({ enabled: true, canOperate: true });
    expect(html).toContain(">Operations</button>");
    expect(html).toContain(">Client Service</button>");
    expect(html).not.toContain("data-view-label");
    expect(html).toContain("Run scan");
  });
});
