import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), write: vi.fn(), read: vi.fn(), stale: vi.fn(), revalidate: vi.fn(), library: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/data/custodian-library", () => ({
  getCustodianLibrary: mocks.library,
  CustodianLibraryError: class CustodianLibraryError extends Error {},
}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), redirect: vi.fn() }));
vi.mock("@/lib/data/acat-status", () => ({
  writeAcatBookRecord: mocks.write, readAcatMachine: mocks.read,
}));
vi.mock("@/lib/data/acat-workspace", () => ({ markAcatBookStale: mocks.stale }));
vi.mock("@/app/(authenticated)/asset-transfer/acat-lane-actions", () => ({ loadUnlinkedAcatDetail: vi.fn() }));
vi.mock("@/app/(authenticated)/acat-tracking/actions", () => ({ unlinkAcatFromExistingTransfer: vi.fn() }));
vi.mock("@/components/transfers/TransferPreparationPanel", () => ({ TransferPreparationPanel: () => null }));
vi.mock("@/components/transfers/AcatLinkPicker", () => ({ AcatLinkPicker: () => null }));
vi.mock("@/components/transfers/AcatStatusCard", () => ({ AcatStatusCard: () => null }));

import { AcatBookView } from "@/components/transfers/AcatBookView";
import type { AcatBookRow } from "@/lib/data/acat-book";

const SUITE = "acat-book-drawer-off";
const FIXTURE = "test/fixtures/acat-book-drawer-off.json";
const CAPTURE = process.env.TKT332_CAPTURE_GOLDEN === "1";

function bookRow(over: Partial<AcatBookRow> = {}): AcatBookRow {
  const id = over.id ?? "rec-1";
  return {
    acatTransferId: id,
    clientName: "Client",
    controlNumber: null,
    direction: "In",
    type: "Full",
    accountType: "Brokerage",
    status: "Submitted",
    transferringContra: "Schwab",
    statementAmount: 1000,
    acatDate: "2026-07-10",
    lastActivityAt: "2026-07-10T00:00:00.000Z",
    apexAccountId: "****1111",
    statementAccountNumber: null,
    dtccNumber: null,
    assetMap: { total: null, mapped: null, unmapped: null, pending: null, expected: null },
    wealthAdvisor: null,
    crmDealId: null,
    tradeInstructionsBlank: false,
    notes: null,
    tradeInstructions: null,
    custodianName: "",
    textLoadError: null,
    feeCharged: null,
    feeRequestCompleted: null,
    hasIssue: false,
    removedAt: null,
    ...over,
    id,
  };
}

const ROWS = [
  bookRow({ id: "rec-open", clientName: "Open Client", status: "Submitted" }),
  bookRow({ id: "rec-done", clientName: "Done Client", status: "Completed" }),
  bookRow({ id: "rec-rej", clientName: "Rejected Client", status: "Rejected" }),
];

function props(over: Record<string, unknown> = {}) {
  return {
    rows: ROWS,
    linkedTransferIds: {},
    linkedByRecordId: {},
    userName: null,
    prefsScope: "synthetic",
    ...over,
  };
}

function render(over: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(AcatBookView, props(over)));
}

const CASES: Record<string, () => string> = {
  openEditable: () => render({ editsEnabled: true, dayToDayEnabled: true, initialRecordId: "rec-open" }),
  openReadOnly: () => render({ editsEnabled: false, dayToDayEnabled: true, initialRecordId: "rec-open" }),
  closed: () => render({ editsEnabled: true, dayToDayEnabled: true }),
};

const captured: Record<string, string> = {};

function golden(): Record<string, string> {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, string>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "synthetic@example.test" } });
});
afterEach(() => { vi.unstubAllEnvs(); });

function check(key: string, name: string) {
  const markup = CASES[key]();
  if (CAPTURE) {
    captured[key] = markup;
    mkdirSync("test/fixtures", { recursive: true });
    writeFileSync(FIXTURE, JSON.stringify({ ...captured }, null, 2) + "\n");
  } else {
    expect(markup).toBe(golden()[key]);
  }
  markCase(SUITE, name);
}

describe("flag-off book markup", () => {
  it("tkt332 off: the open editable book markup is unchanged", () => {
    check("openEditable", "tkt332 off: the open editable book markup is unchanged");
  });
  it("tkt332 off: the open read-only book markup is unchanged", () => {
    check("openReadOnly", "tkt332 off: the open read-only book markup is unchanged");
  });
  it("tkt332 off: the closed book markup is unchanged", () => {
    check("closed", "tkt332 off: the closed book markup is unchanged");
  });
  it("tkt332 off: a null drawer prop renders the same markup as an omitted one", () => {
    const base = { editsEnabled: true, dayToDayEnabled: true, initialRecordId: "rec-open" };
    const omitted = render(base);
    const explicitNull = render({ ...base, transferDrawer: null });
    expect(explicitNull).toBe(omitted);
    expect(explicitNull).not.toContain("Export CSV");
    expect(explicitNull).not.toContain("acat-transfer-shell");
    if (!CAPTURE) expect(explicitNull).toBe(golden().openEditable);
    markCase(SUITE, "tkt332 off: a null drawer prop renders the same markup as an omitted one");
  });
});
