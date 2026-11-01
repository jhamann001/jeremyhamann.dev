import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIENT_IDENTITY_MAX_CLIENTS, type ClientSearchItem } from "@/lib/client-identity-contract";
import ClientIdentitySelection from "./ClientIdentitySelection";
import { getLinkedClients } from "./client-identity-display";
import { mockAcats } from "@/lib/mock-data";

const clients: ClientSearchItem[] = [
  { cedarRidgeUserId: "user-synthetic-11111111", displayName: "Alex Example", accountHints: [{ custodian: "APEX", maskedAccountNumber: "••••1234", relationshipType: "JOINT" }] },
  { cedarRidgeUserId: "user-synthetic-22222222", displayName: "Alex Example", accountHints: [{ custodian: "APEX", maskedAccountNumber: "••••1234", relationshipType: "JOINT" }] },
];
function Harness({ initial = [] }: { initial?: ClientSearchItem[] }) {
  const [selected, setSelected] = useState(initial);
  return <ClientIdentitySelection selected={selected} onChange={setSelected} />;
}
afterEach(() => vi.unstubAllGlobals());

describe("explicit multi-person selection", () => {
  it("keeps duplicate names distinct, excludes selected IDs, and supports keyboard add/remove focus", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: clients, hasMore: false, directory: { health: "FRESH" } }) }));
    render(<Harness />);
    let input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Alex" } });
    expect(await screen.findAllByRole("option")).toHaveLength(2);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Add another person" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Add another person" }));
    input = screen.getByRole("combobox");
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "Alex" } });
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("22222222");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(within(screen.getByRole("list", { name: "Selected clients" })).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent("Added Alex Example, ID ending 22222222");
    fireEvent.click(screen.getByRole("button", { name: "Remove Alex Example, ID ending 11111111" }));
    expect(screen.getByRole("button", { name: "Add another person" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: /Remove.*11111111/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove Alex Example, ID ending 22222222" }));
    expect(screen.getByRole("combobox")).toHaveFocus();
    expect(screen.queryByRole("list", { name: "Selected clients" })).not.toBeInTheDocument();
  });

  it("caps selections at the shared limit and allows removing a person", () => {
    const initial = Array.from({ length: CLIENT_IDENTITY_MAX_CLIENTS }, (_, index) => ({ ...clients[0], cedarRidgeUserId: `user-synthetic-${index.toString().padStart(8, "0")}` }));
    render(<Harness initial={initial} />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add another person" })).not.toBeInTheDocument();
    expect(screen.getByText(/Up to 10 people/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Remove.*00000000/ }));
    expect(screen.getByRole("button", { name: "Add another person" })).toBeEnabled();
  });

  it("does not infer individuals by splitting a historical combined name", () => {
    expect(getLinkedClients({ ...mockAcats[0], clientName: "Historical A & B", cedarRidgeUserId: null,
      cedarRidgeUserIds: clients.map((client) => client.cedarRidgeUserId), linkedClients: clients })).toEqual(clients.map((client) => ({ ...client, accountHints: [] })));
    expect(getLinkedClients({ ...mockAcats[0], cedarRidgeUserId: clients[0].cedarRidgeUserId, cedarRidgeUserIds: [], linkedClients: [] })).toEqual([]);
    expect(getLinkedClients({ ...mockAcats[0], cedarRidgeUserId: clients[0].cedarRidgeUserId })).toHaveLength(1);
  });
});
