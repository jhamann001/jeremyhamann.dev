import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import RecordGroup from "./RecordGroup";
import { AcatRecord } from "@/lib/types";
import { defaultVisibleColumns } from "@/lib/record-fields";

const FAKE_NOW = new Date("2026-04-15T00:00:00Z").getTime();
const VISIBLE = defaultVisibleColumns();

function makeRecord(overrides: Partial<AcatRecord>): AcatRecord {
  return {
    id: "REC-1",
    clientName: "Alice",
    status: "PendingReview",
    apexAccountId: "APX-1",
    lastUpdated: "2026-04-10T00:00:00Z",
    crmDealId: "",
    custodianId: "",
    custodianName: "Schwab",
    acatDate: "2026-04-10",
    slackAlerted: false,
    mappingSource: "",
    apexSource: "",
    assets: [],
    ...overrides,
  };
}

describe("RecordGroup", () => {
  it("renders the status label and count in the group header", () => {
    render(
      <RecordGroup
        status="PendingReview"
        records={[makeRecord({ id: "a" }), makeRecord({ id: "b" })]}
        collapsed={false}
        selectedId={null}
        density="comfortable"
        now={FAKE_NOW}
        visibleColumns={VISIBLE}
        onToggle={vi.fn()}
        onOpenRecord={vi.fn()}
      />
    );
    const header = screen.getByRole("button", { expanded: true });
    expect(header).toHaveTextContent("Pending Review");
    expect(header).toHaveTextContent("2");
  });

  it("hides rows when collapsed", () => {
    render(
      <RecordGroup
        status="PendingReview"
        records={[makeRecord({ id: "a", clientName: "Alice" })]}
        collapsed={true}
        selectedId={null}
        density="comfortable"
        now={FAKE_NOW}
        visibleColumns={VISIBLE}
        onToggle={vi.fn()}
        onOpenRecord={vi.fn()}
      />
    );
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
  });

  it("shows rows when expanded", () => {
    render(
      <RecordGroup
        status="PendingReview"
        records={[makeRecord({ id: "a", clientName: "Alice" })]}
        collapsed={false}
        selectedId={null}
        density="comfortable"
        now={FAKE_NOW}
        visibleColumns={VISIBLE}
        onToggle={vi.fn()}
        onOpenRecord={vi.fn()}
      />
    );
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("calls onToggle when header is clicked", () => {
    const onToggle = vi.fn();
    render(
      <RecordGroup
        status="PendingReview"
        records={[makeRecord({})]}
        collapsed={false}
        selectedId={null}
        density="comfortable"
        now={FAKE_NOW}
        visibleColumns={VISIBLE}
        onToggle={onToggle}
        onOpenRecord={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { expanded: true }));
    expect(onToggle).toHaveBeenCalledWith("PendingReview");
  });

  it("surfaces count of records with issues in header", () => {
    const withIssues = makeRecord({
      id: "x",
      assets: [
        {
          id: "1",
          symbol: "AAPL",
          description: "",
          expectedQty: 10,
          actualQty: 8,
          mapStatus: "Unmapped",
        },
      ],
    });
    const clean = makeRecord({ id: "y", assets: [] });
    render(
      <RecordGroup
        status="PendingReview"
        records={[withIssues, clean]}
        collapsed={false}
        selectedId={null}
        density="comfortable"
        now={FAKE_NOW}
        visibleColumns={VISIBLE}
        onToggle={vi.fn()}
        onOpenRecord={vi.fn()}
      />
    );
    expect(screen.getByText(/with issues/)).toBeInTheDocument();
  });
});
