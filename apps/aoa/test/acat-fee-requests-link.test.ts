import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const mocks = vi.hoisted(() => ({ readBook: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), redirect: vi.fn() }));
vi.mock("@/lib/data/acat-status", () => ({ writeAcatBookRecord: vi.fn(), readAcatMachine: vi.fn() }));
vi.mock("@/lib/data/custodian-library", () => ({
  getCustodianLibrary: vi.fn(),
  CustodianLibraryError: class CustodianLibraryError extends Error {},
}));
vi.mock("@/lib/data/acat-workspace", () => ({ readAcatBook: mocks.readBook, markAcatBookStale: vi.fn() }));
vi.mock("@/app/(authenticated)/asset-transfer/acat-lane-actions", () => ({ loadUnlinkedAcatDetail: vi.fn() }));
vi.mock("@/app/(authenticated)/acat-tracking/actions", () => ({ unlinkAcatFromExistingTransfer: vi.fn() }));
vi.mock("@/components/transfers/TransferPreparationPanel", () => ({ TransferPreparationPanel: () => null }));
vi.mock("@/components/transfers/AcatLinkPicker", () => ({ AcatLinkPicker: () => null }));
vi.mock("@/components/transfers/AcatStatusCard", () => ({ AcatStatusCard: () => null }));

import { AcatBookData } from "@/components/transfers/AcatBookData";
import { AcatBookView } from "@/components/transfers/AcatBookView";
import { canSeeUnlinkedAcats } from "@/lib/data/acat-lane";
import { canReadCustodianLibrary } from "@/lib/data/custodian-library-contract";
import type { Identity } from "@/lib/data/types";
import { canAccessOperationsTools } from "@/lib/operations/authorization";
import { acatFeeRequestsHref, acatReimbursementCreateEnabled, OPERATIONS_FEE_REQUESTS_HREF } from "@/lib/operations/fee-request-link";

const SUITE = "acat-fee-requests-link";
const HREF = "/operations/fee-requests";

// Release switches that make the Operations Tools fee-request page reachable (lib/flags.ts) and the
// drawer's own fee release (book, edits, both fee switches).
const DESTINATION: Record<string, string> = {
  APP_ENV: "prod", OPERATIONS_TOOLS: "1", OPERATIONS_FEE_REQUESTS: "1", OPERATIONS_PRODUCTION_ENABLED: "1",
};
const CREATE: Record<string, string> = { SHOW_ACAT_FEE_REQUEST_CREATE_TKT350: "1" };
const FEE_RELEASE: Record<string, string> = {
  EPIC_ACAT_OPS_WORKSPACE_TKT290: "1", SHOW_ACAT_OPS_BOOK_TKT293: "1", ALLOW_ACAT_OPS_EDITS_TKT294: "1",
  EPIC_ACAT_FEE_REIMBURSEMENT_TKT318: "1", SHOW_ACAT_FEE_REIMBURSEMENT_TKT333: "1",
};

function stub(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
}

function identity(role: string): Identity {
  return { role, email: "synthetic@example.test" } as unknown as Identity;
}

