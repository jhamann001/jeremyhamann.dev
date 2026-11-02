// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const { loadMock } = vi.hoisted(() => ({ loadMock: vi.fn() }));
vi.mock("@/app/(authenticated)/client-transfers/actions", () => ({ loadAdvisorTransfers: loadMock }));

import { AdvisorTransferList } from "@/components/transfers/AdvisorTransferList";
import type { AdvisorTransferRow } from "@/lib/transfers/advisor-transfer-status";

const SUITE = "advisor-transfer-list";

function row(over: Partial<AdvisorTransferRow> & Pick<AdvisorTransferRow, "id" | "clientName">): AdvisorTransferRow {
  return {
    status: "Submitted",
    direction: "In",
    type: "Full",
    accountType: "Traditional IRA",
    transferringContra: "Charles Schwab",
    wealthAdvisor: "Rachel",
    additionalResources: null,
    originalClientRequestDate: "2026-04-01",
    opsSubmissionDateToApex: "2026-04-03",
    apexCompletionDate: null,
    acatDate: "2026-04-01",
    statementAmount: 123456789,
    custodian: { id: "C1", name: "Charles Schwab", avgProcessingDays: 6 },
    ...over,
  };
}

const ABIGAYLE = row({ id: "r1", clientName: "Abigayle Beier", additionalResources: "https://app.crm.example/tasks/abc-123" });
const ADA = row({ id: "r2", clientName: "Daniel Chen", transferringContra: "Fidelity", wealthAdvisor: "Reynold", status: "PendingSettlement", acatDate: "2026-03-01" });
const GRACE = row({
  id: "r3", clientName: "Grace Hopper", transferringContra: "Vanguard", wealthAdvisor: "Priya", status: "Completed",
  apexCompletionDate: "2026-04-20", acatDate: "2026-02-01", statementAmount: null, custodian: null,
});
const ROWS = [ABIGAYLE, ADA, GRACE];

