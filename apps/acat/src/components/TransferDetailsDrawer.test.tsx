import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TransferDetailsDrawer from "./TransferDetailsDrawer";
import { AcatRecord } from "@/lib/types";

vi.mock("./AcatDetail", () => ({
  __esModule: true,
  default: ({
    layout,
    onMutate,
    onDeleted,
    focus,
  }: {
    layout: string;
    onMutate?: () => void;
    onDeleted?: () => void;
    focus?: { field?: string };
  }) => (
    <div data-testid="full-acat-detail" data-layout={layout} data-focus-field={focus?.field}>
      <span>Transfer Details</span>
      <span>Security Recon</span>
      <span>Fees</span>
      <button onClick={onMutate}>Save detail</button>
      <button onClick={onDeleted}>Delete detail</button>
    </div>
  ),
}));

const acat = {
  id: "a1",
  clientName: "Client One",
  status: "Completed",
  transferringContra: "Fidelity",
  accountType: "Individual",
} as AcatRecord;

describe("TransferDetailsDrawer", () => {
  it("renders over the current page and supports inline refresh and full-record navigation", () => {
    const onClose = vi.fn();
    const onMutate = vi.fn();
    const onOpenFullRecord = vi.fn();

    render(
      <TransferDetailsDrawer
        acat={acat}
        onClose={onClose}
        onMutate={onMutate}
        onOpenFullRecord={onOpenFullRecord}
      />
    );

    expect(screen.getByRole("dialog", { name: "Client One" })).toBeInTheDocument();
    expect(screen.getByTestId("full-acat-detail")).toHaveAttribute("data-layout", "drawer");
    expect(screen.getByText("Transfer Details")).toBeInTheDocument();
    expect(screen.getByText("Security Recon")).toBeInTheDocument();
    expect(screen.getByText("Fees")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save detail" }));
    fireEvent.click(screen.getByRole("button", { name: /Full record/ }));
    expect(onMutate).toHaveBeenCalledTimes(1);
    expect(onOpenFullRecord).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes after a deletion from the full editable detail", () => {
    const onClose = vi.fn();
    render(
      <TransferDetailsDrawer
        acat={acat}
        onClose={onClose}
        onMutate={vi.fn()}
        onOpenFullRecord={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete detail" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("labels and forwards data-quality focus context", () => {
    render(
      <TransferDetailsDrawer
        acat={acat}
        onClose={vi.fn()}
        onMutate={vi.fn()}
        onOpenFullRecord={vi.fn()}
        focus={{
          ruleKey: "missing_crm_ticket",
          title: "Required CRM ticket is missing",
          detail: "Add the CRM ticket.",
          tab: "details",
          field: "crmTicket",
          fieldLabel: "CRM Ticket",
        }}
      />
    );

    expect(screen.getByText("Editing from Data Quality")).toBeInTheDocument();
    expect(screen.getByText("Fix: CRM Ticket")).toBeInTheDocument();
    expect(screen.getByTestId("full-acat-detail")).toHaveAttribute("data-focus-field", "crmTicket");
  });
});
