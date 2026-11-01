import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import TransferDetailsTab from "./TransferDetailsTab";
import { jsonFetcher } from "@/lib/fetcher";
import { AcatRecord } from "@/lib/types";

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock("./Toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

// Isolated SWR cache per test so the /api/custodians read doesn't share
// state across cases (important now that mount-time data fetching goes
// through SWR instead of a one-shot useEffect).
function renderWithSWR(ui: React.ReactElement) {
  return render(
    <SWRConfig
      value={{
        fetcher: jsonFetcher,
        provider: () => new Map(),
        dedupingInterval: 0,
        focusThrottleInterval: 0,
      }}
    >
      {ui}
    </SWRConfig>
  );
}

function openProcessingInstructions() {
  const button = screen.getByRole("button", { name: /Processing & Instructions/ });
  expect(button).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(button);
  expect(button).toHaveAttribute("aria-expanded", "true");
}

const mockUseSession = vi.fn(() => ({
  data: {
    user: {
      email: "admin@example.com",
      name: "Admin",
      role: "ADMIN",
    },
  },
  status: "authenticated",
}));

vi.mock("next-auth/react", () => ({
  useSession: () => mockUseSession(),
}));

const mockCustodians = [
  { id: "CUST-001", name: "Fidelity", acatFeeAmount: 0, avgProcessingDays: 5 },
  { id: "CUST-002", name: "Charles Schwab", acatFeeAmount: 50, avgProcessingDays: 6 },
];

function makeFetchMock() {
  return vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/custodians" && (!init || init.method === undefined || init.method === "GET")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockCustodians),
      });
    }
    if (url === "/api/custodians" && init?.method === "POST") {
      const body = JSON.parse((init.body as string) ?? "{}");
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            id: `CUST-NEW-${body.name}`,
            name: body.name,
            acatFeeAmount: 0,
            avgProcessingDays: 7,
          }),
      });
    }
    if (url.startsWith("/api/dtcc-suggestion?")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: "suggested", dtccNumber: "0188", source: "custodian", historicalSampleSize: 3 }),
      });
    }
    if (url.includes("/manual-form-recommendation")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          status: "ACTION_REQUIRED",
          apexAccountTitleSuggestion:
            "Sarah Jenkins - Brokerage / Individual",
          custodian: mockCustodians[0],
          candidates: [
            {
              id: "default-brokerage-firm-transfer",
              custodianName: "Fidelity",
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
              code: "VERIFY_DEFAULT_BROKERAGE_WORKFLOW",
              message:
                "Brokerage Firm Transfer is selected by default; confirm it against the current client request.",
            },
          ],
          discrepancies: [],
          sourceGuidance: [],
        }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
  }) as unknown as typeof fetch;
}

const mockAcat: AcatRecord = {
  id: "REC-001",
  clientName: "Sarah Jenkins",
  controlNumber: "CTL-10421",
  acatTransferId: "TRN-9812",
  direction: "In",
  type: "Full",
  accountType: "Brokerage / Individual",
  status: "AcatReceived",
  wealthAdvisor: "Jeremy H.",
  apexAccountId: "APX-1049201",
  statementAccountNumber: "PIN-10000098",
  transferringContra: "Charles Schwab",
  dtccNumber: "0188",
  statementAmount: 26800000,
  methodRequested: "ACAT",
  crwEe: "No",
  originalClientRequestDate: "2026-04-10",
  crmTicket: "OPP-9812",
  apexTicket: "APX-TKT-101",
  tradeRequestId: "TRQ-456",
  tradeRequestUrl: "https://trades.example.com/requests/TRQ-456",
  lastUpdated: "2026-04-12T14:32:00Z",
  crmDealId: "OPP-9812",
  custodianId: "CUST-002",
  custodianName: "Charles Schwab",
  acatDate: "2026-04-10",
  slackAlerted: false,
  mappingSource: "GCP Project API",
  apexSource: "Uploaded",
  assets: [],
};

