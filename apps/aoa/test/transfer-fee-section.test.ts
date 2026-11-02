// @vitest-environment jsdom
import { createElement, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const actions = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), apply: vi.fn(), rules: vi.fn() }));
// The mock deliberately has no reimbursement-log action (ticket): a component that still imported
// one would fail to render, so a passing suite proves the section cannot call the tracker log write.
vi.mock("@/app/(authenticated)/acat-tracking/fee-actions", () => ({
  loadTransferFee: actions.load,
  saveTransferFeeField: actions.save,
  applyTransferFeeRules: actions.apply,
  loadFeeRules: actions.rules,
}));

import { TransferFeeSection, type TransferFeeRecord } from "@/components/transfers/TransferFeeSection";
import * as icons from "@/components/transfers/transfer-fee-icons";

const SUITE = "transfer-fee-section";
const FEE_REQUESTS = "/operations/fee-requests";

const EMPTY = {
  feeCharged: null, feeAmount: null, feeMemo: null, feeRequestSubmitted: null, feeRequestCompleted: null,
  feeApexTicket: null, feeCreditRequestId: null,
};
const CHARGED = { ...EMPTY, feeCharged: "Yes", feeAmount: "$50.00", feeMemo: "ACAT Transfer Fee: $50.00" };
const row = (over: Record<string, unknown> = {}) => ({ id: "77", status: "Pending", feeAmount: 50, feeType: "ACAT Transfer Fee", submissionDate: "2026-10-12T12:00:00.000Z", ...over });
const PENDING = row();
const ok = (fee: Record<string, unknown>, log: unknown[] | null = []) => ({ ok: true, fee, log });
const bad = (code: string, fee: Record<string, unknown> | null = null, log: unknown[] | null = null) => ({ ok: false, code, fee, log });
const RULES = [
  { id: "fee-1", feeType: "ACAT Transfer Fee", accountType: "ANY", transferType: "ANY", direction: "ANY", amount: 75, amountText: null, notes: null },
  { id: "fee-2", feeType: "Wire Fee", accountType: "IRA", transferType: "FULL", direction: "OUT", amount: null, amountText: "varies", notes: "Per request" },
];

const RECORD: TransferFeeRecord = {
  clientName: "Pat Example", direction: "In", type: "Partial", status: "Submitted", transferringContra: "Fidelity",
  custodianName: "Fidelity Investments", controlNumber: "CTRL-9", apexAccountId: "****1111", custodianId: "cust-1", transferWorkflow: null,
};
const FULL_OUT: TransferFeeRecord = { ...RECORD, direction: "Out", type: "Full" };

function setup(opts: {
  record?: Partial<TransferFeeRecord>; fee?: unknown; rules?: unknown; refreshToken?: string; neverLoad?: boolean;
  feeRequestsHref?: string | null;
  showSchedule?: boolean;
  readOnly?: boolean;
  reimbursement?: boolean;
  initialFee?: ComponentProps<typeof TransferFeeSection>["initialFee"];
} = {}) {
  actions.load.mockImplementation(() => opts.neverLoad ? new Promise(() => {}) : Promise.resolve(opts.fee ?? ok(EMPTY, [])));
  actions.rules.mockResolvedValue(opts.rules ?? { ok: true, rules: RULES });
  const record = { ...RECORD, ...(opts.record ?? {}) };
  const feeRequestsHref = opts.feeRequestsHref === undefined ? FEE_REQUESTS : opts.feeRequestsHref;
  const shared = { feeRequestsHref, showSchedule: opts.showSchedule, readOnly: opts.readOnly, reimbursement: opts.reimbursement, initialFee: opts.initialFee };
  const view = render(createElement(TransferFeeSection, { recordId: "rec-1", refreshToken: opts.refreshToken ?? "", record, ...shared }));
  const again = (token: string, next: Partial<TransferFeeRecord> = {}) =>
    view.rerender(createElement(TransferFeeSection, { recordId: "rec-1", refreshToken: token, record: { ...record, ...next }, ...shared }));
  return { ...view, again };
}

async function ready() {
  await waitFor(() => expect((screen.getByLabelText("Edit Fee Amount") as HTMLButtonElement).disabled).toBe(false));
  await waitFor(() => expect(screen.queryByText("Loading custodian fee schedule...")).toBeNull());
}
async function mount(opts: Parameters<typeof setup>[0] = {}) {
  const view = setup(opts);
  await ready();
  return view;
}

const edit = (label: string) => fireEvent.click(screen.getByLabelText(`Edit ${label}`));
const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const logLink = () => screen.getByRole("link", { name: "Log Reimbursement in Operations Tools" }) as HTMLAnchorElement;
const disabledLog = () => screen.getByRole("button", { name: /Enter Fee Amount First/ }) as HTMLButtonElement;

