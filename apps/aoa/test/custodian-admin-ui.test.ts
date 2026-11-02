import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

vi.mock("server-only", () => ({}));
vi.mock("@/app/(authenticated)/acat-tracking/custodian-admin-actions", () => ({
  createCustodian: vi.fn(), saveCustodianDetails: vi.fn(), saveCustodianPlaybook: vi.fn(),
  markCustodianReviewed: vi.fn(), addCustodianFee: vi.fn(), saveCustodianFee: vi.fn(),
  deleteCustodianFee: vi.fn(), mergeCustodian: vi.fn(),
}));

import { CustodianLibrary, CustodianTiming } from "@/components/custodians/CustodianLibrary";
import {
  AdminDialogBody, AdminFailure, FeeForm, PlaybookPanel, ReviewStatus,
} from "@/components/custodians/CustodianAdmin";
import { BLANK_FEE, playbookDraftFrom } from "@/lib/data/custodian-admin-contract";
import { libraryFixture } from "./fixtures/custodian-library";

const profile = libraryFixture.custodians[0];
const noop = () => {};
const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const body = (custodian = profile) => html(createElement(AdminDialogBody, {
  profile: custodian, custodians: [custodian, { ...custodian, id: "other", name: "Other Custodian" }],
  timing: createElement(CustodianTiming, { profile: custodian }), onSaved: noop, onMerged: noop, notify: noop,
}));
function inOrder(markup: string, expected: string[]) {
  let at = -1;
  for (const text of expected) {
    const next = markup.indexOf(text, at + 1);
    expect(next, `"${text}" after position ${at}`).toBeGreaterThan(at);
    at = next;
  }
}

