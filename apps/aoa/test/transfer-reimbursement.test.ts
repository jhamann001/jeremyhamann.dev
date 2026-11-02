// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const actions = vi.hoisted(() => ({
  load: vi.fn(), save: vi.fn(), apply: vi.fn(), rules: vi.fn(),
  preview: vi.fn(), pending: vi.fn(), submit: vi.fn(), search: vi.fn(),
}));
// The fee-actions mock has no reimbursement-log action (ticket), and the reimbursement actions are the only
// write the preview can reach: a component that called a tracker log write would fail to render.
vi.mock("@/app/(authenticated)/acat-tracking/fee-actions", () => ({
  loadTransferFee: actions.load,
  saveTransferFeeField: actions.save,
  applyTransferFeeRules: actions.apply,
  loadFeeRules: actions.rules,
}));
vi.mock("@/app/(authenticated)/acat-tracking/reimbursement-actions", () => ({
  previewTransferReimbursement: actions.preview,
  lookupPendingReimbursements: actions.pending,
  submitTransferReimbursement: actions.submit,
}));
vi.mock("@/app/(authenticated)/operations/fee-requests/actions", () => ({ searchOperationsFeeClients: actions.search }));

import { TransferFeeSection, type TransferFeeRecord } from "@/components/transfers/TransferFeeSection";
import { isSubmissionKey } from "@/lib/data/acat-reimbursement-view";

const SUITE = "transfer-reimbursement";
const FEE_REQUESTS = "/operations/fee-requests";
const PAT = "003BLO191836131AAA";
const SAM = "003MLO108774638AAA";

const EMPTY = {
  feeCharged: null, feeAmount: null, feeMemo: null, feeRequestSubmitted: null, feeRequestCompleted: null, feeApexTicket: null, feeCreditRequestId: null,
};
const CHARGED = { ...EMPTY, feeCharged: "Yes", feeAmount: "$50.00", feeMemo: "ACAT Transfer Fee: $50.00", feeApexTicket: "APX-77" };
const RECORD: TransferFeeRecord = {
  clientName: "Pat Example", direction: "Out", type: "Partial", status: "Submitted", transferringContra: "Fidelity",
  custodianName: "Fidelity Investments", controlNumber: "CTRL-9", apexAccountId: "********ZHLK", custodianId: "cust-1",
  transferWorkflow: null, cedarRidgeUserId: "user-1",
};
const ACCOUNTS = [
  { id: "acct-1", label: "IRA · ••••ZHLK", status: "OPEN", matchesTransfer: true },
  { id: "acct-2", label: "Brokerage · ••••ZZZZ", status: "OPEN", matchesTransfer: false },
];
const CLIENT = { clientSfId: PAT, name: "Pat Example", householdName: "Example Household", accounts: ACCOUNTS };
const PREFILL = { client: CLIENT, clientSource: "transfer-link", accountId: "acct-1", pending: [] };
const REQUEST = {
  id: "req_000000000000001", status: "PENDING", clientName: "Pat Example", accountLabel: "IRA · ••••ZHLK",
  feeAmount: "50.00", feeTypes: ["ACAT out"], submittedAt: "2026-10-15T12:00:00.000Z",
};
const ok = (fee: Record<string, unknown>) => ({ ok: true, fee, log: null });

function setup(opts: { reimbursement?: boolean; fee?: unknown; prefill?: unknown; record?: Partial<TransferFeeRecord>; href?: string | null } = {}) {
  actions.load.mockResolvedValue(opts.fee ?? ok(CHARGED));
  actions.rules.mockResolvedValue({ ok: true, rules: [] });
  actions.preview.mockResolvedValue(opts.prefill ?? { ok: true, prefill: PREFILL });
  actions.pending.mockResolvedValue({ ok: true, pending: [] });
  actions.submit.mockResolvedValue({ ok: true, request: REQUEST });
  actions.search.mockResolvedValue([]);
  return render(createElement(TransferFeeSection, {
    recordId: "rec-1", refreshToken: "", record: { ...RECORD, ...(opts.record ?? {}) },
    feeRequestsHref: opts.href === undefined ? FEE_REQUESTS : opts.href, reimbursement: opts.reimbursement ?? true,
  }));
}

