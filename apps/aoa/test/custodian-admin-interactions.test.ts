// @vitest-environment jsdom
import { createElement, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const actions = vi.hoisted(() => ({
  createCustodian: vi.fn(), saveCustodianDetails: vi.fn(), saveCustodianPlaybook: vi.fn(),
  markCustodianReviewed: vi.fn(), addCustodianFee: vi.fn(), saveCustodianFee: vi.fn(),
  deleteCustodianFee: vi.fn(), mergeCustodian: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/app/(authenticated)/acat-tracking/custodian-admin-actions", () => actions);
vi.mock("@/components/transfers/AcatTrackingView", () => ({ AcatTrackingView: () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));

import { AcatWorkspace } from "@/components/custodians/AcatWorkspace";
import { CustodianLibrary } from "@/components/custodians/CustodianLibrary";
import { CONFIRM_DELETE_FEE, CONFIRM_MERGE_CUSTODIAN, custodiansCsv } from "@/lib/data/custodian-admin-contract";
import { custodianAdminAllowed } from "@/lib/flags";
import type { CustodianLibrary as Library, CustodianProfile } from "@/lib/data/custodian-library-contract";
import { libraryFixture } from "./fixtures/custodian-library";

const first = libraryFixture.custodians[0];
const other: CustodianProfile = { ...first, id: "other", name: "Other Custodian", dtcNumber: "DEMO-9999", fees: [] };
const twoCustodians: Library = { ...libraryFixture, custodians: [first, other] };

// Mirrors AcatWorkspace: it owns the library snapshot and swaps in saved custodians.
function Harness({ initial = libraryFixture }: { initial?: Library }) {
  const [library, setLibrary] = useState(initial);
  return createElement(CustodianLibrary, { library, admin: true, onLibraryChange: (update) => setLibrary(update) });
}
const open = (name = "Example Custodian") => fireEvent.click(screen.getByLabelText(`View ${name} playbook and fees`));
const panel = (name: string) => within(screen.getByRole("region", { name }));

beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open"); this.dispatchEvent(new Event("close"));
  };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("custodian admin interactions", () => {
  it("saving a playbook keeps the dialog open and shows Transfer playbook updated", async () => {
    actions.saveCustodianPlaybook.mockResolvedValue({ ok: true, custodian: { ...first, dtcNumber: "0443", watchouts: "parity line", contactEmail: "ops@example.test" } });
    render(createElement(Harness));
    open();
    fireEvent.click(panel("Transfer playbook").getByText("Edit"));
    fireEvent.change(screen.getByLabelText("DTC / clearing #"), { target: { value: "0443" } });
    fireEvent.click(panel("Transfer playbook").getByText("Save"));
    await waitFor(() => expect(screen.getByText("Transfer playbook updated")).toBeTruthy());
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Custodian reference · Admin")).toBeTruthy();
    expect(screen.getByText("Mixed · Partial docs · Wet signature · LOA required")).toBeTruthy();
    expect(panel("Transfer playbook").getByText("0443")).toBeTruthy();
    expect(panel("Transfer playbook").getByText("parity line")).toBeTruthy();
    expect(panel("Transfer playbook").getByText("ops@example.test")).toBeTruthy();
    expect(actions.saveCustodianPlaybook.mock.calls[0][1]).toMatchObject({ dtcNumber: "0443" });
    markCase("custodian-admin-interactions", "saving a playbook keeps the dialog open and shows Transfer playbook updated");
  });

  it("a failed save keeps the last saved custodian and Retry re-sends the same draft", async () => {
    actions.saveCustodianPlaybook
      .mockResolvedValueOnce({ ok: false, reason: "The tracker did not save this change. Try again.", retryable: true })
      .mockResolvedValueOnce({ ok: true, custodian: { ...first, dtcNumber: "0443" } });
    render(createElement(Harness));
    open();
    fireEvent.click(panel("Transfer playbook").getByText("Edit"));
    fireEvent.change(screen.getByLabelText("DTC / clearing #"), { target: { value: "0443" } });
    fireEvent.click(panel("Transfer playbook").getByText("Save"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("The tracker did not save this change. Try again."));
    expect(screen.queryByText("Transfer playbook updated")).toBeNull();
    expect((screen.getByLabelText("DTC / clearing #") as HTMLInputElement).value).toBe("0443");
    expect(screen.getByLabelText("View Example Custodian playbook and fees").textContent).toContain("DEMO-1234");
    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() => expect(screen.getByText("Transfer playbook updated")).toBeTruthy());
    expect(actions.saveCustodianPlaybook).toHaveBeenCalledTimes(2);
    expect(actions.saveCustodianPlaybook.mock.calls[1]).toEqual(actions.saveCustodianPlaybook.mock.calls[0]);
    expect(screen.queryByRole("alert")).toBeNull();
    markCase("custodian-admin-interactions", "a failed save keeps the last saved custodian and Retry re-sends the same draft");
  });

  it("delete fee asks for confirmation and sends nothing when cancelled", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    actions.deleteCustodianFee.mockResolvedValue({ ok: true, custodian: { ...first, fees: [first.fees[1]] } });
    render(createElement(Harness));
    open();
    fireEvent.click(panel("Fee schedule").getAllByText("Delete")[0]);
    expect(confirm).toHaveBeenCalledWith(CONFIRM_DELETE_FEE);
    expect(actions.deleteCustodianFee).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(panel("Fee schedule").getAllByText("Delete")[0]);
    await waitFor(() => expect(screen.getByText("Fee deleted")).toBeTruthy());
    expect(actions.deleteCustodianFee).toHaveBeenCalledWith("synthetic-one", "fee-zero");
    expect(panel("Fee schedule").queryByText("Transfer fee")).toBeNull();
    markCase("custodian-admin-interactions", "delete fee asks for confirmation and sends nothing when cancelled");
  });

  it("merge is disabled until a target is chosen and confirms before posting", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    actions.mergeCustodian.mockResolvedValue({ ok: true, custodian: other, reassigned: 2, deletedId: "synthetic-one" });
    render(createElement(Harness, { initial: twoCustodians }));
    fireEvent.change(screen.getByLabelText("Find a custodian"), { target: { value: "Example Custodian" } });
    expect(screen.queryByLabelText("View Other Custodian playbook and fees")).toBeNull();
    open();
    expect(within(panel("Danger zone").getByLabelText("Merge into")).getByText("Other Custodian")).toBeTruthy();
    const merge = panel("Danger zone").getByText("Merge") as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
    fireEvent.change(panel("Danger zone").getByLabelText("Merge into"), { target: { value: "other" } });
    expect(merge.disabled).toBe(false);
    fireEvent.click(merge);
    expect(confirm).toHaveBeenCalledWith(CONFIRM_MERGE_CUSTODIAN);
    expect(actions.mergeCustodian).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(merge);
    await waitFor(() => expect(actions.mergeCustodian).toHaveBeenCalledWith("synthetic-one", "other"));
    markCase("custodian-admin-interactions", "merge is disabled until a target is chosen and confirms before posting");
  });

  it("merge shows the kept custodian and the moved count", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    actions.mergeCustodian.mockResolvedValue({ ok: true, custodian: { ...other, transfersToDate: 5 }, reassigned: 3, deletedId: "synthetic-one" });
    render(createElement(Harness, { initial: twoCustodians }));
    open();
    fireEvent.change(panel("Danger zone").getByLabelText("Merge into"), { target: { value: "other" } });
    fireEvent.click(panel("Danger zone").getByText("Merge"));
    await waitFor(() => expect(screen.getByText("Merged. 3 ACAT records moved to Other Custodian.")).toBeTruthy());
    expect(await screen.findByRole("heading", { name: "Other Custodian" })).toBeTruthy();
    expect(screen.queryByLabelText("View Example Custodian playbook and fees")).toBeNull();
    expect(screen.queryByText("Example Custodian")).toBeNull();
    expect(screen.queryByText("Transfer fee")).toBeNull();
    expect(screen.queryByText("Delivery fee")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
    cleanup();
    actions.mergeCustodian.mockResolvedValue({ ok: true, custodian: other, reassigned: 1, deletedId: "synthetic-one" });
    render(createElement(Harness, { initial: twoCustodians }));
    open();
    fireEvent.change(panel("Danger zone").getByLabelText("Merge into"), { target: { value: "other" } });
    fireEvent.click(panel("Danger zone").getByText("Merge"));
    await waitFor(() => expect(screen.getByText("Merged. 1 ACAT record moved to Other Custodian.")).toBeTruthy());
    markCase("custodian-admin-interactions", "merge shows the kept custodian and the moved count");
  });

  it("a blank name on create shows Name is required and makes no call", async () => {
    render(createElement(Harness));
    fireEvent.click(screen.getByText("New"));
    expect(screen.getByPlaceholderText("e.g. Betterment")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Custodian name"), { target: { value: "   " } });
    fireEvent.click(screen.getByText("Add"));
    expect(screen.getByRole("alert").textContent).toContain("Name is required");
    expect(actions.createCustodian).not.toHaveBeenCalled();
    open();
    fireEvent.click(panel("Custodian details").getByText("Edit"));
    fireEvent.change(panel("Custodian details").getByLabelText("Name"), { target: { value: "  " } });
    fireEvent.click(panel("Custodian details").getByText("Save"));
    expect(within(screen.getByRole("dialog")).getByRole("alert").textContent).toContain("Name is required");
    expect(screen.getByRole("heading", { name: "Example Custodian" })).toBeTruthy();
    expect(actions.saveCustodianDetails).not.toHaveBeenCalled();
    expect(actions.createCustodian).not.toHaveBeenCalled();
    actions.saveCustodianDetails.mockResolvedValue({ ok: true, custodian: { ...first, name: "Renamed Custodian" } });
    fireEvent.change(panel("Custodian details").getByLabelText("Name"), { target: { value: "Renamed Custodian" } });
    fireEvent.click(panel("Custodian details").getByText("Save"));
    await waitFor(() => expect(screen.getByText("Custodian updated")).toBeTruthy());
    expect(screen.getByRole("heading", { name: "Renamed Custodian" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Close custodian details"));
    actions.createCustodian.mockResolvedValue({ ok: true, custodian: { ...first, id: "brand-new", name: "Betterment", fees: [] } });
    fireEvent.change(screen.getByLabelText("Custodian name"), { target: { value: "Betterment" } });
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(screen.getByText("Added Betterment")).toBeTruthy());
    // The new custodian's dialog becomes accessible only once its effect has called showModal().
    expect(await screen.findByRole("heading", { name: "Betterment" })).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    markCase("custodian-admin-interactions", "a blank name on create shows Name is required and makes no call");
  });

  it("Export CSV downloads the shown custodians", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
    let blob: Blob | undefined;
    let filename = "";
    let href = "";
    URL.createObjectURL = vi.fn((value: Blob) => { blob = value; return "blob:custodian-csv"; });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(this: HTMLAnchorElement) { filename = this.download; href = this.href; });
    render(createElement(Harness, { initial: twoCustodians }));
    fireEvent.change(screen.getByLabelText("Find a custodian"), { target: { value: "Other" } });
    fireEvent.click(screen.getByText("Export CSV"));
    expect(filename).toBe("custodians-fees-2026-10-13.csv");
    expect(href).toBe("blob:custodian-csv");
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob as Blob);
    });
    expect(text).toBe(custodiansCsv([other]));
    expect(text).not.toContain("Example Custodian");
    await act(async () => {});
    markCase("custodian-admin-interactions", "Export CSV downloads the shown custodians");
  });

  it("saving a fee keeps the dialog open and shows the fee type, account type, transfer type, direction, amount, and notes", async () => {
    const empty: CustodianProfile = { ...first, fees: [] };
    const fee = { ...first.fees[0], id: "fee-new", feeType: "Outgoing wire", accountType: "BROKERAGE", transferType: "FULL", direction: "OUT", amount: 25, amountText: null, notes: "parity", documentation: null };
    actions.addCustodianFee.mockResolvedValue({ ok: true, custodian: { ...empty, fees: [fee] } });
    render(createElement(Harness, { initial: { ...libraryFixture, custodians: [empty] } }));
    open();
    fireEvent.click(panel("Fee schedule").getByRole("button", { name: "Add fee" }));
    fireEvent.change(screen.getByLabelText("Fee type"), { target: { value: "Outgoing wire" } });
    fireEvent.change(screen.getByLabelText("Account type"), { target: { value: "BROKERAGE" } });
    fireEvent.change(screen.getByLabelText("Transfer type"), { target: { value: "FULL" } });
    fireEvent.change(screen.getByLabelText("Transfer direction relative to Apex"), { target: { value: "OUT" } });
    fireEvent.change(screen.getByLabelText("Amount (USD, blank if unknown)"), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "parity" } });
    fireEvent.click(panel("Fee schedule").getByText("Add"));
    await waitFor(() => expect(screen.getByText("Fee added")).toBeTruthy());
    expect(actions.addCustodianFee.mock.calls[0][1]).toMatchObject({ feeType: "Outgoing wire", accountType: "BROKERAGE", transferType: "FULL", direction: "OUT", amount: "25", notes: "parity" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    const schedule = panel("Fee schedule");
    for (const text of ["Outgoing wire", "BROKERAGE", "FULL", "Transfer into Apex", "$25.00", "· parity"]) expect(schedule.getByText(text)).toBeTruthy();
    markCase("custodian-admin-interactions", "saving a fee keeps the dialog open and shows the fee type, account type, transfer type, direction, amount, and notes");
  });

  it("an operations user sees no create, edit, merge, download, or delete when the release is on", () => {
    vi.stubEnv("EPIC_ACAT_CUSTODIAN_ADMIN_TKT323", "1");
    vi.stubEnv("SHOW_ACAT_CUSTODIAN_ADMIN_TKT337", "1");
    const admin = custodianAdminAllowed("OPERATIONS");
    expect(admin).toBe(false);
    render(createElement(CustodianLibrary, { library: libraryFixture, admin }));
    open();
    expect(screen.getByText("Custodian reference · Read only")).toBeTruthy();
    expect(screen.getByText("Mixed · Verified")).toBeTruthy();
    for (const text of ["Add Custodian", "Export CSV", "Edit", "Add fee", "Merge", "Delete"]) expect(screen.queryByText(text)).toBeNull();
    expect(screen.getByText("Transfer fee")).toBeTruthy();
    expect(screen.getByText("Delivery fee")).toBeTruthy();
    for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    markCase("custodian-admin-interactions", "an operations user sees no create, edit, merge, download, or delete when the release is on");
  });

  it("an admin workspace shows the admin description and keeps a saved custodian in the snapshot", async () => {
    const scope = "scope-337";
    const now = Date.now();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/auth/session")) {
        return new Response(JSON.stringify({ user: { email: "admin@example.test" }, navigationScope: scope, expires: new Date(now + 3_600_000).toISOString() }));
      }
      return new Response("{}", { status: 500 });
    }));
    actions.saveCustodianPlaybook.mockResolvedValue({ ok: true, custodian: { ...first, dtcNumber: "0443" } });
    const initial = { scope, serverNow: now, sessionExpiresAt: now + 3_600_000, snapshot: { view: "library" as const, data: libraryFixture, checkedAt: now, expiresAt: now + 300_000 } };
    render(createElement(AcatWorkspace, { scope, initialView: "library", initial, custodianAdmin: true }));
    await waitFor(() => expect(screen.getByText("Add Custodian")).toBeTruthy());
    expect(screen.getByText("Transfer playbooks, contacts, timing and fees. The Transfer Tracker is the source of truth. Admin changes save there.")).toBeTruthy();
    open();
    fireEvent.click(panel("Transfer playbook").getByText("Edit"));
    fireEvent.change(screen.getByLabelText("DTC / clearing #"), { target: { value: "0443" } });
    fireEvent.click(panel("Transfer playbook").getByText("Save"));
    await waitFor(() => expect(screen.getByText("Transfer playbook updated")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Close custodian details"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("View Example Custodian playbook and fees").textContent).toContain("0443");
    open();
    expect(panel("Transfer playbook").getByText("0443")).toBeTruthy();
    const reads = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
    expect(reads.filter((url) => url.startsWith("/api/acat-workspace"))).toEqual([]);
    markCase("custodian-admin-interactions", "an admin workspace shows the admin description and keeps a saved custodian in the snapshot");
  });
});
