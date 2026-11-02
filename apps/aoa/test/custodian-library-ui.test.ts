import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CustodianDetails, CustodianLibrary } from "@/components/custodians/CustodianLibrary";
import { AcatSectionNav } from "@/components/custodians/AcatSectionNav";
import { libraryFixture } from "./fixtures/custodian-library";
import { NAV_GROUPS } from "@/components/shell/nav-config";
import { markCase } from "./acat-book-flywheel";

const { auth, read } = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); }, notFound: () => { throw new Error("notFound"); } }));
vi.mock("@/app/(authenticated)/acat-tracking/custodian-admin-actions", () => ({}));
vi.mock("@/lib/data/custodian-library", () => ({
  getCustodianLibrary: read,
  CustodianLibraryError: class extends Error { constructor(readonly reason: string) { super("Custodian library unavailable"); } },
}));
import Page from "@/app/(authenticated)/custodian-library/page";
import { CustodianLibraryData } from "@/components/custodians/CustodianLibraryData";
import { CustodianLibraryError } from "@/lib/data/custodian-library";

beforeEach(() => { vi.clearAllMocks(); });
const render = (profile = libraryFixture.custodians[0]) => renderToStaticMarkup(createElement(CustodianDetails, { profile }));

describe("custodian library UI", () => {
  it("renders all operational and fee fields, with no mutation controls", () => {
    const html = render();
    for (const text of ["DTC number", "DEMO-1234", "DEMO-ROUTING", "Contact method", "Email", "Contact details", "Wet signature", "Required for IRA", "Call to confirm", "Secure portal", "Confirm instructions", "ops@example.test", "$0.00", "Varies", "Waived with qualification", "Confirm eligibility", "Internal reference", "7 days", "3 business days", "Created", "Last updated", "Transfer into Apex", "Transfer out of Apex"]) expect(html).toContain(text);
    expect(html).toContain("not a fee calculation or reimbursement decision");
    expect(html).not.toMatch(/<form|<button|contenteditable|javascript:/i);
  });
  it("does not interpret no rules or unknown information as a free transfer", () => {
    const html = render({ ...libraryFixture.custodians[0], fees: [], acatFeeAmount: null, paperworkOnFile: null, observedAvgProcessingBusinessDays: null });
    expect(html).toContain("This does not mean transfers are free");
    expect(html).toContain("Not recorded");
    expect(html).toContain("No observed timing");
  });
  it("escapes source text, including fee documentation", () => {
    const payload = '<script>alert("x")</script>';
    const c = libraryFixture.custodians[0];
    const html = render({ ...c, watchouts: payload, fees: [{ ...c.fees[0], documentation: payload }] });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it("provides searchable summary cards and a retrieval timestamp without mounting every detail", () => {
    const html = renderToStaticMarkup(createElement(CustodianLibrary, { library: libraryFixture }));
    expect(html).toContain('type="search"');
    expect(html).toContain("1 of 1 custodians");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-label="View Example Custodian playbook and fees"');
    expect(html).toContain("DEMO-1234");
    expect(html).toContain("2 fee rules");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("DEMO-ROUTING");
    expect(html).toContain("Source snapshot");
    expect(html).toContain("Individual transfer records are not included");
  });
  it("labels an absent fee schedule without implying a zero fee", () => {
    const html = renderToStaticMarkup(createElement(CustodianLibrary, { library: { ...libraryFixture,
      custodians: [{ ...libraryFixture.custodians[0], fees: [] }] } }));
    expect(html).toContain("No fee rules recorded");
    expect(html).not.toContain("$0.00");
  });
  it("workspace header shows Custodian Library and does not show Tracked ACATs", () => {
    for (const current of ["tracking", "library"] as const) {
      const html = renderToStaticMarkup(createElement(AcatSectionNav, { current }));
      expect(html).toContain('aria-label="ACAT workspace"');
      expect(html).toContain("Custodian Library");
      expect(html).toContain('href="/acat-tracking?view=library"');
      expect(html).not.toContain("Tracked ACATs");
    }
    const tracking = renderToStaticMarkup(createElement(AcatSectionNav, { current: "tracking" }));
    const library = renderToStaticMarkup(createElement(AcatSectionNav, { current: "library" }));
    expect(tracking).not.toContain('aria-current="page"');
    expect(library.match(/aria-current="page"/g)).toHaveLength(1);
  });
  it("shows an empty source distinctly", () => {
    const html = renderToStaticMarkup(createElement(CustodianLibrary, { library: { ...libraryFixture, custodians: [] } }));
    expect(html).toContain("No custodians are configured");
    expect(html).not.toContain("unavailable");
  });
  it.each([true, false])("keeps refresh and distinct source/check timestamps with populated=%s", (populated) => {
    const html = renderToStaticMarkup(createElement(CustodianLibrary, {
      library: { ...libraryFixture, custodians: populated ? libraryFixture.custodians : [] },
      status: createElement("p", { role: "status" }, "Last checked: current check"),
      actions: createElement("button", { type: "button" }, "Refresh"),
    }));
    expect(html.match(/>Refresh<\/button>/g)).toHaveLength(1);
    expect(html).toContain("Last checked: current check");
    expect(html).toContain("Source snapshot");
    expect(html).toContain(`dateTime="${libraryFixture.retrievedAt}"`);
    expect(html).toContain("Individual transfer records are not included");
  });
  it("keeps controls but no source details, timestamps or empty-source claim when data is unavailable", () => {
    const html = renderToStaticMarkup(createElement(CustodianLibrary, {
      library: null, status: createElement("p", { role: "status" }, "Snapshot expired"),
      actions: createElement("button", { type: "button" }, "Refresh"),
    }));
    expect(html).toContain("Snapshot expired");
    expect(html).toContain(">Refresh</button>");
    expect(html).not.toMatch(/Source snapshot|Example Custodian|No custodians are configured|type="search"|<time/);
  });
  it("provides only one ACAT sidebar destination with the existing role gate", () => {
    const items = NAV_GROUPS.flatMap((g) => g.items);
    expect(items.some((i) => i.href === "/custodian-library" || i.label === "Custodian Library")).toBe(false);
    const nav = items.find((i) => i.href === "/acat-tracking");
    expect(nav?.requiredRoles).toEqual(["ADMIN", "OPERATIONS"]);
  });

  it("unavailable timing keeps the profile and shows no observed timing", () => {
    const profile = {
      ...libraryFixture.custodians[0],
      observedTimingAvailable: false as const,
      observedAvgProcessingBusinessDays: null,
      observedCompletedTransfers: 0,
      feeSchedules: [{
        id: "doc-1",
        filename: "schedule.pdf",
        contentType: "application/pdf" as const,
        byteSize: 12,
        sha256: "ab".repeat(32),
        createdAt: "2026-09-20T12:00:00.000Z",
      }],
    };
    const html = renderToStaticMarkup(createElement("div", null,
      createElement(CustodianLibrary, { library: { ...libraryFixture, custodians: [profile] } }),
      createElement(CustodianDetails, { profile }),
    ));
    expect(html).toContain("Example Custodian");
    expect(html.match(/No observed timing/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("schedule.pdf");
    expect(html).not.toContain("%PDF");
    markCase("custodian-library-ui", "unavailable timing keeps the profile and shows no observed timing");
  });
});

describe("server page access and degradation", () => {
  it("redirects unauthenticated users before reads", async () => {
    auth.mockResolvedValue(null);
    await expect(Page()).rejects.toThrow("redirect");
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["ADVISOR", "CLIENT_SERVICE", "VIEWER", undefined])("hides the page from %s before reads", async (role) => {
    auth.mockResolvedValue({ user: { role } });
    await expect(Page()).rejects.toThrow("notFound");
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["ADMIN", "OPERATIONS"])("redirects %s bookmarks to the workspace without reading source data", async (role) => {
    auth.mockResolvedValue({ user: { role } });
    await expect(Page()).rejects.toThrow("redirect:/acat-tracking?view=library");
    expect(read).not.toHaveBeenCalled();
  });
  it("loads data for the authenticated role", async () => {
    read.mockResolvedValue(libraryFixture);
    const result = await CustodianLibraryData({ role: "OPERATIONS" });
    expect(read).toHaveBeenCalledWith("OPERATIONS");
    expect(renderToStaticMarkup(result)).toContain("Example Custodian");
  });
  it("shows unavailability without fabricated rows or error details", async () => {
    read.mockRejectedValue(new CustodianLibraryError("unavailable"));
    const html = renderToStaticMarkup(await CustodianLibraryData({ role: "ADMIN" }));
    expect(html).toContain("No fee or playbook data could be verified");
    expect(html).not.toContain("Example Custodian");
  });
  it("does not hide unexpected programming errors", async () => {
    read.mockRejectedValue(new Error("Unexpected programming error"));
    await expect(CustodianLibraryData({ role: "ADMIN" })).rejects.toThrow("Unexpected programming error");
  });
});
