import { fireEvent, render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonFetcher } from "@/lib/fetcher";
import TransferDocumentHistory from "./TransferDocumentHistory";

const saved = { id: "PDF-1", kind: "TRANSFER_FORM", filename: "Synthetic-CATR.pdf", createdAt: "2026-09-21T16:00:00Z", createdBy: "ops@example.test", positionCount: 100, includedCount: 72, excludedCount: 28, undecidedCount: 0 };
function renderHistory(id = "REC-1") {
  return render(<SWRConfig value={{ provider: () => new Map(), fetcher: jsonFetcher, dedupingInterval: 0, shouldRetryOnError: false }}><TransferDocumentHistory key={id} acatId={id} /></SWRConfig>);
}
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => Response.json({ documents: [saved], nextCursor: null }))); });
describe("saved paperwork history", () => {
  it("shows saved PDF and its frozen inputs after reopening without generating or importing", async () => {
    const view = renderHistory();
    expect(await screen.findByRole("link", { name: "Download PDF" })).toHaveAttribute("href", "/api/acats/REC-1/documents/PDF-1");
    expect(screen.getByRole("link", { name: "Inputs used (CSV)" })).toHaveAttribute("href", "/api/acats/REC-1/documents/PDF-1?input=1");
    expect(screen.getByText(/100 holdings · 72 included · 28 excluded/)).toBeInTheDocument();
    view.unmount(); renderHistory();
    expect(await screen.findByText("Synthetic-CATR.pdf")).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });
  it("paginates older versions and returns to latest", async () => {
    vi.mocked(fetch).mockImplementation(async (url) => Response.json(String(url).includes("cursor=")
      ? { documents: [{ ...saved, id: "CSV-1", kind: "MAPPING_CSV", filename: "original-input.csv" }], nextCursor: null }
      : { documents: [saved], nextCursor: "PDF-1" }));
    renderHistory();
    fireEvent.click(await screen.findByRole("button", { name: "Older documents" }));
    expect(await screen.findByRole("link", { name: "Download saved CSV" })).toHaveAttribute("href", "/api/acats/REC-1/documents/CSV-1");
    fireEvent.click(screen.getByRole("button", { name: "Latest documents" }));
    expect(await screen.findByRole("link", { name: "Download PDF" })).toBeInTheDocument();
  });
  it("explains the empty history and does not promise recovery of old local downloads", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ documents: [], nextCursor: null }));
    renderHistory();
    expect(await screen.findByText(/older local downloads cannot be recovered automatically/)).toBeInTheDocument();
  });
  it("shows a retrieval error instead of an empty history", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: "Unavailable" }, { status: 500 }));
    renderHistory();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load saved documents");
    expect(screen.queryByText(/No saved documents yet/)).not.toBeInTheDocument();
  });
});