async function viewProps(role: string): Promise<Record<string, unknown>> {
  const tree = await AcatBookData({ identity: identity(role), userName: null, prefsScope: "synthetic", editsEnabled: true, feeEnabled: true });
  const children = Children.toArray((tree as ReactElement<{ children: ReactNode }>).props.children);
  const view = children.find((c): c is ReactElement<Record<string, unknown>> => isValidElement(c) && c.type === AcatBookView);
  if (!view) throw new Error("AcatBookView element not found");
  return view.props;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readBook.mockResolvedValue({ rows: [], linkedTransferIds: {}, linkedByRecordId: {}, removedRows: null });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("ACAT drawer link to Operations Tools fee requests (ticket)", () => {
  it("the link is the canonical Operations Tools fee-request route, with no parameters", () => {
    expect(OPERATIONS_FEE_REQUESTS_HREF).toBe(HREF);
    expect(existsSync("app/(authenticated)/operations/fee-requests/page.tsx")).toBe(true);
    expect(HREF).not.toMatch(/[?#]/);
    markCase(SUITE, "the link is the canonical Operations Tools fee-request route, with no parameters");
  });

  it("the helper returns the link only for roles and flags the destination page accepts", () => {
    stub(DESTINATION);
    for (const role of ["ADMIN", "OPERATIONS"]) expect(acatFeeRequestsHref(role), role).toBe(HREF);
    for (const role of ["ADVISOR", "VIEWER", "CLIENT_SERVICE", "", null, undefined]) {
      expect(acatFeeRequestsHref(role), String(role)).toBeNull();
    }
    for (const [key, value] of [
      ["OPERATIONS_TOOLS", ""], ["OPERATIONS_TOOLS", "0"], ["OPERATIONS_TOOLS", "true"],
      ["OPERATIONS_FEE_REQUESTS", ""], ["OPERATIONS_FEE_REQUESTS", "0"], ["OPERATIONS_FEE_REQUESTS", "true"],
      ["OPERATIONS_PRODUCTION_ENABLED", ""], ["OPERATIONS_PRODUCTION_ENABLED", "0"],
      ["APP_ENV", "staging"], ["APP_ENV", ""],
    ]) {
      vi.unstubAllEnvs();
      stub(DESTINATION);
      vi.stubEnv(key, value);
      expect(acatFeeRequestsHref("OPERATIONS"), `${key}=${value}`).toBeNull();
    }
    vi.unstubAllEnvs();
    stub({ ...DESTINATION, APP_ENV: "dev", OPERATIONS_PRODUCTION_ENABLED: "" });
    expect(acatFeeRequestsHref("OPERATIONS")).toBe(HREF);
    markCase(SUITE, "the helper returns the link only for roles and flags the destination page accepts");
  });

  it("every role the drawer admits can open the destination", () => {
    const roles = ["ADMIN", "OPERATIONS", "OPS", "ADVISOR", "CLIENT_SERVICE", "VIEWER", "HOA", "", "admin", " ADMIN "];
    const drawerRoles = roles.filter((role) => canSeeUnlinkedAcats(role) && canReadCustodianLibrary(role));
    expect(drawerRoles).toEqual(["ADMIN", "OPERATIONS"]);
    for (const role of drawerRoles) expect(canAccessOperationsTools(role), role).toBe(true);
    markCase(SUITE, "every role the drawer admits can open the destination");
  });

  it("the helper applies the same two checks as the destination page", () => {
    const page = readFileSync("app/(authenticated)/operations/fee-requests/page.tsx", "utf8");
    expect(page).toContain("if (!operationsFeeRequestsPreviewEnabled() || !canAccessOperationsTools(role)) notFound();");
    const helper = readFileSync("lib/operations/fee-request-link.ts", "utf8");
    expect(helper).toContain("operationsFeeRequestsPreviewEnabled() && canAccessOperationsTools(role)");
    markCase(SUITE, "the helper applies the same two checks as the destination page");
  });

  it("the book data passes the link only while the fee release is on and the user may open the destination", async () => {
    stub(FEE_RELEASE);
    stub(DESTINATION);
    expect((await viewProps("OPERATIONS")).feeRequestsHref).toBe(HREF);
    expect((await viewProps("ADMIN")).feeRequestsHref).toBe(HREF);
    expect((await viewProps("VIEWER")).feeRequestsHref).toBeNull();
    vi.stubEnv("OPERATIONS_FEE_REQUESTS", "0");
    expect((await viewProps("OPERATIONS")).feeRequestsHref).toBeNull();
    vi.stubEnv("OPERATIONS_FEE_REQUESTS", "1");
    const off = await AcatBookData({ identity: identity("OPERATIONS"), userName: null, prefsScope: "synthetic", editsEnabled: true, feeEnabled: false });
    const offView = Children.toArray((off as ReactElement<{ children: ReactNode }>).props.children)
      .find((c): c is ReactElement<Record<string, unknown>> => isValidElement(c) && c.type === AcatBookView);
    expect(offView?.props.feeEnabled).toBe(false);
    expect(offView?.props.feeRequestsHref).toBeNull();
    markCase(SUITE, "the book data passes the link only while the fee release is on and the user may open the destination");
  });

  it("the section source has no tracker reimbursement call, Fee Store setting, or tracker link", () => {
    const section = readFileSync("components/transfers/TransferFeeSection.tsx", "utf8");
    const actions = readFileSync("app/(authenticated)/acat-tracking/fee-actions.ts", "utf8");
    for (const [name, source] of [["section", section], ["actions", actions]] as const) {
      expect(source, name).not.toMatch(/logTransferReimbursement/);
      expect(source, name).not.toMatch(/action:\s*"log"/);
      expect(source, name).not.toMatch(/fee-store/i);
      expect(source, name).not.toMatch(/TRANSFER_TRACKER_URL|EXTERNAL_APPS|Open Transfer Tracker|\/api\/fees/);
    }
    expect(section).toContain('import Link from "next/link";');
    expect(section.match(/href=\{feeRequestsHref\}/g)).toHaveLength(2);
    markCase(SUITE, "the section source has no tracker reimbursement call, Fee Store setting, or tracker link");
  });

  it("the preview-and-confirm flow is on only with its switch, the destination and a role the create path accepts (ticket)", async () => {
    stub(FEE_RELEASE);
    stub(DESTINATION);
    for (const role of ["ADMIN", "OPERATIONS", "OPS", "VIEWER"]) expect(acatReimbursementCreateEnabled(role), role).toBe(false);
    expect((await viewProps("OPERATIONS")).feeReimbursement).toBe(false);
    stub(CREATE);
    for (const role of ["ADMIN", "OPERATIONS"]) expect(acatReimbursementCreateEnabled(role), role).toBe(true);
    for (const role of ["OPS", "ADVISOR", "VIEWER", "CLIENT_SERVICE", "", null, undefined]) expect(acatReimbursementCreateEnabled(role), String(role)).toBe(false);
    expect((await viewProps("OPERATIONS")).feeReimbursement).toBe(true);
    expect((await viewProps("ADMIN")).feeReimbursement).toBe(true);
    expect((await viewProps("VIEWER")).feeReimbursement).toBe(false);
    expect((await viewProps("OPERATIONS")).feeRequestsHref).toBe(HREF);
    vi.stubEnv("OPERATIONS_FEE_REQUESTS", "0");
    expect((await viewProps("OPERATIONS")).feeReimbursement).toBe(false);
    vi.stubEnv("OPERATIONS_FEE_REQUESTS", "1");
    vi.stubEnv("SHOW_ACAT_FEE_REQUEST_CREATE_TKT350", "0");
    expect((await viewProps("OPERATIONS")).feeReimbursement).toBe(false);
    expect((await viewProps("OPERATIONS")).feeRequestsHref).toBe(HREF);
    vi.stubEnv("SHOW_ACAT_FEE_REQUEST_CREATE_TKT350", "1");
    const off = await AcatBookData({ identity: identity("OPERATIONS"), userName: null, prefsScope: "synthetic", editsEnabled: true, feeEnabled: false });
    const offView = Children.toArray((off as ReactElement<{ children: ReactNode }>).props.children)
      .find((c): c is ReactElement<Record<string, unknown>> => isValidElement(c) && c.type === AcatBookView);
    expect(offView?.props.feeReimbursement).toBe(false);
    markCase(SUITE, "the preview-and-confirm flow is on only with its switch, the destination and a role the create path accepts (ticket)");
  });
});
