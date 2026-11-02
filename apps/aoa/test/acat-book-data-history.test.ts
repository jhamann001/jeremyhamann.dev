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

const SUITE = "acat-book-data-history";
const EPIC = "EPIC_ACAT_FIELD_HISTORY_TKT322";
const SHOW = "SHOW_ACAT_FIELD_HISTORY_TKT336";

async function bookViewProps(): Promise<Record<string, unknown>> {
  const identity = { role: "OPERATIONS", email: "synthetic@example.test" } as unknown as Identity;
  const tree = await AcatBookData({ identity, userName: null, prefsScope: "synthetic" });
  const children = Children.toArray((tree as ReactElement<{ children: ReactNode }>).props.children);
  const view = children.find((c): c is ReactElement<Record<string, unknown>> => isValidElement(c) && c.type === AcatBookView);
  if (!view) throw new Error("AcatBookView element not found");
  return view.props;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readBook.mockResolvedValue({ rows: [], linkedTransferIds: {}, linkedByRecordId: {}, removedRows: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("book data history prop (ticket)", () => {
  it("passes the field history release to the book view only while both history switches are exactly 1", async () => {
    expect((await bookViewProps()).historyEnabled).toBe(false);
    vi.stubEnv(SHOW, "1");
    expect((await bookViewProps()).historyEnabled).toBe(false);
    vi.stubEnv(SHOW, "0");
    vi.stubEnv(EPIC, "1");
    expect((await bookViewProps()).historyEnabled).toBe(false);
    vi.stubEnv(SHOW, "1");
    expect((await bookViewProps()).historyEnabled).toBe(true);
    vi.stubEnv(EPIC, "true");
    expect((await bookViewProps()).historyEnabled).toBe(false);
    markCase(SUITE, "passes the field history release to the book view only while both history switches are exactly 1");
  });

  it("leaves the existing book props unchanged by the history switches", async () => {
    const off = await bookViewProps();
    vi.stubEnv(EPIC, "1");
    vi.stubEnv(SHOW, "1");
    const on = await bookViewProps();
    expect({ ...on, historyEnabled: false }).toEqual(off);
    expect(on.transferDrawer).toBeNull();
    markCase(SUITE, "leaves the existing book props unchanged by the history switches");
  });
});
