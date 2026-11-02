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
import { acatPaperworkEnabled, epicAcatPaperworkEnabled, showAcatPaperworkEnabled } from "@/lib/flags";
import type { Identity } from "@/lib/data/types";

const SUITE = "acat-paperwork-flags";
const BOOK_EPIC = "EPIC_ACAT_OPS_WORKSPACE_TKT290";
const BOOK_SHOW = "SHOW_ACAT_OPS_BOOK_TKT293";
const DRAWER_EPIC = "EPIC_ACAT_TRANSFER_DRAWER_TKT319";
const DRAWER_SHOW = "SHOW_ACAT_TRANSFER_DRAWER_TKT332";
const EPIC = "EPIC_ACAT_PAPERWORK_TKT321";
const SHOW = "SHOW_ACAT_PAPERWORK_TKT335";

function drawerOn() {
  vi.stubEnv(BOOK_EPIC, "1");
  vi.stubEnv(BOOK_SHOW, "1");
  vi.stubEnv(DRAWER_EPIC, "1");
  vi.stubEnv(DRAWER_SHOW, "1");
}

async function bookViewProps(role: string): Promise<Record<string, unknown>> {
  const identity = { role, email: "synthetic@example.test" } as unknown as Identity;
  const tree = await AcatBookData({ identity, userName: null, prefsScope: "synthetic" });
  const children = Children.toArray((tree as ReactElement<{ children: ReactNode }>).props.children);
  const view = children.find((c): c is ReactElement<Record<string, unknown>> => isValidElement(c) && c.type === AcatBookView);
  if (!view) throw new Error("AcatBookView element not found");
  return view.props;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readBook.mockResolvedValue({ rows: [], linkedTransferIds: {}, linkedByRecordId: {}, removedRows: null });
  for (const name of [BOOK_EPIC, BOOK_SHOW, DRAWER_EPIC, DRAWER_SHOW, EPIC, SHOW]) vi.stubEnv(name, "");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("paperwork flags", () => {
  it("tkt335 flags: every helper is off by default", () => {
    expect(epicAcatPaperworkEnabled()).toBe(false);
    expect(showAcatPaperworkEnabled()).toBe(false);
    expect(acatPaperworkEnabled()).toBe(false);
    markCase(SUITE, "tkt335 flags: every helper is off by default");
  });

  it("tkt335 flags: only the exact string 1 turns each paperwork flag on", () => {
    for (const value of ["true", "0", "", "yes", " 1", "11"]) {
      vi.stubEnv(EPIC, value);
      vi.stubEnv(SHOW, value);
      expect(epicAcatPaperworkEnabled(), value).toBe(false);
      expect(showAcatPaperworkEnabled(), value).toBe(false);
    }
    vi.stubEnv(EPIC, "1");
    vi.stubEnv(SHOW, "1");
    expect(epicAcatPaperworkEnabled()).toBe(true);
    expect(showAcatPaperworkEnabled()).toBe(true);
    markCase(SUITE, "tkt335 flags: only the exact string 1 turns each paperwork flag on");
  });

  it("tkt335 flags: paperwork needs the drawer, the epic flag, and the show flag together", () => {
    vi.stubEnv(EPIC, "1");
    vi.stubEnv(SHOW, "1");
    expect(acatPaperworkEnabled()).toBe(false);
    drawerOn();
    expect(acatPaperworkEnabled()).toBe(true);
    vi.stubEnv(DRAWER_SHOW, "0");
    expect(acatPaperworkEnabled()).toBe(false);
    markCase(SUITE, "tkt335 flags: paperwork needs the drawer, the epic flag, and the show flag together");
  });

  it("tkt335 flags: the book data passes paperwork false while paperwork is off and leaves transferDrawer unchanged", async () => {
    drawerOn();
    const props = await bookViewProps("ADMIN");
    expect(props.paperwork).toBe(false);
    expect(props.transferDrawer).toEqual({ admin: true });
    expect((await bookViewProps("OPERATIONS")).transferDrawer).toEqual({ admin: false });
    markCase(SUITE, "tkt335 flags: the book data passes paperwork false while paperwork is off and leaves transferDrawer unchanged");
  });

  it("tkt335 flags: the book data passes paperwork true only while paperwork is on", async () => {
    drawerOn();
    vi.stubEnv(EPIC, "1");
    vi.stubEnv(SHOW, "1");
    const props = await bookViewProps("ADMIN");
    expect(props.paperwork).toBe(true);
    expect(props.transferDrawer).toEqual({ admin: true });
    markCase(SUITE, "tkt335 flags: the book data passes paperwork true only while paperwork is on");
  });

  it("tkt335 flags: the epic flag alone and the show flag alone each leave paperwork off", async () => {
    drawerOn();
    vi.stubEnv(EPIC, "1");
    expect(acatPaperworkEnabled()).toBe(false);
    expect((await bookViewProps("ADMIN")).paperwork).toBe(false);
    vi.stubEnv(EPIC, "");
    vi.stubEnv(SHOW, "1");
    expect(acatPaperworkEnabled()).toBe(false);
    expect((await bookViewProps("ADMIN")).paperwork).toBe(false);
    markCase(SUITE, "tkt335 flags: the epic flag alone and the show flag alone each leave paperwork off");
  });
});