async function ready() {
  await waitFor(() => expect((screen.getByLabelText("Edit Fee Amount") as HTMLButtonElement).disabled).toBe(false));
  await waitFor(() => expect(screen.queryByText("Loading custodian fee schedule...")).toBeNull());
}
async function openPreview(opts: Parameters<typeof setup>[0] = {}) {
  setup(opts);
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Log Reimbursement" }));
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(within(dialog).queryByText("Loading the reimbursement details...")).toBeNull());
  return dialog;
}

const confirmButton = () => screen.getByRole("button", { name: "Confirm and Submit" }) as HTMLButtonElement;
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const submitted = () => actions.submit.mock.calls.map((call) => call[0]);

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

describe("log reimbursement preview and confirm (ticket)", () => {
  it("with the release off, Log Reimbursement is still the link to Operations Tools and nothing is previewed", async () => {
    setup({ reimbursement: false });
    await ready();
    const link = screen.getByRole("link", { name: "Log Reimbursement in Operations Tools" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(FEE_REQUESTS);
    expect(screen.queryByRole("button", { name: "Log Reimbursement" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(actions.preview).not.toHaveBeenCalled();
    expect(actions.submit).not.toHaveBeenCalled();
    markCase(SUITE, "with the release off, Log Reimbursement is still the link to Operations Tools and nothing is previewed");
  });

  it("with the release on, Log Reimbursement is a button, the history link stays, and the tracker is not written", async () => {
    setup();
    await ready();
    expect(screen.getByRole("button", { name: "Log Reimbursement" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Log Reimbursement in Operations Tools" })).toBeNull();
    const history = screen.getByRole("link", { name: /Open Operations Tools fee requests/ }) as HTMLAnchorElement;
    expect(history.getAttribute("href")).toBe(FEE_REQUESTS);
    expect(screen.getByText("Log Reimbursement opens a preview. Nothing is submitted until you confirm it.")).toBeTruthy();
    expect(actions.save).not.toHaveBeenCalled();
    expect(actions.apply).not.toHaveBeenCalled();
    markCase(SUITE, "with the release on, Log Reimbursement is a button, the history link stays, and the tracker is not written");
  });

  it("opens a preview prefilled from the transfer and writes nothing until confirmed", async () => {
    const dialog = await openPreview();
    expect(actions.preview).toHaveBeenCalledWith("rec-1", { cedarRidgeUserId: "user-1", maskedAccount: "********ZHLK" });
    expect(within(dialog).getByRole("heading", { name: "Review Reimbursement Request" })).toBeTruthy();
    const client = within(dialog).getByTestId("reimbursement-client");
    expect(client.textContent).toContain("Pat Example");
    expect(client.textContent).toContain("Household: Example Household");
    expect(client.textContent).toContain("Prefilled from the client linked to this transfer.");
    const account = field("Apex account") as unknown as HTMLSelectElement;
    expect(account.value).toBe("acct-1");
    expect([...account.options].map((o) => o.textContent)).toEqual([
      "Choose an account", "IRA · ••••ZHLK · OPEN · matches this transfer", "Brokerage · ••••ZZZZ · OPEN",
    ]);
    expect(within(dialog).getByText("This transfer's Apex account is ********ZHLK.")).toBeTruthy();
    expect(field("Fee amount").value).toBe("50.00");
    expect((screen.getByRole("checkbox", { name: "ACAT out" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "ACAT in" }) as HTMLInputElement).checked).toBe(false);
    expect(field("Reason").value).toBe("ACAT transfer fee reimbursement for the Fidelity transfer. Control # CTRL-9. ACAT record rec-1.");
    expect(field("Relevant tickets").value).toBe("APX-77");
    expect(confirmButton().disabled).toBe(false);
    expect(actions.submit).not.toHaveBeenCalled();
    markCase(SUITE, "opens a preview prefilled from the transfer and writes nothing until confirmed");
  });

  it("Cancel and Escape close the preview and write nothing", async () => {
    await openPreview();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const spy = vi.fn();
    window.addEventListener("keydown", spy);
    fireEvent.click(screen.getByRole("button", { name: "Log Reimbursement" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    window.removeEventListener("keydown", spy);
    expect(spy).not.toHaveBeenCalled();
    expect(actions.submit).not.toHaveBeenCalled();
    markCase(SUITE, "Cancel and Escape close the preview and write nothing");
  });

  it("the Close button and a click on the backdrop close the preview and write nothing", async () => {
    const dialog = await openPreview();
    fireEvent.mouseDown(dialog);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Log Reimbursement" }));
    const again = await screen.findByRole("dialog");
    fireEvent.mouseDown(again.parentElement as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(actions.submit).not.toHaveBeenCalled();
    markCase(SUITE, "the Close button and a click on the backdrop close the preview and write nothing");
  });

  it("edit then confirm sends the edited values once and shows the Pending request", async () => {
    await openPreview();
    fireEvent.change(field("Apex account"), { target: { value: "acct-2" } });
    fireEvent.change(field("Fee amount"), { target: { value: "$75.25" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "ACAT out" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Wire" }));
    fireEvent.change(field("Reason"), { target: { value: "Edited reason" } });
    fireEvent.change(field("Relevant tickets"), { target: { value: "APX-1\nAPX-2" } });
    fireEvent.click(confirmButton());
    await waitFor(() => expect(actions.submit).toHaveBeenCalledTimes(1));
    const [input] = submitted();
    expect(input).toMatchObject({
      clientSfId: PAT, accountId: "acct-2", feeAmount: "75.25", feeTypes: ["Wire"], reason: "Edited reason", tickets: "APX-1\nAPX-2",
    });
    expect(isSubmissionKey(input.submissionKey)).toBe(true);
    const card = await screen.findByTestId("reimbursement-submitted");
    expect(card.textContent).toContain("Reimbursement Submitted");
    expect(card.textContent).toContain("Pending");
    expect(card.textContent).toContain("Pat Example");
    const open = within(card).getByRole("link", { name: "Open this request in Operations Tools" }) as HTMLAnchorElement;
    expect(open.getAttribute("href")).toBe(`${FEE_REQUESTS}?request=${REQUEST.id}#request-${REQUEST.id}`);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Log Another Reimbursement" })).toBeTruthy();
    markCase(SUITE, "edit then confirm sends the edited values once and shows the Pending request");
  });

  it("a double click on Confirm creates one request", async () => {
    await openPreview();
    let release: (value: unknown) => void = () => {};
    actions.submit.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const button = confirmButton();
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.submit(screen.getByTestId("reimbursement-dialog").querySelector("form") as HTMLFormElement);
    await waitFor(() => expect((screen.getByRole("button", { name: "Submitting..." }) as HTMLButtonElement).disabled).toBe(true));
    expect(actions.submit).toHaveBeenCalledTimes(1);
    release({ ok: true, request: REQUEST });
    await screen.findByTestId("reimbursement-submitted");
    expect(actions.submit).toHaveBeenCalledTimes(1);
    markCase(SUITE, "a double click on Confirm creates one request");
  });

  it("cannot confirm without a real client and one of its accounts", async () => {
    await openPreview({ prefill: { ok: true, prefill: { client: CLIENT, clientSource: "transfer-link", accountId: null, pending: [] } } });
    expect(confirmButton().disabled).toBe(true);
    expect(screen.getByText("Complete: Apex account")).toBeTruthy();
    expect(screen.getByText("The account could not be resolved from this transfer. Choose the account.")).toBeTruthy();
    fireEvent.click(confirmButton());
    expect(actions.submit).not.toHaveBeenCalled();
    fireEvent.change(field("Apex account"), { target: { value: "acct-2" } });
    expect(confirmButton().disabled).toBe(false);
    markCase(SUITE, "cannot confirm without a real client and one of its accounts");
  });

  it("with no client resolved, shows the search, asks for a client, and saves the chosen client's id, never its name", async () => {
    await openPreview({ prefill: { ok: true, prefill: { client: null, clientSource: "conflict", accountId: null, pending: [] } } });
    expect(screen.getByText(/point to different clients, so none is chosen/)).toBeTruthy();
    expect(confirmButton().disabled).toBe(true);
    expect(screen.getByText("Complete: Client, Apex account")).toBeTruthy();
    actions.search.mockResolvedValue([{ clientSfId: SAM, name: "Sam Example", householdName: null, accounts: [{ id: "acct-7", label: "Roth · ••••7777", status: "OPEN" }] }]);
    fireEvent.change(field("Search for a client"), { target: { value: "Sam" } });
    const option = await screen.findByRole("option", { name: /Sam Example/ });
    expect(actions.search).toHaveBeenCalledWith("Sam");
    fireEvent.click(option);
    expect(screen.getByTestId("reimbursement-client").textContent).toContain("Sam Example");
    expect(confirmButton().disabled).toBe(true);
    fireEvent.change(field("Apex account"), { target: { value: "acct-7" } });
    fireEvent.click(confirmButton());
    await waitFor(() => expect(actions.submit).toHaveBeenCalledTimes(1));
    expect(submitted()[0]).toMatchObject({ clientSfId: SAM, accountId: "acct-7" });
    expect(JSON.stringify(submitted()[0])).not.toContain("Sam Example");
    markCase(SUITE, "with no client resolved, shows the search, asks for a client, and saves the chosen client's id, never its name");
  });

  it("changing the client clears the account so it must be chosen again", async () => {
    await openPreview();
    fireEvent.click(screen.getByRole("button", { name: "Change client" }));
    actions.search.mockResolvedValue([{ clientSfId: SAM, name: "Sam Example", householdName: null, accounts: [{ id: "acct-7", label: "Roth · ••••7777", status: "OPEN" }] }]);
    fireEvent.change(field("Search for a client"), { target: { value: "Sam" } });
    fireEvent.click(await screen.findByRole("option", { name: /Sam Example/ }));
    expect((field("Apex account") as unknown as HTMLSelectElement).value).toBe("");
    expect(confirmButton().disabled).toBe(true);
    markCase(SUITE, "changing the client clears the account so it must be chosen again");
  });

  it("shows Pending requests already on file and still lets Confirm create another", async () => {
    const pending = [{ id: "req_000000000000009", feeAmount: "50.00", feeTypes: ["ACAT out"], submittedAt: "2026-10-14T12:00:00.000Z" }];
    await openPreview({ prefill: { ok: true, prefill: { ...PREFILL, pending } } });
    const box = screen.getByTestId("reimbursement-pending");
    expect(box.textContent).toContain("Pending requests already on file for this client and account");
    expect(box.textContent).toContain("$50.00 · ACAT out · 2026-10-14");
    expect(within(box).getByRole("link", { name: "Open" }).getAttribute("href")).toBe(`${FEE_REQUESTS}?request=req_000000000000009#request-req_000000000000009`);
    expect(confirmButton().disabled).toBe(false);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(actions.submit).toHaveBeenCalledTimes(1));
    markCase(SUITE, "shows Pending requests already on file and still lets Confirm create another");
  });

  it("looks up the Pending requests again for the account the user picks", async () => {
    await openPreview();
    actions.pending.mockResolvedValue({ ok: true, pending: [{ id: "req_000000000000008", feeAmount: "10.00", feeTypes: ["Wire"], submittedAt: "2026-10-13T12:00:00.000Z" }] });
    fireEvent.change(field("Apex account"), { target: { value: "acct-2" } });
    await waitFor(() => expect(actions.pending).toHaveBeenCalledWith(PAT, "acct-2"));
    expect((await screen.findByTestId("reimbursement-pending")).textContent).toContain("$10.00 · Wire");
    markCase(SUITE, "looks up the Pending requests again for the account the user picks");
  });

  it("a failed submit shows the reason, keeps the form, and the retry reuses the same key and creates one card", async () => {
    await openPreview();
    actions.submit.mockResolvedValueOnce({ ok: false, code: "failed", field: null });
    fireEvent.click(confirmButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The request could not be submitted. Try again; submitting again will not create a second request from this form.");
    expect(screen.queryByTestId("reimbursement-submitted")).toBeNull();
    expect(field("Fee amount").value).toBe("50.00");
    fireEvent.click(confirmButton());
    await screen.findByTestId("reimbursement-submitted");
    expect(actions.submit).toHaveBeenCalledTimes(2);
    expect(submitted()[1].submissionKey).toBe(submitted()[0].submissionKey);
    expect(screen.getAllByTestId("reimbursement-submitted")).toHaveLength(1);
    markCase(SUITE, "a failed submit shows the reason, keeps the form, and the retry reuses the same key and creates one card");
  });

  it("a thrown submit is reported as retryable and a different preview gets a different key", async () => {
    await openPreview();
    actions.submit.mockRejectedValueOnce(new Error("network"));
    fireEvent.click(confirmButton());
    expect((await screen.findByRole("alert")).textContent).toContain("could not be submitted");
    fireEvent.click(confirmButton());
    await screen.findByTestId("reimbursement-submitted");
    const firstKey = submitted()[0].submissionKey;
    fireEvent.click(screen.getByRole("button", { name: "Log Another Reimbursement" }));
    await screen.findByRole("dialog");
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(actions.submit).toHaveBeenCalledTimes(3));
    expect(submitted()[2].submissionKey).not.toBe(firstKey);
    markCase(SUITE, "a thrown submit is reported as retryable and a different preview gets a different key");
  });

  it("explains a conflict instead of retrying silently", async () => {
    await openPreview();
    actions.submit.mockResolvedValueOnce({ ok: false, code: "conflict", field: null });
    fireEvent.click(confirmButton());
    expect((await screen.findByRole("alert")).textContent).toContain("already submitted with different values");
    markCase(SUITE, "explains a conflict instead of retrying silently");
  });

  it("marks the field the server refused", async () => {
    await openPreview();
    actions.submit.mockResolvedValueOnce({ ok: false, code: "invalid", field: "amount" });
    fireEvent.click(confirmButton());
    await waitFor(() => expect(field("Fee amount").getAttribute("aria-invalid")).toBe("true"));
    markCase(SUITE, "marks the field the server refused");
  });

  it("a failed preview load says so and Retry loads it again", async () => {
    setup({ prefill: { ok: false, code: "unavailable" } });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Log Reimbursement" }));
    await screen.findByText("The reimbursement details could not be loaded.");
    expect(screen.queryByRole("button", { name: "Confirm and Submit" })).toBeNull();
    actions.preview.mockResolvedValue({ ok: true, prefill: PREFILL });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    expect(actions.preview).toHaveBeenCalledTimes(2);
    expect(actions.submit).not.toHaveBeenCalled();
    markCase(SUITE, "a failed preview load says so and Retry loads it again");
  });

  it("does not open a preview until a fee amount above zero is entered", async () => {
    setup({ fee: ok({ ...EMPTY, feeCharged: "Yes", feeAmount: "$0.00" }), record: { direction: "Out", type: "Full" } });
    await ready();
    expect(screen.getByText("Review needed", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("Fee Details Need Review")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Log Reimbursement|Enter Fee Amount First/ })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(actions.preview).not.toHaveBeenCalled();
    expect(actions.submit).not.toHaveBeenCalled();
    markCase(SUITE, "does not open a preview until a fee amount above zero is entered");
  });

  it("keeps the preview disabled when a charge is recorded without an amount", async () => {
    setup({ fee: ok({ ...EMPTY, feeCharged: "Yes", feeAmount: null }), record: { direction: "Out", type: "Full" } });
    await ready();
    expect(screen.getByText("Amount not recorded")).toBeTruthy();
    const button = screen.getByRole("button", { name: /Enter Fee Amount First/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(actions.preview).not.toHaveBeenCalled();
    expect(actions.submit).not.toHaveBeenCalled();
  });

  it("the preview and section source never call the tracker log write or FeeStore", () => {
    for (const path of ["components/transfers/TransferReimbursementDialog.tsx", "components/transfers/TransferFeeSection.tsx", "app/(authenticated)/acat-tracking/reimbursement-actions.ts"]) {
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toMatch(/logTransferReimbursement|action:\s*"log"|feeStore|TRANSFER_TRACKER_URL|Open Transfer Tracker|\/api\/fees/i);
    }
    const dialog = readFileSync("components/transfers/TransferReimbursementDialog.tsx", "utf8");
    expect(dialog).not.toMatch(/fee-actions|acat-fee"|postTransferFee/);
    markCase(SUITE, "the preview and section source never call the tracker log write or FeeStore");
  });
});