describe("custodian admin UI", () => {
  it("release off renders exactly the read-only baseline", () => {
    const baseline = readFileSync("test/fixtures/custodian-library-readonly.html", "utf8");
    expect(html(createElement(CustodianLibrary, { library: libraryFixture }))).toBe(baseline);
    markCase("custodian-admin-ui", "release off renders exactly the read-only baseline");
  });

  it("admin sees Add Custodian, Export CSV, Edit, Add fee and Merge into", () => {
    const library = html(createElement(CustodianLibrary, { library: libraryFixture, admin: true }));
    for (const text of ["Add Custodian", ">New<", "Export CSV", 'title="Export current view as CSV"']) expect(library).toContain(text);
    expect(library.indexOf("Add Custodian")).toBeLessThan(library.indexOf("Find a custodian"));
    expect(html(createElement(CustodianLibrary, { library: { ...libraryFixture, custodians: [] }, admin: true }))).toMatch(/<button[^>]*disabled=""[^>]*>Export CSV<\/button>|<button[^>]*title="Export current view as CSV"[^>]*disabled=""/);
    const dialog = body();
    for (const text of [">Edit<", "Add fee", "Merge into", "Danger zone", "Select a custodian…", "Other Custodian", "Verify before use"]) expect(dialog).toContain(text);
    expect(dialog).toMatch(/title="When this custodian(?:'|&#x27;)s fee applies, based on the transfer(?:'|&#x27;)s direction relative to Apex"/);
    expect(body({ ...profile, fees: [{ ...profile.fees[0], direction: "ANY" }] }))
      .toContain("Both directions");
    expect(dialog).not.toContain("Example Custodian</option>");
    expect(dialog).toMatch(/<button[^>]*disabled=""[^>]*>Merge<\/button>/);
    markCase("custodian-admin-ui", "admin sees Add Custodian, Export CSV, Edit, Add fee and Merge into");
  });

  it("playbook form lists groups and fields in the tracker's order", () => {
    const markup = html(createElement(PlaybookPanel, {
      profile, editing: true, draft: playbookDraftFrom(profile), busy: false,
      onDraftChange: noop, onStartEdit: noop, onSave: noop, onCancel: noop,
    }));
    inOrder(markup, [
      "Routing", "DTC / clearing #", "Receiving / house account #", "Last-known value only; verify it before each transfer.",
      "Transfer type", "— (unset)", "ACAT", "Manual", "Mixed", "Internal", "Unconfirmed",
      "Documentation status", "Documented", "Partial docs", "Needs call",
      "Requirements", "Signature", "Electronic signature accepted (DocuSign)", "Wet signature required",
      "Letter of acceptance", "Medallion (MSG)", "Paperwork on file",
      "Proceeds &amp; contact", "Liquidation proceeds", "Return method", "Contact method", "Contact details",
      "Track record", "Transfers to date", "Watchouts", "One per line (use • or newlines for bullets)",
    ]);
    expect(markup).not.toContain("Recent clients");
    expect(markup).toMatch(/<textarea[^>]*rows="6"/);
    expect(markup).not.toMatch(/<input[^>]*type="number"[^>]*min=/);
    expect(markup).toMatch(/<input[^>]*type="email"/);
    expect(markup).toMatch(/<input[^>]*type="number"/);
    expect(markup).toContain("Existing custom values are kept until you choose a replacement");
    markCase("custodian-admin-ui", "playbook form lists groups and fields in the tracker's order");
  });

  it("fee form lists fields in the tracker's order with the direction copy", () => {
    const markup = html(createElement(FeeForm, { draft: BLANK_FEE, saveLabel: "Add", saving: false, onChange: noop, onSave: noop, onCancel: noop }));
    inOrder(markup, [
      "Fee type", "Account type", "Transfer type", "Transfer direction relative to Apex",
      "Both directions", "Transfer out of Apex", "Transfer into Apex",
      "These are this custodian’s fees",
      "Amount (USD, blank if unknown)", "Amount text (e.g. &quot;Call contra&quot;)", "Notes", "Documentation (link or reference)",
      ">Add<", ">Cancel<",
    ]);
    expect(markup).toMatch(/<input[^>]*type="number"/);
    expect(markup).not.toMatch(/<input[^>]*type="number"[^>]*(min|step)=/);
    markCase("custodian-admin-ui", "fee form lists fields in the tracker's order with the direction copy");
  });

  it("shows the fee empty state copy", () => {
    expect(body({ ...profile, fees: [] })).toContain("No fees on file yet. Click <strong>Add fee</strong> to create one.");
    const populated = body();
    expect(populated).not.toContain("No fees on file yet");
    inOrder(populated, ["Fee schedule", "(2)", "Transfer fee", "Transfer into Apex", "$0.00", "Delivery fee", "Transfer out of Apex", "Varies"]);
    const bare = body({ ...profile, signature: null, paperworkOnFile: null, transfersToDate: null, watchouts: "• one\n- two\n\n◦ three" });
    expect(bare).toContain("<li>one</li><li>two</li><li>three</li>");
    expect(bare.match(/—/g)?.length).toBeGreaterThanOrEqual(3);
    const filled = body({ ...profile, paperworkOnFile: true, transfersToDate: 3 });
    expect(filled).toContain(">Yes<");
    expect(filled).toMatch(/data-pill[^>]*>3</);
    markCase("custodian-admin-ui", "shows the fee empty state copy");
  });

  it("marks Needs setup and Verified with pill classes", () => {
    const needs = html(createElement(ReviewStatus, { status: "NEEDS_SETUP" }));
    const verified = html(createElement(ReviewStatus, { status: "VERIFIED" }));
    expect(needs).toMatch(/_reviewWarning_/);
    expect(needs).toContain("Needs setup");
    expect(verified).toMatch(/_reviewSuccess_/);
    expect(verified).toContain("Verified");
    const banner = body({ ...profile, reviewStatus: "NEEDS_SETUP" });
    expect(banner).toContain("This custodian was auto-created from an ingested contra and needs review.");
    expect(banner).toContain("Mark reviewed");
    expect(body()).not.toContain("Mark reviewed");
    markCase("custodian-admin-ui", "marks Needs setup and Verified with pill classes");
  });

  it("the stylesheet carries the tracker hues and never hides admin forms", () => {
    // Values copied from transfer-tracker src/app/globals.css (light 45-55, dark 127-137).
    const hues = [
      "#2d8a5e", "#eaf5ef", "#c7e3d3", "#a17e2e", "#faf3e0", "#ebdcb1", "#b83c3c", "#fbecec", "#eec7c7",
      "#5fc08a", "rgba(95,192,138,0.12)", "rgba(95,192,138,0.3)",
      "#d4b15c", "rgba(212,177,92,0.12)", "rgba(212,177,92,0.3)",
      "#e07070", "rgba(224,112,112,0.14)", "rgba(224,112,112,0.32)",
    ];
    expect(hues).toHaveLength(18);
    const squash = (file: string) => readFileSync(file, "utf8").replace(/\s+/g, "");
    for (const file of ["components/custodians/CustodianAdmin.module.css", "components/custodians/CustodianLibrary.module.css"]) {
      const css = squash(file);
      for (const hue of hues) expect(css, `${file} ${hue}`).toContain(hue);
    }
    expect(readFileSync("components/custodians/CustodianAdmin.module.css", "utf8")).not.toMatch(/display:\s*none/);
    const library = readFileSync("components/custodians/CustodianLibrary.module.css", "utf8");
    expect(library.match(/\.reviewWarning\s*\{[^}]*\}/g)?.join(" ")).toMatch(/--ca-warning/);
    expect(library.match(/\.reviewSuccess\s*\{[^}]*\}/g)?.join(" ")).toMatch(/--ca-success/);
    expect(library.match(/\.reviewWarning\s*\{[^}]*\}/g)?.join(" ")).not.toMatch(/--ca-success/);
    expect(library.match(/\.reviewSuccess\s*\{[^}]*\}/g)?.join(" ")).not.toMatch(/--ca-warning/);
    markCase("custodian-admin-ui", "the stylesheet carries the tracker hues and never hides admin forms");
  });

  it("a failure banner offers Retry", () => {
    const retryable = html(createElement(AdminFailure, { message: "The tracker did not save this change. Try again.", onRetry: noop }));
    expect(retryable).toContain('role="alert"');
    expect(retryable).toContain(">Retry<");
    expect(html(createElement(AdminFailure, { message: "Name is required" }))).not.toContain("Retry");
    markCase("custodian-admin-ui", "a failure banner offers Retry");
  });
});
