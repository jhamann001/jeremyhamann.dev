import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import SecurityReconTab, {
  reconcile,
  normalizeTicker,
  aggregateApexPositions,
} from "./SecurityReconTab";
import { ToastProvider } from "./Toast";
import { jsonFetcher } from "@/lib/fetcher";
import { mockAcats } from "@/lib/mock-data";
import { AcatRecord, ApexPosition, Asset } from "@/lib/types";

const acat = mockAcats[0]; // Sarah Jenkins — 3 assets, one mismatch

// Isolate SWR cache + disable dedupe/throttle per render so mocked fetches
// don't leak between tests and focus events trigger an immediate revalidate.
function renderWithProviders(ui: React.ReactElement) {
  return render(
    <SWRConfig
      value={{
        fetcher: jsonFetcher,
        provider: () => new Map(),
        dedupingInterval: 0,
        focusThrottleInterval: 0,
      }}
    >
      <ToastProvider>{ui}</ToastProvider>
    </SWRConfig>
  );
}

function mappingResponse(record: AcatRecord) {
  return {
    ok: true,
    json: async () => ({
      acatId: record.id,
      mappingSource: record.mappingSource,
      apexSource: record.apexSource,
      assets: record.assets,
      lastSynced: record.mappingSyncedAt ?? null,
    }),
  };
}

