import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import MappingAccountPicker from "./MappingAccountPicker";

afterEach(() => vi.restoreAllMocks());

describe("mapping registration selection", () => {
  it("requires an explicit choice and passes only that registration to sync", async () => {
    const onSelect = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi.fn().mockResolvedValue({ accounts: [
      { id: "ira", holder: "Synthetic Owner", registration: "Traditional IRA", custodian: "Synthetic Funds", accountNumberLast4: null, investorNumberLast4: "1234", statementDate: "2026-08-31", positionCount: 2, isHistorical: false },
      { id: "roth", holder: "Synthetic Owner", registration: "Roth IRA", custodian: "Synthetic Funds", accountNumberLast4: null, investorNumberLast4: "1234", statementDate: "2026-07-31", positionCount: 4, isHistorical: true },
    ] });
    render(<SWRConfig value={{ provider: () => new Map(), fetcher }}><MappingAccountPicker acatId="REC" clientName="Synthetic Owner" accountType="Roth IRA" syncing={false} onSelect={onSelect} onClose={vi.fn()} /></SWRConfig>);
    await screen.findAllByRole("radio");
    expect(screen.getByRole("button", { name: "Link and sync" })).toBeDisabled();
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: /Synthetic Owner — Roth IRA/ }));
    expect(screen.getByText(/earlier household run/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Link and sync" }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledExactlyOnceWith("roth"));
    fireEvent.change(screen.getByRole("textbox", { name: "Search mapping accounts" }), { target: { value: "Different" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByRole("button", { name: "Link and sync" })).toBeDisabled();
  });
});
