// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";
import { transferFormFixture } from "./fixtures/transfer-form";

const actions = vi.hoisted(() => ({ load: vi.fn(), watch: vi.fn(), confirm: vi.fn(), generate: vi.fn() }));
vi.mock("@/app/(authenticated)/acat-tracking/paperwork-actions", () => ({
  loadPaperwork: actions.load,
  loadPaperworkWatchouts: actions.watch,
  confirmPaperworkTitle: actions.confirm,
  generatePaperwork: actions.generate,
}));

import { AcatPaperworkSection } from "@/components/transfers/AcatPaperworkSection";
import { EXTERNAL_APPS } from "@/lib/external-apps";
import {
  PAPERWORK_FAILURE_COPY,
  PAPERWORK_HISTORY_FAILURE,
  PAPERWORK_NO_DOCUMENTS,
  PAPERWORK_SAVE_FAILED,
  PAPERWORK_WATCHOUTS_FAILURE,
} from "@/lib/transfers/paperwork-section";
import type { TransferFormPreparation } from "@/lib/transfers/transfer-form-contract";

const SUITE = "acat-paperwork-section";
const CONFIRMED_AT = "2026-09-25T14:00:00.000Z";
const STORED_AT = "2026-10-01T16:30:00.000Z";
const APEX = "APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST" as const;

const CONFIRMATION = {
  id: "conf-1", title: "Receiving Title LLC", registration: "Individual", confirmedBy: "operator@example.test",
  confirmedAt: CONFIRMED_AT, valid: true, source: "AOA" as const,
};
const holding = (id: string, include: boolean | null) => ({ id, symbol: id.toUpperCase(), description: `Holding ${id}`, quantity: 5, include });

function prep(over: Partial<TransferFormPreparation> = {}): TransferFormPreparation {
  const base = structuredClone(transferFormFixture);
  return {
    ...base,
    confirmation: { ...CONFIRMATION },
    accounts: { ...base.accounts, deliveringTitleSuggestion: "Delivering Title LLC" },
    workflows: [{ ...base.workflows[0], template: APEX }],
    ...over,
  };
}
const custodian = (over: Record<string, unknown> = {}) => ({
  id: "cust-1", name: "Example Brokerage", reviewStatus: "VERIFIED", watchouts: "Original watchout",
  letterOfAcceptance: "LOA required", receivingAccountNumber: "HOUSE-77", medallionRequired: "Medallion for transfers over $100k",
  signature: "Wet signature", returnMethod: "Mail", liquidationMethod: "Market order", ...over,
});
const watchouts = (over: Record<string, unknown> = {}) => ({
  ok: true as const, custodian: custodian(over), match: "MATCHED" as const, candidates: [],
  retrievedAt: "2026-10-13T15:00:00.000Z", checkedAt: "2026-10-13T15:00:05.000Z",
});
const loaded = (data: TransferFormPreparation) => ({ ok: true as const, data });
const fail = (reason: string) => ({ ok: false as const, reason });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

function renderSection(props: { readOnly?: boolean } = {}) {
  return render(createElement(AcatPaperworkSection, { recordId: "rec-1", readOnly: props.readOnly ?? false }));
}
async function ready(props: { readOnly?: boolean } = {}) {
  const view = renderSection(props);
  await screen.findByText("Original watchout");
  await screen.findByRole("heading", { name: "Transfer paperwork recommendation" });
  return view;
}

const downloadButton = () => screen.getByRole("button", { name: "Download prefilled form" }) as HTMLButtonElement;
const finalReview = () => screen.getByLabelText(/I verified the delivering title and reviewed both accounts/) as HTMLInputElement;
const pdfResponse = () => new Response("%PDF-1.7 synthetic", {
  status: 200, headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="transfer-doc-1.pdf"' },
});

