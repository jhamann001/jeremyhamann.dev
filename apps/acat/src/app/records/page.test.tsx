import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import RecordsPage from "./page";
import { mockAcats } from "@/lib/mock-data";
import { ToastProvider } from "@/components/Toast";
import { jsonFetcher } from "@/lib/fetcher";

const replaceMock = vi.fn();
const pushMock = vi.fn();
const searchParamsStore = { value: "" };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  usePathname: () => "/records",
  useSearchParams: () => new URLSearchParams(searchParamsStore.value),
}));

vi.mock("next-auth/react", () => ({
  signOut: vi.fn(),
  useSession: () => ({
    data: {
      user: { email: "j@example.com", name: "Jeremy", role: "ADMIN" },
    },
    status: "authenticated",
  }),
}));

const mockStorage: Record<string, string> = {};

beforeEach(() => {
  replaceMock.mockClear();
  pushMock.mockClear();
  searchParamsStore.value = "";
  for (const key of Object.keys(mockStorage)) delete mockStorage[key];
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mockStorage[k] ?? null,
    setItem: (k: string, v: string) => {
      mockStorage[k] = v;
    },
    removeItem: (k: string) => {
      delete mockStorage[k];
    },
  });
  // Route by URL so each endpoint gets a shape it actually produces.
  // This matters now that the drawer's tabs (SecurityReconTab, FeesTab,
  // TransferDetailsTab) are SWR-backed and mount as CollapsibleSections
  // alongside Transfer Details — they hit /api/asset-mapping, /api/fees,
  // and /api/custodians on drawer open.
  global.fetch = vi.fn().mockImplementation((url: string) => {
    if (typeof url === "string" && url.startsWith("/api/asset-mapping")) {
      const acat = mockAcats[0];
      return Promise.resolve({
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
    }
    if (typeof url === "string" && url.startsWith("/api/custodians")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
      });
    }
    if (typeof url === "string" && url.startsWith("/api/fees")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
      });
    }
    if (
      typeof url === "string" &&
      url.includes("/manual-form-recommendation")
    ) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            status: "ACTION_REQUIRED",
            custodian: null,
            candidates: [
              {
                id: "default-brokerage-firm-transfer",
                custodianName: "Delivering firm",
                displayName: "Standard brokerage transfer",
                template: "APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST",
                apexTransferSelection: "BROKERAGE_FIRM_TRANSFER",
                apexTransferSelectionByInstruction: {
                  LIQUIDATE: "LIQUIDATE_ALL_ASSETS_TRANSFER_AS_CASH",
                },
                assetHandling: {
                  mode: "CLIENT_DIRECTED",
                  options: ["IN_KIND", "LIQUIDATE"],
                  defaultInstruction: "IN_KIND",
                },
                isDefaultFallback: true,
              },
            ],
            actions: [
              {
                code: "VERIFY_UNLINKED_CUSTODIAN",
                message: "Verify the delivering firm before generating.",
              },
            ],
            discrepancies: [],
            sourceGuidance: [],
          }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(mockAcats),
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderPage() {
  return render(
    <SWRConfig
      value={{
        fetcher: jsonFetcher,
        provider: () => new Map(),
        dedupingInterval: 0,
        focusThrottleInterval: 0,
      }}
    >
      <ToastProvider>
        <RecordsPage />
      </ToastProvider>
    </SWRConfig>
  );
}

describe("RecordsPage", () => {
  it("renders the nav rail and records view", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("All Records")).toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: "Dashboard" })).toBeInTheDocument();
  });

  it("opens the drawer by updating the URL when a row is clicked", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Sarah Jenkins")).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: /Open Sarah Jenkins/ }));
    expect(replaceMock).toHaveBeenCalledWith(
      "/records?open=REC-001",
      expect.objectContaining({ scroll: false })
    );
  });

  it("shows the drawer when ?open=<id> is present on mount", async () => {
    searchParamsStore.value = "open=REC-001";
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
        "Sarah Jenkins"
      )
    );
  });
});