beforeEach(() => {
  toastMock.mockClear();
  mockUseSession.mockReturnValue({
    data: {
      user: {
        email: "admin@example.com",
        name: "Admin",
        role: "ADMIN",
      },
    },
    status: "authenticated",
  });
  global.fetch = makeFetchMock();
});

describe("TransferDetailsTab", () => {
  it("includes the reviewed identity version when editing a transfer matching key", async () => {
    renderWithSWR(<TransferDetailsTab acat={{ ...mockAcat, cedarRidgeUserId: "user-synthetic", identityVersion: 7, acatTransferId: "OLD-TRANSFER" }} />);
    fireEvent.click(screen.getByText("OLD-TRANSFER"));
    const input = screen.getByDisplayValue("OLD-TRANSFER");
    fireEvent.change(input, { target: { value: "NEW-TRANSFER" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/acats/${mockAcat.id}`, expect.objectContaining({ body: JSON.stringify({ acatTransferId: "NEW-TRANSFER", expectedIdentityVersion: 7 }) })));
  });

  it("clears a pending receiving account with an empty string and its reviewed version", async () => {
    const onMutate = vi.fn();
    renderWithSWR(<TransferDetailsTab acat={{ ...mockAcat, status: "PendingAccountOpening", cedarRidgeUserId: "user-synthetic", identityVersion: 7 }} onMutate={onMutate} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Apex Account #" }));
    const input = screen.getByDisplayValue(mockAcat.apexAccountId);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/acats/${mockAcat.id}`, expect.objectContaining({ body: JSON.stringify({ apexAccountId: "", expectedIdentityVersion: 7 }) })));
    await waitFor(() => expect(onMutate).toHaveBeenCalledOnce());
  });

  it("retains a nonpending account edit and surfaces the server's blank-account rejection", async () => {
    const legacyFetch = makeFetchMock();
    global.fetch = vi.fn((url: string, init?: RequestInit) => init?.method === "PATCH"
      ? Promise.resolve({ ok: false, json: async () => ({ code: "ACCOUNT_NOT_LINKED", error: "The selected client is not linked to that Apex account." }) })
      : legacyFetch(url, init)) as typeof fetch;
    const onMutate = vi.fn();
    renderWithSWR(<TransferDetailsTab acat={{ ...mockAcat, status: "Submitted", cedarRidgeUserId: "user-synthetic", identityVersion: 7 }} onMutate={onMutate} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Apex Account #" }));
    const input = screen.getByDisplayValue(mockAcat.apexAccountId);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith("error", "Update Failed", "The selected client is not linked to that Apex account."));
    expect(input).toBeInTheDocument();
    expect(onMutate).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(`/api/acats/${mockAcat.id}`, expect.objectContaining({ body: JSON.stringify({ apexAccountId: "", expectedIdentityVersion: 7 }) }));
  });

  it("keeps transfer details open and processing instructions collapsed by default", () => {
    renderWithSWR(<TransferDetailsTab acat={mockAcat} />);
    expect(screen.getByText("Transfer & Account Details")).toBeInTheDocument();
    expect(screen.getByText("Transfer")).toBeInTheDocument();
    expect(screen.getByText("Accounts")).toBeInTheDocument();
    expect(screen.queryByText("Dates & Monitoring")).not.toBeInTheDocument();

    openProcessingInstructions();

    expect(screen.getByText("Dates & Monitoring")).toBeInTheDocument();
    expect(screen.getByText("Tickets & Resources")).toBeInTheDocument();
    expect(screen.getAllByText("Trade Instructions")).toHaveLength(2);
  });

  it.each([
    "ACAT",
    "MANUAL",
    "DRS",
    "RESIDUAL",
    "UNCLASSIFIED",
  ] as const)("loads paperwork guidance for %s transfers", async (transferWorkflow) => {
    const fetchSpy = makeFetchMock();
    global.fetch = fetchSpy;
    renderWithSWR(
      <TransferDetailsTab
        acat={{ ...mockAcat, transferWorkflow }}
      />
    );
    openProcessingInstructions();

    expect(
      await screen.findByText("Transfer paperwork recommendation")
    ).toBeInTheDocument();
    const downloadButton = screen.getByRole("button", {
      name: "Download prefilled form",
    });
    expect(downloadButton).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "I confirmed this account title matches Apex.",
      })
    );
    expect(downloadButton).toBeEnabled();
    expect(
      (fetchSpy as ReturnType<typeof vi.fn>).mock.calls.some(([url]) =>
        String(url).includes("/manual-form-recommendation")
      )
    ).toBe(true);
  });

  it("displays field values from the ACAT record", () => {
    renderWithSWR(<TransferDetailsTab acat={mockAcat} />);
    openProcessingInstructions();
    expect(screen.getByText("CTL-10421")).toBeInTheDocument();
    expect(screen.getByText("TRN-9812")).toBeInTheDocument();
    expect(screen.getByText("In")).toBeInTheDocument();
    expect(screen.getByText("Full")).toBeInTheDocument();
    expect(screen.getByText("Brokerage / Individual")).toBeInTheDocument();
    expect(screen.getByText("Jeremy H.")).toBeInTheDocument();
    expect(screen.getByText("APX-1049201")).toBeInTheDocument();
    expect(screen.getAllByText("Charles Schwab").length).toBeGreaterThan(0);
    expect(screen.getByText("$268,000.00")).toBeInTheDocument();
    expect(screen.getByText("04-10-2026")).toBeInTheDocument();
    // OPP-9812 appears twice: once as CRM Ticket, once as CRM Deal ID
    // (the latter is auto-derived from the ticket on create).
    expect(screen.getAllByText("OPP-9812").length).toBe(2);
    expect(screen.getByText("TRQ-456")).toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: "https://trades.example.com/requests/TRQ-456",
      })
    ).toHaveAttribute("href", "https://trades.example.com/requests/TRQ-456");
  });

  it("masks the statement account number in display", () => {
    renderWithSWR(<TransferDetailsTab acat={mockAcat} />);
    expect(screen.queryByText("PIN-10000098")).not.toBeInTheDocument();
    expect(screen.getByText("•••-••••0098")).toBeInTheDocument();
  });

  it("shows the full unmasked account number when editing", () => {
    renderWithSWR(<TransferDetailsTab acat={mockAcat} />);
    fireEvent.click(screen.getByText("•••-••••0098"));
    expect(screen.getByDisplayValue("PIN-10000098")).toBeInTheDocument();
  });

  it("shows edit input when a field is clicked", () => {
    renderWithSWR(<TransferDetailsTab acat={mockAcat} />);
    fireEvent.click(screen.getByText("CTL-10421"));
    const input = screen.getByDisplayValue("CTL-10421");
    expect(input).toBeInTheDocument();
  });

  it("offers inherited account types when editing account type", () => {
    renderWithSWR(<TransferDetailsTab acat={mockAcat} />);
    fireEvent.click(screen.getByText("Brokerage / Individual"));

    const select = screen.getByDisplayValue("Brokerage / Individual");
    expect(select).toHaveTextContent("Inherited Roth IRA");
    expect(select).toHaveTextContent("Inherited Traditional IRA (w/ beneficiaries)");
  });

  it("shows dash for empty fields", () => {
    const sparse: AcatRecord = {
      ...mockAcat,
      rejectionReason: undefined,
      additionalResources: undefined,
      tradeRequestId: undefined,
      tradeRequestUrl: undefined,
    };
    renderWithSWR(<TransferDetailsTab acat={sparse} />);
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThan(0);
  });

  it("treats a missing workflow as Unclassified and does not offer a blank workflow", async () => {
    const fetchSpy = makeFetchMock();
    global.fetch = fetchSpy;
    renderWithSWR(<TransferDetailsTab acat={{ ...mockAcat, transferWorkflow: undefined }} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit Transfer Workflow" }));
    const select = screen.getByDisplayValue("UNCLASSIFIED") as HTMLSelectElement;
    expect(Array.from(select.options).some((option) => option.value === "")).toBe(false);

    fireEvent.change(select, { target: { value: "MANUAL" } });

    await waitFor(() => {
      const patchCall = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls.find(
        (call) =>
          (call[0] as string).startsWith("/api/acats/") &&
          (call[1] as RequestInit | undefined)?.method === "PATCH"
      );
      expect(patchCall).toBeTruthy();
      expect(JSON.parse(patchCall![1].body)).toEqual({ transferWorkflow: "MANUAL" });
    });
  });

  it("renders the ContraCombobox when editing transferringContra", async () => {
    renderWithSWR(<TransferDetailsTab acat={mockAcat} />);

    const contraRows = screen.getAllByText("Charles Schwab");
    fireEvent.click(contraRows[0]);

    const combobox = await screen.findByRole("combobox");
    expect((combobox as HTMLInputElement).value).toBe("Charles Schwab");

    fireEvent.focus(combobox);
    fireEvent.change(combobox, { target: { value: "" } });
    await waitFor(() => {
      expect(screen.getByText("Fidelity")).toBeInTheDocument();
    });
  });

  it("PATCHes transferringContra when a contra is picked and the user clicks outside", async () => {
    const fetchSpy = makeFetchMock();
    global.fetch = fetchSpy;

    renderWithSWR(
      <div>
        <button data-testid="outside">outside</button>
        <TransferDetailsTab acat={mockAcat} />
      </div>
    );

    fireEvent.click(screen.getAllByText("Charles Schwab")[0]);
    const combobox = await screen.findByRole("combobox");
    fireEvent.focus(combobox);

    await waitFor(() =>
      expect(
        (combobox as HTMLInputElement).value
      ).toBe("Charles Schwab")
    );
    fireEvent.change(combobox, { target: { value: "" } });

    fireEvent.mouseDown(await screen.findByText("Fidelity"));

    // Blur-to-save: clicking outside the InlineField wrapper commits.
    fireEvent.mouseDown(screen.getByTestId("outside"));

    await waitFor(() => {
      const patchCall = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) =>
          (c[0] as string).startsWith("/api/acats/") &&
          (c[1] as RequestInit | undefined)?.method === "PATCH"
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(patchCall![1].body);
      expect(body.transferringContra).toBe("Fidelity");
    });
  });

  it("hides the + Add new row for non-admin users", async () => {
    mockUseSession.mockReturnValue({
      data: {
        user: {
          email: "user@example.com",
          name: "User",
          role: "USER",
        },
      },
      status: "authenticated",
    });

    renderWithSWR(<TransferDetailsTab acat={mockAcat} />);
    fireEvent.click(screen.getAllByText("Charles Schwab")[0]);
    const combobox = await screen.findByRole("combobox");
    fireEvent.focus(combobox);
    fireEvent.change(combobox, { target: { value: "Raymond James" } });

    expect(
      screen.queryByText(/Add "Raymond James" as a new contra/i)
    ).not.toBeInTheDocument();
  });

  it("renders URL-shaped values as external links that don't trigger edit mode", () => {
    const withLink: AcatRecord = {
      ...mockAcat,
      crmTicket: "https://crm.example/task/123",
    };
    renderWithSWR(<TransferDetailsTab acat={withLink} />);
    openProcessingInstructions();

    const link = screen.getByRole("link", {
      name: "https://crm.example/task/123",
    });
    expect(link).toHaveAttribute("href", "https://crm.example/task/123");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel") ?? "").toContain("noopener");

    fireEvent.click(link);
    expect(
      screen.queryByDisplayValue("https://crm.example/task/123")
    ).not.toBeInTheDocument();
  });

  it("admin can add a new contra from the inline edit", async () => {
    const fetchSpy = makeFetchMock();
    global.fetch = fetchSpy;

    renderWithSWR(<TransferDetailsTab acat={mockAcat} />);
    fireEvent.click(screen.getAllByText("Charles Schwab")[0]);
    const combobox = await screen.findByRole("combobox");
    fireEvent.focus(combobox);
    fireEvent.change(combobox, { target: { value: "Raymond James" } });

    fireEvent.mouseDown(
      await screen.findByText(/Add "Raymond James" as a new contra/i)
    );

    await waitFor(() => {
      const postCall = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) =>
          (c[0] as string) === "/api/custodians" &&
          (c[1] as RequestInit | undefined)?.method === "POST"
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall![1].body);
      expect(body.name).toBe("Raymond James");
    });
  });

  it("PATCHes a text field when the input is blurred with a new value", async () => {
    const fetchSpy = makeFetchMock();
    global.fetch = fetchSpy;
    renderWithSWR(<TransferDetailsTab acat={mockAcat} />);
    openProcessingInstructions();

    fireEvent.click(screen.getByText("CTL-10421"));
    const input = screen.getByDisplayValue("CTL-10421") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "CTL-NEW" } });
    fireEvent.blur(input);

    await waitFor(() => {
      const patchCall = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) =>
          (c[0] as string).startsWith("/api/acats/") &&
          (c[1] as RequestInit | undefined)?.method === "PATCH"
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(patchCall![1].body);
      expect(body.controlNumber).toBe("CTL-NEW");
    });
  });

  it("offers a reliable DTC suggestion for a blank field", async () => {
    const fetchSpy = makeFetchMock();
    global.fetch = fetchSpy;
    const missingDtcc = { ...mockAcat, dtccNumber: undefined };
    renderWithSWR(<TransferDetailsTab acat={missingDtcc} />);

    const useSuggestion = await screen.findByRole("button", { name: "Use 0188" });
    fireEvent.click(useSuggestion);
    await waitFor(() => {
      const patchCall = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => (c[0] as string) === "/api/acats/REC-001" && (c[1] as RequestInit | undefined)?.method === "PATCH"
      );
      expect(JSON.parse(patchCall![1].body)).toEqual({ dtccNumber: "0188" });
    });
  });

  it("PATCHes trade request fields from the Trade Request section", async () => {
    const fetchSpy = makeFetchMock();
    global.fetch = fetchSpy;
    renderWithSWR(<TransferDetailsTab acat={mockAcat} />);
    openProcessingInstructions();

    fireEvent.click(screen.getByText("TRQ-456"));
    const input = screen.getByDisplayValue("TRQ-456") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "TRQ-789" } });
    fireEvent.blur(input);

    await waitFor(() => {
      const patchCall = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) =>
          (c[0] as string).startsWith("/api/acats/") &&
          (c[1] as RequestInit | undefined)?.method === "PATCH"
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(patchCall![1].body);
      expect(body.tradeRequestId).toBe("TRQ-789");
    });
  });

  it("only shows rejection reason for rejected transfers", () => {
    const { unmount } = renderWithSWR(<TransferDetailsTab acat={mockAcat} />);
    openProcessingInstructions();
    expect(screen.queryByText("Rejection Reason")).not.toBeInTheDocument();
    unmount();

    renderWithSWR(
      <TransferDetailsTab
        acat={{ ...mockAcat, status: "Rejected", rejectionReason: "Contra rejected the request" }}
      />
    );
    openProcessingInstructions();
    expect(screen.getByText("Rejection Reason")).toBeInTheDocument();
    expect(screen.getByText("Contra rejected the request")).toBeInTheDocument();
  });

  it("opens processing instructions and starts editing the focused data-quality field", () => {
    renderWithSWR(
      <TransferDetailsTab
        acat={{ ...mockAcat, crmTicket: "" }}
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

    expect(screen.getByText("Fixing: Required CRM ticket is missing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Processing & Instructions/ })).toHaveAttribute("aria-expanded", "true");
    const target = document.querySelector('[data-quality-target="true"]');
    expect(target).not.toBeNull();
    expect(within(target as HTMLElement).getByRole("textbox")).toHaveFocus();
  });

  it("does NOT PATCH when blurring without changing the value", async () => {
    const fetchSpy = makeFetchMock();
    global.fetch = fetchSpy;
    renderWithSWR(<TransferDetailsTab acat={mockAcat} />);

    fireEvent.click(screen.getByText("CTL-10421"));
    const input = screen.getByDisplayValue("CTL-10421") as HTMLInputElement;
    fireEvent.blur(input);

    await waitFor(() => {
      expect(screen.queryByDisplayValue("CTL-10421")).not.toBeInTheDocument();
    });
    const patchCall = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) =>
        (c[0] as string).startsWith("/api/acats/") &&
        (c[1] as RequestInit | undefined)?.method === "PATCH"
    );
    expect(patchCall).toBeUndefined();
  });

  it("Escape cancels an edit without saving", async () => {
    const fetchSpy = makeFetchMock();
    global.fetch = fetchSpy;
    renderWithSWR(<TransferDetailsTab acat={mockAcat} />);

    fireEvent.click(screen.getByText("CTL-10421"));
    const input = screen.getByDisplayValue("CTL-10421") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ZZZ" } });
    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByDisplayValue("ZZZ")).not.toBeInTheDocument();
    });
    const patchCall = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) =>
        (c[0] as string).startsWith("/api/acats/") &&
        (c[1] as RequestInit | undefined)?.method === "PATCH"
    );
    expect(patchCall).toBeUndefined();
  });

  it("auto-commits a select change without an explicit save click", async () => {
    const fetchSpy = makeFetchMock();
    global.fetch = fetchSpy;
    renderWithSWR(<TransferDetailsTab acat={mockAcat} />);

    fireEvent.click(screen.getByText("In"));
    const select = screen.getByDisplayValue("In") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "Out" } });

    await waitFor(() => {
      const patchCall = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) =>
          (c[0] as string).startsWith("/api/acats/") &&
          (c[1] as RequestInit | undefined)?.method === "PATCH"
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(patchCall![1].body);
      expect(body.direction).toBe("Out");
    });
  });

  it("renders methodRequested as pills from a comma-delimited value", () => {
    const multi: AcatRecord = {
      ...mockAcat,
      methodRequested: "API, Full Docusign",
    };
    renderWithSWR(<TransferDetailsTab acat={multi} />);
    expect(screen.getByText("API")).toBeInTheDocument();
    expect(screen.getByText("Full Docusign")).toBeInTheDocument();
  });

  it("PATCHes methodRequested as a comma-delimited list when multiple methods are selected and user clicks outside", async () => {
    const fetchSpy = makeFetchMock();
    global.fetch = fetchSpy;

    const multi: AcatRecord = { ...mockAcat, methodRequested: "API" };
    renderWithSWR(
      <div>
        <button data-testid="outside">outside</button>
        <TransferDetailsTab acat={multi} />
      </div>
    );

    fireEvent.click(screen.getByText("API"));

    const trigger = await screen.findByRole("button", { name: /^API$/ });
    fireEvent.click(trigger);

    fireEvent.click(await screen.findByText("Full Docusign"));

    fireEvent.mouseDown(screen.getByTestId("outside"));

    await waitFor(() => {
      const patchCall = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) =>
          (c[0] as string).startsWith("/api/acats/") &&
          (c[1] as RequestInit | undefined)?.method === "PATCH"
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(patchCall![1].body);
      expect(body.methodRequested).toBe("API, Full Docusign");
    });
  });
});