describe("SecurityReconTab", () => {
  const onMutate = vi.fn();

  beforeEach(() => {
    onMutate.mockClear();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          acatId: acat.id,
          mappingSource: "GCP Project API",
          apexSource: "Uploaded",
          assets: acat.assets,
          lastSynced: "2026-04-12T14:32:00Z",
        }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the asset mapping card", async () => {
    renderWithProviders(<SecurityReconTab acat={acat} onMutate={onMutate} />);

    expect(screen.getByText("Asset Mapping (Internal DB)")).toBeInTheDocument();
    expect(screen.getByLabelText("Upload asset mapping CSV")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Download template" })
    ).toHaveAttribute(
      "href",
      "/templates/asset-mapping-upload-template.csv"
    );
  });

  it("shows the three new columns immediately after sync and retains them during recon and export", async () => {
    const syncedAt = "2026-09-15T14:00:00.000Z";
    const updated: AcatRecord = {
      ...acat,
      mappingSyncedAt: syncedAt,
      assets: [{
        ...acat.assets[0],
        mappingTransferStatus: "LIQUIDATE",
        mappingTransferNotes: 'Reviewed, "liquidate" first',
        mappingTransferring: false,
        mappingStatementDate: "June 1-30, 2026",
        mappingStatementAgeDays: 77,
        mappingStatementIsStale: true,
        mappingSyncedAt: syncedAt,
        notes: "Keep the local recon note",
      }],
    };
    let current = acat;
    vi.mocked(global.fetch).mockImplementation(async (_url, init) => {
      if (init?.method === "POST") current = updated;
      return mappingResponse(current) as Response;
    });
    // No parent refresher: the sync response itself must update the rows.
    renderWithProviders(<SecurityReconTab acat={acat} />);
    await waitFor(() => expect(screen.getByText("Not yet recorded")).toBeInTheDocument());
    for (const name of ["Transfer eligibility", "Transferring?", "Statement freshness"]) {
      expect(screen.getByRole("columnheader", { name })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByTitle("Sync from GCP"));
    await waitFor(() => expect(screen.getByText("LIQUIDATE")).toBeInTheDocument());
    const row = () => within(screen.getByText("AAPL").closest("tr")!);
    expect(row().getByText('Reviewed, "liquidate" first')).toBeInTheDocument();
    expect(row().getByText("No", { exact: true })).toBeInTheDocument();
    expect(row().getByText("June 1-30, 2026")).toBeInTheDocument();
    expect(row().getByText("Reported age: 77 days")).toBeInTheDocument();
    expect(row().getByText("Flagged stale")).toBeInTheDocument();
    expect(row().getByText("Keep the local recon note")).toBeInTheDocument();
    expect(screen.queryByText("TSLA")).not.toBeInTheDocument();

    const csv = "CUSIP,Symbol,Description,Asset Class,Qty,Amount,Settling Location,Settling Location Reason\n037833100,AAPL,Apple Inc.,Equity,1000,10000,DTC,Standard\n594918104,MSFT,Microsoft,Equity,10,1000,DTC,Standard";
    fireEvent.change(screen.getByLabelText("Upload Apex output CSV"), {
      target: { files: [new File([csv], "apex.csv", { type: "text/csv" })] },
    });
    await waitFor(() => expect(screen.getByText("Save Recon Results")).toBeInTheDocument());
    expect(row().getByText("LIQUIDATE")).toBeInTheDocument();
    expect(row().getByText("No", { exact: true })).toBeInTheDocument();
    const extra = screen.getByText("MSFT").closest("tr")!;
    // Apex-only positions must not inherit a statement or decision.
    expect(within(extra).queryByText("June 1-30, 2026")).not.toBeInTheDocument();
    expect(within(extra).queryByText("LIQUIDATE")).not.toBeInTheDocument();

    const createObjectURL = vi.fn<(blob: Blob | MediaSource) => string>(() => "blob:recon-test");
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
      const blob = createObjectURL.mock.calls[0][0] as Blob;
      const contents = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.readAsText(blob);
      });
      expect(contents).toContain('"Transfer Eligibility","Transfer Eligibility Notes","Transferring? (Asset Mapping)","Statement Date","Reported Statement Age (Days)","Reported Statement Stale","Asset Mapping Synced At"');
      expect(contents).toContain('"LIQUIDATE","Reviewed, ""liquidate"" first","No","June 1-30, 2026","77","Yes","' + syncedAt + '"');
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }

    fireEvent.click(screen.getByText("Save Recon Results"));
    await waitFor(() => expect(screen.queryByText("Save Recon Results")).not.toBeInTheDocument());
    expect(row().getByText("LIQUIDATE")).toBeInTheDocument();
    expect(row().getByText("Flagged stale")).toBeInTheDocument();
    const patch = vi.mocked(global.fetch).mock.calls.find(([, init]) => init?.method === "PATCH");
    const body = JSON.parse(patch![1]!.body as string);
    expect(body.assets[0]).not.toHaveProperty("mappingTransferStatus");
    expect(body.assets[0]).not.toHaveProperty("includeInTransfer");
  });

  it("distinguishes Yes, No, unset, zero-day age, and missing freshness", async () => {
    const syncedAt = "2026-09-15T14:00:00.000Z";
    const updated: AcatRecord = {
      ...acat,
      assets: acat.assets.map((asset, index) => ({
        ...asset, mappingSyncedAt: syncedAt,
        mappingTransferring: index === 0 ? true : index === 1 ? false : null,
        mappingStatementDate: index === 0 ? "2026-09-15" : null,
        mappingStatementAgeDays: index === 0 ? 0 : null,
        mappingStatementIsStale: index === 0 ? false : null,
      })),
    };
    vi.mocked(global.fetch).mockResolvedValue(mappingResponse(updated) as Response);
    renderWithProviders(<SecurityReconTab acat={updated} />);
    await waitFor(() => expect(screen.getByText("Reported age: 0 days")).toBeInTheDocument());
    expect(within(screen.getByText("AAPL").closest("tr")!).getByText("Yes", { exact: true })).toBeInTheDocument();
    expect(within(screen.getByText("TSLA").closest("tr")!).getByText("No", { exact: true })).toBeInTheDocument();
    expect(within(screen.getByText("GOOGL").closest("tr")!).getByText("Not set")).toBeInTheDocument();
    expect(screen.getByText("Not flagged stale")).toBeInTheDocument();
    expect(screen.getAllByText("Freshness unknown")).toHaveLength(2);
  });

  it("retains the previous source details after a failed sync", async () => {
    const updated: AcatRecord = {
      ...acat,
      assets: [{ ...acat.assets[0], mappingTransferStatus: "REVIEW", mappingSyncedAt: "2026-09-01T14:00:00.000Z" }],
    };
    vi.mocked(global.fetch).mockImplementation(async (_url, init) => init?.method === "POST"
      ? { ok: false, json: async () => ({ error: "Pipeline unavailable" }) } as Response
      : mappingResponse(updated) as Response);
    renderWithProviders(<SecurityReconTab acat={updated} />);
    await waitFor(() => expect(screen.getByText("REVIEW")).toBeInTheDocument());
    fireEvent.click(screen.getByTitle("Sync from GCP"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Pipeline unavailable"));
    expect(screen.getByText("REVIEW")).toBeInTheDocument();
  });

  it("renders the Apex upload card", () => {
    renderWithProviders(<SecurityReconTab acat={acat} onMutate={onMutate} />);

    expect(screen.getByText("Apex Output / Activities")).toBeInTheDocument();
    expect(screen.getByText("Drop Apex CSV here")).toBeInTheDocument();
  });

  it("fetches mapping data on mount", async () => {
    renderWithProviders(<SecurityReconTab acat={acat} onMutate={onMutate} />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        `/api/asset-mapping?acatId=${acat.id}`,
        expect.objectContaining({ cache: "no-store" })
      );
    });
  });

  it("revalidates mapping data on window focus", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    renderWithProviders(<SecurityReconTab acat={acat} onMutate={onMutate} />);

    const mappingCalls = () => fetchMock.mock.calls.filter(([url]) => url === `/api/asset-mapping?acatId=${acat.id}`);
    await waitFor(() => expect(mappingCalls()).toHaveLength(1));

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() =>
      expect(mappingCalls().length).toBeGreaterThanOrEqual(2)
    );
  });

  it("displays mapping source from API response", async () => {
    renderWithProviders(<SecurityReconTab acat={acat} onMutate={onMutate} />);

    await waitFor(() => {
      expect(
        screen.getByText("Connected to GCP statement-pipeline")
      ).toBeInTheDocument();
    });
  });

  it("shows loading state initially", () => {
    global.fetch = vi.fn().mockImplementation(
      () => new Promise(() => {})
    );

    renderWithProviders(<SecurityReconTab acat={acat} onMutate={onMutate} />);

    expect(screen.getByText("Loading mapping data...")).toBeInTheDocument();
  });

  it("shows error state when fetch fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    renderWithProviders(<SecurityReconTab acat={acat} onMutate={onMutate} />);

    await waitFor(() => {
      expect(screen.getByText("Failed to load mapping data")).toBeInTheDocument();
    });
  });

  it("renders the reconciliation summary bar", () => {
    renderWithProviders(<SecurityReconTab acat={acat} onMutate={onMutate} />);

    expect(screen.getByText("Reconciliation")).toBeInTheDocument();
    expect(screen.getByText("Position Details")).toBeInTheDocument();
  });

  it("renders asset rows in the table", () => {
    renderWithProviders(<SecurityReconTab acat={acat} onMutate={onMutate} />);

    expect(screen.getByText("AAPL")).toBeInTheDocument();
    expect(screen.getByText("TSLA")).toBeInTheDocument();
    expect(screen.getByText("GOOGL")).toBeInTheDocument();
  });

  it("does not show save button before CSV reconciliation", () => {
    renderWithProviders(<SecurityReconTab acat={acat} onMutate={onMutate} />);

    expect(screen.queryByText("Save Recon Results")).not.toBeInTheDocument();
  });

  it("allows manually overriding a row's actual qty and marks it as Manual", async () => {
    renderWithProviders(<SecurityReconTab acat={acat} onMutate={onMutate} />);

    // Wait for the table to render the first asset.
    await waitFor(() => {
      expect(screen.getByText("AAPL")).toBeInTheDocument();
    });

    // Pencil icons are only visible on hover, but they're still in the DOM.
    const pencilButtons = document.querySelectorAll<HTMLButtonElement>(
      'button[title="Manually override this row"]'
    );
    expect(pencilButtons.length).toBeGreaterThan(0);
    act(() => {
      pencilButtons[0].click();
    });

    const qtyInput = screen.getByDisplayValue(String(acat.assets[0].actualQty)) as HTMLInputElement;
    act(() => {
      qtyInput.focus();
      qtyInput.value = "42";
      qtyInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const saveButtons = document.querySelectorAll<HTMLButtonElement>(
      'button[title="Save override"]'
    );
    act(() => {
      saveButtons[0].click();
    });

    await waitFor(() => {
      expect(screen.getByText("Manual")).toBeInTheDocument();
    });
  });

  it("sends manual row overrides in the Save Recon Results payload and clears them on success", async () => {
    renderWithProviders(<SecurityReconTab acat={acat} onMutate={onMutate} />);

    await waitFor(() => expect(screen.getByText("AAPL")).toBeInTheDocument());

    // Upload a CSV whose quantities match the expected positions, so
    // `reconRows` is populated and the Save button appears.
    const [aapl, tsla, googl] = acat.assets;
    const csv = [
      "CUSIP,Symbol,Description,Asset Class,Qty,Amount,Settling Location,Settling Location Reason",
      `${aapl.cusip},AAPL,Apple Inc.,Equity,${aapl.expectedQty},0,DTC,Standard`,
      `${tsla.cusip},TSLA,Tesla Inc.,Equity,${tsla.expectedQty},0,DTC,Standard`,
      `${googl.cusip},GOOGL,Alphabet Inc. Cl A,Equity,${googl.expectedQty},0,DTC,Standard`,
    ].join("\n");
    const file = new File([csv], "apex.csv", { type: "text/csv" });
    const fileInput = document.querySelector<HTMLInputElement>(
      'input[aria-label="Upload Apex output CSV"]'
    );
    expect(fileInput).not.toBeNull();
    // jsdom's HTMLInputElement.files is read-only via assignment; redefine so
    // React's onChange handler sees the uploaded file.
    Object.defineProperty(fileInput!, "files", {
      value: [file],
      configurable: true,
    });
    await act(async () => {
      fileInput!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() =>
      expect(screen.getByText("Save Recon Results")).toBeInTheDocument()
    );

    // Override AAPL's actualQty to a value nobody could derive from the CSV.
    const pencilButtons = document.querySelectorAll<HTMLButtonElement>(
      'button[title="Manually override this row"]'
    );
    act(() => {
      pencilButtons[0].click();
    });
    const qtyInput = screen.getByDisplayValue(
      String(aapl.expectedQty)
    ) as HTMLInputElement;
    // fireEvent.change routes through React's synthetic event layer so the
    // controlled input's state actually updates. Setting input.value directly
    // is a no-op for React-controlled inputs.
    fireEvent.change(qtyInput, { target: { value: "42" } });
    const commitOverrideButtons = document.querySelectorAll<HTMLButtonElement>(
      'button[title="Save override"]'
    );
    act(() => {
      commitOverrideButtons[0].click();
    });
    await waitFor(() => expect(screen.getByText("Manual")).toBeInTheDocument());

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    const saveButton = screen.getByText("Save Recon Results");
    await act(async () => {
      saveButton.click();
    });

    // Find the PATCH call triggered by Save Recon Results. mutateMapping also
    // fires a GET on success, so we have to filter rather than assume call 0.
    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/acats/${acat.id}` &&
          (init as RequestInit | undefined)?.method === "PATCH"
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as RequestInit).body as string);
      expect(body.apexSource).toBe("Uploaded");
      const overriddenAsset = body.assets.find(
        (a: { id: string }) => a.id === aapl.id
      );
      expect(overriddenAsset).toBeDefined();
      expect(overriddenAsset.actualQty).toBe(42);
      // No Apex-extra rows should be in the payload.
      for (const a of body.assets as { id: string }[]) {
        expect(a.id.startsWith("apex-extra-")).toBe(false);
      }
    });

    // Override layer should be wiped after a successful save so the Manual
    // badge doesn't linger on a row that's now authoritative in the DB.
    await waitFor(() =>
      expect(screen.queryByText("Manual")).not.toBeInTheDocument()
    );
  });

  it("shows Save Recon Results once a row has been edited, even without a CSV upload", async () => {
    // Regression: the Save button used to be gated on `reconRows`, which
    // meant a user could click the pencil icon and edit a row's status /
    // issue / notes but had no way to persist those edits without first
    // uploading a Apex CSV. Now any pending row edit reveals Save.
    renderWithProviders(<SecurityReconTab acat={acat} onMutate={onMutate} />);

    await waitFor(() => expect(screen.getByText("AAPL")).toBeInTheDocument());

    expect(screen.queryByText("Save Recon Results")).not.toBeInTheDocument();

    const pencilButtons = document.querySelectorAll<HTMLButtonElement>(
      'button[title="Manually override this row"]'
    );
    expect(pencilButtons.length).toBeGreaterThan(0);
    act(() => {
      pencilButtons[0].click();
    });

    const notesInput = screen.getByPlaceholderText(/verified against PDF/i) as HTMLInputElement;
    fireEvent.change(notesInput, { target: { value: "Verified by ops" } });

    const commitOverrideButtons = document.querySelectorAll<HTMLButtonElement>(
      'button[title="Save override"]'
    );
    act(() => {
      commitOverrideButtons[0].click();
    });

    await waitFor(() =>
      expect(screen.getByText("Save Recon Results")).toBeInTheDocument()
    );
  });

  it("persists asset notes via the assets[] payload on Save Recon Results", async () => {
    renderWithProviders(<SecurityReconTab acat={acat} onMutate={onMutate} />);
    await waitFor(() => expect(screen.getByText("AAPL")).toBeInTheDocument());

    const pencilButtons = document.querySelectorAll<HTMLButtonElement>(
      'button[title="Manually override this row"]'
    );
    act(() => {
      pencilButtons[0].click();
    });
    const notesInput = screen.getByPlaceholderText(/verified against PDF/i) as HTMLInputElement;
    fireEvent.change(notesInput, { target: { value: "Verified by JH" } });
    const commitOverrideButtons = document.querySelectorAll<HTMLButtonElement>(
      'button[title="Save override"]'
    );
    act(() => {
      commitOverrideButtons[0].click();
    });

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    await waitFor(() =>
      expect(screen.getByText("Save Recon Results")).toBeInTheDocument()
    );
    const saveButton = screen.getByText("Save Recon Results");
    await act(async () => {
      saveButton.click();
    });

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/acats/${acat.id}` &&
          (init as RequestInit | undefined)?.method === "PATCH"
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as RequestInit).body as string);
      const overriddenAsset = body.assets.find(
        (a: { id: string }) => a.id === acat.assets[0].id
      );
      expect(overriddenAsset.notes).toBe("Verified by JH");
    });
  });

  it("does NOT claim apexSource: Uploaded when saving row edits without a CSV", async () => {
    // Save flow used to hard-code apexSource: "Uploaded" on every save,
    // which would mark the Transfer Details summary as if a CSV had been
    // processed even when the user was just annotating an existing row.
    renderWithProviders(<SecurityReconTab acat={acat} onMutate={onMutate} />);
    await waitFor(() => expect(screen.getByText("AAPL")).toBeInTheDocument());

    const pencilButtons = document.querySelectorAll<HTMLButtonElement>(
      'button[title="Manually override this row"]'
    );
    act(() => {
      pencilButtons[0].click();
    });
    const notesInput = screen.getByPlaceholderText(/verified against PDF/i) as HTMLInputElement;
    fireEvent.change(notesInput, { target: { value: "no CSV here" } });
    const commitOverrideButtons = document.querySelectorAll<HTMLButtonElement>(
      'button[title="Save override"]'
    );
    act(() => {
      commitOverrideButtons[0].click();
    });

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    await waitFor(() =>
      expect(screen.getByText("Save Recon Results")).toBeInTheDocument()
    );
    await act(async () => {
      screen.getByText("Save Recon Results").click();
    });

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/acats/${acat.id}` &&
          (init as RequestInit | undefined)?.method === "PATCH"
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as RequestInit).body as string);
      expect(body.apexSource).toBeUndefined();
    });
  });

  it("materializes an edited Apex-only Unexpected row via the newAssets[] payload", async () => {
    renderWithProviders(<SecurityReconTab acat={acat} onMutate={onMutate} />);
    await waitFor(() => expect(screen.getByText("AAPL")).toBeInTheDocument());

    // Upload a CSV that includes a position not in the expected list. The
    // recon adds it as an apex-extra "Unexpected" row.
    const [aapl, tsla, googl] = acat.assets;
    const csv = [
      "CUSIP,Symbol,Description,Asset Class,Qty,Amount,Settling Location,Settling Location Reason",
      `${aapl.cusip},AAPL,Apple Inc.,Equity,${aapl.expectedQty},0,DTC,Standard`,
      `${tsla.cusip},TSLA,Tesla Inc.,Equity,${tsla.expectedQty},0,DTC,Standard`,
      `${googl.cusip},GOOGL,Alphabet Inc. Cl A,Equity,${googl.expectedQty},0,DTC,Standard`,
      "594918104,MSFT,Microsoft Corp.,Equity,42,8400,DTC,Standard",
    ].join("\n");
    const file = new File([csv], "apex.csv", { type: "text/csv" });
    const fileInput = document.querySelector<HTMLInputElement>(
      'input[aria-label="Upload Apex output CSV"]'
    );
    Object.defineProperty(fileInput!, "files", {
      value: [file],
      configurable: true,
    });
    await act(async () => {
      fileInput!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() => expect(screen.getByText("MSFT")).toBeInTheDocument());

    // Find the pencil for the MSFT row and edit it.
    const msftRow = screen.getByText("MSFT").closest("tr")!;
    const msftPencil = msftRow.querySelector<HTMLButtonElement>(
      'button[title="Manually override this row"]'
    );
    expect(msftPencil).not.toBeNull();
    act(() => {
      msftPencil!.click();
    });

    const notesInput = screen.getByPlaceholderText(/verified against PDF/i) as HTMLInputElement;
    fireEvent.change(notesInput, { target: { value: "Confirm with client" } });

    const commit = msftRow.querySelector<HTMLButtonElement>(
      'button[title="Save override"]'
    );
    act(() => {
      commit!.click();
    });

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    await act(async () => {
      screen.getByText("Save Recon Results").click();
    });

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/acats/${acat.id}` &&
          (init as RequestInit | undefined)?.method === "PATCH"
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as RequestInit).body as string);
      expect(Array.isArray(body.newAssets)).toBe(true);
      expect(body.newAssets).toHaveLength(1);
      const created = body.newAssets[0];
      expect(created.symbol).toBe("MSFT");
      expect(created.cusip).toBe("594918104");
      expect(created.expectedQty).toBe(0);
      expect(created.actualQty).toBe(42);
      expect(created.notes).toBe("Confirm with client");
      // No apex-extra synthetic IDs leak into either payload.
      for (const a of body.assets as { id: string }[]) {
        expect(a.id.startsWith("apex-extra-")).toBe(false);
      }
    });
  });

  it("does not include untouched Apex-only Unexpected rows in the save payload", async () => {
    // Only Unexpected rows the user actually edited should be persisted —
    // otherwise every CSV upload would clutter the DB with positions ops
    // never reviewed.
    renderWithProviders(<SecurityReconTab acat={acat} onMutate={onMutate} />);
    await waitFor(() => expect(screen.getByText("AAPL")).toBeInTheDocument());

    const [aapl, tsla, googl] = acat.assets;
    const csv = [
      "CUSIP,Symbol,Description,Asset Class,Qty,Amount,Settling Location,Settling Location Reason",
      `${aapl.cusip},AAPL,Apple Inc.,Equity,${aapl.expectedQty},0,DTC,Standard`,
      `${tsla.cusip},TSLA,Tesla Inc.,Equity,${tsla.expectedQty},0,DTC,Standard`,
      `${googl.cusip},GOOGL,Alphabet Inc. Cl A,Equity,${googl.expectedQty},0,DTC,Standard`,
      "594918104,MSFT,Microsoft Corp.,Equity,42,8400,DTC,Standard",
    ].join("\n");
    const file = new File([csv], "apex.csv", { type: "text/csv" });
    const fileInput = document.querySelector<HTMLInputElement>(
      'input[aria-label="Upload Apex output CSV"]'
    );
    Object.defineProperty(fileInput!, "files", {
      value: [file],
      configurable: true,
    });
    await act(async () => {
      fileInput!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() => expect(screen.getByText("MSFT")).toBeInTheDocument());

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    await act(async () => {
      screen.getByText("Save Recon Results").click();
    });

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/acats/${acat.id}` &&
          (init as RequestInit | undefined)?.method === "PATCH"
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as RequestInit).body as string);
      // Either omitted entirely or empty — both mean "don't create".
      expect(body.newAssets ?? []).toEqual([]);
    });
  });

  it("lets users edit and save persisted Unmapped row status, issue, and notes", async () => {
    const acatWithUnmapped: AcatRecord = {
      ...acat,
      assets: [
        {
          id: "UNMAPPED-1",
          symbol: "NFLX",
          description: "Netflix Inc.",
          cusip: "64110L106",
          expectedQty: 25,
          actualQty: 0,
          mapStatus: "Unmapped",
          issue: "Not found in Apex CSV",
          notes: "Initial review note",
        },
      ],
    };

    vi.mocked(global.fetch).mockResolvedValue(mappingResponse(acatWithUnmapped) as Response);
    renderWithProviders(
      <SecurityReconTab acat={acatWithUnmapped} onMutate={onMutate} />
    );

    await waitFor(() => expect(screen.getByText("NFLX")).toBeInTheDocument());

    const row = screen.getByText("NFLX").closest("tr")!;
    expect(row.textContent).toMatch(/Unmapped/);
    // Regression coverage for the real bug: the pencil existed in the DOM,
    // but issue rows lacked `group`, so `group-hover:opacity-100` never fired.
    expect(row.className.split(/\s+/)).toContain("group");

    const editButton = row.querySelector<HTMLButtonElement>(
      'button[title="Manually override this row"]'
    );
    expect(editButton).not.toBeNull();
    act(() => {
      editButton!.click();
    });

    fireEvent.change(screen.getByDisplayValue("Mismatch"), {
      target: { value: "Pending" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Issue/i), {
      target: { value: "Escalated to contra" },
    });
    fireEvent.change(screen.getByPlaceholderText(/verified against PDF/i), {
      target: { value: "Ops reviewing with client" },
    });

    const commit = row.querySelector<HTMLButtonElement>(
      'button[title="Save override"]'
    );
    act(() => {
      commit!.click();
    });

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    await waitFor(() =>
      expect(screen.getByText("Save Recon Results")).toBeInTheDocument()
    );
    await act(async () => {
      screen.getByText("Save Recon Results").click();
    });

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/acats/${acatWithUnmapped.id}` &&
          (init as RequestInit | undefined)?.method === "PATCH"
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as RequestInit).body as string);
      const updatedAsset = body.assets.find(
        (a: { id: string }) => a.id === "UNMAPPED-1"
      );
      expect(updatedAsset).toMatchObject({
        id: "UNMAPPED-1",
        mapStatus: "Pending",
        issue: "Escalated to contra",
        notes: "Ops reviewing with client",
      });
    });
  });

  it("renders persisted asset notes in the read-only Notes column", async () => {
    const acatWithNotes: AcatRecord = {
      ...acat,
      assets: [
        {
          id: "N1",
          symbol: "AAPL",
          description: "Apple Inc.",
          cusip: "037833100",
          expectedQty: 100,
          actualQty: 100,
          mapStatus: "Mapped",
          notes: "Awaiting confirmation — JR",
        },
      ],
    };
    vi.mocked(global.fetch).mockResolvedValue(mappingResponse(acatWithNotes) as Response);
    renderWithProviders(
      <SecurityReconTab acat={acatWithNotes} onMutate={onMutate} />
    );

    await waitFor(() => expect(screen.getByText("AAPL")).toBeInTheDocument());
    expect(screen.getByText("Awaiting confirmation — JR")).toBeInTheDocument();
  });

  it("trusts persisted mapStatus in the static view so a saved surplus stays Mapped", async () => {
    // Regression: after Save Recon Results the client clears apexPositions,
    // causing displayRows/reconStats to fall back to an `acat.assets`-only
    // view. That fallback previously recomputed status from
    // expectedQty !== actualQty, which flipped a just-saved surplus
    // (Apex qty > expected) back into a Mismatch / "Unmapped" discrepancy
    // — contradicting the Mapped value we had just written to the DB.
    const surplusAcat: AcatRecord = {
      ...acat,
      assets: [
        {
          id: "S1",
          symbol: "NVDA",
          description: "NVIDIA Corp.",
          cusip: "67066G104",
          expectedQty: 100,
          actualQty: 112,
          mapStatus: "Mapped",
        },
      ],
    };

    vi.mocked(global.fetch).mockResolvedValue(mappingResponse(surplusAcat) as Response);
    renderWithProviders(<SecurityReconTab acat={surplusAcat} onMutate={onMutate} />);

    await waitFor(() => expect(screen.getByText("NVDA")).toBeInTheDocument());

    // The recon summary bar should count this as matched, not an issue.
    const reconSummary = screen.getByText("Reconciliation").closest("div")!
      .parentElement!;
    expect(reconSummary.textContent).toMatch(/1\s*matched/);
    expect(reconSummary.textContent).toMatch(/0\s*issues/);

    // No "discrepancies detected" banner.
    expect(screen.queryByText(/discrepanc/i)).not.toBeInTheDocument();

    // The row's status badge should be Mapped (rendered by StatusBadge).
    const row = screen.getByText("NVDA").closest("tr")!;
    expect(row.textContent).toMatch(/Mapped/);
    expect(row.textContent).not.toMatch(/Unmapped/);
  });

  it("counts a fractional-only shortfall as matched (no discrepancy banner)", async () => {
    // Regression: ACATs can't move fractional shares, so expected=100.37
    // vs apex=100 must NOT count as an issue. The summary bar should
    // read "1 matched / 0 issues" and the Position Details header must
    // NOT render the red "discrepancies detected" chip.
    const fractionalAcat: AcatRecord = {
      ...acat,
      assets: [
        {
          id: "F1",
          symbol: "AAPL",
          description: "Apple Inc.",
          cusip: "037833100",
          expectedQty: 100.37,
          actualQty: 0,
          mapStatus: "Pending",
        },
      ],
    };

    vi.mocked(global.fetch).mockResolvedValue(mappingResponse(fractionalAcat) as Response);
    renderWithProviders(
      <SecurityReconTab acat={fractionalAcat} onMutate={onMutate} />
    );

    await waitFor(() => expect(screen.getByText("AAPL")).toBeInTheDocument());

    // Apex reports 100 whole shares — the .37 stayed at the delivering
    // custodian, as expected for every ACAT.
    const csv = [
      "CUSIP,Symbol,Description,Asset Class,Qty,Amount,Settling Location,Settling Location Reason",
      "037833100,AAPL,Apple Inc.,Equity,100,15000,DTC,Standard",
    ].join("\n");
    const file = new File([csv], "apex.csv", { type: "text/csv" });
    const fileInput = document.querySelector<HTMLInputElement>(
      'input[aria-label="Upload Apex output CSV"]'
    );
    expect(fileInput).not.toBeNull();
    Object.defineProperty(fileInput!, "files", {
      value: [file],
      configurable: true,
    });
    await act(async () => {
      fileInput!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() =>
      expect(screen.getByText("Save Recon Results")).toBeInTheDocument()
    );

    const reconSummary = screen.getByText("Reconciliation").closest("div")!
      .parentElement!;
    expect(reconSummary.textContent).toMatch(/1\s*matched/);
    expect(reconSummary.textContent).toMatch(/0\s*issues/);

    // No red discrepancy chip in the Position Details header.
    expect(screen.queryByText(/discrepanc/i)).not.toBeInTheDocument();

    // The informational breadcrumb should still surface on the row so
    // ops knows why the Actual column reads 100 against an expected
    // 100.37 — we just don't treat it as an issue.
    expect(
      screen.getByText(/Fractional share not transferable/i)
    ).toBeInTheDocument();
  });

  it("awaits the parent refresh and clears CSV state on successful save", async () => {
    // Regression: prior to this guard, `onMutate` was fire-and-forget inside
    // saveReconResults. A fast close+reopen of the drawer could land before
    // /api/acats had been refetched, causing the UI to hydrate from the
    // pre-save SWR cache and show "old results". The save flow must now hold
    // the "Saving…" state until the parent's list refresh has resolved.

    let resolveRefresh: (() => void) | null = null;
    const deferredOnMutate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        })
    );

    renderWithProviders(
      <SecurityReconTab acat={acat} onMutate={deferredOnMutate} />
    );

    await waitFor(() => expect(screen.getByText("AAPL")).toBeInTheDocument());

    const [aapl, tsla, googl] = acat.assets;
    const csv = [
      "CUSIP,Symbol,Description,Asset Class,Qty,Amount,Settling Location,Settling Location Reason",
      `${aapl.cusip},AAPL,Apple Inc.,Equity,${aapl.expectedQty},0,DTC,Standard`,
      `${tsla.cusip},TSLA,Tesla Inc.,Equity,${tsla.expectedQty},0,DTC,Standard`,
      `${googl.cusip},GOOGL,Alphabet Inc. Cl A,Equity,${googl.expectedQty},0,DTC,Standard`,
    ].join("\n");
    const file = new File([csv], "apex.csv", { type: "text/csv" });
    const fileInput = document.querySelector<HTMLInputElement>(
      'input[aria-label="Upload Apex output CSV"]'
    );
    expect(fileInput).not.toBeNull();
    Object.defineProperty(fileInput!, "files", {
      value: [file],
      configurable: true,
    });
    await act(async () => {
      fileInput!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() =>
      expect(screen.getByText("Save Recon Results")).toBeInTheDocument()
    );

    // Fire the save but do NOT await full settlement — we want to observe the
    // intermediate "Saving…" state while the deferred refresh is pending.
    const saveButton = screen.getByText("Save Recon Results");
    act(() => {
      saveButton.click();
    });

    // onMutate is invoked but still pending — the save should be holding.
    await waitFor(() => expect(deferredOnMutate).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByText("Saving...")).toBeInTheDocument()
    );

    // Resolve the parent refresh. Now the save flow can finish.
    await act(async () => {
      resolveRefresh?.();
    });

    // Once the refresh resolves, the Saving state should clear and the CSV
    // upload surface should be back to its empty prompt (no reconRows → no
    // Save button; drop zone visible again).
    await waitFor(() =>
      expect(screen.queryByText("Saving...")).not.toBeInTheDocument()
    );
    await waitFor(() =>
      expect(screen.queryByText("Save Recon Results")).not.toBeInTheDocument()
    );
    expect(screen.getByText("Drop Apex CSV here")).toBeInTheDocument();
  });
});

