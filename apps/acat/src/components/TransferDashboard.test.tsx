import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TransferDashboard from "./TransferDashboard";
import { AcatRecord } from "@/lib/types";

function record(overrides: Partial<AcatRecord> = {}): AcatRecord {
  return {
    id: "r1",
    clientName: "Client One",
    apexAccountId: "A1",
    status: "Completed",
    transferWorkflow: "ACAT",
    originalClientRequestDate: "2025-06-01",
    opsSubmissionDateToApex: "2025-06-02",
    apexCompletionDate: "2025-06-07",
    lastUpdated: "2025-06-07",
    crmDealId: "",
    custodianId: "",
    custodianName: "",
    acatDate: "2025-06-01",
    slackAlerted: false,
    mappingSource: "GCP Project API",
    apexSource: "Pending Upload",
    assets: [],
    ...overrides,
  };
}

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }) as unknown as typeof fetch;
});

describe("TransferDashboard", () => {
  it("uses the shared dashboard data-quality composition", () => {
    render(
      <TransferDashboard
        acats={[
          record({
            controlNumber: "CTRL-1",
            residualMonitoringRequired: true,
            residualFollowUpDate: "2025-06-08",
          }),
        ]}
        onSelectRecord={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Residual monitoring \(1\)/ })).toBeInTheDocument();
  });

  it("shows finalized outcome cards and workflow timing", async () => {
    render(<TransferDashboard acats={[record(), record({ id: "r2", status: "Rejected", rejectionReason: "Bad account" })]} onSelectRecord={vi.fn()} />);
    expect(screen.getByText("All transfers")).toBeInTheDocument();
    expect(screen.getByText("Cycle time by transfer workflow")).toBeInTheDocument();
    expect(screen.queryByText("Terminal")).not.toBeInTheDocument();
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/data-quality-reviews"));
  });

  it("keeps missing historical recon neutral", async () => {
    render(<TransferDashboard acats={[record()]} onSelectRecord={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reconciliation" }));
    expect(screen.getAllByText("Not tracked")).toHaveLength(2);
    expect(screen.getByText("No recon evidence; not a mismatch")).toBeInTheDocument();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  });

  it("shows monthly requests separately from residual movements", () => {
    const currentMonth = new Date().toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
    render(<TransferDashboard acats={[record(), record({ id: "drs", transferWorkflow: "DRS" }), record({ id: "res", type: "Residual Credit", transferWorkflow: "RESIDUAL" })]} onSelectRecord={vi.fn()} />);
    fireEvent.click(screen.getByText("Transfer requests over time"));
    const section = screen.getByText("Transfer requests over time").closest("details");
    expect(section).not.toBeNull();
    const rows = within(section!).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("Jun 2025");
    expect(rows.at(-1)).toHaveTextContent(currentMonth);
    expect(within(section!).getByRole("img", { name: "Monthly transfer requests by workflow" })).toBeInTheDocument();
    expect(within(section!).getByText("View monthly data")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "DRS" })).toBeInTheDocument();
  });

  it("uses distinct, matching legend and bar fills without changing monthly counts", () => {
    render(<TransferDashboard acats={[
      record(),
      record({ id: "manual", transferWorkflow: "MANUAL" }),
      record({ id: "drs", transferWorkflow: "DRS" }),
      record({ id: "unclassified", transferWorkflow: "UNCLASSIFIED" }),
      record({ id: "residual", type: "Residual Credit", transferWorkflow: "RESIDUAL" }),
    ]} onSelectRecord={vi.fn()} />);
    fireEvent.click(screen.getByText("Transfer requests over time"));
    const chart = screen.getByRole("img", { name: "Monthly transfer requests by workflow" });
    const month = within(chart).getByLabelText("Jun 2025: 4 requests; ACAT (API) 1, Manual 1, DRS 1, Unclassified 1");
    const segments = Array.from(month.querySelectorAll<HTMLSpanElement>("span[style]"));
    expect(segments).toHaveLength(4);

    const fills = [
      { label: "ACAT (API)", color: "#7c3aed" },
      { label: "Manual", color: "#0d9488" },
      { label: "DRS", color: "#d97706" },
      { label: "Unclassified", color: "#6b7280" },
    ];
    fills.forEach(({ label, color }, index) => {
      const swatch = within(chart).getByText(label).querySelector<HTMLSpanElement>("span")!;
      expect(swatch).toHaveStyle({ backgroundColor: color });
      expect(segments[index]).toHaveStyle({ backgroundColor: color, height: "25%" });
      expect(segments[index].style.backgroundImage).toBe(swatch.style.backgroundImage);
      expect(segments[index].style.boxShadow).toBe("inset 0 1px 0 var(--bg-card)");
    });
    expect(segments[1].style.backgroundImage).toContain("repeating-linear-gradient");
    expect(segments[0].style.backgroundImage).toBe("");
    expect(new Set(segments.map((segment) => segment.style.backgroundColor)).size).toBe(4);
    expect(screen.getByText("View monthly data")).toBeInTheDocument();
  });

  it("separates top contras into ACAT/API and Manual panels", () => {
    render(<TransferDashboard acats={[record({ transferringContra: "Fidelity" }), record({ id: "manual", transferWorkflow: "MANUAL", transferringContra: "Schwab" })]} onSelectRecord={vi.fn()} />);
    fireEvent.click(screen.getByText("Top contras"));

    const acatPanel = screen.getByText("Top ACAT / API contras").closest("div");
    const manualPanel = screen.getByText("Top Manual contras").closest("div");
    expect(acatPanel).not.toBeNull();
    expect(manualPanel).not.toBeNull();
    expect(within(acatPanel!).getByText("Fidelity")).toBeInTheDocument();
    expect(within(acatPanel!).queryByText("Schwab")).not.toBeInTheDocument();
    expect(within(manualPanel!).getByText("Schwab")).toBeInTheDocument();
    expect(within(manualPanel!).queryByText("Fidelity")).not.toBeInTheDocument();
    expect(screen.getAllByRole("columnheader", { name: "Finalized transfers" })).toHaveLength(2);
    expect(screen.queryByText("Outcome n")).not.toBeInTheDocument();
    expect(screen.getByText(/counts completed, rejected, and canceled transfers; active and purged transfers are excluded/)).toBeInTheDocument();
    expect(screen.getByText(/is rejected transfers divided by finalized transfers/)).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader", { name: "Median submit → complete" })).toHaveLength(2);
    expect(screen.getByText(/Ops Submission Date to Apex → Apex Completion Date/)).toBeInTheDocument();
    expect(screen.getAllByText(/weekends and ACATS processing holidays are excluded/)).toHaveLength(2);
  });

  it.each(["ACAT", "MANUAL"] as const)("shows finalized transfers as the rejection denominator for %s", (workflow) => {
    const statuses = ["Completed", "Rejected", "Canceled", "Purged", "Accepted"] as const;
    render(<TransferDashboard acats={statuses.map((status) => record({
      id: status, status, transferWorkflow: workflow, transferringContra: "Example Custodian",
    }))} onSelectRecord={vi.fn()} />);
    fireEvent.click(screen.getByText("Top contras"));
    const row = screen.getByText("Example Custodian").closest("tr")!;
    const cells = within(row).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent(/^1$/);
    expect(cells[2]).toHaveTextContent(/^3$/);
    expect(cells[3]).toHaveTextContent("33.3%");
  });

  it("documents every data-quality control even when the queue is empty", async () => {
    render(<TransferDashboard acats={[]} onSelectRecord={vi.fn()} />);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Dashboard sections" })).getByRole("button", { name: /Data quality/ }));
    fireEvent.click(screen.getByText("What the queue checks"));

    expect(screen.getByText("Completed without Apex date")).toBeInTheDocument();
    expect(screen.getByText("Residual sweep needs follow-up")).toBeInTheDocument();
    expect(screen.getByText(/Selecting more than one request method is valid/)).toBeInTheDocument();
  });

  it("filters the data-quality queue by exception type", async () => {
    render(
      <TransferDashboard
        acats={[
          record({ id: "missing-date", apexCompletionDate: undefined, transferWorkflow: "ACAT" }),
          record({ id: "missing-reason", status: "Rejected", rejectionReason: "", transferWorkflow: "MANUAL" }),
        ]}
        onSelectRecord={vi.fn()}
      />
    );

    fireEvent.click(within(screen.getByRole("navigation", { name: "Dashboard sections" })).getByRole("button", { name: /Data quality/ }));
    await waitFor(() => expect(screen.getByLabelText("Exception type")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Exception type"), { target: { value: "completed_missing_date" } });

    const results = screen.getByLabelText("Exception results");
    expect(within(results).getByText("Completed without Apex date")).toBeInTheDocument();
    expect(within(results).queryByText("Rejected without reason")).not.toBeInTheDocument();
  });

  it("opens a data-quality exception with its target field context", async () => {
    const onSelectRecord = vi.fn();
    render(
      <TransferDashboard
        acats={[record({ id: "missing-date", apexCompletionDate: undefined })]}
        onSelectRecord={onSelectRecord}
      />
    );

    fireEvent.click(within(screen.getByRole("navigation", { name: "Dashboard sections" })).getByRole("button", { name: /Data quality/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Fix in transfer" }));

    expect(onSelectRecord).toHaveBeenCalledWith(
      "missing-date",
      expect.objectContaining({
        ruleKey: "completed_missing_date",
        tab: "details",
        field: "apexCompletionDate",
        fieldLabel: "Apex Completion Date",
      })
    );
  });

  it("searches all data-quality issues by client name", async () => {
    render(
      <TransferDashboard
        acats={[
          record({ id: "alice-date", clientName: "Alice Adams", apexCompletionDate: undefined, transferWorkflow: "MANUAL" }),
          record({ id: "alice-reason", clientName: "Alice Adams", status: "Rejected", rejectionReason: "", transferWorkflow: "MANUAL" }),
          record({ id: "bob-date", clientName: "Bob Brown", apexCompletionDate: undefined, transferWorkflow: "MANUAL" }),
        ]}
        onSelectRecord={vi.fn()}
      />
    );

    fireEvent.click(within(screen.getByRole("navigation", { name: "Dashboard sections" })).getByRole("button", { name: /Data quality/ }));
    fireEvent.change(await screen.findByLabelText("Search data quality by client"), { target: { value: "alice" } });

    expect(screen.getAllByText(/Alice Adams/)).toHaveLength(2);
    expect(screen.queryByText(/Bob Brown/)).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Completed without Apex date (1)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Rejected without reason (1)" })).toBeInTheDocument();
  });

  it("removes a category from the open queue after its last exception is closed", async () => {
    global.fetch = vi.fn(async (_input, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return {
          ok: true,
          json: async () => ({ id: "review-1", ...body }),
        } as Response;
      }
      return { ok: true, json: async () => [] } as Response;
    }) as unknown as typeof fetch;

    render(
      <TransferDashboard
        acats={[record({ id: "missing-date", apexCompletionDate: undefined, transferWorkflow: "MANUAL" })]}
        onSelectRecord={vi.fn()}
      />
    );

    fireEvent.click(within(screen.getByRole("navigation", { name: "Dashboard sections" })).getByRole("button", { name: /Data quality/ }));
    const exceptionType = await screen.findByLabelText("Exception type");
    expect(within(exceptionType).getByRole("option", { name: "Completed without Apex date (1)" })).toBeInTheDocument();

    fireEvent.change(exceptionType, { target: { value: "completed_missing_date" } });
    fireEvent.click(screen.getByRole("button", { name: "Close exception" }));

    await waitFor(() => expect(exceptionType).toHaveValue("ALL"));
    expect(within(exceptionType).queryByRole("option", { name: /Completed without Apex date/ })).not.toBeInTheDocument();
    expect(screen.getByText("No exceptions in this view.")).toBeInTheDocument();
  });
});
