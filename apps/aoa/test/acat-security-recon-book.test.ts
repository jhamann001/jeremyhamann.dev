import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), write: vi.fn(), read: vi.fn(), stale: vi.fn(), revalidate: vi.fn(), library: vi.fn(), readBook: vi.fn(),
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
vi.mock("@/lib/data/acat-workspace", () => ({ markAcatBookStale: mocks.stale, readAcatBook: mocks.readBook }));
vi.mock("@/app/(authenticated)/asset-transfer/acat-lane-actions", () => ({ loadUnlinkedAcatDetail: vi.fn() }));
vi.mock("@/app/(authenticated)/acat-tracking/actions", () => ({ unlinkAcatFromExistingTransfer: vi.fn() }));
vi.mock("@/components/transfers/TransferPreparationPanel", () => ({ TransferPreparationPanel: () => null }));
vi.mock("@/components/transfers/AcatLinkPicker", () => ({ AcatLinkPicker: () => null }));
vi.mock("@/components/transfers/AcatStatusCard", () => ({ AcatStatusCard: () => null }));

import { AcatBookView } from "@/components/transfers/AcatBookView";
import { AcatBookData } from "@/components/transfers/AcatBookData";
import type { Identity } from "@/lib/data/types";
import type { AcatBookRow } from "@/lib/data/acat-book";

const SUITE = "acat-security-recon-book";
const FIXTURE = "test/fixtures/acat-security-recon-off.json";
const CAPTURE = process.env.TKT334_CAPTURE_GOLDEN === "1";

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

const DRAWER_ON = { transferDrawer: { admin: true } };

const CASES: Record<string, () => string> = {
  openEditable: () => render({ ...DRAWER_ON, editsEnabled: true, initialRecordId: "rec-open" }),
  openReadOnly: () => render({ ...DRAWER_ON, editsEnabled: false, initialRecordId: "rec-open" }),
  closed: () => render({ ...DRAWER_ON, editsEnabled: true }),
};

const captured: Record<string, string> = {};

function golden(): Record<string, string> {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, string>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readBook.mockResolvedValue({ rows: [], linkedTransferIds: {}, linkedByRecordId: {}, removedRows: null });
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

describe("flag-off markup with the transfer drawer on", () => {
  it("tkt334 off: the open drawer markup with the drawer on equals the baseline (edits on)", () => {
    check("openEditable", "tkt334 off: the open drawer markup with the drawer on equals the baseline (edits on)");
  });
  it("tkt334 off: the open drawer markup with the drawer on equals the baseline (edits off)", () => {
    check("openReadOnly", "tkt334 off: the open drawer markup with the drawer on equals the baseline (edits off)");
  });
  it("tkt334 off: the open drawer markup with the drawer on equals the baseline (no open record)", () => {
    check("closed", "tkt334 off: the open drawer markup with the drawer on equals the baseline (no open record)");
  });
});

const BOOK_ENV: Record<string, string> = {
  EPIC_ACAT_OPS_WORKSPACE_TKT290: "1",
  SHOW_ACAT_OPS_BOOK_TKT293: "1",
  EPIC_ACAT_TRANSFER_DRAWER_TKT319: "1",
  SHOW_ACAT_TRANSFER_DRAWER_TKT332: "1",
  EPIC_ACAT_SECURITY_RECON_TKT320: "1",
  SHOW_ACAT_SECURITY_RECON_TKT334: "1",
};

async function bookViewProps(): Promise<Record<string, unknown>> {
  const identity = { role: "ADMIN", email: "synthetic@example.test" } as unknown as Identity;
  const tree = await AcatBookData({ identity, userName: null, prefsScope: "synthetic" });
  const children = Children.toArray((tree as ReactElement<{ children: ReactNode }>).props.children);
  const view = children.find((c): c is ReactElement<Record<string, unknown>> => isValidElement(c) && c.type === AcatBookView);
  if (!view) throw new Error("AcatBookView element not found");
  return view.props;
}

describe("security recon mount", () => {
  it("tkt334 book: an omitted securityRecon prop renders the same markup as false", () => {
    const base = { ...DRAWER_ON, editsEnabled: true, initialRecordId: "rec-open" };
    const omitted = render(base);
    const explicitFalse = render({ ...base, securityRecon: false });
    expect(explicitFalse).toBe(omitted);
    expect(explicitFalse).toBe(golden().openEditable);
    expect(explicitFalse).not.toContain("acat-security-recon");
    markCase(SUITE, "tkt334 book: an omitted securityRecon prop renders the same markup as false");
  });

  it("tkt334 book: securityRecon true mounts the section under the shell", () => {
    const markup = render({ ...DRAWER_ON, editsEnabled: true, initialRecordId: "rec-open", securityRecon: true });
    const shell = markup.indexOf('data-testid="acat-transfer-shell"');
    const section = markup.indexOf('data-testid="acat-security-recon"');
    expect(shell).toBeGreaterThan(-1);
    expect(section).toBeGreaterThan(shell);
    expect(markup).toContain("Security Recon");
    expect(markup.split('data-testid="acat-security-recon"')).toHaveLength(2);
    const readOnly = render({ ...DRAWER_ON, editsEnabled: false, initialRecordId: "rec-open", securityRecon: true });
    expect(readOnly).toContain('data-testid="acat-security-recon"');
    expect(readOnly).not.toContain("Upload asset mapping CSV");
    markCase(SUITE, "tkt334 book: securityRecon true mounts the section under the shell");
  });

  it("tkt334 book: securityRecon true without an open record mounts nothing", () => {
    const markup = render({ ...DRAWER_ON, editsEnabled: true, securityRecon: true });
    expect(markup).toBe(golden().closed);
    expect(markup).not.toContain("acat-security-recon");
    markCase(SUITE, "tkt334 book: securityRecon true without an open record mounts nothing");
  });

  it("tkt334 book: AcatBookData passes securityRecon true only with the drawer and both new switches", async () => {
    for (const [key, value] of Object.entries(BOOK_ENV)) vi.stubEnv(key, value);
    const props = await bookViewProps();
    expect(props.securityRecon).toBe(true);
    expect(props.transferDrawer).toEqual({ admin: true });
    markCase(SUITE, "tkt334 book: AcatBookData passes securityRecon true only with the drawer and both new switches");
  });

  it("tkt334 book: AcatBookData passes false when any one of the four switches is off", async () => {
    expect((await bookViewProps()).securityRecon).toBe(false);
    for (const off of ["EPIC_ACAT_SECURITY_RECON_TKT320", "SHOW_ACAT_SECURITY_RECON_TKT334", "SHOW_ACAT_TRANSFER_DRAWER_TKT332", "SHOW_ACAT_OPS_BOOK_TKT293"]) {
      vi.unstubAllEnvs();
      for (const [key, value] of Object.entries(BOOK_ENV)) vi.stubEnv(key, key === off ? "0" : value);
      expect((await bookViewProps()).securityRecon, off).toBe(false);
    }
    markCase(SUITE, "tkt334 book: AcatBookData passes false when any one of the four switches is off");
  });
});
