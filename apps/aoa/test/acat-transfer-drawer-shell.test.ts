// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const actions = vi.hoisted(() => ({
  load: vi.fn(), change: vi.fn(), complete: vi.fn(), reject: vi.fn(), status: vi.fn(), text: vi.fn(),
  remove: vi.fn(), replace: vi.fn(), search: vi.fn(), contras: vi.fn(), suggestion: vi.fn(), refresh: vi.fn(),
}));
vi.mock("@/app/(authenticated)/acat-tracking/transfer-drawer-actions", () => ({
  loadTransferDrawer: actions.load,
  changeTransferField: actions.change,
  completeTransfer: actions.complete,
  rejectTransfer: actions.reject,
  changeTransferStatus: actions.status,
  saveTransferText: actions.text,
  deleteTransfer: actions.remove,
  replaceTransferClient: actions.replace,
  searchTransferClients: actions.search,
  listTransferContras: actions.contras,
  loadDtccSuggestion: actions.suggestion,
}));
vi.mock("@/app/(authenticated)/acat-tracking/book-actions", () => ({ searchAcatBookClients: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: actions.refresh, push: vi.fn() }) }));

import { AcatTransferDrawerShell } from "@/components/transfers/AcatTransferDrawerShell";
import { mapDrawerTransfer, type DrawerTransfer } from "@/lib/data/acat-drawer-contract";
import { ACAT_WRITE_UNAVAILABLE } from "@/lib/data/acat-book-edit";
import type { AcatBookRow } from "@/lib/data/acat-book";

const SUITE = "acat-transfer-drawer-shell";
const USER = "user-11111111-1111-1111-1111-111111111111";
const USER_2 = "user-22222222-2222-2222-2222-222222222222";
const FRESH = { writeEligible: true, enabled: true, health: "FRESH", pendingAccountPolicy: "ACCOUNT_REQUIRED" };
const STALE = { ...FRESH, health: "STALE" };
const MAPPING_REFUSAL = "Changing the saved name clears its asset mapping link. Confirm this change first.";

function raw(over: Record<string, unknown> = {}) {
  return {
    id: "rec-1", identityVersion: 4, clientName: "Pat Example", status: "Submitted", controlNumber: "CTRL-1",
    acatTransferId: "ACAT-1", direction: "In", type: "Full", accountType: "Traditional IRA", wealthAdvisor: "Rachel",
    notes: "Call back", transferWorkflow: "ACAT", transferringContra: "Fidelity", dtccNumber: "",
    apexAccountId: "****3402", statementAccountNumber: "****8819", statementAmount: 123456, acatDate: "2026-09-01",
    crmTicket: "PT-1", feeCharged: "Yes", feeAmount: "$50.00",
    assets: [{ mapStatus: "Mapped" }, { mapStatus: "Expected" }, { mapStatus: "Unmapped" }, { mapStatus: "Pending" }],
    ...over,
  };
}

function transfer(over: Record<string, unknown> = {}): DrawerTransfer {
  const mapped = mapDrawerTransfer(raw(over));
  if (!mapped) throw new Error("fixture must map");
  return mapped;
}

function bookRow(over: Partial<AcatBookRow> = {}): AcatBookRow {
  return {
    id: "rec-1", acatTransferId: "ACAT-1", clientName: "Pat Example", controlNumber: "CTRL-1", direction: "In", type: "Full",
    accountType: "Traditional IRA", status: "Submitted", transferringContra: "Fidelity", statementAmount: 123456,
    acatDate: "2026-09-01", lastActivityAt: "2026-10-01T00:00:00.000Z", apexAccountId: "****3402",
    statementAccountNumber: null, dtccNumber: null,
    assetMap: { total: null, mapped: null, unmapped: null, pending: null, expected: null },
    wealthAdvisor: "Rachel", crmDealId: null, tradeInstructionsBlank: false, notes: "Call back", tradeInstructions: null,
    custodianName: "", textLoadError: null, feeCharged: null, feeRequestCompleted: null, hasIssue: false, removedAt: null,
    records: { needsClientLink: false, cedarRidgeUserIds: USER, reconStatus: "Needs Review" },
    ...over,
  };
}

const disabled = (el: HTMLElement) => (el as HTMLButtonElement | HTMLSelectElement).disabled;
const fail = (reason: string, retryable = true, extra: Record<string, unknown> = {}) => ({ ok: false, reason, retryable, ...extra });

type Props = {
  admin?: boolean; readOnly?: boolean; position?: { index: number; total: number };
  onPrevious?: (() => void) | null; onNext?: (() => void) | null; row?: AcatBookRow;
};
const handlers = {
  onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onPrevious: vi.fn(), onNext: vi.fn(),
};

