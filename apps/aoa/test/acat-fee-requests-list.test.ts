// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const actions = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), apply: vi.fn(), rules: vi.fn(), requests: vi.fn() }));
// The fee-actions mock deliberately has no reimbursement-log action: the section cannot call the tracker log write.
vi.mock("@/app/(authenticated)/acat-tracking/fee-actions", () => ({
  loadTransferFee: actions.load,
  saveTransferFeeField: actions.save,
  applyTransferFeeRules: actions.apply,
  loadFeeRules: actions.rules,
}));
vi.mock("@/app/(authenticated)/acat-tracking/fee-requests-actions", () => ({ loadTransferFeeRequests: actions.requests }));

import { TransferFeeRequestsList } from "@/components/transfers/TransferFeeRequestsList";
import { TransferFeeSection, type TransferFeeRecord } from "@/components/transfers/TransferFeeSection";
import type { TransferFeeRequest, TransferFeeRequestsRead } from "@/lib/data/acat-fee-requests-view";

const SUITE = "acat-fee-requests-list";
const HREF = "/operations/fee-requests";
const EMPTY = {
  feeCharged: null, feeAmount: null, feeMemo: null, feeRequestSubmitted: null, feeRequestCompleted: null,
  feeApexTicket: null, feeCreditRequestId: null,
};
const CHARGED = { ...EMPTY, feeCharged: "Yes", feeAmount: "$50.00" };
const RECORD: TransferFeeRecord = {
  clientName: "Pat Example", direction: "In", type: "Partial", status: "Submitted", transferringContra: "Fidelity",
  custodianName: "Fidelity Investments", controlNumber: "CTRL-9", apexAccountId: "****1111", custodianId: "cust-1", transferWorkflow: null,
  cedarRidgeUserId: "user-1",
};

const item = (id: string, status: TransferFeeRequest["status"], over: Partial<TransferFeeRequest> = {}): TransferFeeRequest => ({
  id, kind: "FEE_CREDIT", status, feeAmount: "50.00", feeTypes: ["ACAT out"], submittedAt: "2026-10-14T12:00:00.000Z", creditedAt: null, ...over,
});
const resolved = (requests: TransferFeeRequest[], over: Partial<Extract<TransferFeeRequestsRead, { identity: "resolved" }>> = {}): TransferFeeRequestsRead => ({
  identity: "resolved", clientName: "Pat Example", accountLabel: "IRA · ••••1111", requests, truncated: false, ...over,
});
const ok = (read: TransferFeeRequestsRead) => ({ ok: true, read });
const FIVE = [
  item("req_1", "PENDING"), item("req_2", "APPROVED"), item("req_3", "REJECTED"), item("req_4", "CANCELLED"),
  item("req_5", "CREDITED", { feeAmount: "10.00", feeTypes: ["ACAT in", "Wire"], creditedAt: "2026-10-10T00:00:00.000Z" }),
];