function mount(initial: Parameters<typeof AdvisorTransferList>[0]["initial"]) {
  return render(createElement(AdvisorTransferList, { initial }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => loadMock.mockReset());
afterEach(() => cleanup());

describe("AdvisorTransferList", () => {
  it("shows client, contra, advisor, status, direction, type and dates for each transfer", () => {
    mount({ ok: true, rows: [ABIGAYLE] });
    const rowButton = screen.getByRole("button", { name: /Abigayle Beier/ });
    expect(rowButton.textContent).toContain("Charles Schwab");
    expect(rowButton.textContent).toContain("In · Full");
    expect(rowButton.textContent).toContain("$1,234,567.89");
    expect(rowButton.textContent).toContain("Submitted");
    expect(screen.queryByText("Wealth advisor")).toBeNull();
    fireEvent.click(rowButton);
    const detail = rowButton.closest("li") as HTMLElement;
    for (const [label, value] of [
      ["Client", "Abigayle Beier"], ["Transferring contra", "Charles Schwab"], ["Wealth advisor", "Rachel"],
      ["Direction", "In"], ["Type", "Full"], ["Account type", "Traditional IRA"],
      ["Original client request", "04-01-2026"], ["Submitted to Apex", "04-03-2026"], ["Apex completion", "—"],
      ["Expected value", "$1,234,567.89"], ["Custodian SLA", "Charles Schwab · ~6 business days"],
    ]) {
      const term = within(detail).getByText(label, { selector: "dt" });
      expect(term.nextElementSibling?.textContent).toBe(value);
    }
    const link = within(detail).getByRole("link", { name: "Open CRM task" });
    expect(link.getAttribute("href")).toBe("https://app.crm.example/tasks/abc-123");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    markCase(SUITE, "shows client, contra, advisor, status, direction, type and dates for each transfer");
  });

  it("shows only Active rows first and switches Completed and All", () => {
    mount({ ok: true, rows: ROWS });
    expect(screen.getByText("Read-only view of ACAT transfers. Account numbers, fees, and internal notes aren’t shown.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Active" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("Grace Hopper")).toBeNull();
    expect(screen.getByText("Abigayle Beier")).toBeTruthy();
    expect(screen.getByText("Daniel Chen")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Completed" }));
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
    expect(screen.queryByText("Abigayle Beier")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText("2")).toBeTruthy();
    markCase(SUITE, "shows only Active rows first and switches Completed and All");
  });

  it("narrows by client, contra, or advisor text and combines it with the status set", () => {
    mount({ ok: true, rows: ROWS });
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    const search = screen.getByPlaceholderText("Search by client, contra, or advisor");
    fireEvent.change(search, { target: { value: "chen" } });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    fireEvent.change(search, { target: { value: "VANGUARD" } });
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    fireEvent.change(search, { target: { value: "reynold" } });
    expect(screen.getByText("Daniel Chen")).toBeTruthy();
    fireEvent.change(search, { target: { value: "vanguard" } });
    fireEvent.click(screen.getByRole("button", { name: "Active" }));
    expect(screen.queryByRole("listitem")).toBeNull();
    markCase(SUITE, "narrows by client, contra, or advisor text and combines it with the status set");
  });

  it("shows no rows for a search with no match", () => {
    mount({ ok: true, rows: ROWS });
    fireEvent.change(screen.getByPlaceholderText("Search by client, contra, or advisor"), { target: { value: "zzz" } });
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(screen.getByText("No transfers match your filters.")).toBeTruthy();
    expect(screen.getByText("Try a different search or switch the status filter.")).toBeTruthy();
    markCase(SUITE, "shows no rows for a search with no match");
  });

  it("shows an empty allowed list without a refusal", () => {
    mount({ ok: true, rows: [] });
    expect(screen.getByText("No transfers match your filters.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("No transfers yet.")).toBeTruthy();
    expect(screen.getByText("Once a client transfer is opened it will appear here.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/isn’t available/)).toBeNull();
    markCase(SUITE, "shows an empty allowed list without a refusal");
  });

  it("shows a retryable failure in place of the rows and Retry repeats the load", async () => {
    mount({ ok: false });
    expect(screen.getByRole("alert").textContent).toContain("Couldn’t load transfers.");
    expect(screen.queryByRole("listitem")).toBeNull();
    loadMock.mockResolvedValueOnce({ ok: true, rows: ROWS });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry" })); });
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Abigayle Beier")).toBeTruthy();
    // A later failed refresh puts the failure back in place of the rows.
    loadMock.mockResolvedValueOnce({ ok: false, reason: "unavailable" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh" })); });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Abigayle Beier")).toBeNull();
    markCase(SUITE, "shows a retryable failure in place of the rows and Retry repeats the load");
  });

  it("keeps the newest load when a slower older load finishes last", async () => {
    mount({ ok: true, rows: [ABIGAYLE] });
    const slow = deferred<unknown>();
    const fast = deferred<unknown>();
    loadMock.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    const refresh = screen.getByRole("button", { name: "Refresh" });
    // Refresh stays enabled while a load runs, so a second click starts a newer load.
    await act(async () => { fireEvent.click(refresh); });
    expect(refresh.getAttribute("aria-busy")).toBe("true");
    await act(async () => { fireEvent.click(refresh); });
    await act(async () => { fast.resolve({ ok: true, rows: [ADA] }); });
    expect(screen.getByText("Daniel Chen")).toBeTruthy();
    await act(async () => { slow.resolve({ ok: true, rows: [GRACE] }); });
    expect(screen.getByText("Daniel Chen")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Completed" }));
    expect(screen.queryByText("Grace Hopper")).toBeNull();
    markCase(SUITE, "keeps the newest load when a slower older load finishes last");
  });

  it("hides the list when a refresh is refused", async () => {
    mount({ ok: true, rows: ROWS });
    loadMock.mockResolvedValueOnce({ ok: false, reason: "not_allowed" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh" })); });
    expect(screen.queryByText("Abigayle Beier")).toBeNull();
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(screen.queryByPlaceholderText("Search by client, contra, or advisor")).toBeNull();
    expect(screen.getByText("This list isn’t available to your account.")).toBeTruthy();
    markCase(SUITE, "hides the list when a refresh is refused");
  });

  it("treats a thrown load as a retryable failure", async () => {
    mount({ ok: true, rows: ROWS });
    loadMock.mockRejectedValueOnce(new Error("Failed to fetch"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh" })); });
    expect(screen.getByRole("alert").textContent).toContain("Couldn’t load transfers.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    markCase(SUITE, "treats a thrown load as a retryable failure");
  });

  it("keeps the search and status set when refreshed", async () => {
    mount({ ok: true, rows: ROWS });
    fireEvent.click(screen.getByRole("button", { name: "Completed" }));
    fireEvent.change(screen.getByPlaceholderText("Search by client, contra, or advisor"), { target: { value: "hopper" } });
    loadMock.mockResolvedValueOnce({ ok: true, rows: [ABIGAYLE, GRACE] });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh" })); });
    expect((screen.getByPlaceholderText("Search by client, contra, or advisor") as HTMLInputElement).value).toBe("hopper");
    expect(screen.getByRole("button", { name: "Completed" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
    expect(screen.getByText(/refreshed \d+s ago/)).toBeTruthy();
    markCase(SUITE, "keeps the search and status set when refreshed");
  });

  it("renders the failure state without controls until a load succeeds", async () => {
    mount({ ok: false });
    expect(screen.getByRole("heading", { name: "Client Transfers" })).toBeTruthy();
    expect(screen.queryByPlaceholderText("Search by client, contra, or advisor")).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(screen.queryByText(/Read-only view/)).toBeNull();
    loadMock.mockResolvedValueOnce({ ok: false, reason: "unavailable" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry" })); });
    expect(screen.queryByPlaceholderText("Search by client, contra, or advisor")).toBeNull();
    loadMock.mockResolvedValueOnce({ ok: true, rows: ROWS });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry" })); });
    expect(screen.getByPlaceholderText("Search by client, contra, or advisor")).toBeTruthy();
    markCase(SUITE, "renders the failure state without controls until a load succeeds");
  });

  it("renders a status the tracker does not label as its raw name and counts it as Active", () => {
    mount({ ok: true, rows: [row({ id: "n1", clientName: "New Status Client", status: "SomethingNew" })] });
    expect(screen.getByText("SomethingNew")).toBeTruthy();
    expect(screen.getByText("New Status Client")).toBeTruthy();
    expect(screen.getByText("1", { selector: "strong" })).toBeTruthy();
    markCase(SUITE, "renders a status the tracker does not label as its raw name and counts it as Active");
  });

  it("omits account numbers, fee amounts, fee memos, and internal notes", () => {
    const full = {
      ...ABIGAYLE,
      apexAccountId: "TAV-vgthyr-823",
      statementAccountNumber: "FQBU-lsqsxd-612",
      controlNumber: "CTRL-secret-001",
      feeAmount: "$75.00",
      feeMemo: "internal-only fee context",
      notes: "internal-only ops notes",
    } as AdvisorTransferRow;
    const { container } = mount({ ok: true, rows: [full] });
    fireEvent.click(screen.getByRole("button", { name: /Abigayle Beier/ }));
    const text = container.textContent ?? "";
    for (const secret of ["TAV-vgthyr-823", "FQBU-lsqsxd-612", "CTRL-secret-001", "$75.00", "internal-only fee context", "internal-only ops notes"]) {
      expect(text).not.toContain(secret);
    }
    expect(container.innerHTML).not.toContain("secret");
    expect(screen.queryByRole("button", { name: /edit|delete|fee/i })).toBeNull();
    markCase(SUITE, "omits account numbers, fee amounts, fee memos, and internal notes");
  });

  it("uses the tracker hue for active and terminal statuses", () => {
    mount({ ok: true, rows: ROWS });
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    const hue = (label: string) => screen.getByText(label, { selector: "span[data-hue]" }).getAttribute("data-hue");
    expect(hue("Submitted")).toBe("active");
    expect(hue("Pending Settlement")).toBe("active");
    expect(hue("Completed")).toBe("terminal");
    markCase(SUITE, "uses the tracker hue for active and terminal statuses");
  });
});
