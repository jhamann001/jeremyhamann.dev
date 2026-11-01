import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import Home from "./page";
import { AcatRecord } from "@/lib/types";
import { DataQualityFocus } from "@/lib/data-quality-focus";

const pushMock = vi.fn();
const useAcatsMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => "/",
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { email: "u@example.com", name: "U", role: "ADMIN" } },
    status: "authenticated",
  }),
  signOut: vi.fn(),
}));

vi.mock("@/hooks/use-acats", () => ({
  useAcats: () => useAcatsMock(),
  POLL_INTERVAL_MS: 1_000_000,
}));

vi.mock("@/components/NewAcatModal", () => ({
  __esModule: true,
  default: () => <div data-testid="new-acat-modal" />,
}));

vi.mock("@/components/TransferDetailsDrawer", () => ({
  __esModule: true,
  default: ({
    acat,
    focus,
    onClose,
    onOpenFullRecord,
  }: {
    acat: AcatRecord;
    focus?: DataQualityFocus;
    onClose: () => void;
    onOpenFullRecord: () => void;
  }) => (
    <div role="dialog" aria-label="Transfer details" data-focus-field={focus?.field}>
      <span>Details for {acat.id}</span>
      <button onClick={onOpenFullRecord}>Full record</button>
      <button onClick={onClose}>Close details</button>
    </div>
  ),
}));

vi.mock("@/components/TransferDashboard", () => ({
  __esModule: true,
  default: ({
    onSelectRecord,
  }: {
    acats: AcatRecord[];
    onSelectRecord: (id: string, focus?: DataQualityFocus) => void;
  }) => (
    <>
      <button data-testid="dashboard-record" onClick={() => onSelectRecord("acat-99")}>
        dashboard
      </button>
      <button
        data-testid="dashboard-quality-record"
        onClick={() => onSelectRecord("acat-99", {
          ruleKey: "missing_crm_ticket",
          title: "Required CRM ticket is missing",
          detail: "Add the CRM ticket.",
          tab: "details",
          field: "crmTicket",
          fieldLabel: "CRM Ticket",
        })}
      >
        quality issue
      </button>
    </>
  ),
}));

describe("Home page (Dashboard + NavRail)", () => {
  beforeEach(() => {
    pushMock.mockReset();
    useAcatsMock.mockReset();
  });

  it("shows the loading state while records are loading", () => {
    useAcatsMock.mockReturnValue({
      acats: [],
      loading: true,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    render(<Home />);
    expect(screen.getByText(/loading transfer records/i)).toBeInTheDocument();
  });

  it("renders the NavRail + Dashboard when records are loaded", async () => {
    useAcatsMock.mockReturnValue({
      acats: [
        { id: "a1", status: "AcatReceived" } as AcatRecord,
      ],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    render(<Home />);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /go to dashboard/i })
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /all records/i })).toBeInTheDocument();
    expect(screen.getByTestId("dashboard-record")).toBeInTheDocument();
  });

  it("opens a dashboard record in a drawer without leaving the dashboard", async () => {
    useAcatsMock.mockReturnValue({
      acats: [{ id: "acat-99" } as AcatRecord],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    render(<Home />);
    fireEvent.click(screen.getByTestId("dashboard-record"));

    expect(await screen.findByRole("dialog", { name: "Transfer details" })).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Full record" }));
    expect(pushMock).toHaveBeenCalledWith("/records?open=acat-99");
  });

  it("passes the selected data-quality field into the transfer drawer", async () => {
    useAcatsMock.mockReturnValue({
      acats: [{ id: "acat-99" } as AcatRecord],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    render(<Home />);
    fireEvent.click(screen.getByTestId("dashboard-quality-record"));

    expect(await screen.findByRole("dialog", { name: "Transfer details" }))
      .toHaveAttribute("data-focus-field", "crmTicket");
  });
});