function makeAsset(overrides: Partial<Asset>): Asset {
  return {
    id: "A1",
    symbol: "AAPL",
    description: "Apple Inc.",
    expectedQty: 100,
    actualQty: 0,
    mapStatus: "Pending",
    ...overrides,
  };
}

function makeApex(overrides: Partial<ApexPosition>): ApexPosition {
  return {
    cusip: "037833100",
    symbol: "AAPL",
    description: "Apple Inc.",
    assetClass: "Equity",
    qty: 100,
    amount: 15000,
    settlingLocation: "DTC",
    settlingLocationReason: "Standard",
    ...overrides,
  };
}

describe("reconcile", () => {
  it("matches by symbol (case-insensitive)", () => {
    const assets = [makeAsset({ symbol: "AAPL", cusip: undefined })];
    const apex = [makeApex({ symbol: "aapl", cusip: "037833100" })];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Matched");
  });

  it("matches by cusip when asset has cusip set", () => {
    const assets = [makeAsset({ symbol: "AAPL", cusip: "037833100" })];
    const apex = [makeApex({ symbol: "APPLE", cusip: "037833100" })];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Matched");
  });

  it("cross-matches asset.symbol against apex.cusip when pipeline stored a CUSIP as symbol", () => {
    const assets = [makeAsset({ id: "A1", symbol: "037833100", cusip: undefined })];
    const apex = [makeApex({ cusip: "037833100", symbol: "AAPL" })];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Matched");
    expect(rows[0].actualQty).toBe(100);
  });

  it("marks cross-matched CUSIP row as Mismatch when quantities differ", () => {
    const assets = [makeAsset({ symbol: "88160R101", cusip: undefined, expectedQty: 200 })];
    const apex = [makeApex({ cusip: "88160R101", symbol: "TSLA", qty: 190 })];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Mismatch");
    expect(rows[0].issue).toContain("-10 shares");
  });

  it("prefers cusip field match over symbol-to-cusip cross-match", () => {
    const assets = [makeAsset({ symbol: "AAPL", cusip: "037833100" })];
    const apex = [
      makeApex({ cusip: "999999999", symbol: "AAPL", qty: 50 }),
      makeApex({ cusip: "037833100", symbol: "DIFFERENT", qty: 100 }),
    ];
    const rows = reconcile(assets, apex);
    expect(rows[0].status).toBe("Matched");
    expect(rows[0].actualQty).toBe(100);
    expect(rows[1].status).toBe("Unexpected");
  });

  it("reports Missing when no match found by symbol or cusip", () => {
    const assets = [makeAsset({ symbol: "XYZ", cusip: undefined })];
    const apex = [makeApex({ cusip: "037833100", symbol: "AAPL" })];
    const rows = reconcile(assets, apex);
    const missing = rows.find((r) => r.status === "Missing");
    expect(missing).toBeDefined();
    expect(missing!.issue).toBe("Not found in Apex CSV");
  });

  it("reports Unexpected for unmatched Apex rows", () => {
    const assets = [makeAsset({ symbol: "AAPL" })];
    const apex = [
      makeApex({ symbol: "AAPL" }),
      makeApex({ symbol: "MSFT", cusip: "594918104", qty: 50 }),
    ];
    const rows = reconcile(assets, apex);
    const unexpected = rows.find((r) => r.status === "Unexpected");
    expect(unexpected).toBeDefined();
    expect(unexpected!.symbol).toBe("MSFT");
  });

  // Cash reconciles by dollar amount (`amount`), not share quantity — a cash
  // line's qty is always 0; the dollars live in `amount` on both sides.
  it("matches pipeline Cash to Apex USD", () => {
    const assets = [makeAsset({ symbol: "Cash", cusip: undefined, expectedQty: 0, amount: 500 })];
    const apex = [makeApex({ symbol: "USD", cusip: "", qty: 0, amount: 500, description: "US Dollar" })];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Matched");
    expect(rows[0].actualQty).toBe(500);
  });

  it("matches pipeline USD to Apex Cash", () => {
    const assets = [makeAsset({ symbol: "USD", cusip: undefined, expectedQty: 0, amount: 1000 })];
    const apex = [makeApex({ symbol: "Cash", cusip: "", qty: 0, amount: 1000, description: "Cash Balance" })];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Matched");
  });

  it("reports Mismatch when cash amounts differ", () => {
    const assets = [makeAsset({ symbol: "Cash", cusip: undefined, expectedQty: 0, amount: 500 })];
    const apex = [makeApex({ symbol: "USD", cusip: "", qty: 0, amount: 450 })];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Mismatch");
    expect(rows[0].issue).toContain("Cash Mismatch");
    expect(rows[0].issue).toContain("-$50.00");
  });

  it("marks fee rows as Info with no issue", () => {
    const assets = [makeAsset({ symbol: "AAPL" })];
    const apex = [
      makeApex({ symbol: "AAPL" }),
      makeApex({ symbol: "FEE", cusip: "", description: "ACAT Transfer Fee", qty: 1, amount: -50, assetClass: "Fee" }),
    ];
    const rows = reconcile(assets, apex);
    const feeRow = rows.find((r) => r.symbol === "FEE");
    expect(feeRow).toBeDefined();
    expect(feeRow!.status).toBe("Info");
    expect(feeRow!.issue).toBeUndefined();
  });

  it("detects fee by description", () => {
    const assets: Asset[] = [];
    const apex = [
      makeApex({ symbol: "MISC", cusip: "", description: "Outgoing ACAT Fee", qty: 1, amount: -75 }),
    ];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Info");
    expect(rows[0].issue).toBeUndefined();
  });

  it("detects fee by asset class", () => {
    const assets: Asset[] = [];
    const apex = [
      makeApex({ symbol: "CHG", cusip: "", description: "Charge", assetClass: "Fee", qty: 1 }),
    ];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Info");
  });

  it("non-fee unmatched rows are still Unexpected", () => {
    const assets: Asset[] = [];
    const apex = [makeApex({ symbol: "MSFT", cusip: "594918104", qty: 50 })];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Unexpected");
    expect(rows[0].issue).toBe("Not in expected positions");
  });

  it("treats apex qty above expected as Matched with no issue", () => {
    const assets = [makeAsset({ symbol: "AAPL", expectedQty: 100 })];
    const apex = [makeApex({ symbol: "AAPL", qty: 112 })];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Matched");
    expect(rows[0].issue).toBeUndefined();
    expect(rows[0].actualQty).toBe(112);
  });

  it("marks short quantity as Mismatch", () => {
    const assets = [makeAsset({ symbol: "AAPL", expectedQty: 100 })];
    const apex = [makeApex({ symbol: "AAPL", qty: 90 })];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Mismatch");
    expect(rows[0].issue).toContain("-10 shares");
  });

  it("exact quantity match is Matched", () => {
    const assets = [makeAsset({ symbol: "AAPL", expectedQty: 100 })];
    const apex = [makeApex({ symbol: "AAPL", qty: 100 })];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Matched");
    expect(rows[0].issue).toBeUndefined();
  });

  it("treats apex cash above expected as Matched", () => {
    const assets = [makeAsset({ symbol: "Cash", cusip: undefined, expectedQty: 0, amount: 500 })];
    const apex = [makeApex({ symbol: "USD", cusip: "", qty: 0, amount: 525 })];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Matched");
    expect(rows[0].issue).toBeUndefined();
  });

  it("sums multiple Apex rows for the same CUSIP before matching", () => {
    const assets = [makeAsset({ symbol: "AAPL", cusip: "037833100", expectedQty: 100 })];
    const apex = [
      makeApex({ cusip: "037833100", symbol: "AAPL", qty: 60, amount: 9000 }),
      makeApex({ cusip: "037833100", symbol: "AAPL", qty: 40, amount: 6000 }),
    ];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Matched");
    expect(rows[0].actualQty).toBe(100);
    expect(rows[0].amount).toBe(15000);
  });

  it("sums multiple Apex rows for the same symbol when CUSIP is absent", () => {
    const assets = [makeAsset({ symbol: "MSFT", cusip: undefined, expectedQty: 50 })];
    const apex = [
      makeApex({ cusip: "", symbol: "MSFT", qty: 30 }),
      makeApex({ cusip: "", symbol: "msft", qty: 20 }),
    ];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Matched");
    expect(rows[0].actualQty).toBe(50);
  });

  it("aggregated short quantity is still reported as Mismatch", () => {
    const assets = [makeAsset({ symbol: "AAPL", cusip: "037833100", expectedQty: 100 })];
    const apex = [
      makeApex({ cusip: "037833100", symbol: "AAPL", qty: 60 }),
      makeApex({ cusip: "037833100", symbol: "AAPL", qty: 30 }),
    ];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Mismatch");
    expect(rows[0].actualQty).toBe(90);
    expect(rows[0].issue).toContain("-10 shares");
  });

  it("does not aggregate fee rows with matching symbols", () => {
    const assets: Asset[] = [];
    const apex = [
      makeApex({ symbol: "FEE", cusip: "", description: "ACAT Fee", assetClass: "Fee", qty: 1, amount: -50 }),
      makeApex({ symbol: "FEE", cusip: "", description: "Outgoing Fee", assetClass: "Fee", qty: 1, amount: -75 }),
    ];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "Info")).toBe(true);
  });

  // ACATs can only move whole shares — the delivering custodian keeps any
  // fractional piece. We treat that exact pattern as Matched (not Mismatch)
  // but leave an informational breadcrumb on the row.
  it("treats a fractional-only shortfall as Matched with an info note", () => {
    const assets = [
      makeAsset({ symbol: "AAPL", cusip: undefined, expectedQty: 100.37 }),
    ];
    const apex = [makeApex({ symbol: "AAPL", qty: 100 })];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Matched");
    expect(rows[0].issue).toMatch(/Fractional share not transferable/i);
  });

  it("still reports Mismatch when short by more than the fractional part", () => {
    const assets = [
      makeAsset({ symbol: "AAPL", cusip: undefined, expectedQty: 100.37 }),
    ];
    const apex = [makeApex({ symbol: "AAPL", qty: 99 })];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Mismatch");
    expect(rows[0].issue).toContain("Qty Mismatch");
  });

  it("exact fractional match is Matched with no issue", () => {
    const assets = [
      makeAsset({ symbol: "AAPL", cusip: undefined, expectedQty: 100.37 }),
    ];
    const apex = [makeApex({ symbol: "AAPL", qty: 100.37 })];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Matched");
    expect(rows[0].issue).toBeUndefined();
  });

  it("tolerates floating-point noise (0.1 + 0.2 vs 0.3)", () => {
    const assets = [makeAsset({ symbol: "AAPL", cusip: undefined, expectedQty: 0.3 })];
    const apex = [makeApex({ symbol: "AAPL", qty: 0.1 + 0.2 })];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Matched");
    expect(rows[0].issue).toBeUndefined();
  });

  it("matches BRK.B (expected) to BRKB (apex) via ticker normalization", () => {
    const assets = [
      makeAsset({ symbol: "BRK.B", cusip: undefined, expectedQty: 25 }),
    ];
    const apex = [
      makeApex({ symbol: "BRKB", cusip: "", qty: 25, description: "Berkshire Hathaway Cl B" }),
    ];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Matched");
  });

  it("matches BRK'B (expected) to BRK-B (apex)", () => {
    const assets = [
      makeAsset({ symbol: "BRK'B", cusip: undefined, expectedQty: 25 }),
    ];
    const apex = [
      makeApex({ symbol: "BRK-B", cusip: "", qty: 25, description: "Berkshire Hathaway Cl B" }),
    ];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Matched");
  });

  it("aggregates BRK.B and BRKB apex rows into one position when CUSIP is absent", () => {
    const assets = [
      makeAsset({ symbol: "BRK.B", cusip: undefined, expectedQty: 30 }),
    ];
    const apex = [
      makeApex({ symbol: "BRK.B", cusip: "", qty: 10 }),
      makeApex({ symbol: "BRKB", cusip: "", qty: 20 }),
    ];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Matched");
    expect(rows[0].actualQty).toBe(30);
  });

  // Regression guard: even if a normalized-symbol row exists, an exact CUSIP
  // hit on a different row must win. Mirrors the existing "prefers cusip
  // field match" test, but forces the symbol path through normalization.
  it("still prefers CUSIP match over normalized symbol match", () => {
    const assets = [
      makeAsset({ symbol: "BRK.B", cusip: "084670702", expectedQty: 25 }),
    ];
    const apex = [
      makeApex({ cusip: "999999999", symbol: "BRKB", qty: 11 }),
      makeApex({ cusip: "084670702", symbol: "DIFFERENT", qty: 25 }),
    ];
    const rows = reconcile(assets, apex);
    expect(rows[0].status).toBe("Matched");
    expect(rows[0].actualQty).toBe(25);
    const unexpected = rows.find((r) => r.status === "Unexpected");
    expect(unexpected?.actualQty).toBe(11);
  });

  it("matches 'U S D' to Cash via normalized cash synonyms", () => {
    const assets = [
      makeAsset({ symbol: "Cash", cusip: undefined, expectedQty: 0, amount: 500 }),
    ];
    const apex = [
      makeApex({ symbol: "U S D", cusip: "", qty: 0, amount: 500, description: "US Dollar" }),
    ];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Matched");
  });

  // Feature (ticket): cash reconciles by dollars pulled from asset mapping.
  it("flags a real cash shortfall with a dollar delta (Example Client case)", () => {
    const assets = [
      makeAsset({ symbol: "CASH", cusip: undefined, expectedQty: 0, amount: 2671.51 }),
    ];
    const apex = [
      makeApex({ symbol: "CASH", cusip: "", qty: 0, amount: 1936.87, description: "Cash Balance" }),
    ];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Mismatch");
    expect(rows[0].expectedQty).toBe(2671.51);
    expect(rows[0].actualQty).toBe(1936.87);
    expect(rows[0].issue).toBe("Cash Mismatch (-$734.64)");
  });

  it("treats a sub-cent cash difference as Matched", () => {
    const assets = [
      makeAsset({ symbol: "CASH", cusip: undefined, expectedQty: 0, amount: 100 }),
    ];
    const apex = [
      makeApex({ symbol: "CASH", cusip: "", qty: 0, amount: 99.995 }),
    ];
    const rows = reconcile(assets, apex);
    expect(rows[0].status).toBe("Matched");
    expect(rows[0].issue).toBeUndefined();
  });

  it("shows expected cash dollars on a missing cash line", () => {
    const assets = [
      makeAsset({ symbol: "CASH", cusip: undefined, expectedQty: 0, amount: 1856.45 }),
    ];
    const apex = [makeApex({ symbol: "AAPL", qty: 10 })];
    const rows = reconcile(assets, apex);
    const cash = rows.find((r) => r.symbol === "CASH");
    expect(cash?.status).toBe("Missing");
    expect(cash?.expectedQty).toBe(1856.45);
  });

  it("surfaces unexpected apex cash with its dollar amount as actual", () => {
    const assets: Asset[] = [];
    const apex = [makeApex({ symbol: "CASH", cusip: "", qty: 0, amount: 42.5 })];
    const rows = reconcile(assets, apex);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Unexpected");
    expect(rows[0].actualQty).toBe(42.5);
  });
});

