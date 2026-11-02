import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), readBook: vi.fn(), stale: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), redirect: vi.fn() }));
vi.mock("@/lib/data/acat-status", () => ({ writeAcatBookRecord: vi.fn(), readAcatMachine: vi.fn() }));
vi.mock("@/lib/data/custodian-library", () => ({
  getCustodianLibrary: vi.fn(),
  CustodianLibraryError: class CustodianLibraryError extends Error {},
}));
vi.mock("@/lib/data/acat-workspace", () => ({ readAcatBook: mocks.readBook, markAcatBookStale: mocks.stale }));
vi.mock("@/app/(authenticated)/asset-transfer/acat-lane-actions", () => ({ loadUnlinkedAcatDetail: vi.fn() }));
vi.mock("@/app/(authenticated)/acat-tracking/actions", () => ({ unlinkAcatFromExistingTransfer: vi.fn() }));
vi.mock("@/components/transfers/TransferPreparationPanel", () => ({ TransferPreparationPanel: () => null }));
vi.mock("@/components/transfers/AcatLinkPicker", () => ({ AcatLinkPicker: () => null }));
vi.mock("@/components/transfers/AcatStatusCard", () => ({ AcatStatusCard: () => null }));

import { AcatBookData } from "@/components/transfers/AcatBookData";
import { AcatBookView } from "@/components/transfers/AcatBookView";
import type { Identity } from "@/lib/data/types";

const SUITE = "acat-book-data-drawer";
const BOOK_EPIC = "EPIC_ACAT_OPS_WORKSPACE_TKT290";
const BOOK_SHOW = "SHOW_ACAT_OPS_BOOK_TKT293";
const EPIC = "EPIC_ACAT_TRANSFER_DRAWER_TKT319";
const SHOW = "SHOW_ACAT_TRANSFER_DRAWER_TKT332";

function identity(role: string): Identity {
  return { role, email: "synthetic@example.test" } as unknown as Identity;
}

async function bookViewProps(role: string): Promise<Record<string, unknown>> {
  const tree = await AcatBookData({ identity: identity(role), userName: null, prefsScope: "synthetic" });
  const children = Children.toArray((tree as ReactElement<{ children: ReactNode }>).props.children);
  const view = children.find((c): c is ReactElement<Record<string, unknown>> => isValidElement(c) && c.type === AcatBookView);
  if (!view) throw new Error("AcatBookView element not found");
  return view.props;
}

function drawerOn() {
  vi.stubEnv(BOOK_EPIC, "1");
  vi.stubEnv(BOOK_SHOW, "1");
  vi.stubEnv(EPIC, "1");
  vi.stubEnv(SHOW, "1");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readBook.mockResolvedValue({ rows: [], linkedTransferIds: {}, linkedByRecordId: {}, removedRows: null });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("book data drawer prop", () => {
  it("tkt332 data: the drawer off passes no transferDrawer to the book view", async () => {
    expect((await bookViewProps("ADMIN")).transferDrawer).toBeNull();
    vi.stubEnv(BOOK_EPIC, "1");
    vi.stubEnv(BOOK_SHOW, "1");
    vi.stubEnv(EPIC, "1");
    expect((await bookViewProps("ADMIN")).transferDrawer).toBeNull();
    vi.stubEnv(SHOW, "1");
    vi.stubEnv(BOOK_SHOW, "0");
    expect((await bookViewProps("ADMIN")).transferDrawer).toBeNull();
    markCase(SUITE, "tkt332 data: the drawer off passes no transferDrawer to the book view");
  });

  it("tkt332 data: an admin gets transferDrawer admin true while the drawer is on", async () => {
    drawerOn();
    expect((await bookViewProps("ADMIN")).transferDrawer).toEqual({ admin: true });
    markCase(SUITE, "tkt332 data: an admin gets transferDrawer admin true while the drawer is on");
  });

  it("tkt332 data: an operations user gets transferDrawer admin false while the drawer is on", async () => {
    drawerOn();
    expect((await bookViewProps("OPERATIONS")).transferDrawer).toEqual({ admin: false });
    markCase(SUITE, "tkt332 data: an operations user gets transferDrawer admin false while the drawer is on");
  });
});
