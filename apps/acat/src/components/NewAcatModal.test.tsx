import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import NewAcatModal from "./NewAcatModal";
import { defaultResidualFollowUpDate } from "@/lib/acat-operational-defaults";
import { mockAcats } from "@/lib/mock-data";
import { useClientIdentityStatus } from "@/hooks/use-client-identity-status";
import type { ClientDirectoryStatus } from "@/lib/client-identity-contract";

vi.mock("@/hooks/use-client-identity-status", () => ({ useClientIdentityStatus: vi.fn() }));
const legacyDirectory: ClientDirectoryStatus = { enabled: false, writeEligible: false, health: "UNKNOWN", pendingAccountPolicy: "PENDING_ACCOUNT_OPENING_ONLY", lastSuccessAt: null, sourceAsOf: null };
const freshDirectory: ClientDirectoryStatus = { ...legacyDirectory, enabled: true, writeEligible: true, health: "FRESH" };

vi.mock("./Toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

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

function makeFetchMock(overrides?: {
  postCustodian?: (name: string) => Promise<unknown>;
}) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/custodians" && (!init || init.method === undefined || init.method === "GET")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockCustodians),
      });
    }
    if (url === "/api/custodians" && init?.method === "POST") {
      const body = JSON.parse((init.body as string) ?? "{}");
      if (overrides?.postCustodian) {
        return overrides.postCustodian(body.name).then((data) => ({
          ok: true,
          json: () => Promise.resolve(data),
        }));
      }
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
        json: () => Promise.resolve({
          status: "suggested",
          dtccNumber: "0226",
          source: "history",
          historicalSampleSize: 3,
        }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ id: "REC-099" }),
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.mocked(useClientIdentityStatus).mockReturnValue({ status: legacyDirectory, loading: false, error: null, refresh: vi.fn() });
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