function stubWindowKeys() {
  const spy = vi.fn();
  window.addEventListener("keydown", spy);
  return { spy, stop: () => window.removeEventListener("keydown", spy) };
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

describe("transfer fee section", () => {
  it("renders the seven fee fields with the tracker labels", async () => {
    await mount({ fee: ok({ ...EMPTY, feeApexTicket: "APX-1" }) });
    expect(screen.getByRole("heading", { name: "Fee Details" })).toBeTruthy();
    const labels = ["Fee Charged?", "Fee Amount", "Fee Memo", "Fee Request Submitted", "Fee Request Completed", "Fee Apex Ticket", "Fee Credit Req ID"];
    const found = labels.map((label) => screen.getByText(label).textContent);
    expect(found).toEqual(labels);
    expect(screen.getByLabelText("Edit Fee Apex Ticket").textContent).toBe("APX-1");
    expect(screen.getByLabelText("Edit Fee Amount").textContent).toBe("—");
    markCase(SUITE, "renders the seven fee fields with the tracker labels");
  });

  it("ends every fee line with its pencil", async () => {
    await mount({ fee: ok({ ...EMPTY, feeApexTicket: "APX-1", feeMemo: "a long memo ".repeat(12) }) });
    const labels = ["Fee Charged?", "Fee Amount", "Fee Memo", "Fee Request Submitted", "Fee Request Completed", "Fee Apex Ticket", "Fee Credit Req ID"];
    for (const label of labels) {
      const button = screen.getByLabelText(`Edit ${label}`);
      const last = button.lastElementChild;
      expect(last?.tagName.toLowerCase(), label).toBe("svg");
      expect(button.querySelectorAll("svg"), label).toHaveLength(1);
    }
    markCase(SUITE, "ends every fee line with its pencil");
  });

  it("shows the stored value after a save", async () => {
    actions.save.mockResolvedValue(ok({ ...EMPTY, feeMemo: "stored by tracker" }));
    await mount();
    edit("Fee Memo");
    fireEvent.change(input("Fee Memo"), { target: { value: "typed by user" } });
    fireEvent.keyDown(input("Fee Memo"), { key: "Enter" });
    await screen.findByText("stored by tracker");
    expect(actions.save).toHaveBeenCalledWith("rec-1", "feeMemo", "typed by user");
    expect(screen.queryByText("typed by user")).toBeNull();
    expect(screen.queryByLabelText("Fee Memo")).toBeNull();
    markCase(SUITE, "shows the stored value after a save");
  });

  it("keeps the last saved value and the unsent edit when a save fails", async () => {
    actions.save.mockResolvedValue(bad("refused", { ...EMPTY, feeMemo: "old memo" }, []));
    await mount({ fee: ok({ ...EMPTY, feeMemo: "old memo" }) });
    edit("Fee Memo");
    fireEvent.change(input("Fee Memo"), { target: { value: "new memo" } });
    fireEvent.keyDown(input("Fee Memo"), { key: "Enter" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Update Failed");
    expect(alert.textContent).toContain("Could not save changes. The tracker refused this change.");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(input("Fee Memo").value).toBe("new memo");
    fireEvent.click(screen.getByLabelText("Cancel edit"));
    expect(screen.getByLabelText("Edit Fee Memo").textContent).toBe("old memo");
    markCase(SUITE, "keeps the last saved value and the unsent edit when a save fails");
  });

  it("Enter saves and Escape cancels an edit", async () => {
    actions.save.mockResolvedValue(ok({ ...EMPTY, feeAmount: "$9.00" }));
    await mount();
    edit("Fee Amount");
    fireEvent.change(input("Fee Amount"), { target: { value: "$9.00" } });
    fireEvent.keyDown(input("Fee Amount"), { key: "Escape" });
    expect(screen.queryByLabelText("Fee Amount")).toBeNull();
    expect(actions.save).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Edit Fee Amount").textContent).toBe("—");
    edit("Fee Amount");
    fireEvent.change(input("Fee Amount"), { target: { value: "$9.00" } });
    fireEvent.keyDown(input("Fee Amount"), { key: "Enter" });
    await screen.findByText("$9.00", { selector: "span" });
    expect(actions.save).toHaveBeenCalledTimes(1);
    markCase(SUITE, "Enter saves and Escape cancels an edit");
  });

  it("Escape cancels an edit without closing the drawer", async () => {
    await mount({ fee: ok({ ...EMPTY, feeCharged: "Yes" }) });
    const keys = stubWindowKeys();
    edit("Fee Amount");
    fireEvent.keyDown(input("Fee Amount"), { key: "Escape" });
    expect(screen.queryByLabelText("Fee Amount")).toBeNull();
    edit("Fee Charged?");
    const select = screen.getByLabelText("Fee Charged?") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    fireEvent.keyDown(select, { key: "Escape" });
    expect(screen.queryByLabelText("Fee Charged?")).toBeNull();
    expect(keys.spy).not.toHaveBeenCalled();
    expect(actions.save).not.toHaveBeenCalled();
    // Control: a key the section does not handle still reaches the window.
    fireEvent.keyDown(screen.getByLabelText("Edit Fee Amount"), { key: "ArrowDown" });
    expect(keys.spy).toHaveBeenCalledTimes(1);
    keys.stop();
    markCase(SUITE, "Escape cancels an edit without closing the drawer");
  });

  it("shows the applied amount and memo after Apply Selected", async () => {
    actions.apply.mockResolvedValue(ok({ ...EMPTY, feeCharged: "Yes", feeAmount: "$75.00", feeMemo: "ACAT Transfer Fee: $75.00" }));
    await mount();
    await screen.findByText("Fee Schedule — Fidelity");
    expect((screen.getByRole("button", { name: "Apply Selected to Record" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Select ACAT Transfer Fee"));
    expect(screen.getByText("Selected Total (1 fee)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply Selected to Record" }));
    await screen.findByText("ACAT Transfer Fee: $75.00", { selector: "span" });
    expect(actions.apply).toHaveBeenCalledWith("rec-1", ["fee-1"]);
    expect(screen.getByLabelText("Edit Fee Amount").textContent).toBe("$75.00");
    expect(screen.getByText("1 fee applied to record", { exact: false })).toBeTruthy();
    markCase(SUITE, "shows the applied amount and memo after Apply Selected");
  });

  it("shows a retry when the fee rules cannot be loaded", async () => {
    await mount({ rules: { ok: false, reason: "unavailable" }, fee: ok(CHARGED) });
    const alert = await screen.findByText("The custodian fee schedule could not be loaded.");
    expect(alert).toBeTruthy();
    expect(screen.getByLabelText("Edit Fee Amount").textContent).toBe("$50.00");
    actions.rules.mockResolvedValue({ ok: true, rules: RULES });
    fireEvent.click(screen.getByRole("button", { name: "Retry fee schedule" }));
    await screen.findByText("Fee Schedule — Fidelity");
    expect(actions.rules).toHaveBeenCalledTimes(2);
    markCase(SUITE, "shows a retry when the fee rules cannot be loaded");
  });

  it("leaves the fee unchanged and shows a retry when apply fails", async () => {
    actions.apply.mockResolvedValue(bad("internal_error", EMPTY, []));
    await mount();
    await screen.findByText("Fee Schedule — Fidelity");
    fireEvent.click(screen.getByLabelText("Select ACAT Transfer Fee"));
    fireEvent.click(screen.getByRole("button", { name: "Apply Selected to Record" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Update Failed");
    expect(alert.textContent).toContain("Could not apply fee schedule. The tracker could not complete this change.");
    expect(screen.getByLabelText("Edit Fee Amount").textContent).toBe("—");
    expect(screen.getByLabelText("Edit Fee Memo").textContent).toBe("—");
    actions.apply.mockResolvedValue(ok(CHARGED));
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByLabelText("Edit Fee Amount").textContent).toBe("$50.00"));
    expect(actions.apply).toHaveBeenCalledTimes(2);
    expect(actions.apply).toHaveBeenLastCalledWith("rec-1", ["fee-1"]);
    markCase(SUITE, "leaves the fee unchanged and shows a retry when apply fails");
  });

  it("shows the tracker no-rules copy when none are available", async () => {
    await mount({ rules: { ok: true, rules: [] } });
    expect(await screen.findByText("No fee schedule on file for Fidelity. Add entries via the CustodianFee seed file.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply Selected to Record" })).toBeNull();
    cleanup();
    await mount({ record: { custodianId: null, transferringContra: null, custodianName: "" } });
    expect(screen.getByText("Set a transferring contra to see its fee schedule.")).toBeTruthy();
    expect(actions.rules).toHaveBeenCalledTimes(1);
    markCase(SUITE, "shows the tracker no-rules copy when none are available");
  });

  it("hides Apply Selected while the record has a fee", async () => {
    await mount({ fee: ok(CHARGED) });
    await screen.findByText("Fee Schedule — Fidelity");
    expect(screen.queryByRole("button", { name: "Apply Selected to Record" })).toBeNull();
    expect(screen.getByText("2 configured")).toBeTruthy();
    expect(screen.getByText("Showing every fee configured for Fidelity. Select one or more to apply to this record.")).toBeTruthy();
    expect(screen.getByText("Applies to all account types")).toBeTruthy();
    expect(screen.getByText("IRA · FULL · Direction OUT · Per request")).toBeTruthy();
    expect(screen.getByText("varies")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Select Wire Fee"));
    fireEvent.click(screen.getByLabelText("Select ACAT Transfer Fee"));
    expect(screen.getByText("Selected Total (2 fees)")).toBeTruthy();
    expect(screen.getByText("Amount needs confirmation")).toBeTruthy();
    markCase(SUITE, "hides Apply Selected while the record has a fee");
  });

  it.each([
    { ...RULES[1], amount: null, amountText: "varies" },
    { ...RULES[1], amount: 75, amountText: "per position" },
  ])("requires the actual amount before applying a variable or qualified rule: %s", async (rule) => {
    await mount({ rules: { ok: true, rules: [rule] } });
    fireEvent.click(screen.getByLabelText("Select Wire Fee"));
    expect(screen.getByText("Amount needs confirmation")).toBeTruthy();
    expect(screen.getByText("Selected fees have a variable or qualified amount. Confirm the actual charge and enter its amount above.")).toBeTruthy();
    const apply = screen.getByRole("button", { name: "Apply Selected to Record" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(apply);
    expect(actions.apply).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Edit Fee Amount").textContent).toBe("—");
  });

  it("shows the Full ACAT Out warning for a full outgoing transfer only", async () => {
    await mount({ record: FULL_OUT });
    expect(screen.getByText("Full ACAT Out — verify the automatic fee credit")).toBeTruthy();
    expect(screen.getByText("Confirm the charge and reimbursement in Apex, record the fee amount and fee-specific Apex ticket, then log the request so its Fee Crediting Req ID is tied back here.")).toBeTruthy();
    expect(screen.getByText("Pending", { selector: "span" })).toBeTruthy();
    expect(screen.queryByText("Fee Charged", { selector: "span" })).toBeNull();
    cleanup();
    for (const record of [RECORD, { ...RECORD, direction: "Out", type: "Partial" }, { ...RECORD, direction: "In", type: "Full" }]) {
      await mount({ record });
      expect(screen.queryByText("Full ACAT Out — verify the automatic fee credit")).toBeNull();
      cleanup();
    }
    markCase(SUITE, "shows the Full ACAT Out warning for a full outgoing transfer only");
  });

  it("does not show the warning for a DRS transfer", async () => {
    await mount({ record: { ...FULL_OUT, transferWorkflow: " drs " } });
    expect(screen.queryByText("Full ACAT Out — verify the automatic fee credit")).toBeNull();
    expect(screen.getByText("Pending", { selector: "span" })).toBeTruthy();
    markCase(SUITE, "does not show the warning for a DRS transfer");
  });

  it("declares the tracker semantic tokens in the module CSS", () => {
    const css = readFileSync("components/transfers/TransferFeeSection.module.css", "utf8");
    const light = css.slice(css.indexOf(".root {"), css.indexOf(":global(html.dark) .root"));
    const dark = css.slice(css.indexOf(":global(html.dark) .root"), css.indexOf(".root *"));
    const tokens = (block: string) => Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
    expect(tokens(light)).toMatchObject({
      success: "#2d8a5e", "success-bg": "#eaf5ef", "success-border": "#c7e3d3",
      warning: "#a17e2e", "warning-bg": "#faf3e0", "warning-border": "#ebdcb1",
      danger: "#b83c3c", "danger-bg": "#fbecec", "danger-border": "#eec7c7",
      info: "#3b6fa0", "info-bg": "#eaf1f8", "info-border": "#c9dbec",
      accent: "#3b6fa0", "accent-light": "#eaf1f8",
    });
    expect(tokens(dark)).toMatchObject({
      success: "#5fc08a", "success-bg": "rgba(95, 192, 138, 0.12)", "success-border": "rgba(95, 192, 138, 0.3)",
      warning: "#d4b15c", "warning-bg": "rgba(212, 177, 92, 0.12)", "warning-border": "rgba(212, 177, 92, 0.3)",
      danger: "#e07070", "danger-bg": "rgba(224, 112, 112, 0.14)", "danger-border": "rgba(224, 112, 112, 0.32)",
      info: "#6fa3d3", "info-bg": "rgba(111, 163, 211, 0.14)", "info-border": "rgba(111, 163, 211, 0.3)",
      accent: "#6fa3d3", "accent-light": "rgba(111, 163, 211, 0.14)",
    });
    // Each status chip class reads its own hue; neutral chrome stays on AoA tokens.
    expect(css).toMatch(/\.toneWarning\s*\{[^}]*var\(--warning-border\)[^}]*var\(--warning-bg\)[^}]*var\(--warning\)/);
    expect(css).toMatch(/\.toneInfo\s*\{[^}]*var\(--info-border\)[^}]*var\(--info-bg\)[^}]*var\(--info\)/);
    expect(css).toMatch(/\.toneSuccess\s*\{[^}]*var\(--success-border\)[^}]*var\(--success-bg\)[^}]*var\(--success\)/);
    expect(css).toMatch(/\.toneDanger\s*\{[^}]*var\(--danger-border\)[^}]*var\(--danger-bg\)[^}]*var\(--danger\)/);
    expect(css).toContain("var(--font-sans)");
    // No media query hides a fee field or action on a narrow screen.
    expect(css).not.toMatch(/@media/);
    // The only display:none is the empty announcement region.
    expect(css.replace(".live:empty { display: none; }", "")).not.toMatch(/display:\s*none/);
    markCase(SUITE, "declares the tracker semantic tokens in the module CSS");
  });

  it("disables Log Reimbursement when the amount is not above zero", async () => {
    await mount({ record: FULL_OUT, fee: ok({ ...EMPTY, feeCharged: "Yes" }, []) });
    const button = disabledLog();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Enter Fee Amount First");
    expect(button.getAttribute("title")).toBe("Enter the charged fee amount first");
    expect(screen.queryByRole("link", { name: /Log Reimbursement/ })).toBeNull();
    expect(screen.getByText("Amount not recorded")).toBeTruthy();
    expect(document.body.textContent).not.toContain("incurs a $0.00");
    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
    markCase(SUITE, "disables Log Reimbursement when the amount is not above zero");
  });

  it("shows the loading state without a reimbursement spinner while the fee loads", async () => {
    setup({ neverLoad: true });
    expect(screen.queryByText("Checking reimbursement status...")).toBeNull();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(7);
    expect(screen.getByText("Pending", { selector: "span" })).toBeTruthy();
    expect((screen.getByLabelText("Edit Fee Amount") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Fee Status Pending")).toBeNull();
    expect(await screen.findByText("Fee Schedule — Fidelity")).toBeTruthy();
    markCase(SUITE, "shows the loading state without a reimbursement spinner while the fee loads");
  });

  it("the header badge follows stored fee evidence independently of terminal status", async () => {
    await mount({ fee: ok(CHARGED, []) });
    expect(screen.getByText("Fee Charged", { selector: "span" })).toBeTruthy();
    cleanup();
    await mount({ fee: ok({ ...EMPTY, feeAmount: "$12.00" }, []) });
    expect(screen.getByText("Fee Charged", { selector: "span" })).toBeTruthy();
    cleanup();
    await mount({ record: { status: "Completed" }, fee: ok({ ...EMPTY, feeCharged: "No" }) });
    expect(screen.getByText("No Fee", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("No Fee Charged")).toBeTruthy();
    expect(screen.getByText("No ACAT transfer fee was charged for this record. No reimbursement action needed.")).toBeTruthy();
    cleanup();
    await mount();
    expect(screen.getByText("Pending", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("Fee Status Pending")).toBeTruthy();
    expect(screen.getByText("The charged fee has not been documented. Confirm the charge before recording a fee or reimbursement.")).toBeTruthy();
    for (const status of ["Completed", "Rejected", "Purged", "Canceled", "Deferred"]) {
      cleanup();
      await mount({ record: { status } });
      expect(screen.getByText("Pending", { selector: "span" })).toBeTruthy();
      expect(screen.queryByText("No Fee Charged")).toBeNull();
    }
    markCase(SUITE, "the header badge follows the fee and the terminal status");
  });

  it("shows the tracker success announcements for a save and an apply", async () => {
    actions.save.mockResolvedValue(ok({ ...EMPTY, feeApexTicket: "APX-9" }));
    actions.apply.mockResolvedValue(ok(CHARGED));
    await mount();
    await screen.findByText("Fee Schedule — Fidelity");
    edit("Fee Apex Ticket");
    fireEvent.change(input("Fee Apex Ticket"), { target: { value: "APX-9" } });
    fireEvent.keyDown(input("Fee Apex Ticket"), { key: "Enter" });
    const status = screen.getByRole("status");
    await waitFor(() => expect(status.textContent).toBe("Updated feeApexTicket saved"));
    fireEvent.click(screen.getByLabelText("Select ACAT Transfer Fee"));
    fireEvent.click(screen.getByRole("button", { name: "Apply Selected to Record" }));
    await waitFor(() => expect(status.textContent).toBe("Applied 1 fee applied to record"));
    markCase(SUITE, "shows the tracker success announcements for a save and an apply");
  });

  it("retries the failed action when Retry is pressed", async () => {
    actions.save.mockResolvedValueOnce(bad("rate_limited", EMPTY, [])).mockResolvedValueOnce(ok({ ...EMPTY, feeMemo: "kept" }));
    await mount();
    edit("Fee Memo");
    fireEvent.change(input("Fee Memo"), { target: { value: "kept" } });
    fireEvent.keyDown(input("Fee Memo"), { key: "Enter" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Too many changes at once — wait a minute and try again.");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await screen.findByText("kept");
    expect(actions.save).toHaveBeenCalledTimes(2);
    expect(actions.save).toHaveBeenNthCalledWith(2, "rec-1", "feeMemo", "kept");
    expect(screen.queryByRole("alert")).toBeNull();
    markCase(SUITE, "retries the failed action when Retry is pressed");
  });

  it("reloads the fee when the editor saves", async () => {
    const view = await mount({ fee: ok({ ...EMPTY, feeMemo: "before" }) });
    edit("Fee Amount");
    fireEvent.change(input("Fee Amount"), { target: { value: "$1" } });
    actions.load.mockResolvedValue(ok({ ...EMPTY, feeMemo: "after editor save" }, []));
    await act(async () => { view.again("2026-10-13T00:00:00.000Z"); });
    await screen.findByText("after editor save");
    expect(actions.load).toHaveBeenCalledTimes(2);
    // An unsent edit survives the reload.
    expect(input("Fee Amount").value).toBe("$1");
    markCase(SUITE, "reloads the fee when the editor saves");
  });

  it("shows a retry when the fee cannot be loaded", async () => {
    setup({ fee: bad("transport") });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The tracker did not answer — try again.");
    expect(screen.queryByLabelText("Edit Fee Amount")).toBeNull();
    expect(screen.getByText("Unavailable", { selector: "span" })).toBeTruthy();
    expect(screen.queryByText("Fee Status Pending")).toBeNull();
    actions.load.mockResolvedValue(ok(CHARGED, []));
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await screen.findByLabelText("Edit Fee Amount");
    await waitFor(() => expect(screen.getByLabelText("Edit Fee Amount").textContent).toBe("$50.00"));
    markCase(SUITE, "shows a retry when the fee cannot be loaded");
  });

  it("distinguishes an explicit zero fee from a missing amount", async () => {
    await mount({ fee: ok({ ...EMPTY, feeAmount: "$0.00" }) });
    expect(screen.getByText("No Fee", { selector: "span" })).toBeTruthy();
    expect(screen.getByLabelText("Edit Fee Amount").textContent).toBe("$0.00");
    expect(screen.queryByText("Review fee reimbursement")).toBeNull();
    cleanup();
    await mount({ fee: ok({ ...EMPTY, feeCharged: "Yes" }) });
    expect(screen.getByText("Fee Charged", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("Amount not recorded")).toBeTruthy();
    expect(screen.getByLabelText("Edit Fee Amount").textContent).toBe("—");
    expect(disabledLog().disabled).toBe(true);
  });

  it.each([
    { feeCharged: "No", feeAmount: "$75.00" },
    { feeCharged: "Yes", feeAmount: "$0.00" },
  ])("requires review for contradictory fee evidence: %s", async (values) => {
    await mount({ fee: ok({ ...EMPTY, ...values }) });
    expect(screen.getByText("Review needed", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("Fee Details Need Review")).toBeTruthy();
    expect(screen.queryByText("No Fee Charged")).toBeNull();
    expect(screen.queryByRole("link", { name: /Log Reimbursement/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply Selected to Record" })).toBeNull();
  });

  it("does not treat a failed fee read on a completed transfer as no charge", async () => {
    setup({ record: { status: "Completed" }, fee: bad("transport") });
    await screen.findByRole("alert");
    expect(screen.getByText("Unavailable", { selector: "span" })).toBeTruthy();
    expect(screen.queryByText("No Fee", { selector: "span" })).toBeNull();
    expect(screen.queryByText("No Fee Charged")).toBeNull();
  });

  it("keeps previous values visible but marks a failed refresh unavailable", async () => {
    const view = await mount({ fee: ok(CHARGED), showSchedule: false });
    actions.load.mockResolvedValue(bad("transport"));
    await act(async () => { view.again("refresh-failed"); });
    expect(await screen.findByText("Showing previously loaded fee details.")).toBeTruthy();
    expect(screen.getByText("Unavailable", { selector: "span" })).toBeTruthy();
    expect(screen.getByLabelText("Edit Fee Amount").textContent).toBe("$50.00");
    expect((screen.getByLabelText("Edit Fee Amount") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("link", { name: /Log Reimbursement/ })).toBeNull();
  });

  it("does not load or display the legacy schedule when the workspace supplies it", async () => {
    await mount({ showSchedule: false, fee: ok(CHARGED) });
    expect(actions.load).toHaveBeenCalledWith("rec-1");
    expect(actions.rules).not.toHaveBeenCalled();
    expect(screen.queryByText(/Fee Schedule/)).toBeNull();
    expect(screen.getByLabelText("Edit Fee Amount").textContent).toBe("$50.00");
  });

  it("shows archived fee details and history access without edit or reimbursement controls", async () => {
    setup({ readOnly: true, reimbursement: true, fee: ok({ ...CHARGED, feeRequestSubmitted: "2026-10-20", feeRequestCompleted: "2026-10-21", feeApexTicket: "APX-1", feeCreditRequestId: "credit-1" }) });
    await screen.findByText("credit-1");
    expect(screen.getByText("2026-10-20")).toBeTruthy();
    expect(screen.getByText("2026-10-21")).toBeTruthy();
    expect(screen.getByText("APX-1")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /^Edit / })).toHaveLength(0);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Apply Selected|Log Reimbursement|Enter Fee/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Log Reimbursement/ })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("link", { name: "Open Operations Tools fee requests" })).toBeTruthy();
    expect(actions.save).not.toHaveBeenCalled();
    expect(actions.apply).not.toHaveBeenCalled();
  });

  it("displays an initial server snapshot while refreshing the source", async () => {
    setup({ initialFee: CHARGED, neverLoad: true, showSchedule: false });
    expect(screen.getByLabelText("Edit Fee Amount").textContent).toBe("$50.00");
    expect(actions.load).toHaveBeenCalledWith("rec-1");
    expect(actions.rules).not.toHaveBeenCalled();
  });

  it("renders the lucide v1.24.0 icon paths", () => {
    // Copied from dist/esm/icons/*.mjs of `npm pack lucide-react@1.24.0`.
    const expected: Record<string, Array<[string, Record<string, string>]>> = { "DollarSign": [ [ "line", { "x1": "12", "x2": "12", "y1": "2", "y2": "22" } ], [ "path", { "d": "M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" } ] ], "CircleAlert": [ [ "circle", { "cx": "12", "cy": "12", "r": "10" } ], [ "line", { "x1": "12", "x2": "12", "y1": "8", "y2": "12" } ], [ "line", { "x1": "12", "x2": "12.01", "y1": "16", "y2": "16" } ] ], "TriangleAlert": [ [ "path", { "d": "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" } ], [ "path", { "d": "M12 9v4" } ], [ "path", { "d": "M12 17h.01" } ] ], "LoaderCircle": [ [ "path", { "d": "M21 12a9 9 0 1 1-6.219-8.56" } ] ], "CircleCheck": [ [ "circle", { "cx": "12", "cy": "12", "r": "10" } ], [ "path", { "d": "m9 12 2 2 4-4" } ] ], "Clock": [ [ "circle", { "cx": "12", "cy": "12", "r": "10" } ], [ "path", { "d": "M12 6v6l4 2" } ] ], "Receipt": [ [ "path", { "d": "M12 17V7" } ], [ "path", { "d": "M16 8h-6a2 2 0 0 0 0 4h4a2 2 0 0 1 0 4H8" } ], [ "path", { "d": "M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z" } ] ], "RefreshCw": [ [ "path", { "d": "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" } ], [ "path", { "d": "M21 3v5h-5" } ], [ "path", { "d": "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" } ], [ "path", { "d": "M8 16H3v5" } ] ], "CircleDot": [ [ "circle", { "cx": "12", "cy": "12", "r": "10" } ], [ "circle", { "cx": "12", "cy": "12", "r": "1" } ] ], "Ban": [ [ "circle", { "cx": "12", "cy": "12", "r": "10" } ], [ "path", { "d": "M4.929 4.929 19.07 19.071" } ] ], "Pencil": [ [ "path", { "d": "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" } ], [ "path", { "d": "m15 5 4 4" } ] ], "X": [ [ "path", { "d": "M18 6 6 18" } ], [ "path", { "d": "m6 6 12 12" } ] ], "BookOpen": [ [ "path", { "d": "M12 7v14" } ], [ "path", { "d": "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" } ] ], "ArrowRight": [ [ "path", { "d": "M5 12h14" } ], [ "path", { "d": "m12 5 7 7-7 7" } ] ]
};
    const exported = Object.keys(icons).filter((name) => typeof (icons as Record<string, unknown>)[name] === "function" && name !== "icon");
    expect(exported.sort()).toEqual(Object.keys(expected).sort());
    for (const [name, nodes] of Object.entries(expected)) {
      const Icon = (icons as unknown as Record<string, (props: { size?: number }) => React.ReactElement>)[name];
      const { container, unmount } = render(createElement(Icon, { size: 16 }));
      const svg = container.querySelector("svg")!;
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg.getAttribute("width")).toBe("16");
      expect(svg.getAttribute("stroke")).toBe("currentColor");
      expect(svg.getAttribute("stroke-width")).toBe("2");
      expect(svg.getAttribute("stroke-linecap")).toBe("round");
      expect(svg.getAttribute("stroke-linejoin")).toBe("round");
      const drawn = [...svg.children].map((el) => [el.tagName.toLowerCase(), Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]))]);
      expect(drawn, name).toEqual(nodes);
      unmount();
    }
    markCase(SUITE, "renders the lucide v1.24.0 icon paths");
  });

  it("keeps the tracker copy strings that remain", async () => {
    // Independent literals typed here, not read from FEE_COPY.
    await mount({ record: FULL_OUT, fee: ok({ ...CHARGED, feeAmount: "$50.00" }, [PENDING]) });
    const text = document.body.textContent ?? "";
    for (const literal of [
      "Fee Details", "Fee Charged?", "Fee Amount", "Fee Memo", "Fee Request Submitted", "Fee Request Completed", "Fee Apex Ticket", "Fee Credit Req ID",
      "Full ACAT Out — verify the automatic fee credit",
      "Fee Schedule — Fidelity", "2 configured", "Showing every fee configured for Fidelity. Select one or more to apply to this record.",
      "Selected Total (0 fees)", "ACAT Transfer Fee", "Fee from Fidelity",
      "Review fee reimbursement",
      "The recorded fee amount is $50.00.", "Review the existing Operations Tools request and its status before submitting another reimbursement.",
      "Control #: CTRL-9 · Apex Account: ****1111", "Log Reimbursement",
    ]) expect(text, literal).toContain(literal);
    expect(screen.getByLabelText("Select ACAT Transfer Fee")).toBeTruthy();
    cleanup();
    await mount({ fee: ok({ ...EMPTY, feeCharged: "No" }) });
    fireEvent.click(screen.getByLabelText("Edit Fee Memo"));
    expect(screen.getByLabelText("Cancel edit")).toBeTruthy();
    markCase(SUITE, "keeps the tracker copy strings that remain");
  });

  it("tkt349: shows a link to the Operations Tools fee requests page for status and history", async () => {
    await mount({ fee: ok(CHARGED, []) });
    const card = screen.getByTestId("fee-requests-link-card");
    expect(within(card).getByRole("heading", { name: "Reimbursement Requests" })).toBeTruthy();
    expect(card.textContent).toContain("Reimbursement status and history are tracked in Operations Tools fee requests.");
    const link = within(card).getByRole("link", { name: "Open Operations Tools fee requests" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/operations/fee-requests");
    // A same-app link: no query parameters, no new window, no external origin.
    expect(link.getAttribute("target")).toBeNull();
    expect(link.getAttribute("href")).not.toMatch(/[?#]|^https?:/);
    markCase(SUITE, "tkt349: shows a link to the Operations Tools fee requests page for status and history");
  });

  it("directs recorded fees to request review without inferring credited status from a date or ID", async () => {
    await mount({ fee: ok({ ...CHARGED, feeRequestCompleted: "2026-10-21", feeCreditRequestId: "request-1" }) });
    expect(screen.getByText("Review fee reimbursement")).toBeTruthy();
    expect(screen.getByText(/Review the existing Operations Tools request and its status before submitting another reimbursement/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Operations Tools fee requests" })).toBeTruthy();
    expect(logLink()).toBeTruthy();
    expect(screen.getByLabelText("Edit Fee Request Completed").textContent).toBe("2026-10-21");
    expect(screen.getByLabelText("Edit Fee Credit Req ID").textContent).toBe("request-1");
    expect(document.body.textContent).not.toMatch(/Per firm policy|Action Required|Reimbursement credited/i);
  });

  it("tkt349: Log Reimbursement is a link to Operations Tools and calls no tracker action", async () => {
    await mount({ fee: ok(CHARGED, []) });
    expect(screen.getByText("Review fee reimbursement")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Log Reimbursement/ })).toBeNull();
    const link = logLink();
    expect(link.getAttribute("href")).toBe("/operations/fee-requests");
    expect(link.textContent).toBe("Log Reimbursement");
    expect(screen.getByText("Log Reimbursement opens Operations Tools fee requests. Select this client and account there to submit the request.")).toBeTruthy();
    const before = { load: actions.load.mock.calls.length, save: actions.save.mock.calls.length, apply: actions.apply.mock.calls.length };
    // jsdom does not navigate; the click must not start any tracker action either.
    link.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(link);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect({ load: actions.load.mock.calls.length, save: actions.save.mock.calls.length, apply: actions.apply.mock.calls.length }).toEqual(before);
    expect(actions.save).not.toHaveBeenCalled();
    expect(actions.apply).not.toHaveBeenCalled();
    markCase(SUITE, "tkt349: Log Reimbursement is a link to Operations Tools and calls no tracker action");
  });

  it("tkt349: shows no link, no Log Reimbursement and no tracker link when Operations Tools is unavailable", async () => {
    await mount({ fee: ok(CHARGED, []), feeRequestsHref: null });
    expect(screen.getByText("Review fee reimbursement")).toBeTruthy();
    expect(screen.getByText("Reimbursement requests are not available right now.")).toBeTruthy();
    expect(screen.queryByTestId("fee-requests-link-card")).toBeNull();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Log Reimbursement|Enter Fee Amount First/ })).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/tracker\.|Transfer Tracker|operations\/fee-requests/i);
    // The same holds when the amount is not above zero: nothing says Log Reimbursement is possible.
    cleanup();
    await mount({ record: FULL_OUT, fee: ok({ ...EMPTY, feeAmount: "$0.00" }, []), feeRequestsHref: null });
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Log Reimbursement|Enter Fee Amount First/ })).toBeNull();
    markCase(SUITE, "tkt349: shows no link, no Log Reimbursement and no tracker link when Operations Tools is unavailable");
  });

  it("tkt349: shows no reimbursement rows, statuses, spinner, retry or not-configured message", async () => {
    // Even a tracker answer that carries log rows is ignored: Stage 1 reads no reimbursement.
    await mount({ fee: ok(CHARGED, [PENDING, row({ id: "78", status: "Credited" })]) });
    expect(screen.queryByText("Reimbursement Log")).toBeNull();
    expect(document.querySelectorAll("[data-tone]")).toHaveLength(0);
    expect(document.querySelectorAll("[data-log-status]")).toHaveLength(0);
    expect(screen.queryByText("Checking reimbursement status...")).toBeNull();
    expect(screen.queryByText("The reimbursement log is not configured.")).toBeNull();
    expect(screen.queryByText("The reimbursement log could not be read.")).toBeNull();
    expect(screen.queryByRole("button", { name: /Retry reimbursement log|Refresh/ })).toBeNull();
    expect(screen.queryByText(/on file/i)).toBeNull();
    expect(screen.getByLabelText("Edit Fee Amount").textContent).toBe("$50.00");
    markCase(SUITE, "tkt349: shows no reimbursement rows, statuses, spinner, retry or not-configured message");
  });

  it("tkt349: keeps the fee and shows no reimbursement dead end when the tracker log was unreadable", async () => {
    // The adapter turns the tracker's log_not_configured and log_unavailable answers into a good fee read.
    await mount({ fee: ok(CHARGED, null) });
    expect(screen.getByLabelText("Edit Fee Amount").textContent).toBe("$50.00");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Checking reimbursement status...")).toBeNull();
    expect(logLink().getAttribute("href")).toBe("/operations/fee-requests");
    markCase(SUITE, "tkt349: keeps the fee and shows no reimbursement dead end when the tracker log was unreadable");
  });
});