function mountSection(opts: { requests?: unknown; requestsOnFile?: boolean; href?: string | null; fee?: unknown } = {}) {
  actions.load.mockResolvedValue(opts.fee ?? { ok: true, fee: CHARGED, log: null });
  actions.rules.mockResolvedValue({ ok: true, rules: [] });
  actions.requests.mockResolvedValue(opts.requests ?? ok(resolved([])));
  const href = opts.href === undefined ? HREF : opts.href;
  const props = { recordId: "rec-1", refreshToken: "", record: RECORD, feeRequestsHref: href, requestsOnFile: opts.requestsOnFile ?? true };
  const view = render(createElement(TransferFeeSection, props));
  const again = (refreshToken: string) => view.rerender(createElement(TransferFeeSection, { ...props, refreshToken }));
  return { ...view, again };
}
const card = () => screen.findByTestId("fee-requests-on-file");
const ready = () => waitFor(() => expect((screen.getByLabelText("Edit Fee Amount") as HTMLButtonElement).disabled).toBe(false));

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("requests on file in the fee section (ticket)", () => {
  it("lists every request with the five statuses as separate labels, with amount, fee types and dates", async () => {
    mountSection({ requests: ok(resolved(FIVE)) });
    const list = within(await card());
    await waitFor(() => expect(list.getAllByTestId("fee-request-on-file")).toHaveLength(5));
    const rows = list.getAllByTestId("fee-request-on-file").map((node) => node.textContent ?? "");
    const labels = ["Pending", "Approved", "Rejected", "Cancelled", "Credited"];
    labels.forEach((label, index) => expect(rows[index]).toContain(label));
    expect(new Set(labels.map((label) => rows.filter((row) => row.includes(label)).length))).toEqual(new Set([1]));
    expect(rows[0]).toContain("$50.00");
    expect(rows[0]).toContain("Fee credit · ACAT out");
    expect(rows[0]).toContain("Submitted 10-14-2026");
    expect(rows[4]).toContain("$10.00");
    expect(rows[4]).toContain("Fee credit · ACAT in · Wire");
    expect(rows[4]).toContain("Credited 10-10-2026");
    FIVE.forEach((request, index) => expect(rows[index]).toContain(`Request ID ${request.id}`));
    expect(list.queryByText("Linked to this transfer")).toBeNull();
    expect(list.getByText("Pat Example · IRA · ••••1111")).toBeTruthy();
    expect(actions.requests).toHaveBeenCalledTimes(1);
    expect(actions.requests).toHaveBeenCalledWith("rec-1", { cedarRidgeUserId: "user-1", maskedAccount: "****1111" });
    markCase(SUITE, "lists every request with the five statuses as separate labels, with amount, fee types and dates");
  });

  it.each(["req_pending", "req_credited"])("marks only the exact stored request %s as linked, irrespective of account-wide statuses", async feeCreditRequestId => {
    actions.requests.mockResolvedValue(ok(resolved([
      item("req_pending", "PENDING"),
      item("req_credited", "CREDITED", { creditedAt: "2026-10-10T00:00:00.000Z" }),
    ])));
    const view = render(createElement(TransferFeeRequestsList, {
      recordId: "rec-1", cedarRidgeUserId: null, maskedAccount: "****1111", feeRequestsHref: HREF,
      reloadKey: 0, feeCreditRequestId,
    }));
    const list = within(view.container);
    await waitFor(() => expect(list.getAllByTestId("fee-request-on-file")).toHaveLength(2));
    const rows = list.getAllByTestId("fee-request-on-file");
    for (const row of rows) {
      const linked = row.textContent?.includes(`Request ID ${feeCreditRequestId}`);
      expect(within(row).queryByText("Linked to this transfer") !== null).toBe(linked);
    }
    expect(list.getAllByText("Linked to this transfer")).toHaveLength(1);
    expect(list.getByText("Pending")).toBeTruthy();
    expect(list.getByText("Credited")).toBeTruthy();
  });

  it("updates the exact link when its stored id changes without re-reading requests, and never links an unknown id", async () => {
    actions.requests.mockResolvedValue(ok(resolved([item("req_1", "PENDING"), item("req_2", "CREDITED")])));
    const props = { recordId: "rec-1", cedarRidgeUserId: null, maskedAccount: "****1111", feeRequestsHref: HREF, reloadKey: 0 };
    const view = render(createElement(TransferFeeRequestsList, { ...props, feeCreditRequestId: "req_1" }));
    const list = within(view.container);
    await list.findByText("Linked to this transfer");
    expect(list.getByText("Linked to this transfer").closest("li")?.textContent).toContain("Request ID req_1");
    view.rerender(createElement(TransferFeeRequestsList, { ...props, feeCreditRequestId: "req_2" }));
    expect(list.getByText("Linked to this transfer").closest("li")?.textContent).toContain("Request ID req_2");
    for (const feeCreditRequestId of ["unknown-id", "REQ_2", " req_2 ", "", null, undefined]) {
      view.rerender(createElement(TransferFeeRequestsList, { ...props, feeCreditRequestId }));
      expect(list.queryByText("Linked to this transfer")).toBeNull();
    }
    expect(actions.requests).toHaveBeenCalledTimes(1);
  });

  it("labels the kind of every request, so a service guarantee or a billing exception is never read as a fee credit", async () => {
    mountSection({ requests: ok(resolved([
      item("req_1", "APPROVED", { kind: "SERVICE_GUARANTEE", feeAmount: null, feeTypes: [] }),
      item("req_2", "PENDING", { kind: "BILLING_EXCEPTION", feeAmount: null, feeTypes: [] }),
      item("req_3", "CANCELLED", { kind: "LARGE_HOUSEHOLD_EXCEPTION", feeAmount: null, feeTypes: [] }),
    ])) });
    const list = within(await card());
    await waitFor(() => expect(list.getAllByTestId("fee-request-on-file")).toHaveLength(3));
    const text = list.getAllByTestId("fee-request-on-file").map((node) => node.textContent ?? "");
    expect(text[0]).toContain("Service guarantee");
    expect(text[1]).toContain("Billing exception");
    expect(text[2]).toContain("Large household exception");
    expect(text.join(" ")).not.toContain("Fee credit");
    expect(text[0]).toContain("—");
    markCase(SUITE, "labels the kind of every request, so a service guarantee or a billing exception is never read as a fee credit");
  });

  it("links each request to Operations Tools only when the destination is available, never anywhere else", async () => {
    const view = mountSection({ requests: ok(resolved([item("req_1", "PENDING")])) });
    const list = within(await card());
    const open = await list.findByRole("link", { name: "Open" }) as HTMLAnchorElement;
    expect(open.getAttribute("href")).toBe(`${HREF}?request=req_1#request-req_1`);
    view.unmount();
    mountSection({ requests: ok(resolved([item("req_1", "PENDING")])), href: null });
    const bare = within(await card());
    await bare.findByTestId("fee-request-on-file");
    expect(bare.queryByRole("link")).toBeNull();
    markCase(SUITE, "links each request to Operations Tools only when the destination is available, never anywhere else");
  });

  it("says none are on file as a normal state: no alert, no Retry, no link", async () => {
    mountSection({ requests: ok(resolved([])), href: null });
    const list = within(await card());
    expect(await list.findByText("No reimbursement requests are on file for this client and account.")).toBeTruthy();
    expect(list.queryByRole("alert")).toBeNull();
    expect(list.queryByRole("button")).toBeNull();
    expect(list.queryByRole("link")).toBeNull();
    expect(document.querySelectorAll('a[href*="tracker"], a[target="_blank"]')).toHaveLength(0);
    markCase(SUITE, "says none are on file as a normal state: no alert, no Retry, no link");
  });

  it("says it cannot match the transfer, never that none are on file, when the client or the account is not resolved", async () => {
    for (const reason of ["client", "account"] as const) {
      const view = mountSection({ requests: ok({ identity: "unresolved", reason }), href: null });
      const list = within(await card());
      const text = reason === "client"
        ? "This transfer could not be matched to a specific client, so its existing requests are not shown."
        : "This transfer could not be matched to one Apex account, so its existing requests are not shown.";
      expect(await list.findByText(text)).toBeTruthy();
      expect(list.queryByText(/No reimbursement requests are on file/)).toBeNull();
      expect(list.queryByRole("alert")).toBeNull();
      expect(list.queryByRole("link")).toBeNull();
      view.unmount();
    }
    markCase(SUITE, "says it cannot match the transfer, never that none are on file, when the client or the account is not resolved");
  });

  it("shows a retryable failure that repeats only the read, keeps the fee fields usable, and never falls back to the tracker", async () => {
    mountSection({ requests: { ok: false, code: "unavailable" }, href: null });
    const list = within(await card());
    const alert = await list.findByRole("alert");
    expect(alert.textContent).toContain("The requests on file could not be loaded.");
    expect(list.queryByRole("link")).toBeNull();
    await ready();
    expect((screen.getByLabelText("Edit Fee Amount") as HTMLButtonElement).disabled).toBe(false);
    const loads = actions.load.mock.calls.length;
    const ruleLoads = actions.rules.mock.calls.length;
    actions.requests.mockResolvedValue(ok(resolved([item("req_1", "PENDING")])));
    await act(async () => { fireEvent.click(list.getByRole("button", { name: "Retry requests on file" })); });
    expect(await list.findByTestId("fee-request-on-file")).toBeTruthy();
    expect(actions.requests).toHaveBeenCalledTimes(2);
    expect(actions.load.mock.calls.length).toBe(loads);
    expect(actions.rules.mock.calls.length).toBe(ruleLoads);
    expect(actions.save).not.toHaveBeenCalled();
    markCase(SUITE, "shows a retryable failure that repeats only the read, keeps the fee fields usable, and never falls back to the tracker");
  });

  it("treats a thrown read as the same retryable failure", async () => {
    actions.requests.mockRejectedValueOnce(new Error("network")).mockResolvedValue(ok(resolved([])));
    const view = render(createElement(TransferFeeRequestsList, { recordId: "rec-2", cedarRidgeUserId: null, maskedAccount: null, feeRequestsHref: null, reloadKey: 0 }));
    expect(await within(view.container).findByRole("alert")).toBeTruthy();
    await act(async () => { fireEvent.click(within(view.container).getByRole("button", { name: "Retry requests on file" })); });
    expect(await within(view.container).findByText(/No reimbursement requests are on file/)).toBeTruthy();
    markCase(SUITE, "treats a thrown read as the same retryable failure");
  });

  it("reads once per open: a fee save, a fee reload and a re-render never read again", async () => {
    const view = mountSection({ requests: ok(resolved([item("req_1", "PENDING")])) });
    await ready();
    await card();
    await waitFor(() => expect(actions.requests).toHaveBeenCalledTimes(1));
    actions.save.mockResolvedValue({ ok: true, fee: { ...CHARGED, feeAmount: "$75.00" }, log: null });
    fireEvent.click(screen.getByLabelText("Edit Fee Amount"));
    const input = screen.getByLabelText("Fee Amount") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "$75.00" } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    await waitFor(() => expect(actions.save).toHaveBeenCalledTimes(1));
    view.again("changed");
    await waitFor(() => expect(actions.load).toHaveBeenCalledTimes(2));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    expect(actions.requests).toHaveBeenCalledTimes(1);
    markCase(SUITE, "reads once per open: a fee save, a fee reload and a re-render never read again");
  });

  it("reads again when the reload key changes and keeps the list on screen while it does", async () => {
    let finish: (value: unknown) => void = () => {};
    actions.requests.mockResolvedValueOnce(ok(resolved([item("req_1", "PENDING")])));
    const props = { recordId: "rec-1", cedarRidgeUserId: null, maskedAccount: "****1111", feeRequestsHref: HREF };
    const view = render(createElement(TransferFeeRequestsList, { ...props, reloadKey: 0 }));
    await within(view.container).findByText("Pending");
    actions.requests.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    view.rerender(createElement(TransferFeeRequestsList, { ...props, reloadKey: 1 }));
    await waitFor(() => expect(actions.requests).toHaveBeenCalledTimes(2));
    expect(within(view.container).getByText("Pending")).toBeTruthy();
    expect(within(view.container).queryByText("Checking the requests on file...")).toBeNull();
    await act(async () => { finish(ok(resolved([item("req_1", "PENDING"), item("req_9", "APPROVED")]))); });
    await waitFor(() => expect(within(view.container).getAllByTestId("fee-request-on-file")).toHaveLength(2));
    markCase(SUITE, "reads again when the reload key changes and keeps the list on screen while it does");
  });

  it("renders nothing when the action reports the release off or the role refused", async () => {
    for (const code of ["off", "forbidden"]) {
      const view = mountSection({ requests: { ok: false, code } });
      await waitFor(() => expect(actions.requests).toHaveBeenCalled());
      await ready();
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
      expect(screen.queryByTestId("fee-requests-on-file")).toBeNull();
      view.unmount();
      actions.requests.mockClear();
    }
    markCase(SUITE, "renders nothing when the action reports the release off or the role refused");
  });

  it("makes no read and shows no card unless the server enabled it", async () => {
    mountSection({ requestsOnFile: false });
    await ready();
    expect(actions.requests).not.toHaveBeenCalled();
    expect(screen.queryByTestId("fee-requests-on-file")).toBeNull();
    cleanup();
    actions.requests.mockClear();
    actions.load.mockResolvedValue({ ok: true, fee: CHARGED, log: null });
    actions.rules.mockResolvedValue({ ok: true, rules: [] });
    render(createElement(TransferFeeSection, { recordId: "rec-1", refreshToken: "", record: RECORD, feeRequestsHref: HREF }));
    await ready();
    expect(actions.requests).not.toHaveBeenCalled();
    markCase(SUITE, "makes no read and shows no card unless the server enabled it");
  });

  it("says when the list was cut at 50 and ignores an answer that arrives after the section is gone", async () => {
    mountSection({ requests: ok(resolved([item("req_1", "PENDING")], { truncated: true })) });
    expect(await within(await card()).findByText("Showing the 50 most recent requests. Open Operations Tools for the rest.")).toBeTruthy();
    cleanup();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let finish: (value: unknown) => void = () => {};
    actions.requests.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(createElement(TransferFeeRequestsList, { recordId: "rec-1", cedarRidgeUserId: null, maskedAccount: null, feeRequestsHref: null, reloadKey: 0 }));
    view.unmount();
    await act(async () => { finish(ok(resolved([item("req_1", "PENDING")]))); });
    expect(error).not.toHaveBeenCalled();
    markCase(SUITE, "says when the list was cut at 50 and ignores an answer that arrives after the section is gone");
  });
});
