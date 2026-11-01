import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientSearchItem } from "@/lib/client-identity-contract";
import ClientIdentityPicker from "./ClientIdentityPicker";

const clients: ClientSearchItem[] = [
  { cedarRidgeUserId: "user-synthetic-11111111", displayName: "Alex Example", accountHints: [{ maskedAccountNumber: "****1234", custodian: "Apex", relationshipType: "JOINT" }] },
  { cedarRidgeUserId: "user-synthetic-22222222", displayName: "Alex Example", accountHints: [{ maskedAccountNumber: "****5678", custodian: "Apex", relationshipType: "PRIMARY" }] },
];

function Harness({ onSelect = vi.fn() }: { onSelect?: (client: ClientSearchItem) => void }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ClientSearchItem | null>(null);
  return <ClientIdentityPicker query={query} selected={selected} onQueryChange={(value) => { setQuery(value); setSelected(null); }} onSelect={(client) => { setSelected(client); setQuery(client.displayName); onSelect(client); }} />;
}

afterEach(() => vi.unstubAllGlobals());

describe("ClientIdentityPicker", () => {
  it("requires explicit selection and distinguishes identical names with masked hints", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: clients, hasMore: false, directory: { health: "FRESH", writeEligible: true } }) }));
    const selected = vi.fn();
    render(<Harness onSelect={selected} />);
    const input = screen.getByRole("combobox", { name: "Search client name" });
    fireEvent.change(input, { target: { value: "Alex" } });
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent("****1234");
    expect(options[1]).toHaveTextContent("22222222");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(selected).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(selected).toHaveBeenCalledWith(clients[1]);
    expect(screen.getByText(/Selected client · ID ending 22222222/)).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-expanded", "false");
    fireEvent.change(input, { target: { value: "Alex changed" } });
    expect(screen.queryByText(/Selected client/)).not.toBeInTheDocument();
  });

  it("supports mouse selection without losing the option on input blur", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: clients, hasMore: true, directory: { health: "FRESH", writeEligible: true } }) }));
    const selected = vi.fn();
    render(<Harness onSelect={selected} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Alex" } });
    const option = (await screen.findAllByRole("option"))[0];
    expect(screen.getByText(/More matches/)).toBeInTheDocument();
    fireEvent.mouseDown(option);
    fireEvent.click(option);
    expect(selected).toHaveBeenCalledWith(clients[0]);
  });

  it("shows no match and closes on Escape without selecting a person", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [], hasMore: false, directory: { health: "FRESH", writeEligible: true } }) }));
    const selected = vi.fn();
    render(<Harness onSelect={selected} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Unknown" } });
    await screen.findByText(/No matching clients/);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(selected).not.toHaveBeenCalled();
  });

  it("does not label a fresh directory unavailable when creation cutover is off", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: clients, hasMore: false, directory: { enabled: false, health: "FRESH", writeEligible: false } }) }));
    render(<Harness />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Alex" } });
    await screen.findAllByRole("option");
    expect(screen.queryByText(/linking is paused/)).not.toBeInTheDocument();
  });

  it("keeps stale results visibly read-only and never treats an outage as no match", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ items: clients, hasMore: false, directory: { writeEligible: false, health: "STALE" } }) }).mockResolvedValueOnce({ ok: false, json: async () => ({ error: "Source temporarily unavailable" }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Alex" } });
    await screen.findByText(/linking is paused/);
    fireEvent.change(input, { target: { value: "Blair" } });
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Source temporarily unavailable");
    expect(screen.queryByText(/No matching clients/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
  });
});