function renderShell(props: Props = {}) {
  return render(createElement(AcatTransferDrawerShell, {
    row: props.row ?? bookRow(),
    admin: props.admin ?? false,
    readOnly: props.readOnly ?? false,
    position: props.position ?? { index: 1, total: 5 },
    onPrevious: props.onPrevious === undefined ? handlers.onPrevious : props.onPrevious,
    onNext: props.onNext === undefined ? handlers.onNext : props.onNext,
    onClose: handlers.onClose,
    onChanged: handlers.onChanged,
    onRemoved: handlers.onRemoved,
  }));
}

async function loaded(props: Props = {}) {
  const view = renderShell(props);
  await screen.findByLabelText("Status");
  return view;
}

const field = (label: string) => screen.getByRole("button", { name: `Edit ${label}` });
const editor = (label: string) => screen.getByLabelText(`Edit ${label}`) as HTMLInputElement;
async function openProcessing() {
  fireEvent.click(screen.getByRole("button", { name: /Processing & Instructions/ }));
}

async function openClientDialogAndPick(remove = true) {
  fireEvent.click(screen.getByRole("button", { name: "Review client link" }));
  const dialog = await screen.findByRole("dialog");
  if (remove) fireEvent.click(within(dialog).getByRole("button", { name: /^Remove/ }));
  else fireEvent.click(within(dialog).getByRole("button", { name: "Add another person" }));
  fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "Sam" } });
  fireEvent.mouseDown(await within(dialog).findByRole("option"));
  fireEvent.change(within(dialog).getByLabelText("Reason for this change"), { target: { value: "Name fixed" } });
  return dialog;
}

beforeEach(() => {
  vi.clearAllMocks();
  actions.load.mockResolvedValue({ ok: true, transfer: transfer() });
  actions.suggestion.mockResolvedValue({ ok: true, status: "none", dtccNumber: null });
  actions.contras.mockResolvedValue({ ok: true, contras: [{ name: "Fidelity", dtcNumber: "0226" }, { name: "Schwab", dtcNumber: null }] });
  actions.search.mockResolvedValue({
    ok: true, clients: [{ cedarRidgeUserId: USER_2, displayName: "Sam Selected", accountHints: [] }], hasMore: false, directory: FRESH,
  });
});
afterEach(() => { cleanup(); });

