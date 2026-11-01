import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import AdvisorTransfersView from "./AdvisorTransfersView";
import type { AdvisorAcatRecord } from "@/lib/advisor-redaction";

// Minimal record builder — the component only consumes whitelisted
// fields, so this matches the redactor's output shape exactly.
function makeAdvisorRecord(
  overrides: Partial<AdvisorAcatRecord> = {}
): AdvisorAcatRecord {
  return {
    id: "REC-001",
    clientName: "Jane Doe",
    status: "Submitted",
    direction: "In",
    type: "Full",
    accountType: "Traditional IRA",
    transferringContra: "Schwab",
    wealthAdvisor: "Rachel",
    additionalResources: null,
    originalClientRequestDate: "2026-04-01",
    opsSubmissionDateToApex: "2026-04-03",
    apexCompletionDate: null,
    acatDate: "2026-04-01",
    statementAmount: 25000000,
    custodian: {
      id: "CUST-1",
      name: "Fidelity",
      avgProcessingDays: 5,
    },
    ...overrides,
  };
}

function renderView(records: AdvisorAcatRecord[]) {
  return render(
    <AdvisorTransfersView
      acats={records}
      loading={false}
      error={null}
      lastRefreshedAt={null}
    />
  );
}

// The detail panel is collapsed by default; expand it by clicking the
// row toggle so we can assert on what's inside.
function expandFirstRow() {
  const toggle = screen.getByRole("button", { name: /Jane Doe/i });
  fireEvent.click(toggle);
}

describe("AdvisorTransfersView — additionalResources rendering", () => {
  it("renders a CRM link when additionalResources is a bare URL", () => {
    renderView([
      makeAdvisorRecord({
        additionalResources: "https://crm.example/tasks/abc-123",
      }),
    ]);
    expandFirstRow();

    const link = screen.getByRole("link", { name: /open crm task/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute(
      "href",
      "https://crm.example/tasks/abc-123"
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel") ?? "").toContain("noopener");
  });

  it("omits the row entirely when additionalResources is null", () => {
    renderView([makeAdvisorRecord({ additionalResources: null })]);
    expandFirstRow();

    expect(screen.queryByText(/additional resources/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /open crm task/i })
    ).not.toBeInTheDocument();
  });

  it("omits the row when additionalResources is an empty string", () => {
    // Defense in depth: the redactor normalizes "" -> null, but the UI
    // shouldn't crash or render an empty row if a stray "" sneaks in.
    renderView([
      makeAdvisorRecord({
        additionalResources: "" as unknown as string | null,
      }),
    ]);
    expandFirstRow();

    expect(screen.queryByText(/additional resources/i)).not.toBeInTheDocument();
  });

  it("renders raw text (no link) when additionalResources is non-URL free text", () => {
    renderView([
      makeAdvisorRecord({
        additionalResources: "See ops note from 4/1 — link pending",
      }),
    ]);
    expandFirstRow();

    expect(screen.getByText(/additional resources/i)).toBeInTheDocument();
    expect(
      screen.getByText("See ops note from 4/1 — link pending")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /open crm task/i })
    ).not.toBeInTheDocument();
  });

  it("does not show additionalResources in the collapsed row summary", () => {
    // The compact list view should stay tight; the link only belongs in
    // the expanded detail panel.
    renderView([
      makeAdvisorRecord({
        additionalResources: "https://crm.example/tasks/abc-123",
      }),
    ]);

    expect(
      screen.queryByRole("link", { name: /open crm task/i })
    ).not.toBeInTheDocument();
  });
});

describe("AdvisorTransfersView — transfer value formatting", () => {
  it("uses exact dollars and MM-DD-YYYY dates", () => {
    renderView([makeAdvisorRecord()]);

    expect(screen.getByText("$250,000.00")).toBeInTheDocument();
    expandFirstRow();
    expect(screen.getAllByText("$250,000.00")).toHaveLength(2);
    expect(screen.getByText("04-01-2026")).toBeInTheDocument();
    expect(screen.getByText("04-03-2026")).toBeInTheDocument();
  });
});
