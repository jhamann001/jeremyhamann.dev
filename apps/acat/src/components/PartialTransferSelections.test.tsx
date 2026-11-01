import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonFetcher } from "@/lib/fetcher";
import PartialTransferSelections from "./PartialTransferSelections";

let included: boolean | null;
const onSaved = vi.fn(async () => {});
const onDirtyChange = vi.fn();
function renderSelections(id = "REC-1") {
  return render(<SWRConfig value={{ provider: () => new Map(), fetcher: jsonFetcher, dedupingInterval: 0, shouldRetryOnError: false }}><PartialTransferSelections key={id} acatId={id} onSaved={onSaved} onDirtyChange={onDirtyChange} /></SWRConfig>);
}
beforeEach(() => {
  vi.clearAllMocks(); included = true;
  vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
    if (init?.method === "PUT") { included = JSON.parse(String(init.body)).assets[0].includeInTransfer; return Response.json({ saved: true }); }
    return Response.json({ assets: [
      { id: "A-1", symbol: "TEST", description: "Synthetic Test", expectedQty: 7, includeInTransfer: included },
      { id: "A-2", symbol: "KEEP", description: "Synthetic Keep", expectedQty: 3, includeInTransfer: true },
    ] });
  }));
});
describe("saved partial-transfer selections", () => {
  it("saves a middle/individual choice only, refreshes readiness, and remembers it after reopening", async () => {
    const view = renderSelections();
    fireEvent.click(screen.getByRole("button", { name: "Review saved transfer selections" }));
    const choice = await screen.findByRole("combobox", { name: "Include TEST in transfer" });
    expect(choice).toHaveValue("yes");
    fireEvent.change(choice, { target: { value: "no" } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Save transfer selections" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Selections saved");
    const write = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({ assets: [{ id: "A-1", includeInTransfer: false }] });
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    view.unmount(); renderSelections();
    fireEvent.click(screen.getByRole("button", { name: "Review saved transfer selections" }));
    expect(await screen.findByRole("combobox", { name: "Include TEST in transfer" })).toHaveValue("no");
    expect(screen.getByRole("combobox", { name: "Include KEEP in transfer" })).toHaveValue("yes");
  });
  it("keeps unsaved choices and the generation gate on a failed save", async () => {
    renderSelections();
    fireEvent.click(screen.getByRole("button", { name: "Review saved transfer selections" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "Include TEST in transfer" }), { target: { value: "undecided" } });
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "Could not save" }, { status: 500 }));
    fireEvent.click(screen.getByRole("button", { name: "Save transfer selections" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save");
    expect(screen.getByRole("combobox", { name: "Include TEST in transfer" })).toHaveValue("undecided");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(onSaved).not.toHaveBeenCalled();
  });
  it("does not fetch until expanded, and loads the requested record", async () => {
    renderSelections("REC-2");
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review saved transfer selections" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/acats/REC-2/paperwork-assets", { cache: "no-store" }));
  });
});
