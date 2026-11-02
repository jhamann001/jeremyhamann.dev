import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const { auth, workspace, book, pathname } = vi.hoisted(() => ({
  auth: vi.fn(), workspace: vi.fn(), book: vi.fn(), pathname: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error(`redirect:${url}`); },
  notFound: () => { throw new Error("notFound"); },
  usePathname: pathname,
}));
vi.mock("@/components/custodians/AcatWorkspaceData", () => ({ AcatWorkspaceData: workspace }));
vi.mock("@/components/transfers/AcatBookData", () => ({ AcatBookData: book }));
vi.mock("@/components/shell/useSidebarCounts", () => ({
  useSidebarCounts: () => ({ status: "ready", value: { count: 3 }, retry: vi.fn() }),
  validNavCounts: () => true, validAcatCount: () => true,
}));
import Page from "@/app/(authenticated)/acat-tracking/page";
import { Sidebar } from "@/components/shell/Sidebar";

const sessionMeta = { navigationScope: "opaque", expires: "2099-01-01T00:00:00Z" };
const props = (view?: string | string[]) => ({ searchParams: Promise.resolve({ view }) });

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ ...sessionMeta, user: { role: "OPERATIONS", email: "ops@example.test" } });
  workspace.mockImplementation(({ view }) => createElement("p", null, `Synthetic ${view} data`));
  book.mockImplementation(() => createElement("p", null, "Synthetic book data"));
  pathname.mockReturnValue("/acat-tracking");
});

describe("ACAT Tracking workspace views", () => {
  it.each([undefined, "library"])("redirects unauthenticated requests (%s) before content reads", async (view) => {
    auth.mockResolvedValue(null);
    await expect(Page(props(view))).rejects.toThrow("redirect:/");
    expect(workspace).not.toHaveBeenCalled();
  });
  it.each(["ADVISOR", "CLIENT_SERVICE", "VIEWER", "UNKNOWN", undefined])("hides both views from %s", async (role) => {
    auth.mockResolvedValue({ user: { role } });
    for (const view of [undefined, "library"]) {
      await expect(Page(props(view))).rejects.toThrow("notFound");
    }
    expect(workspace).not.toHaveBeenCalled();
  });
  it.each(["ADMIN", "OPERATIONS"])("streams only the selected initial read for %s", async (role) => {
    auth.mockResolvedValue({ ...sessionMeta, user: { role, email: "ops@example.test" } });
    for (const view of ["tracking", "library"]) {
      workspace.mockClear();
      const tree = await Page(props(view));
      expect(workspace).not.toHaveBeenCalled();
      const html = renderToStaticMarkup(tree);
      expect(html).toContain(`Synthetic ${view} data`);
      expect(workspace.mock.calls[0][0]).toEqual({
        identity: { role, email: "ops@example.test" }, view, scope: "opaque", sessionExpiresAt: Date.parse(sessionMeta.expires), custodianAdmin: false, authorityLibrary: false,
      });
      expect(html).toContain(">ACAT Tracking</h1>");
    }
  });
  it.each([undefined, "", "tracking", "other", "LIBRARY", ["library"], ["library", "tracking"]])(
    "defaults ambiguous selectors to tracking (%j)", async (view) => {
      expect(renderToStaticMarkup(await Page(props(view)))).toContain("Synthetic tracking data");
    },
  );
  it("redirects sessions with no isolation scope before any source reads", async () => {
    auth.mockResolvedValue({ user: { role: "ADMIN" }, expires: sessionMeta.expires });
    await expect(Page(props())).rejects.toThrow("redirect:/");
    expect(workspace).not.toHaveBeenCalled();
  });
  it.each(["ADMIN", "OPERATIONS"])("keeps one active sidebar entry for %s in either query-string view", (role) => {
    // usePathname deliberately excludes query parameters; both views use this path.
    const html = renderToStaticMarkup(createElement(Sidebar, { role }));
    expect(html.match(/href="\/acat-tracking"/g)).toHaveLength(1);
    const activeLink = html.match(/<a\b[^>]*href="\/acat-tracking"[^>]*>/)?.[0];
    expect(activeLink).toMatch(/class="[^"]*active/);
    expect(html).not.toContain("Custodian Library");
  });
  it.each(["ADVISOR", "CLIENT_SERVICE", "VIEWER"])("keeps both workspace entry points out of %s's sidebar", (role) => {
    const html = renderToStaticMarkup(createElement(Sidebar, { role }));
    expect(html).not.toContain('href="/acat-tracking"');
    expect(html).not.toContain("Custodian Library");
  });
});

