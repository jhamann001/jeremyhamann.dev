import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import FinalizeAcatModal from "./FinalizeAcatModal";
import { mockAcats } from "@/lib/mock-data";

describe("FinalizeAcatModal", () => {
  it("requires a completion date and submits closeout fields together", async () => {
    const onConfirm = vi.fn().mockResolvedValue(true);
    render(
      <FinalizeAcatModal
        acat={{ ...mockAcats[0], apexCompletionDate: undefined }}
        targetStatus="Completed"
        saving={false}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />
    );

    const confirm = screen.getByRole("button", { name: "Confirm Complete" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Apex Completion Date/i), {
      target: { value: "2026-09-09" },
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({
      status: "Completed",
      apexCompletionDate: "2026-09-09",
      controlNumber: "CTL-10421",
    }));
  });

  it("requires and trims a rejection reason", async () => {
    const onConfirm = vi.fn().mockResolvedValue(true);
    render(
      <FinalizeAcatModal
        acat={mockAcats[0]}
        targetStatus="Rejected"
        saving={false}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />
    );

    expect(screen.getByRole("button", { name: "Confirm Rejection" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Rejection Reason/i), {
      target: { value: "  Contra rejected request  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm Rejection" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({
      status: "Rejected",
      rejectionReason: "Contra rejected request",
    }));
  });
});