describe("transfer drawer shell", () => {
  it("tkt332 shell: shows previous, next, position, every tracker status, four stat cards, and the notes banner", async () => {
    const view = await loaded();
    expect(disabled(screen.getByRole("button", { name: "Previous record" }))).toBe(false);
    expect(disabled(screen.getByRole("button", { name: "Next record" }))).toBe(false);
    expect(screen.getByText("2 of 5")).toBeTruthy();
    const options = within(screen.getByLabelText("Status")).getAllByRole("option");
    expect(options).toHaveLength(17);
    expect(options[0].textContent).toBe("Waiting for Apex");
    expect(options[16].textContent).toBe("Deferred");
    const stat = (name: string) => view.container.querySelector(`[data-stat="${name}"]`)!;
    expect(stat("total").textContent).toBe("Total Assets4");
    expect(stat("matched").textContent).toBe("Matched2");
    expect(stat("issues").textContent).toBe("Issues1");
    expect(stat("issues").getAttribute("data-color")).toBe("red");
    expect(stat("days").getAttribute("data-color")).toBe("amber");
    expect(screen.getByRole("button", { name: "Edit notes" }).textContent).toContain("Call back");
    expect(view.container.querySelector("[data-hue='completed']")).toBeNull();
    cleanup();
    actions.load.mockResolvedValue({ ok: true, transfer: transfer({ status: "Completed" }) });
    const completed = await loaded();
    expect(completed.container.querySelector("[data-hue='completed']")?.textContent).toBe("Completed");
    cleanup();
    actions.load.mockResolvedValue({ ok: true, transfer: transfer({ status: "Rejected" }) });
    const rejected = await loaded();
    expect(rejected.container.querySelector("[data-hue='rejected']")?.textContent).toBe("Rejected");
    markCase(SUITE, "tkt332 shell: shows previous, next, position, every tracker status, four stat cards, and the notes banner");
  });

  it("tkt332 shell: previous and next call their handlers and are unavailable at the ends", async () => {
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Previous record" }));
    fireEvent.click(screen.getByRole("button", { name: "Next record" }));
    expect(handlers.onPrevious).toHaveBeenCalledTimes(1);
    expect(handlers.onNext).toHaveBeenCalledTimes(1);
    cleanup();
    await loaded({ onPrevious: null, onNext: null, position: { index: 0, total: 1 } });
    expect(disabled(screen.getByRole("button", { name: "Previous record" }))).toBe(true);
    expect(disabled(screen.getByRole("button", { name: "Next record" }))).toBe(true);
    markCase(SUITE, "tkt332 shell: previous and next call their handlers and are unavailable at the ends");
  });

  it("tkt332 shell: arrow keys navigate unless typing or a dialog is open", async () => {
    await loaded();
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(handlers.onNext).toHaveBeenCalledTimes(1);
    expect(handlers.onPrevious).toHaveBeenCalledTimes(1);
    fireEvent.click(field("Associated Control #"));
    fireEvent.keyDown(editor("Associated Control #"), { key: "ArrowRight" });
    expect(handlers.onNext).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(editor("Associated Control #"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Mark Complete" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    fireEvent.keyDown(within(dialog).getByLabelText(/Control #/), { key: "ArrowRight" });
    expect(handlers.onPrevious).toHaveBeenCalledTimes(1);
    expect(handlers.onNext).toHaveBeenCalledTimes(1);
    markCase(SUITE, "tkt332 shell: arrow keys navigate unless typing or a dialog is open");
  });

  it("tkt332 shell: a transfer that cannot be loaded shows a retry and keeps the shell in place", async () => {
    actions.load.mockResolvedValueOnce(fail("Could not load this transfer."));
    renderShell();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load this transfer.");
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next record" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByLabelText("Status");
    expect(actions.load).toHaveBeenCalledTimes(2);
    expect(actions.load).toHaveBeenCalledWith("rec-1");
    markCase(SUITE, "tkt332 shell: a transfer that cannot be loaded shows a retry and keeps the shell in place");
  });

  it("tkt332 shell: choosing Completed or Rejected opens the finalize dialog instead of saving", async () => {
    await loaded();
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "Completed" } });
    expect((await screen.findByRole("dialog")).textContent).toContain("Complete transfer");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "Rejected" } });
    expect((await screen.findByRole("dialog")).textContent).toContain("Reject transfer");
    expect(actions.status).not.toHaveBeenCalled();
    expect(actions.complete).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("Submitted");
    markCase(SUITE, "tkt332 shell: choosing Completed or Rejected opens the finalize dialog instead of saving");
  });

  it("tkt332 shell: Mark Complete requires a date and saves Completed with the optional control number", async () => {
    actions.complete.mockResolvedValue({
      ok: true, transfer: transfer({ status: "Completed", controlNumber: "CTRL-9", apexCompletionDate: "2026-10-12" }),
    });
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Mark Complete" }));
    const dialog = await screen.findByRole("dialog");
    expect(disabled(within(dialog).getByRole("button", { name: "Confirm Complete" }))).toBe(true);
    expect(within(dialog).getByText("Needs review")).toBeTruthy();
    expect(within(dialog).getByText("$50.00")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/Apex Completion Date/), { target: { value: "2026-10-12" } });
    fireEvent.change(within(dialog).getByLabelText("Control #"), { target: { value: "CTRL-9" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm Complete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(actions.complete).toHaveBeenCalledWith("rec-1", { apexCompletionDate: "2026-10-12", controlNumber: "CTRL-9" });
    expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("Completed");
    expect(screen.queryByRole("button", { name: "Mark Complete" })).toBeNull();
    expect(handlers.onChanged).toHaveBeenCalledTimes(1);
    expect(handlers.onChanged.mock.calls[0][0]).toMatchObject({ status: "Completed", controlNumber: "CTRL-9" });
    expect(actions.refresh).toHaveBeenCalled();
    markCase(SUITE, "tkt332 shell: Mark Complete requires a date and saves Completed with the optional control number");
  });

  it("tkt332 shell: Rejected requires a reason and a blank reason leaves the status unchanged", async () => {
    actions.reject.mockResolvedValue({ ok: true, transfer: transfer({ status: "Rejected", rejectionReason: "Wrong custodian" }) });
    await loaded();
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "Rejected" } });
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Confirm Rejection" });
    expect(disabled(confirm)).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Rejection Reason/), { target: { value: "    " } });
    expect(disabled(confirm)).toBe(true);
    fireEvent.click(confirm);
    expect(actions.reject).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("Submitted");
    fireEvent.change(within(dialog).getByLabelText(/Rejection Reason/), { target: { value: "Wrong custodian" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(actions.reject).toHaveBeenCalledWith("rec-1", "Wrong custodian");
    expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("Rejected");
    markCase(SUITE, "tkt332 shell: Rejected requires a reason and a blank reason leaves the status unchanged");
  });

  it("tkt332 shell: a failed finalize keeps the prior status and offers retry", async () => {
    actions.complete.mockResolvedValueOnce(fail(ACAT_WRITE_UNAVAILABLE));
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Mark Complete" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Apex Completion Date/), { target: { value: "2026-10-12" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm Complete" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(ACAT_WRITE_UNAVAILABLE);
    expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("Submitted");
    expect(handlers.onChanged).not.toHaveBeenCalled();
    actions.complete.mockResolvedValueOnce({ ok: true, transfer: transfer({ status: "Completed" }) });
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(actions.complete).toHaveBeenCalledTimes(2);
    markCase(SUITE, "tkt332 shell: a failed finalize keeps the prior status and offers retry");
  });

  it("tkt332 shell: choosing another status saves it through the status action", async () => {
    actions.status.mockResolvedValueOnce(fail(ACAT_WRITE_UNAVAILABLE));
    await loaded();
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "Accepted" } });
    expect((await screen.findByRole("alert")).textContent).toContain(ACAT_WRITE_UNAVAILABLE);
    expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("Submitted");
    actions.status.mockResolvedValueOnce({ ok: true, transfer: transfer({ status: "Accepted" }) });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("Accepted"));
    expect(actions.status).toHaveBeenCalledWith("rec-1", "Accepted");
    expect(actions.status).toHaveBeenCalledTimes(2);
    expect(handlers.onChanged.mock.calls[0][0]).toMatchObject({ status: "Accepted" });
    markCase(SUITE, "tkt332 shell: choosing another status saves it through the status action");
  });

  it("tkt332 shell: Mark Complete is hidden once the transfer is in a terminal status", async () => {
    for (const status of ["Completed", "Rejected", "Purged", "Canceled", "Deferred"]) {
      actions.load.mockResolvedValue({ ok: true, transfer: transfer({ status }) });
      await loaded();
      expect(screen.queryByRole("button", { name: "Mark Complete" }), status).toBeNull();
      cleanup();
    }
    actions.load.mockResolvedValue({ ok: true, transfer: transfer({ status: "Accepted" }) });
    await loaded();
    expect(screen.getByRole("button", { name: "Mark Complete" })).toBeTruthy();
    markCase(SUITE, "tkt332 shell: Mark Complete is hidden once the transfer is in a terminal status");
  });

  it("tkt332 shell: Delete is offered to an admin and not to anyone else", async () => {
    await loaded({ admin: true });
    expect(screen.getByRole("button", { name: "Delete ACAT record" })).toBeTruthy();
    cleanup();
    await loaded({ admin: false });
    expect(screen.queryByRole("button", { name: "Delete ACAT record" })).toBeNull();
    markCase(SUITE, "tkt332 shell: Delete is offered to an admin and not to anyone else");
  });

  it("tkt332 shell: admin delete saves the reason and reports the removal", async () => {
    actions.remove.mockResolvedValue({ ok: true, transfer: transfer(), removed: true });
    await loaded({ admin: true });
    fireEvent.click(screen.getByRole("button", { name: "Delete ACAT record" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Delete ACAT record?");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "Wrong client" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(handlers.onRemoved).toHaveBeenCalledTimes(1));
    expect(actions.remove).toHaveBeenCalledWith("rec-1", "Wrong client");
    expect(handlers.onRemoved.mock.calls[0][0]).toMatchObject({ id: "rec-1" });
    markCase(SUITE, "tkt332 shell: admin delete saves the reason and reports the removal");
  });

  it("tkt332 shell: delete stays blocked for a blank reason and keeps the transfer after a failure", async () => {
    actions.remove.mockResolvedValue(fail(ACAT_WRITE_UNAVAILABLE));
    await loaded({ admin: true });
    fireEvent.click(screen.getByRole("button", { name: "Delete ACAT record" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Delete" });
    expect(disabled(confirm)).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "  ab  " } });
    expect(disabled(confirm)).toBe(true);
    fireEvent.click(confirm);
    expect(actions.remove).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "Wrong client" } });
    fireEvent.click(confirm);
    expect((await within(dialog).findByRole("alert")).textContent).toBe(ACAT_WRITE_UNAVAILABLE);
    expect(disabled(within(dialog).getByRole("button", { name: "Retry" }))).toBe(false);
    expect(handlers.onRemoved).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Review client link" }).textContent).toBe("Pat Example");
    markCase(SUITE, "tkt332 shell: delete stays blocked for a blank reason and keeps the transfer after a failure");
  });

  it("tkt426 shell: the operations drawer shows the full Apex and statement account numbers", async () => {
    actions.load.mockResolvedValue({ ok: true, transfer: transfer({ apexAccountId: "IQQJRXDW3402", statementAccountNumber: "EHHWFABW8819" }) });
    const view = await loaded();
    expect(view.container.textContent).toContain("Apex Acct: IQQJRXDW3402");
    expect(field("Apex Account #").textContent).toContain("IQQJRXDW3402");
    expect(field("Statement Account #").textContent).toContain("EHHWFABW8819");
    expect(view.container.textContent).not.toContain("****3402");
    expect(view.container.textContent).not.toContain("****8819");
  });

  it("tkt332 shell: a saved field shows the stored value", async () => {
    actions.change.mockResolvedValue({ ok: true, transfer: transfer({ direction: "Out" }) });
    await loaded();
    fireEvent.click(field("Direction"));
    fireEvent.change(editor("Direction"), { target: { value: "Out" } });
    await waitFor(() => expect(field("Direction").textContent).toContain("Out"));
    expect(actions.change).toHaveBeenCalledWith("rec-1", "direction", "Out", { direction: "In", identityVersion: 4 });
    expect(handlers.onChanged.mock.calls[0][0]).toMatchObject({ direction: "Out" });
    markCase(SUITE, "tkt332 shell: a saved field shows the stored value");
  });

  it("tkt332 shell: every editable line ends with its pencil, including after a save", async () => {
    actions.change.mockResolvedValue({ ok: true, transfer: transfer({ direction: "Out" }) });
    const view = await loaded();
    await openProcessing();
    const pencilIsLast = (button: Element) => {
      const last = button.lastElementChild;
      expect(last?.getAttribute("aria-hidden"), button.getAttribute("aria-label") ?? "").toBe("true");
      expect(last?.textContent).toBe("✎");
      expect(button.querySelectorAll("[aria-hidden='true']")).toHaveLength(1);
    };
    const lines = () => [...view.container.querySelectorAll("[role='button'][aria-label^='Edit ']")]
      .filter((button) => button.querySelector("[aria-hidden='true']") && button.closest("[aria-label='Edit notes']") === null);
    expect(lines().length).toBeGreaterThan(8);
    for (const line of lines()) pencilIsLast(line);
    fireEvent.click(field("Direction"));
    fireEvent.change(editor("Direction"), { target: { value: "Out" } });
    await waitFor(() => expect(field("Direction").textContent).toContain("Out"));
    await waitFor(() => expect(field("Direction").querySelector("[aria-label='Saved']")).toBeTruthy());
    pencilIsLast(field("Direction"));
    markCase(SUITE, "tkt332 shell: every editable line ends with its pencil, including after a save");
  });

  it("tkt332 shell: a failed save keeps the last saved value and the unsent edit", async () => {
    actions.change.mockResolvedValueOnce(fail("Tracker is unavailable"));
    await loaded();
    fireEvent.click(field("Associated Control #"));
    fireEvent.change(editor("Associated Control #"), { target: { value: "NEW-1" } });
    fireEvent.blur(editor("Associated Control #"));
    const alert = await screen.findByText(/Tracker is unavailable/);
    expect(editor("Associated Control #").value).toBe("NEW-1");
    actions.change.mockResolvedValueOnce({ ok: true, transfer: transfer({ associatedControlNumber: "NEW-1" }) });
    fireEvent.click(within(alert.parentElement!).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(field("Associated Control #").textContent).toContain("NEW-1"));
    expect(actions.change).toHaveBeenCalledTimes(2);
    cleanup();
    actions.change.mockReset();
    actions.change.mockResolvedValueOnce(fail("Tracker is unavailable"));
    await loaded();
    fireEvent.click(field("Associated Control #"));
    fireEvent.change(editor("Associated Control #"), { target: { value: "NEW-2" } });
    fireEvent.blur(editor("Associated Control #"));
    await screen.findByText(/Tracker is unavailable/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
    expect(field("Associated Control #").textContent).toContain("—");
    markCase(SUITE, "tkt332 shell: a failed save keeps the last saved value and the unsent edit");
  });

  it("tkt332 shell: a blank or refused value keeps the last saved value and the unsent value", async () => {
    await loaded();
    await openProcessing();
    fireEvent.click(field("CRM Ticket"));
    fireEvent.change(editor("CRM Ticket"), { target: { value: "" } });
    fireEvent.blur(editor("CRM Ticket"));
    expect((await screen.findByRole("alert")).textContent).toBe("Enter a value to save.");
    expect(editor("CRM Ticket").value).toBe("");
    expect(actions.change).not.toHaveBeenCalled();
    actions.change.mockResolvedValueOnce(fail("CRM Ticket is invalid", false));
    fireEvent.change(editor("CRM Ticket"), { target: { value: "bad ticket" } });
    fireEvent.blur(editor("CRM Ticket"));
    expect((await screen.findByText(/CRM Ticket is invalid/)).textContent).toContain("CRM Ticket is invalid");
    expect(editor("CRM Ticket").value).toBe("bad ticket");
    fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
    expect(field("CRM Ticket").textContent).toContain("PT-1");
    markCase(SUITE, "tkt332 shell: a blank or refused value keeps the last saved value and the unsent value");
  });

  it("tkt332 shell: Apex and statement account fields start blank and never submit a masked value", async () => {
    actions.load.mockResolvedValue({ ok: true, transfer: transfer({ dtccNumber: "****9236" }) });
    await loaded();
    expect(field("Apex Account #").textContent).toContain("****3402");
    fireEvent.click(field("Apex Account #"));
    expect(editor("Apex Account #").value).toBe("");
    expect(editor("Apex Account #").placeholder).toBe("Enter full account number");
    fireEvent.change(editor("Apex Account #"), { target: { value: "****9999" } });
    fireEvent.blur(editor("Apex Account #"));
    expect((await screen.findByRole("alert")).textContent).toContain("masked value cannot be saved");
    expect(actions.change).not.toHaveBeenCalled();
    actions.change.mockResolvedValueOnce({ ok: true, transfer: transfer({ apexAccountId: "****5678" }) });
    fireEvent.change(editor("Apex Account #"), { target: { value: "12345678" } });
    fireEvent.blur(editor("Apex Account #"));
    await waitFor(() => expect(actions.change).toHaveBeenCalledTimes(1));
    expect(actions.change).toHaveBeenCalledWith("rec-1", "apexAccountId", "12345678", { direction: "In", identityVersion: 4 });
    await waitFor(() => expect(screen.queryByLabelText("Edit Apex Account #")).toBeTruthy());
    fireEvent.click(field("Statement Account #"));
    expect(editor("Statement Account #").value).toBe("");
    fireEvent.change(editor("Statement Account #"), { target: { value: "•••• 8819" } });
    fireEvent.blur(editor("Statement Account #"));
    await screen.findByText(/masked value cannot be saved/);
    expect(actions.change).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
    fireEvent.click(field("DTCC #"));
    expect(editor("DTCC #").value).toBe("");
    markCase(SUITE, "tkt332 shell: Apex and statement account fields start blank and never submit a masked value");
  });

  it("tkt332 shell: Escape cancels an inline edit without closing the drawer", async () => {
    await loaded();
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    fireEvent.click(field("Associated Control #"));
    fireEvent.change(editor("Associated Control #"), { target: { value: "NEW-1" } });
    fireEvent.keyDown(editor("Associated Control #"), { key: "Escape" });
    expect(screen.queryByLabelText("Edit Associated Control #", { selector: "input" })).toBeNull();
    expect(field("Associated Control #").textContent).toContain("—");
    expect(onWindowKey).not.toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(actions.change).not.toHaveBeenCalled();
    window.removeEventListener("keydown", onWindowKey);
    markCase(SUITE, "tkt332 shell: Escape cancels an inline edit without closing the drawer");
  });

  it("tkt332 shell: replacing the client shows the selected client's name", async () => {
    actions.replace.mockResolvedValue({ ok: true, transfer: transfer({ clientName: "Sam Selected" }) });
    await loaded();
    const dialog = await openClientDialogAndPick();
    const save = within(dialog).getByRole("button", { name: "Save client link" });
    await waitFor(() => expect(disabled(save)).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(actions.replace).toHaveBeenCalledWith("rec-1", {
      cedarRidgeUserIds: [USER_2], expectedIdentityVersion: 4, reason: "Name fixed", apexAccountId: "", acknowledgeMappingInvalidation: false,
    });
    expect(screen.getByRole("button", { name: "Review client link" }).textContent).toBe("Sam Selected");
    markCase(SUITE, "tkt332 shell: replacing the client shows the selected client's name");
  });

  it("tkt332 shell: client search failure keeps the current client with a retry", async () => {
    actions.search.mockResolvedValueOnce(fail("Client search is unavailable — try again."));
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Review client link" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add another person" }));
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "Sam" } });
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("Client search is unavailable — try again.");
    expect(within(within(dialog).getByRole("list", { name: "Selected clients" })).getByText("Pat Example")).toBeTruthy();
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await within(dialog).findByRole("option")).toBeTruthy();
    expect(actions.search).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Review client link" }).textContent).toBe("Pat Example");
    markCase(SUITE, "tkt332 shell: client search failure keeps the current client with a retry");
  });

  it("tkt332 shell: a failed client save keeps the current client and the unsent selection", async () => {
    actions.replace.mockResolvedValue(fail(ACAT_WRITE_UNAVAILABLE));
    await loaded();
    const dialog = await openClientDialogAndPick();
    const save = within(dialog).getByRole("button", { name: "Save client link" });
    await waitFor(() => expect(disabled(save)).toBe(false));
    fireEvent.click(save);
    expect((await within(dialog).findByText(ACAT_WRITE_UNAVAILABLE)).textContent).toContain(ACAT_WRITE_UNAVAILABLE);
    expect(within(dialog).getByText("Sam Selected")).toBeTruthy();
    expect((within(dialog).getByLabelText("Reason for this change") as HTMLTextAreaElement).value).toBe("Name fixed");
    expect(within(dialog).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review client link" }).textContent).toBe("Pat Example");
    markCase(SUITE, "tkt332 shell: a failed client save keeps the current client and the unsent selection");
  });

  it("tkt332 shell: the DTCC suggestion is offered while the stored DTCC is empty, including during an edit", async () => {
    actions.suggestion.mockResolvedValue({ ok: true, status: "suggested", dtccNumber: "0443" });
    actions.change.mockResolvedValue({ ok: true, transfer: transfer({ dtccNumber: "0443" }) });
    await loaded();
    expect(await screen.findByRole("button", { name: "Use 0443" })).toBeTruthy();
    expect(actions.suggestion).toHaveBeenCalledWith("Fidelity");
    fireEvent.click(field("DTCC #"));
    expect(screen.getByRole("button", { name: "Use 0443" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use 0443" }));
    await waitFor(() => expect(actions.change).toHaveBeenCalledWith("rec-1", "dtccNumber", "0443", { direction: "In", identityVersion: 4 }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Use 0443" })).toBeNull());
    markCase(SUITE, "tkt332 shell: the DTCC suggestion is offered while the stored DTCC is empty, including during an edit");
  });

  it("tkt332 shell: ambiguous DTCC history shows the tracker warning instead of a number", async () => {
    actions.suggestion.mockResolvedValue({ ok: true, status: "ambiguous", dtccNumber: null });
    await loaded();
    expect(await screen.findByText("Conflicting history — review")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Use / })).toBeNull();
    markCase(SUITE, "tkt332 shell: ambiguous DTCC history shows the tracker warning instead of a number");
  });

  it("tkt332 shell: a stored DTCC offers no suggestion and still accepts a manual value", async () => {
    actions.load.mockResolvedValue({ ok: true, transfer: transfer({ dtccNumber: "0443" }) });
    actions.suggestion.mockResolvedValue({ ok: true, status: "suggested", dtccNumber: "0999" });
    actions.change.mockResolvedValue({ ok: true, transfer: transfer({ dtccNumber: "0777" }) });
    await loaded();
    await waitFor(() => expect(actions.suggestion).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /^Use / })).toBeNull();
    fireEvent.click(field("DTCC #"));
    expect(editor("DTCC #").value).toBe("0443");
    fireEvent.change(editor("DTCC #"), { target: { value: "0777" } });
    fireEvent.blur(editor("DTCC #"));
    await waitFor(() => expect(actions.change).toHaveBeenCalledWith("rec-1", "dtccNumber", "0777", { direction: "In", identityVersion: 4 }));
    await waitFor(() => expect(field("DTCC #").textContent).toContain("0777"));
    markCase(SUITE, "tkt332 shell: a stored DTCC offers no suggestion and still accepts a manual value");
  });

  it("tkt332 shell: the notes banner and control number save through the free-text action", async () => {
    actions.text.mockImplementation(async (_id: string, key: string, value: string) => ({
      ok: true, transfer: transfer({ [key]: value }),
    }));
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    const notes = screen.getByLabelText("Notes");
    fireEvent.change(notes, { target: { value: "New note" } });
    fireEvent.blur(notes);
    await waitFor(() => expect(actions.text).toHaveBeenCalledWith("rec-1", "notes", "New note"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit notes" }).textContent).toContain("New note"));
    fireEvent.click(field("Control #"));
    fireEvent.change(editor("Control #"), { target: { value: "CTRL-2" } });
    fireEvent.blur(editor("Control #"));
    await waitFor(() => expect(actions.text).toHaveBeenCalledWith("rec-1", "controlNumber", "CTRL-2"));
    expect(actions.change).not.toHaveBeenCalled();
    cleanup();
    actions.load.mockResolvedValue({ ok: true, transfer: transfer({ notes: "" }) });
    await loaded();
    expect(screen.getByRole("button", { name: "+ Add notes" })).toBeTruthy();
    markCase(SUITE, "tkt332 shell: the notes banner and control number save through the free-text action");
  });

  it("tkt332 shell: dialogs trap Tab and Escape closes only the dialog", async () => {
    await loaded();
    const keys: string[] = [];
    const onWindowKey = (event: KeyboardEvent) => { keys.push(event.key); };
    window.addEventListener("keydown", onWindowKey);
    fireEvent.click(screen.getByRole("button", { name: "Mark Complete" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Apex Completion Date/), { target: { value: "2026-10-12" } });
    const confirm = within(dialog).getByRole("button", { name: "Confirm Complete" });
    confirm.focus();
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(document.activeElement).toBe(within(dialog).getByLabelText(/Apex Completion Date/));
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(confirm, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(keys).toEqual(["Tab", "Tab"]);
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Status")).toBeTruthy();
    window.removeEventListener("keydown", onWindowKey);
    markCase(SUITE, "tkt332 shell: dialogs trap Tab and Escape closes only the dialog");
  });

  it("tkt332 shell: a mapping-invalidation refusal shows the tracker confirm copy and resubmits only after acknowledgement", async () => {
    actions.replace.mockResolvedValueOnce(fail(MAPPING_REFUSAL, false, { code: "MAPPING_INVALIDATION_REQUIRED" }));
    await loaded();
    const dialog = await openClientDialogAndPick();
    const save = within(dialog).getByRole("button", { name: "Save client link" });
    await waitFor(() => expect(disabled(save)).toBe(false));
    fireEvent.click(save);
    expect((await within(dialog).findByRole("alert")).textContent).toBe(MAPPING_REFUSAL);
    expect(actions.replace.mock.calls[0][1].acknowledgeMappingInvalidation).toBe(false);
    const checkbox = within(dialog).getByLabelText(/I understand that a changed name clears the saved statement-account mapping link/);
    expect(disabled(save)).toBe(true);
    actions.replace.mockResolvedValueOnce({ ok: true, transfer: transfer({ clientName: "Sam Selected" }) });
    fireEvent.click(checkbox);
    expect(disabled(save)).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(actions.replace).toHaveBeenCalledTimes(2);
    expect(actions.replace.mock.calls[1][1].acknowledgeMappingInvalidation).toBe(true);
    markCase(SUITE, "tkt332 shell: a mapping-invalidation refusal shows the tracker confirm copy and resubmits only after acknowledgement");
  });

  it("tkt332 shell: Save client link stays disabled until a search returns a fresh client directory", async () => {
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Review client link" }));
    const dialog = await screen.findByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "Save client link" });
    fireEvent.change(within(dialog).getByLabelText("Reason for this change"), { target: { value: "Name fixed" } });
    expect(disabled(save)).toBe(true);
    expect(within(dialog).getByText("Search for a client to check the directory.")).toBeTruthy();
    actions.search.mockResolvedValueOnce({ ok: true, clients: [], hasMore: false, directory: STALE });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add another person" }));
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "Sam" } });
    expect(await within(dialog).findByText("The client directory needs a fresh verified update before linking.")).toBeTruthy();
    expect(disabled(save)).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Check directory again" }));
    await waitFor(() => expect(disabled(save)).toBe(false));
    expect(within(dialog).queryByText("The client directory needs a fresh verified update before linking.")).toBeNull();
    actions.search.mockResolvedValueOnce({ ok: true, clients: [], hasMore: false, directory: null });
    fireEvent.click(within(dialog).getByRole("combobox"));
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "Samu" } });
    await waitFor(() => expect(disabled(save)).toBe(true));
    expect(within(dialog).getByText("Client verification is unavailable. Linking is paused.")).toBeTruthy();
    markCase(SUITE, "tkt332 shell: Save client link stays disabled until a search returns a fresh client directory");
  });

  it("tkt332 shell: an unmappable saved transfer is shown as a retryable failure and Retry reloads the stored transfer", async () => {
    actions.status.mockResolvedValue({ ok: true, transfer: { ...transfer({ status: "Accepted" }), id: "   " } });
    await loaded();
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "Accepted" } });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(ACAT_WRITE_UNAVAILABLE);
    expect(handlers.onChanged).not.toHaveBeenCalled();
    expect(actions.status).toHaveBeenCalledTimes(1);
    actions.load.mockResolvedValue({ ok: true, transfer: transfer({ status: "Accepted" }) });
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(actions.load).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(actions.status).toHaveBeenCalledTimes(1);
    expect(handlers.onChanged).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("Accepted");
    markCase(SUITE, "tkt332 shell: an unmappable saved transfer is shown as a retryable failure and Retry reloads the stored transfer");
  });

  it("tkt332 shell: read-only mode hides every write control and keeps navigation and stats", async () => {
    actions.load.mockResolvedValue({ ok: true, transfer: transfer({ notes: "" }) });
    actions.suggestion.mockResolvedValue({ ok: true, status: "suggested", dtccNumber: "0443" });
    const view = await loaded({ readOnly: true, admin: true });
    expect(screen.queryByRole("button", { name: "Mark Complete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete ACAT record" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Link client" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Review link" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Review client link" })).toBeNull();
    expect(disabled(screen.getByLabelText("Status"))).toBe(true);
    expect(screen.queryByRole("button", { name: "Edit Direction" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Add notes" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Use / })).toBeNull();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Pat Example");
    expect(disabled(screen.getByRole("button", { name: "Previous record" }))).toBe(false);
    expect(disabled(screen.getByRole("button", { name: "Next record" }))).toBe(false);
    expect(view.container.querySelector('[data-stat="total"]')?.textContent).toBe("Total Assets4");
    expect(actions.suggestion).not.toHaveBeenCalled();
    expect(actions.contras).not.toHaveBeenCalled();
    expect(actions.search).not.toHaveBeenCalled();
    await act(async () => { await Promise.resolve(); });
    markCase(SUITE, "tkt332 shell: read-only mode hides every write control and keeps navigation and stats");
  });
});