describe("ACAT Tracking book flag", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("keeps today's tracking read and never renders the book when the flags are off", async () => {
    vi.stubEnv("EPIC_ACAT_OPS_WORKSPACE_TKT290", "1");
    vi.stubEnv("SHOW_ACAT_OPS_BOOK_TKT293", "0");
    const html = renderToStaticMarkup(await Page(props("tracking")));
    expect(html).toContain("Synthetic tracking data");
    expect(book).not.toHaveBeenCalled();
  });

  it("renders the book for tracking and keeps the library read when both flags are on", async () => {
    vi.stubEnv("EPIC_ACAT_OPS_WORKSPACE_TKT290", "1");
    vi.stubEnv("SHOW_ACAT_OPS_BOOK_TKT293", "1");
    const tracking = renderToStaticMarkup(await Page(props("tracking")));
    expect(tracking).toContain("Synthetic book data");
    expect(tracking).not.toContain("Synthetic tracking data");
    expect(book.mock.calls[0][0]).toEqual({
      identity: { role: "OPERATIONS", email: "ops@example.test" }, userName: null, prefsScope: "ops@example.test",
      editsEnabled: false, dayToDayEnabled: false, columnsEnabled: false, showRemoved: false, initialRecordId: null,
      feeEnabled: false,
    });
    renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ view: "tracking", removed: "1" }) }));
    expect(book.mock.calls[1][0]).toMatchObject({ showRemoved: true });
    expect(renderToStaticMarkup(await Page(props("library")))).toContain("Synthetic library data");
    vi.stubEnv("SHOW_ACAT_BOOK_COLUMNS_TKT311", "1");
    vi.stubEnv("EPIC_ACAT_BOOK_DAY_TO_DAY_ACTIONS_TKT302", "1");
    renderToStaticMarkup(await Page(props("tracking")));
    expect(book.mock.calls[2][0]).toMatchObject({ columnsEnabled: true, dayToDayEnabled: false });
  });

  it("passes the fee release to the book only while the book, edits, and both fee switches are on", async () => {
    vi.stubEnv("EPIC_ACAT_OPS_WORKSPACE_TKT290", "1");
    vi.stubEnv("SHOW_ACAT_OPS_BOOK_TKT293", "1");
    const seen = async () => {
      book.mockClear();
      renderToStaticMarkup(await Page(props("tracking")));
      return book.mock.calls[0][0].feeEnabled;
    };
    vi.stubEnv("ALLOW_ACAT_OPS_EDITS_TKT294", "1");
    expect(await seen()).toBe(false);
    vi.stubEnv("EPIC_ACAT_FEE_REIMBURSEMENT_TKT318", "1");
    expect(await seen()).toBe(false);
    vi.stubEnv("SHOW_ACAT_FEE_REIMBURSEMENT_TKT333", "1");
    expect(await seen()).toBe(true);
    vi.stubEnv("ALLOW_ACAT_OPS_EDITS_TKT294", "0");
    expect(await seen()).toBe(false);
    vi.stubEnv("ALLOW_ACAT_OPS_EDITS_TKT294", "1");
    vi.stubEnv("SHOW_ACAT_FEE_REIMBURSEMENT_TKT333", "true");
    expect(await seen()).toBe(false);
    markCase("acat-workspace", "passes the fee release to the book only while the book, edits, and both fee switches are on");
  });

  it("passes only a bounded record query to the ACAT book", async () => {
    vi.stubEnv("EPIC_ACAT_OPS_WORKSPACE_TKT290", "1");
    vi.stubEnv("SHOW_ACAT_OPS_BOOK_TKT293", "1");
    renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ view: "tracking", record: "rec-valid_123" }) }));
    expect(book.mock.calls[0][0]).toMatchObject({ initialRecordId: "rec-valid_123" });
    book.mockClear();
    renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ view: "tracking", record: "x".repeat(129) }) }));
    expect(book.mock.calls[0][0]).toMatchObject({ initialRecordId: null });
    book.mockClear();
    renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ view: "tracking", record: ["rec-valid_123"] }) }));
    expect(book.mock.calls[0][0]).toMatchObject({ initialRecordId: null });
  });
});

describe("ACAT Tracking custodian admin prop (ticket)", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("passes custodianAdmin only to an ADMIN while both switches are on", async () => {
    const shown = async (role: string) => {
      auth.mockResolvedValue({ ...sessionMeta, user: { role, email: "who@example.test" } });
      workspace.mockClear();
      renderToStaticMarkup(await Page(props("library")));
      return workspace.mock.calls[0][0].custodianAdmin;
    };
    expect(await shown("ADMIN")).toBe(false);
    vi.stubEnv("EPIC_ACAT_CUSTODIAN_ADMIN_TKT323", "1");
    expect(await shown("ADMIN")).toBe(false);
    vi.stubEnv("SHOW_ACAT_CUSTODIAN_ADMIN_TKT337", "1");
    expect(await shown("ADMIN")).toBe(true);
    expect(await shown("OPERATIONS")).toBe(false);
  });
});