describe("NewAcatModal client identity", () => {
  const client = { cedarRidgeUserId: "user-synthetic-00000001", displayName: "Alex Example", accountHints: [{ maskedAccountNumber: "****1234", custodian: "Apex", relationshipType: "PRIMARY" }] };

  function setupIdentity(response?: { ok: boolean; status: number; body: object }, directoryClient = client, existingRecords = [] as typeof mockAcats, additionalClients: typeof client[] = []) {
    vi.mocked(useClientIdentityStatus).mockReturnValue({ status: freshDirectory, loading: false, error: null, refresh: vi.fn() });
    const legacyFetch = makeFetchMock();
    const fetchMock = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (url === "/api/clients/search") return Promise.resolve({ ok: true, json: async () => ({ items: [directoryClient, ...additionalClients], hasMore: false, directory: freshDirectory }) });
      if (url === "/api/acats" && init?.method === "POST" && response) return Promise.resolve({ ok: response.ok, status: response.status, json: async () => response.body });
      return legacyFetch(url, init);
    });
    global.fetch = fetchMock as typeof fetch;
    render(<NewAcatModal onClose={vi.fn()} onCreated={vi.fn()} existingRecords={existingRecords} />);
    chooseAcatWorkflow();
    const direction = screen.getAllByRole("combobox").find((input) => input.textContent?.includes("Select direction"));
    fireEvent.change(direction!, { target: { value: "In" } });
    return fetchMock;
  }

  async function selectClient() {
    fireEvent.change(screen.getByRole("combobox", { name: "Search client name" }), { target: { value: "Alex" } });
    fireEvent.click(await screen.findByRole("option", { name: /Alex Example/ }));
  }

  it("submits the selected ID and full manual account number, never the masked hint", async () => {
    const fetchMock = setupIdentity();
    await selectClient();
    fireEvent.change(screen.getByPlaceholderText("e.g. APX-1049201"), { target: { value: "001234" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Transfer" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/acats" && init?.method === "POST")).toBe(true));
    const call = fetchMock.mock.calls.find(([url, init]) => url === "/api/acats" && init?.method === "POST")!;
    const payload = JSON.parse(call[1]!.body as string);
    expect(payload).toMatchObject({ cedarRidgeUserIds: [client.cedarRidgeUserId], apexAccountId: "001234" });
    expect(payload).not.toHaveProperty("clientName");
  });

  it("submits long directory names by ID without applying the legacy name limit", async () => {
    const longClient = { ...client, displayName: "Alex Example " + "Long name ".repeat(18) };
    const fetchMock = setupIdentity(undefined, longClient);
    await selectClient();
    fireEvent.change(screen.getByPlaceholderText("e.g. APX-1049201"), { target: { value: "001234" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Transfer" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/acats" && init?.method === "POST")).toBe(true));
    const call = fetchMock.mock.calls.find(([url, init]) => url === "/api/acats" && init?.method === "POST")!;
    expect(JSON.parse(call[1]!.body as string)).not.toHaveProperty("clientName");
  });

  it("warns on the same selected client ID even when the historical name differs", async () => {
    setupIdentity(undefined, client, [{ ...mockAcats[0], clientName: "Historical spelling", cedarRidgeUserId: client.cedarRidgeUserId, apexAccountId: "001234" }]);
    await selectClient();
    fireEvent.change(screen.getByPlaceholderText("e.g. APX-1049201"), { target: { value: "001234" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Transfer" }));
    expect(screen.getByRole("alertdialog", { name: "Possible duplicate transfer" })).toBeInTheDocument();
    expect(screen.getByText("Same client and Apex account")).toBeInTheDocument();
  });

  it("blocks typed-only names and preserves explicit selections while searching for another person", async () => {
    const fetchMock = setupIdentity();
    fireEvent.change(screen.getByPlaceholderText("e.g. APX-1049201"), { target: { value: "001234" } });
    const input = screen.getByRole("combobox", { name: "Search client name" });
    fireEvent.change(input, { target: { value: "Alex" } });
    await screen.findByRole("option", { name: /Alex Example/ });
    expect(screen.getByRole("button", { name: "Create Transfer" })).toBeDisabled();
    fireEvent.click(screen.getByRole("option", { name: /Alex Example/ }));
    expect(screen.getByRole("button", { name: "Create Transfer" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Add another person" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Search client name" }), { target: { value: "Someone else" } });
    expect(screen.getByRole("button", { name: "Create Transfer" })).toBeEnabled();
    expect(within(screen.getByRole("list", { name: "Selected clients" })).getByText("Alex Example")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/acats" && init?.method === "POST")).toBe(false);
  });

  it("allows a blank account only while account opening is pending", async () => {
    setupIdentity();
    await selectClient();
    const status = screen.getAllByRole("combobox").find((input) => input.textContent?.includes("Pending Account Opening"));
    expect(screen.getByRole("button", { name: "Create Transfer" })).toBeDisabled();
    fireEvent.change(status!, { target: { value: "PendingAccountOpening" } });
    expect(screen.getByRole("button", { name: "Create Transfer" })).toBeEnabled();
    expect(screen.getByText(/Leave blank until the account opens/)).toBeInTheDocument();
    fireEvent.change(status!, { target: { value: "Submitted" } });
    expect(screen.getByRole("button", { name: "Create Transfer" })).toBeDisabled();
  });

  it("submits both explicit people by ID and requires an account even while opening is pending", async () => {
    const joint = { ...client, cedarRidgeUserId: "user-synthetic-00000002", displayName: "Jordan Example" };
    const fetchMock = setupIdentity(undefined, client, [], [joint]);
    await selectClient();
    const status = screen.getAllByRole("combobox").find((input) => input.textContent?.includes("Pending Account Opening"));
    fireEvent.change(status!, { target: { value: "PendingAccountOpening" } });
    expect(screen.getByRole("button", { name: "Create Transfer" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Add another person" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Search client name" }), { target: { value: "Jordan" } });
    fireEvent.click(await screen.findByRole("option", { name: /Jordan Example/ }));
    expect(screen.getByRole("button", { name: "Create Transfer" })).toBeDisabled();
    expect(screen.getByText(/verified joint holders/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("e.g. APX-1049201"), { target: { value: "001234" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Transfer" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/acats" && init?.method === "POST")).toBe(true));
    const call = fetchMock.mock.calls.find(([url, init]) => url === "/api/acats" && init?.method === "POST")!;
    const body = JSON.parse(call[1]!.body as string);
    expect(body.cedarRidgeUserIds).toEqual([client.cedarRidgeUserId, joint.cedarRidgeUserId]);
    expect(body).not.toHaveProperty("clientName");
    expect(body).not.toHaveProperty("cedarRidgeUserId");
  });

  it("surfaces an account-membership rejection without closing the form", async () => {
    setupIdentity({ ok: false, status: 422, body: { code: "ACCOUNT_NOT_LINKED", error: "This account is not linked to the selected client." } });
    await selectClient();
    fireEvent.change(screen.getByPlaceholderText("e.g. APX-1049201"), { target: { value: "009999" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Transfer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This account is not linked");
    expect(screen.getByText("New Transfer Record")).toBeInTheDocument();
  });
});

function chooseAcatWorkflow() {
  const workflow = screen.getAllByRole("combobox").find((select) =>
    select.textContent?.includes("ACAT (API)")
  );
  expect(workflow).toBeTruthy();
  fireEvent.change(workflow!, { target: { value: "ACAT" } });
}

describe("NewAcatModal", () => {
  const onClose = vi.fn();
  const onCreated = vi.fn();

  it("renders the modal with header", () => {
    render(<NewAcatModal onClose={onClose} onCreated={onCreated} />);
    expect(screen.getByText("New Transfer Record")).toBeInTheDocument();
    const workflow = screen.getAllByRole("combobox").find((select) =>
      select.textContent?.includes("ACAT (API)")
    );
    expect(workflow).toHaveTextContent("DRS");
  });

  it("shows the Core Info section open by default", () => {
    render(<NewAcatModal onClose={onClose} onCreated={onCreated} />);
    expect(screen.getByPlaceholderText("e.g. Sarah Jenkins")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("e.g. 12345")).toBeInTheDocument();
  });

  it.each(["workflow", "type"])("places both control numbers side by side when %s selects a residual", (selection) => {
    render(<NewAcatModal onClose={onClose} onCreated={onCreated} />);
    const client = screen.getByPlaceholderText("e.g. Sarah Jenkins");
    const control = screen.getByPlaceholderText("e.g. 12345");
    const type = screen.getAllByRole("combobox").find((select) => select.textContent?.includes("Select type..."))!;
    const workflow = screen.getAllByRole("combobox").find((select) => select.textContent?.includes("ACAT (API)"))!;
    expect(screen.queryByPlaceholderText("e.g. 67890")).not.toBeInTheDocument();
    expect(client.parentElement).not.toHaveClass("col-span-2");
    fireEvent.change(control, { target: { value: "CURRENT-123" } });
    fireEvent.change(selection === "workflow" ? workflow : type, {
      target: { value: selection === "workflow" ? "RESIDUAL" : "Residual Credit" },
    });

    const associated = screen.getByPlaceholderText("e.g. 67890");
    const controlRow = control.parentElement!.parentElement!;
    expect(controlRow).toHaveClass("grid", "grid-cols-2");
    expect(client.parentElement).toHaveClass("col-span-2");
    expect(associated.parentElement!.parentElement).toBe(controlRow);
    expect(control.parentElement!.nextElementSibling).toBe(associated.parentElement);
    expect(control).toHaveValue("CURRENT-123");
    fireEvent.change(associated, { target: { value: "ORIGINAL-456" } });

    fireEvent.change(type, { target: { value: "Full" } });
    expect(screen.queryByPlaceholderText("e.g. 67890")).not.toBeInTheDocument();
    expect(client.parentElement).not.toHaveClass("col-span-2");
    fireEvent.change(workflow, { target: { value: "RESIDUAL" } });
    expect(screen.getByPlaceholderText("e.g. 67890")).toHaveValue("ORIGINAL-456");
    expect(control).toHaveValue("CURRENT-123");
  });

  it("has all five accordion sections (fees removed)", async () => {
    render(<NewAcatModal onClose={onClose} onCreated={onCreated} />);
    await waitFor(() => {
      const html = document.body.innerHTML;
      expect(html).toContain("Core Info");
      expect(html).toContain("Accounts &amp; Transfer");
      expect(html).toContain("Dates");
      expect(html).toContain("Tickets &amp; Resources");
      expect(html).toContain("Notes &amp; Other");
      expect(html).not.toContain(">Fees<");
    });
  });

  it("no longer renders the legacy Delivering Custodian dropdown", async () => {
    render(<NewAcatModal onClose={onClose} onCreated={onCreated} />);
    await waitFor(() =>
      expect(screen.queryByText(/Delivering Custodian/i)).not.toBeInTheDocument()
    );
  });

  it("starts required sections open and expands optional sections on click", () => {
    render(<NewAcatModal onClose={onClose} onCreated={onCreated} />);
    expect(screen.getByPlaceholderText("e.g. APX-1049201")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("e.g. TRQ-12345")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Tickets & Resources"));
    expect(screen.getByPlaceholderText("e.g. TRQ-12345")).toBeInTheDocument();
  });

  it("disables Create button when required fields are empty", () => {
    render(<NewAcatModal onClose={onClose} onCreated={onCreated} />);
    const createButton = screen.getByRole("button", { name: /create transfer/i });
    expect(createButton).toBeDisabled();
    expect(screen.getByText("Still needed: Client Name, Direction, Transfer Workflow, Apex Account #")).toBeInTheDocument();
  });

  it("enables Create button when required fields are filled", () => {
    render(<NewAcatModal onClose={onClose} onCreated={onCreated} />);

    fireEvent.change(screen.getByPlaceholderText("e.g. Sarah Jenkins"), {
      target: { value: "Test Client" },
    });

    const selects = screen.getAllByRole("combobox");
    const directionSelect = selects.find(
      (el) => el.querySelector("option")?.textContent === "Select direction..."
    ) ?? selects[0];
    fireEvent.change(directionSelect, { target: { value: "In" } });
    chooseAcatWorkflow();

    fireEvent.change(screen.getByPlaceholderText("e.g. APX-1049201"), {
      target: { value: "APX-0000001" },
    });

    const createButton = screen.getByRole("button", { name: /create transfer/i });
    expect(createButton).not.toBeDisabled();
    expect(screen.getByText("All required fields are complete")).toBeInTheDocument();
  });

  it("asks before discarding an edited draft", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<NewAcatModal onClose={onClose} onCreated={onCreated} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. Sarah Jenkins"), {
      target: { value: "Unfinished Client" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirm).toHaveBeenCalledWith(
      "Discard this unfinished transfer? Your entries will be lost."
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("warns about a possible duplicate before creating and allows an override", async () => {
    const fetchSpy = makeFetchMock();
    global.fetch = fetchSpy;
    render(
      <NewAcatModal
        onClose={onClose}
        onCreated={onCreated}
        existingRecords={mockAcats}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("e.g. Sarah Jenkins"), {
      target: { value: "Sarah Jenkins" },
    });
    fireEvent.change(screen.getAllByRole("combobox")[0], {
      target: { value: "In" },
    });
    chooseAcatWorkflow();
    fireEvent.change(screen.getByPlaceholderText("e.g. APX-1049201"), {
      target: { value: "APX-1049201" },
    });

    fireEvent.click(screen.getByRole("button", { name: /create transfer/i }));
    expect(screen.getByRole("alertdialog", { name: "Possible duplicate transfer" })).toBeInTheDocument();
    expect(screen.getByText("Same client and Apex account")).toBeInTheDocument();
    expect((fetchSpy as ReturnType<typeof vi.fn>).mock.calls.some(
      (call) => call[0] === "/api/acats" && call[1]?.method === "POST"
    )).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Create Anyway" }));
    await waitFor(() => expect((fetchSpy as ReturnType<typeof vi.fn>).mock.calls.some(
      (call) => call[0] === "/api/acats" && call[1]?.method === "POST"
    )).toBe(true));
  });

  it("creates a transfer without a duplicate warning when only the N/A ID matches", async () => {
    const fetchSpy = makeFetchMock();
    global.fetch = fetchSpy;
    render(
      <NewAcatModal
        onClose={onClose}
        onCreated={onCreated}
        existingRecords={[{ ...mockAcats[0], acatTransferId: "N/A" }]}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("e.g. Sarah Jenkins"), {
      target: { value: mockAcats[0].clientName },
    });
    fireEvent.change(screen.getAllByRole("combobox")[0], {
      target: { value: "Out" },
    });
    const workflow = screen.getAllByRole("combobox").find((select) =>
      select.textContent?.includes("ACAT (API)")
    );
    fireEvent.change(workflow!, { target: { value: "RESIDUAL" } });
    fireEvent.change(screen.getByPlaceholderText("e.g. APX-1049201"), {
      target: { value: "DIFFERENT-ACCOUNT" },
    });
    fireEvent.change(screen.getByPlaceholderText("e.g. TRN-9812"), {
      target: { value: "N/A" },
    });

    fireEvent.click(screen.getByRole("button", { name: /create transfer/i }));

    expect(screen.queryByRole("alertdialog", {
      name: "Possible duplicate transfer",
    })).not.toBeInTheDocument();
    await waitFor(() => {
      const post = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls.find(
        (call) => call[0] === "/api/acats" && call[1]?.method === "POST"
      );
      expect(post).toBeDefined();
      expect(JSON.parse(post![1].body)).toEqual(expect.objectContaining({
        acatTransferId: "N/A",
        transferWorkflow: "RESIDUAL",
      }));
    });
  });

  it.each(["", "Full", "Partial"])("sets type to Residual Credit from %s and saves a separate residual without an account warning", async (previousType) => {
    const fetchSpy = makeFetchMock();
    global.fetch = fetchSpy;
    const previous = { ...mockAcats[0], status: "Completed" as const, acatTransferId: "N/A" };
    render(<NewAcatModal onClose={onClose} onCreated={onCreated} existingRecords={[previous]} />);

    fireEvent.change(screen.getByPlaceholderText("e.g. Sarah Jenkins"), { target: { value: previous.clientName } });
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "Out" } });
    chooseAcatWorkflow();
    const type = screen.getAllByRole("combobox").find((select) => select.textContent?.includes("Select type..."))!;
    fireEvent.change(type, { target: { value: previousType } });
    const workflow = screen.getAllByRole("combobox").find((select) => select.textContent?.includes("ACAT (API)"))!;
    fireEvent.change(workflow, { target: { value: "RESIDUAL" } });
    expect(type).toHaveValue("Residual Credit");
    expect(workflow).toHaveValue("RESIDUAL");
    expect(screen.getByPlaceholderText("e.g. 67890")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("e.g. APX-1049201"), { target: { value: previous.apexAccountId } });
    fireEvent.change(screen.getByPlaceholderText("e.g. 987654321"), { target: { value: previous.statementAccountNumber } });
    fireEvent.change(screen.getByPlaceholderText("e.g. TRN-9812"), { target: { value: "N/A" } });
    fireEvent.change(screen.getByPlaceholderText("e.g. 12345"), { target: { value: "NEW-RESIDUAL" } });
    fireEvent.change(screen.getByPlaceholderText("e.g. 67890"), { target: { value: "ORIGINAL-TRANSFER" } });
    fireEvent.click(screen.getByRole("button", { name: /create transfer/i }));
    expect(screen.queryByRole("alertdialog", { name: "Possible duplicate transfer" })).not.toBeInTheDocument();
    await waitFor(() => {
      const post = vi.mocked(fetchSpy).mock.calls.find((call) => call[0] === "/api/acats" && call[1]?.method === "POST");
      expect(post).toBeDefined();
      expect(JSON.parse(post![1]!.body as string)).toMatchObject({
        type: "Residual Credit", transferWorkflow: "RESIDUAL", residualMonitoringRequired: false,
        controlNumber: "NEW-RESIDUAL", associatedControlNumber: "ORIGINAL-TRANSFER",
      });
    });
  });

  it.each([
    ["e.g. 12345", "Same control number"],
    ["e.g. TRN-9812", "Same ACAT transfer ID"],
  ])("keeps the residual duplicate warning for %s", (placeholder, reason) => {
    const existing = { ...mockAcats[0], controlNumber: "REAL-123", acatTransferId: "REAL-123" };
    render(<NewAcatModal onClose={onClose} onCreated={onCreated} existingRecords={[existing]} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. Sarah Jenkins"), { target: { value: existing.clientName } });
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "Out" } });
    const workflow = screen.getAllByRole("combobox").find((select) => select.textContent?.includes("ACAT (API)"))!;
    fireEvent.change(workflow, { target: { value: "RESIDUAL" } });
    fireEvent.change(screen.getByPlaceholderText("e.g. APX-1049201"), { target: { value: existing.apexAccountId } });
    fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value: "REAL-123" } });
    fireEvent.click(screen.getByRole("button", { name: /create transfer/i }));
    expect(screen.getByRole("alertdialog", { name: "Possible duplicate transfer" })).toBeInTheDocument();
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(screen.queryByText("Same client and Apex account")).not.toBeInTheDocument();
  });

  it("allows changing the type back from Residual Credit without trapping the workflow", () => {
    render(<NewAcatModal onClose={onClose} onCreated={onCreated} />);
    const workflow = screen.getAllByRole("combobox").find((select) => select.textContent?.includes("ACAT (API)"))!;
    const type = screen.getAllByRole("combobox").find((select) => select.textContent?.includes("Select type..."))!;
    fireEvent.change(workflow, { target: { value: "RESIDUAL" } });
    fireEvent.change(type, { target: { value: "Full" } });
    expect(workflow).toHaveValue("UNCLASSIFIED");
    expect(workflow).not.toBeDisabled();
    chooseAcatWorkflow();
    expect(type).toHaveValue("Full");
  });

  it("offers inherited account types when creating an ACAT", async () => {
    render(<NewAcatModal onClose={onClose} onCreated={onCreated} />);

    const accountTypeSelect = screen
      .getAllByRole("combobox")
      .find((select) =>
        select.textContent?.includes("Inherited Traditional IRA (w/ beneficiaries)")
      );

    await waitFor(() => {
      expect(accountTypeSelect).toBeTruthy();
      expect(accountTypeSelect).toHaveTextContent("Inherited Roth IRA");
      expect(accountTypeSelect).toHaveTextContent(
        "Inherited Traditional IRA (w/ beneficiaries)"
      );
    });
  });

  it("calls onClose when Cancel is clicked", () => {
    render(<NewAcatModal onClose={onClose} onCreated={onCreated} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("submits dtccNumber as a string to preserve leading zeros", async () => {
    const fetchSpy = makeFetchMock();
    global.fetch = fetchSpy;

    render(<NewAcatModal onClose={onClose} onCreated={onCreated} />);

    fireEvent.change(screen.getByPlaceholderText("e.g. Sarah Jenkins"), {
      target: { value: "DTCC Test" },
    });
    const directionSelect = screen.getAllByRole("combobox")[0];
    fireEvent.change(directionSelect, { target: { value: "In" } });
    chooseAcatWorkflow();

    fireEvent.change(screen.getByPlaceholderText("e.g. APX-1049201"), {
      target: { value: "APX-DTCC" },
    });
    fireEvent.change(screen.getByPlaceholderText("e.g. 0188"), {
      target: { value: "0188" },
    });

    fireEvent.click(screen.getByRole("button", { name: /create transfer/i }));

    await waitFor(() => {
      const postCall = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) =>
          (c[0] as string) === "/api/acats" &&
          (c[1] as RequestInit | undefined)?.method === "POST"
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall![1].body);
      expect(body.dtccNumber).toBe("0188");
      expect(typeof body.dtccNumber).toBe("string");
    });
  });

  it("suggests DTC from consistent contra history", async () => {
    render(<NewAcatModal onClose={onClose} onCreated={onCreated} />);
    const contraInput = screen.getByPlaceholderText("e.g. Charles Schwab");
    fireEvent.focus(contraInput);
    fireEvent.mouseDown(await screen.findByText("Fidelity"));

    await waitFor(() => expect(screen.getByPlaceholderText("e.g. 0188")).toHaveValue("0226"));
    expect(screen.getByText(/Suggested 0226/)).toBeInTheDocument();
  });

  it("formats outgoing statement amounts as negative dollars with cents", async () => {
    const fetchSpy = makeFetchMock();
    global.fetch = fetchSpy;
    render(<NewAcatModal onClose={onClose} onCreated={onCreated} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. Sarah Jenkins"), { target: { value: "Outgoing" } });
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "Out" } });
    chooseAcatWorkflow();
    fireEvent.change(screen.getByPlaceholderText("e.g. APX-1049201"), { target: { value: "APX-OUT" } });
    const amount = screen.getByPlaceholderText("e.g. $50,000.00");
    fireEvent.change(amount, { target: { value: "1234.5" } });
    fireEvent.blur(amount);
    expect(amount).toHaveValue("-$1,234.50");
    fireEvent.click(screen.getByRole("button", { name: /create transfer/i }));

    await waitFor(() => {
      const postCall = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => (c[0] as string) === "/api/acats" && (c[1] as RequestInit | undefined)?.method === "POST"
      );
      expect(JSON.parse(postCall![1].body).statementAmount).toBe(-123450);
    });
  });

  it("shows the fee check and defaults residual monitoring for a full ACAT Out", () => {
    render(<NewAcatModal onClose={onClose} onCreated={onCreated} />);
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "Out" } });
    const typeSelect = screen.getAllByRole("combobox").find((select) =>
      select.textContent?.includes("Residual Credit") && select.textContent?.includes("Partial")
    );
    expect(typeSelect).toBeTruthy();
    fireEvent.change(typeSelect!, { target: { value: "Full" } });

    expect(screen.getByText("Outgoing ACAT fee check required")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Dates"));
    expect(screen.getByRole("checkbox", { name: "Monitor for a residual sweep" })).toBeChecked();
    expect(screen.getByDisplayValue(defaultResidualFollowUpDate())).toBeInTheDocument();
  });

  it("only prompts for a rejection reason when status is Rejected", () => {
    render(<NewAcatModal onClose={onClose} onCreated={onCreated} />);
    expect(screen.queryByPlaceholderText("Why was this transfer rejected?")).not.toBeInTheDocument();

    const statusSelect = screen.getAllByRole("combobox").find((select) =>
      Array.from((select as HTMLSelectElement).options).some((option) => option.value === "Rejected")
    );
    expect(statusSelect).toBeTruthy();
    fireEvent.change(statusSelect!, { target: { value: "Rejected" } });

    expect(screen.getByPlaceholderText("Why was this transfer rejected?")).toBeInTheDocument();
    expect(screen.getByText(/Still needed:.*Rejection Reason/)).toBeInTheDocument();
  });

  it("submits trade request fields in the create payload", async () => {
    const fetchSpy = makeFetchMock();
    global.fetch = fetchSpy;

    render(<NewAcatModal onClose={onClose} onCreated={onCreated} />);

    fireEvent.change(screen.getByPlaceholderText("e.g. Sarah Jenkins"), {
      target: { value: "Trade Request Client" },
    });
    const directionSelect = screen.getAllByRole("combobox")[0];
    fireEvent.change(directionSelect, { target: { value: "In" } });
    chooseAcatWorkflow();

    fireEvent.change(screen.getByPlaceholderText("e.g. APX-1049201"), {
      target: { value: "APX-TRADE" },
    });

    fireEvent.click(screen.getByText("Tickets & Resources"));
    fireEvent.change(screen.getByPlaceholderText("e.g. TRQ-12345"), {
      target: { value: "TRQ-456" },
    });
    fireEvent.change(screen.getByPlaceholderText("https://..."), {
      target: { value: "https://trades.example.com/requests/TRQ-456" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("e.g. Liquidate on receipt, hold in kind, or follow asset map"),
      { target: { value: "Liquidate on receipt" } }
    );

    fireEvent.click(screen.getByRole("button", { name: /create transfer/i }));

    await waitFor(() => {
      const postCall = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) =>
          (c[0] as string) === "/api/acats" &&
          (c[1] as RequestInit | undefined)?.method === "POST"
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall![1].body);
      expect(body.tradeRequestId).toBe("TRQ-456");
      expect(body.tradeRequestUrl).toBe(
        "https://trades.example.com/requests/TRQ-456"
      );
      expect(body.tradeInstructions).toBe("Liquidate on receipt");
    });
  });

  it("submits transferringContra and does NOT include legacy custodianId/custodianName", async () => {
    const fetchSpy = makeFetchMock();
    global.fetch = fetchSpy;

    render(<NewAcatModal onClose={onClose} onCreated={onCreated} />);

    fireEvent.change(screen.getByPlaceholderText("e.g. Sarah Jenkins"), {
      target: { value: "Test Client" },
    });
    const directionSelect = screen.getAllByRole("combobox")[0];
    fireEvent.change(directionSelect, { target: { value: "In" } });
    chooseAcatWorkflow();

    fireEvent.change(screen.getByPlaceholderText("e.g. APX-1049201"), {
      target: { value: "APX-TEST" },
    });

    // Open the contra combobox and pick Fidelity
    const contraInput = screen.getByPlaceholderText("e.g. Charles Schwab");
    fireEvent.focus(contraInput);
    fireEvent.mouseDown(await screen.findByText("Fidelity"));

    fireEvent.click(screen.getByRole("button", { name: /create transfer/i }));

    await waitFor(() => {
      const postCall = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) =>
          (c[0] as string) === "/api/acats" &&
          (c[1] as RequestInit | undefined)?.method === "POST"
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall![1].body);
      expect(body.clientName).toBe("Test Client");
      expect(body.apexAccountId).toBe("APX-TEST");
      expect(body.direction).toBe("In");
      expect(body.transferringContra).toBe("Fidelity");
      expect(body.custodianId).toBeUndefined();
      expect(body.custodianName).toBeUndefined();
    });
  });

  it("admin can add a new contra through the combobox", async () => {
    const fetchSpy = makeFetchMock();
    global.fetch = fetchSpy;

    render(<NewAcatModal onClose={onClose} onCreated={onCreated} />);

    const contraInput = screen.getByPlaceholderText("e.g. Charles Schwab");
    fireEvent.focus(contraInput);
    fireEvent.change(contraInput, { target: { value: "Raymond James" } });

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

    await waitFor(() => {
      expect(
        (contraInput as HTMLInputElement).value
      ).toBe("Raymond James");
    });
  });

  it("does NOT show the Add new row for non-admin users", async () => {
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

    render(<NewAcatModal onClose={onClose} onCreated={onCreated} />);

    const contraInput = screen.getByPlaceholderText("e.g. Charles Schwab");
    fireEvent.focus(contraInput);
    fireEvent.change(contraInput, { target: { value: "Raymond James" } });

    expect(
      screen.queryByText(/Add "Raymond James" as a new contra/i)
    ).not.toBeInTheDocument();
  });

  it("status picker excludes the recon-derived statuses (ticket item 4)", async () => {
    render(<NewAcatModal onClose={onClose} onCreated={onCreated} />);

    // The Status field is a native <select>; find it by checking which one
    // contains AcatReceived (the default for new ACATs).
    const selects = Array.from(document.querySelectorAll("select"));
    const statusSelect = selects.find((sel) =>
      Array.from(sel.options).some((o) => o.value === "AcatReceived")
    );
    expect(statusSelect).toBeTruthy();

    const labels = Array.from(statusSelect!.options).map(
      (o) => o.textContent ?? ""
    );
    expect(labels).not.toContain("Recon: Matched");
    expect(labels).not.toContain("Recon: Mismatch");
    expect(labels).not.toContain("Recon: Pending");
    // Sanity: a representative lifecycle status survives.
    expect(labels).toContain("ACAT Received");
    expect(labels).toContain("Completed");
  });
});
