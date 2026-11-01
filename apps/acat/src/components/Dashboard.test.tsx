import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { AcatRecord } from "@/lib/types";
import { mockAcats } from "@/lib/mock-data";

const FAKE_NOW = new Date("2026-04-15T00:00:00Z").getTime();

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FAKE_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

// Lazy-import so PAGE_LOAD_TIME captures the fake clock
async function renderDashboard(acats: AcatRecord[]) {
  const mod = await import("./Dashboard");
  const Dashboard = mod.default;
  return render(<Dashboard acats={acats} onSelectRecord={vi.fn()} />);
}

function makeRecord(overrides: Partial<AcatRecord>): AcatRecord {
  return {
    id: "TEST-1",
    clientName: "Test User",
    status: "Completed",
    apexAccountId: "APX-0000",
    lastUpdated: "2026-04-15T00:00:00Z",
    crmDealId: "",
    custodianId: "",
    custodianName: "",
    acatDate: "2026-04-01",
    slackAlerted: false,
    mappingSource: "",
    apexSource: "",
    assets: [],
    ...overrides,
  };
}

describe("Dashboard", () => {
  const onSelectRecord = vi.fn();

  it("renders the Dashboard heading", async () => {
    await renderDashboard(mockAcats);
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
  });

  it("renders the flow-based KPI tiles", async () => {
    await renderDashboard(mockAcats);
    expect(screen.getByText("Inflow / 30d")).toBeInTheDocument();
    expect(screen.getByText("Outflow / 30d")).toBeInTheDocument();
    expect(screen.getByText("Completed / 30d")).toBeInTheDocument();
    expect(screen.getByText("Avg Days to Complete")).toBeInTheDocument();
    // ticket: was "Stalled > 5 days"; per-custodian aging replaced the
    // hardcoded threshold with per-record SLA tiers.
    expect(screen.getByText("Aging beyond SLA")).toBeInTheDocument();
  });

  it("renders the AUM Completed cumulative tile", async () => {
    await renderDashboard(mockAcats);
    expect(screen.getByText("AUM Completed — cumulative")).toBeInTheDocument();
    expect(screen.getByText("YTD into Apex")).toBeInTheDocument();
  });

  it("renders the Pipeline Status tile with bucketed groups", async () => {
    await renderDashboard(mockAcats);
    expect(screen.getByText("Pipeline Status")).toBeInTheDocument();
    expect(screen.getByText("In Flight")).toBeInTheDocument();
    expect(screen.getByText("At Contra")).toBeInTheDocument();
    expect(screen.getByText("At Apex")).toBeInTheDocument();
    expect(screen.getByText("Terminal")).toBeInTheDocument();
  });

  it("counts Waiting for Statement as In Flight and shows its status detail", async () => {
    await renderDashboard([makeRecord({ status: "WaitingForStatement" })]);
    const inFlight = screen.getByText("In Flight").parentElement!.parentElement!;
    expect(within(inFlight).getByText("1")).toBeInTheDocument();
    expect(within(inFlight).getByText("100%")).toBeInTheDocument();

    const disclosure = screen.getByText(/Show all .* statuses/);
    fireEvent.click(disclosure);
    expect(within(disclosure.parentElement!).getByText("Waiting for Statement")).toBeInTheDocument();
  });

  it("Pipeline Status disclosure toggles full status detail", async () => {
    await renderDashboard(mockAcats);
    const toggle = screen.getByText(/Show all .* statuses/);
    fireEvent.click(toggle);
    expect(screen.getByText(/Hide all .* statuses/)).toBeInTheDocument();
  });

  it("renders Reconciliation Health and Direction Mix tiles", async () => {
    await renderDashboard(mockAcats);
    expect(screen.getByText("Reconciliation Health")).toBeInTheDocument();
    expect(screen.getByText("Direction Mix")).toBeInTheDocument();
  });

  it("renders Requires Attention with table headers when items exist", async () => {
    await renderDashboard(mockAcats);
    const heading = screen.queryByText("Requires Attention");
    if (heading) {
      expect(screen.getByText("Days Open")).toBeInTheDocument();
      expect(screen.getByText("Issues")).toBeInTheDocument();
    } else {
      expect(screen.getByText("Nothing requires attention")).toBeInTheDocument();
    }
  });

  it("Recent Activity is reachable via the corner FAB and slideover", async () => {
    await renderDashboard(mockAcats);
    const fab = screen.getByRole("button", { name: /toggle recent activity/i });
    expect(fab).toBeInTheDocument();
    fireEvent.click(fab);
    const dialog = screen.getByRole("dialog", { name: /recent activity/i });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText("Recent Activity")).toBeInTheDocument();
  });

  it("calls onSelectRecord when an action item row is clicked", async () => {
    render(
      await import("./Dashboard").then((m) => (
        <m.default acats={mockAcats} onSelectRecord={onSelectRecord} />
      ))
    );

    const heading = screen.queryByText("Requires Attention");
    if (!heading) return;
    const row = heading.closest(".rounded-xl")?.querySelector("tbody tr");
    if (row) {
      fireEvent.click(row);
      expect(onSelectRecord).toHaveBeenCalled();
    }
  });

  it("renders a View/Edit toggle and switches between modes", async () => {
    await renderDashboard(mockAcats);
    const viewTab = screen.getByRole("tab", { name: /view/i });
    const editTab = screen.getByRole("tab", { name: /edit/i });
    expect(viewTab).toHaveAttribute("aria-selected", "true");
    fireEvent.click(editTab);
    expect(editTab).toHaveAttribute("aria-selected", "true");
    expect(viewTab).toHaveAttribute("aria-selected", "false");
    fireEvent.click(viewTab);
    expect(viewTab).toHaveAttribute("aria-selected", "true");
  });

  it("shows tile size cycler in edit mode", async () => {
    await renderDashboard(mockAcats);
    fireEvent.click(screen.getByRole("tab", { name: /edit/i }));
    // Each visible tile gets a span indicator like "3/12" or "12/12"
    const indicators = screen.getAllByText(/\d+\/12/);
    expect(indicators.length).toBeGreaterThan(0);
  });

  it("renders Inflow and Outflow as separate tiles and no composition tile", async () => {
    await renderDashboard(mockAcats);
    expect(screen.getByText(/Inflow \//)).toBeInTheDocument();
    expect(screen.getByText(/Outflow \//)).toBeInTheDocument();
    expect(
      screen.queryByText("Pipeline Composition Over Time")
    ).not.toBeInTheDocument();
  });

  it("renders range selector chips on KPI tiles", async () => {
    await renderDashboard(mockAcats);
    // Inflow + Outflow + Completed share the FLOW_RANGE_OPTIONS (7d / 30d / 90d)
    // so we expect multiple "30d" chips on the dashboard.
    const thirtyDayChips = screen.getAllByRole("button", { name: "30d" });
    expect(thirtyDayChips.length).toBeGreaterThanOrEqual(2);
  });

  it("does not show the tile library banner in view mode", async () => {
    await renderDashboard(mockAcats);
    expect(screen.queryByText(/Add tile to dashboard/)).not.toBeInTheDocument();
  });

  it("shows the tile library banner in edit mode", async () => {
    await renderDashboard(mockAcats);
    fireEvent.click(screen.getByRole("tab", { name: /edit/i }));
    // With all tiles default-visible, the banner shows the empty state message.
    expect(
      screen.getByText(/All tiles are on the dashboard/)
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Pipeline status bucketing
// ---------------------------------------------------------------------------
describe("Pipeline status bucketing", () => {
  it("groups submitted/contra statuses under At Contra", async () => {
    const submitted = makeRecord({ id: "SUB-1", status: "Submitted" });
    const review = makeRecord({ id: "REV-1", status: "PendingReview" });
    const contra = makeRecord({
      id: "CON-1",
      status: "PendingContraResponse",
    });

    await renderDashboard([submitted, review, contra]);

    const bucket = screen.getByText("At Contra").closest("div")?.parentElement
      ?.parentElement;
    expect(bucket?.textContent).toContain("3");
  });

  it("groups completed/rejected/canceled under Terminal", async () => {
    const completed = makeRecord({
      id: "C-1",
      status: "Completed",
      apexCompletionDate: "2026-04-10",
    });
    const rejected = makeRecord({ id: "R-1", status: "Rejected" });
    const canceled = makeRecord({ id: "K-1", status: "Canceled" });

    await renderDashboard([completed, rejected, canceled]);

    const bucket = screen.getByText("Terminal").closest("div")?.parentElement
      ?.parentElement;
    expect(bucket?.textContent).toContain("3");
  });
});

// ---------------------------------------------------------------------------
// Avg days excludes residuals
// ---------------------------------------------------------------------------
describe("Avg Days KPI", () => {
  it("excludes Residual Credit records from the headline number", async () => {
    const fastResidual = makeRecord({
      id: "RES",
      type: "Residual Credit",
      originalClientRequestDate: "2026-04-13",
      apexCompletionDate: "2026-04-14",
    });
    const slowFull = makeRecord({
      id: "FULL",
      type: "Full",
      originalClientRequestDate: "2026-04-01",
      apexCompletionDate: "2026-04-13",
    });

    await renderDashboard([fastResidual, slowFull]);
    // Only the Full record counts: 12 calendar days become 7 ACATS business days.
    const avgCard = screen.getByText("Avg Days to Complete").closest(".rounded-xl");
    expect(avgCard?.textContent).toContain("7.0d");
  });

  it("shows the all-in number as a footnote when residuals are present", async () => {
    const residual = makeRecord({
      id: "RES",
      type: "Residual Credit",
      originalClientRequestDate: "2026-04-13",
      apexCompletionDate: "2026-04-14",
    });
    const full = makeRecord({
      id: "FULL",
      type: "Full",
      originalClientRequestDate: "2026-04-01",
      apexCompletionDate: "2026-04-13",
    });

    await renderDashboard([residual, full]);
    const avgCard = screen.getByText("Avg Days to Complete").closest(".rounded-xl");
    expect(avgCard?.textContent).toContain("all-in");
  });
});

// ---------------------------------------------------------------------------
// Aging KPI
//
// ticket: records with no linked custodian fall back to a 7-day SLA, so
// warn cutoff = 8.75d and high cutoff = 12.25d. FAKE_NOW = 2026-04-15T00.
// ---------------------------------------------------------------------------
describe("Aging beyond SLA KPI", () => {
  it("counts non-terminal records past the warn threshold", async () => {
    const fresh = makeRecord({
      id: "FRESH",
      status: "Submitted",
      originalClientRequestDate: "2026-04-13", // 2 days → on-track
    });
    const warn = makeRecord({
      id: "WARN",
      status: "Submitted",
      originalClientRequestDate: "2026-04-01", // 14 days → high
    });
    const veryWarn = makeRecord({
      id: "VW",
      status: "Submitted",
      originalClientRequestDate: "2026-04-03", // 12 days → warn (8.75 < 12 ≤ 12.25)
    });
    const terminalStale = makeRecord({
      id: "TS",
      status: "Rejected",
      originalClientRequestDate: "2026-03-01", // terminal → none
    });

    await renderDashboard([fresh, warn, veryWarn, terminalStale]);

    const card = screen.getByText("Aging beyond SLA").closest(".rounded-xl");
    expect(card?.textContent).toContain("2");
  });

  it("shows the empty state when everything is within SLA", async () => {
    const fresh = makeRecord({
      id: "F1",
      status: "Submitted",
      originalClientRequestDate: "2026-04-13",
    });
    await renderDashboard([fresh]);
    expect(screen.getByText("All transfers within SLA")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Inflow / outflow / completed KPI tiles
// ---------------------------------------------------------------------------
describe("Inflow KPI", () => {
  it("counts records initiated in the trailing 30 days", async () => {
    const within30 = makeRecord({
      id: "RECENT",
      status: "Submitted",
      originalClientRequestDate: "2026-04-08",
      statementAmount: 10000000, // $100K in cents
    });
    const older = makeRecord({
      id: "OLD",
      status: "Submitted",
      originalClientRequestDate: "2026-01-01",
      statementAmount: 99999900,
    });

    await renderDashboard([within30, older]);
    const card = screen.getByText("Inflow / 30d").closest(".rounded-xl");
    expect(card?.textContent).toContain("1");
    expect(card?.textContent).toContain("$100K");
  });
});

describe("Outflow KPI", () => {
  it("counts only negative-amount (ACAT Out) records, shown as magnitude", async () => {
    const incoming = makeRecord({
      id: "IN",
      status: "Submitted",
      originalClientRequestDate: "2026-04-08",
      statementAmount: 10000000, // +$100K
    });
    const outgoing = makeRecord({
      id: "OUT",
      status: "Submitted",
      originalClientRequestDate: "2026-04-09",
      statementAmount: -9300000, // -$93K (ACAT Out)
    });

    await renderDashboard([incoming, outgoing]);
    const card = screen.getByText("Outflow / 30d").closest(".rounded-xl");
    expect(card?.textContent).toContain("1");
    expect(card?.textContent).toContain("$93K");
  });
});

describe("Completed KPI", () => {
  it("counts only Completed records in the trailing 30 days", async () => {
    const completed = makeRecord({
      id: "DONE",
      status: "Completed",
      apexCompletionDate: "2026-04-10",
      statementAmount: 20000000, // $200K in cents
    });
    const submitted = makeRecord({
      id: "OPEN",
      status: "Submitted",
      apexCompletionDate: "2026-04-12",
      statementAmount: 99999900,
    });

    await renderDashboard([completed, submitted]);
    const card = screen.getByText("Completed / 30d").closest(".rounded-xl");
    expect(card?.textContent).toContain("$200K");
  });
});