let blobs: Blob[] = [];
let saved: string[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  blobs = [];
  saved = [];
  actions.load.mockResolvedValue(loaded(prep()));
  actions.watch.mockResolvedValue(watchouts());
  actions.confirm.mockResolvedValue(loaded(prep()));
  actions.generate.mockResolvedValue({ ok: true, data: { documentId: "doc-1" } });
  fetchMock = vi.fn(async () => pdfResponse());
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn((blob: Blob) => { blobs.push(blob); return "blob:synthetic"; }) });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved.push(this.download); });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("paperwork section", () => {
  it("tkt335 section: shows the recommended form with its template, handling, both account titles, and the current watchouts", async () => {
    await ready();
    expect(screen.getByText("Standard brokerage transfer")).toBeTruthy();
    expect(screen.getByText("Apex Customer Account Transfer Request")).toBeTruthy();
    expect(screen.getByText("Asset handling: Client-directed — in kind or liquidate")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Transfer in kind" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Liquidate" })).toBeTruthy();
    const titles = screen.getByLabelText("Account titles");
    expect(within(titles).getByText("Receiving Title LLC")).toBeTruthy();
    expect(within(titles).getByText("Delivering Title LLC")).toBeTruthy();
    expect(screen.getByText("Custodian Library — source of truth")).toBeTruthy();
    expect(screen.getByText("Original watchout")).toBeTruthy();
    expect(screen.getByText("LOA required")).toBeTruthy();
    expect(screen.getByText("HOUSE-77")).toBeTruthy();
    expect(screen.getByText("Wet signature")).toBeTruthy();
    markCase(SUITE, "tkt335 section: shows the recommended form with its template, handling, both account titles, and the current watchouts");
  });

  it("tkt335 section: the template line is absent when the tracker sends no template", async () => {
    actions.load.mockResolvedValue(loaded(prep({ workflows: [structuredClone(transferFormFixture.workflows[0])] })));
    await ready();
    expect(screen.getByText("Standard brokerage transfer")).toBeTruthy();
    expect(screen.queryByText(/Transfer Request/)).toBeNull();
    markCase(SUITE, "tkt335 section: the template line is absent when the tracker sends no template");
  });

  it("tkt335 section: shows the confirmed receiving title with the person who confirmed it", async () => {
    await ready();
    const titles = screen.getByLabelText("Account titles");
    expect(within(titles).getByText("Receiving Title LLC")).toBeTruthy();
    const saved = within(titles).getByText(/by operator@example\.test/);
    expect(saved.textContent).toContain(new Date(CONFIRMED_AT).toLocaleString());
    markCase(SUITE, "tkt335 section: shows the confirmed receiving title with the person who confirmed it");
  });

  it("tkt335 section: confirming a title saves with a stable operation id and shows the saved title and person", async () => {
    actions.load.mockResolvedValue(loaded(prep({ confirmation: null })));
    actions.confirm.mockResolvedValueOnce(fail("unavailable")).mockResolvedValueOnce(loaded(prep()));
    await ready();
    expect(screen.queryByRole("button", { name: "Download prefilled form" })?.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Exact receiving account title"), { target: { value: "Receiving Title LLC" } });
    fireEvent.change(screen.getByLabelText("Receiving registration"), { target: { value: "Individual" } });
    const confirm = screen.getByRole("button", { name: "Confirm and save" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I verified this exact title and registration/));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await screen.findByText(PAPERWORK_FAILURE_COPY.unavailable);
    fireEvent.click(screen.getByRole("button", { name: "Confirm and save" }));
    await screen.findByText(/by operator@example\.test/);
    expect(actions.confirm).toHaveBeenCalledTimes(2);
    const [first, second] = actions.confirm.mock.calls.map((call) => call[1]);
    expect(first).toMatchObject({ expectedRevision: "a".repeat(64), title: "Receiving Title LLC", registration: "Individual", confirmed: true });
    expect(first.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.operationId).toBe(first.operationId);
    expect(actions.confirm.mock.calls[0][0]).toBe("rec-1");
    expect(screen.getByText("Receiving account title confirmed and saved.")).toBeTruthy();
    markCase(SUITE, "tkt335 section: confirming a title saves with a stable operation id and shows the saved title and person");
  });

  it("tkt335 section: a recommendation load failure shows a retryable failure in place of the download", async () => {
    actions.load.mockResolvedValue(fail("unavailable"));
    renderSection();
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((node) => node.textContent?.includes(PAPERWORK_FAILURE_COPY.unavailable))).toBe(true);
    expect(screen.queryByRole("button", { name: "Download prefilled form" })).toBeNull();
    expect(screen.queryByText("Standard brokerage transfer")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Retry" }).length).toBeGreaterThan(0);
    markCase(SUITE, "tkt335 section: a recommendation load failure shows a retryable failure in place of the download");
  });

  it("tkt335 section: retry after a load failure reloads and shows the recommendation", async () => {
    actions.load.mockResolvedValueOnce(fail("unavailable")).mockResolvedValue(loaded(prep()));
    renderSection();
    await screen.findAllByRole("alert");
    const retry = screen.getAllByRole("button", { name: "Retry" })[0];
    fireEvent.click(retry);
    await screen.findByText("Standard brokerage transfer");
    expect(actions.load).toHaveBeenCalledTimes(2);
    expect(downloadButton()).toBeTruthy();
    markCase(SUITE, "tkt335 section: retry after a load failure reloads and shows the recommendation");
  });

  it("tkt335 section: a partial transfer shows included, excluded, and undecided counts that update on refresh", async () => {
    actions.load
      .mockResolvedValueOnce(loaded(prep({ scope: "PARTIAL", positions: [holding("a", true), holding("b", false), holding("c", null)] })))
      .mockResolvedValue(loaded(prep({ scope: "PARTIAL", positions: [holding("a", true), holding("b", false), holding("c", true)] })));
    await ready();
    expect(screen.getByText(/Partial-transfer holdings: 1 included, 1 excluded, 1 undecided\./)).toBeTruthy();
    const table = screen.getByRole("table", { name: "Partial-transfer holdings" });
    expect(within(table).getByText("Undecided")).toBeTruthy();
    expect(within(table).getByText("Excluded")).toBeTruthy();
    expect(screen.getByText(/Mark each holding Included or Excluded in Transfer Tracker, then use Refresh/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText(/Partial-transfer holdings: 2 included, 1 excluded, 0 undecided\./);
    expect(within(screen.getByRole("table", { name: "Partial-transfer holdings" })).queryByText("Undecided")).toBeNull();
    markCase(SUITE, "tkt335 section: a partial transfer shows included, excluded, and undecided counts that update on refresh");
  });

  it("tkt335 section: undecided holdings leave the download unavailable", async () => {
    actions.load.mockResolvedValue(loaded(prep({ scope: "PARTIAL", positions: [holding("a", true), holding("c", null)] })));
    await ready();
    fireEvent.click(screen.getByRole("radio", { name: "Transfer in kind" }));
    fireEvent.click(finalReview());
    expect(downloadButton().disabled).toBe(true);
    expect(screen.getByText("Decide whether to include 1 undecided holding in Transfer Tracker, then refresh.")).toBeTruthy();
    fireEvent.click(downloadButton());
    expect(actions.generate).not.toHaveBeenCalled();
    markCase(SUITE, "tkt335 section: undecided holdings leave the download unavailable");
  });

  it("tkt335 section: a client-directed workflow offers in kind or liquidate and a fixed one offers no choice", async () => {
    const { unmount } = await ready();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    unmount();
    actions.load.mockResolvedValue(loaded(prep({
      workflows: [{ ...transferFormFixture.workflows[0], handling: { mode: "FIXED", options: ["LIQUIDATE"] }, template: APEX }],
    })));
    renderSection();
    await screen.findByText("Asset handling: Liquidate only");
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByText(/This route uses liquidation\./)).toBeTruthy();
    markCase(SUITE, "tkt335 section: a client-directed workflow offers in kind or liquidate and a fixed one offers no choice");
  });

  it("tkt335 section: a mixed packet asks for an instruction on every included holding", async () => {
    actions.load.mockResolvedValue(loaded(prep({ scope: "PARTIAL", positions: [holding("a", true), holding("b", true), holding("c", false)] })));
    await ready();
    fireEvent.click(screen.getByRole("radio", { name: "Mix of in-kind and cash" }));
    expect(screen.getByLabelText("Instruction for A")).toBeTruthy();
    expect(screen.getByLabelText("Instruction for B")).toBeTruthy();
    expect(screen.queryByLabelText("Instruction for C")).toBeNull();
    fireEvent.click(finalReview());
    expect(downloadButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Instruction for A"), { target: { value: "IN_KIND" } });
    fireEvent.change(screen.getByLabelText("Instruction for B"), { target: { value: "IN_KIND" } });
    fireEvent.click(finalReview());
    expect(screen.getByText("Choose how the assets should transfer.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Instruction for B"), { target: { value: "LIQUIDATE" } });
    fireEvent.click(finalReview());
    expect(downloadButton().disabled).toBe(false);
    markCase(SUITE, "tkt335 section: a mixed packet asks for an instruction on every included holding");
  });

  it("tkt335 section: a ready download generates and saves the file with the titles and decided instructions", async () => {
    actions.load.mockResolvedValue(loaded(prep({ scope: "PARTIAL", positions: [holding("a", true), holding("b", true), holding("c", false)] })));
    await ready();
    fireEvent.click(screen.getByRole("radio", { name: "Mix of in-kind and cash" }));
    fireEvent.change(screen.getByLabelText("Instruction for A"), { target: { value: "IN_KIND" } });
    fireEvent.change(screen.getByLabelText("Instruction for B"), { target: { value: "LIQUIDATE" } });
    fireEvent.click(finalReview());
    expect(downloadButton().disabled).toBe(false);
    fireEvent.click(downloadButton());
    await screen.findByText("Saved to this transfer's paperwork history. You can download it again without regenerating.");
    expect(actions.generate).toHaveBeenCalledTimes(1);
    expect(actions.generate).toHaveBeenCalledWith("rec-1", expect.objectContaining({
      expectedRevision: "a".repeat(64), confirmationId: "conf-1", workflowId: "default-brokerage", assetInstruction: "MIXED",
      deliveringTitle: "Delivering Title LLC", deliveringTitleConfirmed: true, accountsReviewed: true, instructionsReviewed: true,
      letterOfAuthorizationRequired: false,
      positionInstructions: [{ positionId: "a", assetInstruction: "IN_KIND" }, { positionId: "b", assetInstruction: "LIQUIDATE" }],
    }));
    expect(fetchMock).toHaveBeenCalledWith("/api/transfers/rec-1/forms/doc-1", { cache: "no-store" });
    expect(saved).toEqual(["transfer-doc-1.pdf"]);
    expect(await blobs[0].text()).toContain("%PDF-");
    // The history and the playbook are read again after the save.
    await waitFor(() => expect(actions.load).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(actions.watch).toHaveBeenCalledTimes(2));
    markCase(SUITE, "tkt335 section: a ready download generates and saves the file with the titles and decided instructions");
  });

  it("tkt335 section: the download button stays disabled until the final review is checked", async () => {
    await ready();
    fireEvent.click(screen.getByRole("radio", { name: "Transfer in kind" }));
    expect(downloadButton().disabled).toBe(true);
    expect(screen.getByText("Check the final review confirmation to download the form.")).toBeTruthy();
    fireEvent.click(finalReview());
    expect(downloadButton().disabled).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: "Liquidate" }));
    expect(finalReview().checked).toBe(false);
    expect(downloadButton().disabled).toBe(true);
    markCase(SUITE, "tkt335 section: the download button stays disabled until the final review is checked");
  });

  it("tkt335 section: a generation failure is retryable with the same operation id", async () => {
    actions.generate.mockResolvedValueOnce(fail("unavailable")).mockResolvedValueOnce({ ok: true, data: { documentId: "doc-1" } });
    await ready();
    fireEvent.click(screen.getByRole("radio", { name: "Transfer in kind" }));
    fireEvent.click(finalReview());
    fireEvent.click(downloadButton());
    const alert = await screen.findByText(PAPERWORK_FAILURE_COPY.unavailable);
    expect(saved).toEqual([]);
    fireEvent.click(within(alert.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "Retry" }));
    await screen.findByText(/Saved to this transfer's paperwork history/);
    expect(actions.generate).toHaveBeenCalledTimes(2);
    const [first, second] = actions.generate.mock.calls.map((call) => call[1]);
    expect(second.operationId).toBe(first.operationId);
    expect(saved).toEqual(["transfer-doc-1.pdf"]);
    markCase(SUITE, "tkt335 section: a generation failure is retryable with the same operation id");
  });

  it("tkt335 section: a failed file save retries the save without generating again", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 503, headers: { "content-type": "application/json" } }));
    await ready();
    fireEvent.click(screen.getByRole("radio", { name: "Transfer in kind" }));
    fireEvent.click(finalReview());
    fireEvent.click(downloadButton());
    await screen.findByText(PAPERWORK_SAVE_FAILED);
    expect(saved).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Retry download" }));
    await screen.findByText(/Saved to this transfer's paperwork history/);
    expect(actions.generate).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(saved).toEqual(["transfer-doc-1.pdf"]);
    markCase(SUITE, "tkt335 section: a failed file save retries the save without generating again");
  });

  it("tkt335 section: document history shows each document with its stored time", async () => {
    actions.load.mockResolvedValue(loaded(prep({
      documents: [
        { id: "doc-9", filename: "Apex-Transfer-9.pdf", createdBy: "operator@example.test", createdAt: STORED_AT, sha256: "b".repeat(64) },
        { id: "doc-8", filename: "Apex-Transfer-8.pdf", createdBy: "other@example.test", createdAt: "2026-09-30T09:00:00.000Z", sha256: "c".repeat(64) },
      ],
    })));
    await ready();
    const history = screen.getByLabelText("Transfer document history");
    const first = within(history).getByRole("link", { name: "Apex-Transfer-9.pdf" });
    expect(first.getAttribute("href")).toBe("/api/transfers/rec-1/forms/doc-9");
    const stored = within(history).getByText(new Date(STORED_AT).toLocaleString());
    expect(stored.tagName).toBe("TIME");
    expect(stored.getAttribute("datetime")).toBe(STORED_AT);
    expect(stored.closest("li")?.textContent).toContain("Stored");
    expect(stored.closest("li")?.textContent).toContain("operator@example.test");
    expect(within(history).getByRole("link", { name: "Apex-Transfer-8.pdf" })).toBeTruthy();
    expect(within(history).getByText(new Date("2026-09-30T09:00:00.000Z").toLocaleString())).toBeTruthy();
    expect(within(history).queryByText(PAPERWORK_NO_DOCUMENTS)).toBeNull();
    markCase(SUITE, "tkt335 section: document history shows each document with its stored time");
  });

  it("tkt335 section: empty document history shows No documents yet", async () => {
    await ready();
    expect(within(screen.getByLabelText("Transfer document history")).getByText("No documents yet")).toBeTruthy();
    markCase(SUITE, "tkt335 section: empty document history shows No documents yet");
  });

  it("tkt335 section: watchouts show the playbook as changed after the transfer opened", async () => {
    await ready();
    expect(screen.getByText("Original watchout")).toBeTruthy();
    actions.watch.mockResolvedValue(watchouts({ watchouts: "Changed after the transfer opened" }));
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await screen.findByText("Changed after the transfer opened");
    expect(screen.queryByText("Original watchout")).toBeNull();
    expect(actions.watch).toHaveBeenCalledTimes(2);
    // Refresh also reads the playbook again.
    actions.watch.mockResolvedValue(watchouts({ watchouts: "Changed again" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Changed again");
    markCase(SUITE, "tkt335 section: watchouts show the playbook as changed after the transfer opened");
  });

  it("tkt335 section: a watchouts failure is retryable in place of the watchouts", async () => {
    actions.watch.mockResolvedValueOnce(fail("unavailable")).mockResolvedValue(watchouts());
    renderSection();
    const region = await screen.findByLabelText("Custodian rules");
    await within(region).findByText(PAPERWORK_WATCHOUTS_FAILURE);
    expect(within(region).queryByText("Original watchout")).toBeNull();
    fireEvent.click(within(region).getByRole("button", { name: "Retry" }));
    await within(region).findByText("Original watchout");
    expect(within(region).queryByText(PAPERWORK_WATCHOUTS_FAILURE)).toBeNull();
    markCase(SUITE, "tkt335 section: a watchouts failure is retryable in place of the watchouts");
  });

  it("tkt335 section: a history load failure is retryable in place of the history list", async () => {
    actions.load.mockResolvedValueOnce(fail("unavailable")).mockResolvedValue(loaded(prep({
      documents: [{ id: "doc-9", filename: "Apex-Transfer-9.pdf", createdBy: "operator@example.test", createdAt: STORED_AT, sha256: "b".repeat(64) }],
    })));
    renderSection();
    const history = await screen.findByLabelText("Transfer document history");
    await within(history).findByText(PAPERWORK_HISTORY_FAILURE);
    expect(within(history).queryByRole("link")).toBeNull();
    fireEvent.click(within(history).getByRole("button", { name: "Retry" }));
    await within(history).findByRole("link", { name: "Apex-Transfer-9.pdf" });
    expect(within(history).queryByText(PAPERWORK_HISTORY_FAILURE)).toBeNull();

    // A history refresh that fails after a saved form keeps the saved notice and shows the failure.
    cleanup();
    actions.load.mockReset();
    actions.load.mockResolvedValueOnce(loaded(prep())).mockResolvedValue(fail("unavailable"));
    await ready();
    fireEvent.click(screen.getByRole("radio", { name: "Transfer in kind" }));
    fireEvent.click(finalReview());
    fireEvent.click(downloadButton());
    await screen.findByText(/Saved to this transfer's paperwork history/);
    const after = screen.getByLabelText("Transfer document history");
    await within(after).findByText(PAPERWORK_HISTORY_FAILURE);
    expect(actions.generate).toHaveBeenCalledTimes(1);
    markCase(SUITE, "tkt335 section: a history load failure is retryable in place of the history list");
  });

  it("tkt335 section: a watchouts failure keeps the recommendation visible", async () => {
    actions.watch.mockResolvedValue(fail("unavailable"));
    renderSection();
    await screen.findByText("Standard brokerage transfer");
    await screen.findByText(PAPERWORK_WATCHOUTS_FAILURE);
    expect(screen.getByText("Apex Customer Account Transfer Request")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Transfer in kind" })).toBeTruthy();
    markCase(SUITE, "tkt335 section: a watchouts failure keeps the recommendation visible");
  });

  it("tkt335 section: a stale response from an earlier load is dropped", async () => {
    const slow = deferred<ReturnType<typeof loaded>>();
    actions.load.mockReturnValueOnce(slow.promise).mockResolvedValue(loaded(prep({ accounts: { ...prep().accounts, deliveringTitleSuggestion: "Newest Delivering Title" } })));
    renderSection();
    await screen.findByText("Original watchout");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Newest Delivering Title");
    await act(async () => { slow.resolve(loaded(prep({ accounts: { ...prep().accounts, deliveringTitleSuggestion: "Stale Delivering Title" } }))); });
    expect(screen.queryByText("Stale Delivering Title")).toBeNull();
    expect(screen.getByText("Newest Delivering Title")).toBeTruthy();
    markCase(SUITE, "tkt335 section: a stale response from an earlier load is dropped");
  });

  it("tkt335 section: read-only mode shows no confirm or generate control and still shows history", async () => {
    actions.load.mockResolvedValue(loaded(prep({
      confirmation: null,
      documents: [{ id: "doc-9", filename: "Apex-Transfer-9.pdf", createdBy: "operator@example.test", createdAt: STORED_AT, sha256: "b".repeat(64) }],
    })));
    await ready({ readOnly: true });
    expect(screen.getByText("Edits are off, so paperwork can be reviewed but not changed.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm and save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download prefilled form" })).toBeNull();
    expect(screen.queryByLabelText(/I verified the delivering title/)).toBeNull();
    expect(screen.getByRole("link", { name: "Apex-Transfer-9.pdf" })).toBeTruthy();
    expect(screen.getByText("Original watchout")).toBeTruthy();
    markCase(SUITE, "tkt335 section: read-only mode shows no confirm or generate control and still shows history");
  });

  it("tkt335 section: the delivering title is editable and verified only when an inherited-title review is required", async () => {
    const { unmount } = await ready();
    expect(screen.queryByLabelText(/Delivering account title from current statement/)).toBeNull();
    unmount();
    actions.load.mockResolvedValue(loaded(prep({ inheritedTitleReview: true })));
    renderSection();
    const input = await screen.findByLabelText(/Delivering account title from current statement/);
    expect(screen.getByText("Titles differ — the letter of authorization will be populated.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "Receiving Title LLC" } });
    expect(screen.getByText("Titles match — Custodian Library LOA guidance still applies.")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Transfer in kind" }));
    fireEvent.click(finalReview());
    expect(downloadButton().disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I confirmed this delivering title against the current statement/));
    fireEvent.click(finalReview());
    expect(downloadButton().disabled).toBe(false);
    fireEvent.change(input, { target: { value: "Different Title" } });
    fireEvent.click(screen.getByLabelText(/I confirmed this delivering title against the current statement/));
    fireEvent.click(finalReview());
    fireEvent.click(downloadButton());
    await screen.findByText(/Saved to this transfer's paperwork history/);
    expect(actions.generate).toHaveBeenCalledWith("rec-1", expect.objectContaining({ deliveringTitle: "Different Title", letterOfAuthorizationRequired: true }));
    markCase(SUITE, "tkt335 section: the delivering title is editable and verified only when an inherited-title review is required");
  });

  it("tkt335 section: a house account number is required only when the workflow requires it", async () => {
    const { unmount } = await ready();
    expect(screen.queryByLabelText(/Verified receiving \/ house account number/)).toBeNull();
    unmount();
    actions.load.mockResolvedValue(loaded(prep({
      workflows: [{ ...transferFormFixture.workflows[0], requiresReceivingAccountNumber: true, template: APEX }],
    })));
    renderSection();
    const input = await screen.findByLabelText(/Verified receiving \/ house account number/);
    fireEvent.click(screen.getByRole("radio", { name: "Transfer in kind" }));
    fireEvent.click(finalReview());
    expect(downloadButton().disabled).toBe(true);
    expect(screen.getByText("Verify the receiving / house account number with Apex MF Ops.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "ACCT-5" } });
    fireEvent.click(screen.getByLabelText(/I verified this receiving\/house number with Apex MF Ops/));
    fireEvent.click(finalReview());
    fireEvent.click(downloadButton());
    await screen.findByText(/Saved to this transfer's paperwork history/);
    expect(actions.generate).toHaveBeenCalledWith("rec-1", expect.objectContaining({ receivingAccountNumber: "ACCT-5", receivingAccountNumberVerified: true }));
    markCase(SUITE, "tkt335 section: a house account number is required only when the workflow requires it");
  });

  it("tkt335 section: a disabled tracker shows the disabled copy with a retry", async () => {
    actions.load.mockResolvedValue(fail("disabled"));
    renderSection();
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((node) => node.textContent?.includes(PAPERWORK_FAILURE_COPY.disabled))).toBe(true);
    expect(screen.getAllByRole("button", { name: "Retry" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Download prefilled form" })).toBeNull();
    markCase(SUITE, "tkt335 section: a disabled tracker shows the disabled copy with a retry");
  });

  it("tkt345 section: a loaded recommendation stays in Always On Advice with no tracker fallback link", async () => {
    const { container } = await ready();
    expect(screen.getByText("Standard brokerage transfer")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Transfer Tracker/ })).toBeNull();
    expect(container.querySelector(`a[href="${EXTERNAL_APPS.acatTracking}"]`)).toBeNull();
    markCase(SUITE, "tkt345 section: a loaded recommendation stays in Always On Advice with no tracker fallback link");
  });

  it.each(["unavailable", "disabled"])("tkt345 section: a %s load failure offers Retry in place and no route to Transfer Tracker", async (reason) => {
    actions.load.mockResolvedValue(fail(reason));
    const { container } = renderSection();
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((node) => node.textContent?.includes(PAPERWORK_FAILURE_COPY[reason as "unavailable" | "disabled"]))).toBe(true);
    expect(screen.getAllByRole("button", { name: "Retry" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: /Transfer Tracker/ })).toBeNull();
    expect(container.querySelector(`a[href="${EXTERNAL_APPS.acatTracking}"]`)).toBeNull();
    expect(container.textContent).not.toMatch(/Continue in Transfer Tracker/);
    markCase(SUITE, `tkt345 section: a ${reason} load failure offers Retry in place and no route to Transfer Tracker`);
  });

  it("tkt335 section: the section renders only the masked account numbers the tracker sends", async () => {
    const { container } = await ready();
    expect(container.textContent).toContain("****5678 → ****1234");
    expect(container.textContent).not.toMatch(/\d{7,}/);
    markCase(SUITE, "tkt335 section: the section renders only the masked account numbers the tracker sends");
  });
});