describe("normalizeTicker", () => {
  it("strips common separators", () => {
    expect(normalizeTicker("BRK.B")).toBe("BRKB");
    expect(normalizeTicker("BRK'B")).toBe("BRKB");
    expect(normalizeTicker("BRK-B")).toBe("BRKB");
    expect(normalizeTicker("BRK/B")).toBe("BRKB");
    expect(normalizeTicker("BRK B")).toBe("BRKB");
    expect(normalizeTicker("BRK_B")).toBe("BRKB");
  });

  it("uppercases lowercase input", () => {
    expect(normalizeTicker("brk.b")).toBe("BRKB");
    expect(normalizeTicker("aapl")).toBe("AAPL");
  });

  it("preserves plain alphanumerics", () => {
    expect(normalizeTicker("AAPL")).toBe("AAPL");
    expect(normalizeTicker("GOOG1")).toBe("GOOG1");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeTicker("  AAPL  ")).toBe("AAPL");
  });
});

describe("aggregateApexPositions", () => {
  it("merges separator-varying apex rows into a single position", () => {
    const positions = [
      makeApex({ symbol: "BRK.B", cusip: "", qty: 10, amount: 100 }),
      makeApex({ symbol: "BRKB", cusip: "", qty: 15, amount: 150 }),
      makeApex({ symbol: "BRK-B", cusip: "", qty: 5, amount: 50 }),
    ];
    const aggregated = aggregateApexPositions(positions);
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0].qty).toBe(30);
    expect(aggregated[0].amount).toBe(300);
  });
});
