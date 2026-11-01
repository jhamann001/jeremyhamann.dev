import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import AcatDetail from "./AcatDetail";
import { ToastProvider } from "./Toast";
import { mockAcats } from "@/lib/mock-data";
import type { AcatRecord } from "@/lib/types";
import { useClientIdentityStatus } from "@/hooks/use-client-identity-status";

vi.mock("@/hooks/use-client-identity-status", () => ({ useClientIdentityStatus: vi.fn() }));

const sessionState: {
  current: {
    data: { user: { email: string; name: string; role: "ADMIN" | "USER" } };
    status: "authenticated";
  };
} = {
  current: {
    data: {
      user: {
        email: "admin@example.com",
        name: "Admin",
        role: "ADMIN",
      },
    },
    status: "authenticated",
  },
};

vi.mock("next-auth/react", () => ({
  useSession: () => sessionState.current,
}));

function setSessionRole(role: "ADMIN" | "USER") {
  sessionState.current = {
    ...sessionState.current,
    data: {
      ...sessionState.current.data,
      user: { ...sessionState.current.data.user, role },
    },
  };
}

const acat = mockAcats[0]; // Sarah Jenkins

function renderWithProviders(ui: React.ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

describe("AcatDetail", () => {
  const onMutate = vi.fn();

  beforeEach(() => {
    vi.mocked(useClientIdentityStatus).mockReturnValue({ status: { enabled: false, writeEligible: false, health: "UNKNOWN", pendingAccountPolicy: "PENDING_ACCOUNT_OPENING_ONLY", lastSuccessAt: null, sourceAsOf: null }, loading: false, error: null, refresh: vi.fn() });
    onMutate.mockClear();
    setSessionRole("ADMIN");
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(acat),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the client name in the heading", () => {
    renderWithProviders(<AcatDetail acat={acat} onMutate={onMutate} />);
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading).toHaveTextContent("Sarah Jenkins");
  });

  it("replaces arbitrary name editing with controlled relinking for linked records even before cutover", () => {
    renderWithProviders(<AcatDetail acat={{ ...acat, cedarRidgeUserId: "user-synthetic-11111111", identityVersion: 2 }} onMutate={onMutate} />);
    expect(screen.queryByRole("button", { name: "Edit Client Name" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review client link" }));
    expect(screen.getByRole("dialog", { name: "Review client link" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Reason for this change" })).toBeInTheDocument();
  });

  it("shows every joint holder and protects the historical heading when the scalar projection is null", () => {
    const linkedClients = [{ cedarRidgeUserId: "user-synthetic-11111111", displayName: "Alex Example" }, { cedarRidgeUserId: "user-synthetic-22222222", displayName: "Jordan Example" }];
    renderWithProviders(<AcatDetail acat={{ ...acat, clientName: "Historical joint account", cedarRidgeUserId: null, cedarRidgeUserIds: linkedClients.map((client) => client.cedarRidgeUserId), linkedClients, identityVersion: 3 }} onMutate={onMutate} />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Historical joint account");
    expect(screen.getByLabelText("Linked clients")).toHaveTextContent("Alex Example");
    expect(screen.getByLabelText("Linked clients")).toHaveTextContent("Jordan Example");
    expect(screen.queryByText("Needs client link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Client Name" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review link" }));
    expect(within(screen.getByRole("list", { name: "Selected clients" })).getAllByRole("listitem")).toHaveLength(2);
  });

  it("edits and saves the client name from the heading", async () => {
    renderWithProviders(<AcatDetail acat={acat} onMutate={onMutate} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit Client Name" }));
    const input = screen.getByDisplayValue("Sarah Jenkins");
    fireEvent.change(input, { target: { value: "Sara Jenkins" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        `/api/acats/${acat.id}`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ clientName: "Sara Jenkins" }),
        })
      );
    });
    expect(onMutate).toHaveBeenCalled();
  });

  it("cancels a client-name edit without saving", () => {
    renderWithProviders(<AcatDetail acat={acat} onMutate={onMutate} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit Client Name" }));
    const input = screen.getByDisplayValue("Sarah Jenkins");
    fireEvent.change(input, { target: { value: "Sara Jenkins" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "Sarah Jenkins"
    );
    expect(global.fetch).not.toHaveBeenCalledWith(
      `/api/acats/${acat.id}`,
      expect.objectContaining({ method: "PATCH" })
    );
  });

  it("renders breadcrumbs", () => {
    renderWithProviders(<AcatDetail acat={acat} onMutate={onMutate} />);
    expect(screen.getByText("ACATs")).toBeInTheDocument();
    const schwabElements = screen.getAllByText("Charles Schwab");
    expect(schwabElements.length).toBeGreaterThanOrEqual(1);
  });

  it("renders all four tab buttons", () => {
    renderWithProviders(<AcatDetail acat={acat} onMutate={onMutate} />);
    expect(screen.getByText("Transfer Details")).toBeInTheDocument();
    expect(screen.getByText("Security Recon")).toBeInTheDocument();
    expect(screen.getByText("Fees")).toBeInTheDocument();
    expect(screen.getByText("History")).toBeInTheDocument();
  });

  it("renders stat cards", () => {
    renderWithProviders(<AcatDetail acat={acat} onMutate={onMutate} />);
    expect(screen.getByText("Total Assets")).toBeInTheDocument();
    expect(screen.getByText("Issues")).toBeInTheDocument();
    expect(screen.getByText("Days Since Init")).toBeInTheDocument();
  });

  it("renders the notes banner when notes exist", () => {
    renderWithProviders(<AcatDetail acat={acat} onMutate={onMutate} />);
    expect(screen.getByText(/TSLA qty mismatch under review/)).toBeInTheDocument();
  });

  it("renders Mark Complete button for non-matched records", () => {
    renderWithProviders(<AcatDetail acat={acat} onMutate={onMutate} />);
    expect(screen.getByText("Mark Complete")).toBeInTheDocument();
  });

  it("does not render Mark Complete for completed records", () => {
    const completedAcat = mockAcats[1]; // Michael Torres — Completed
    renderWithProviders(<AcatDetail acat={completedAcat} onMutate={onMutate} />);
    expect(screen.queryByText("Mark Complete")).not.toBeInTheDocument();
  });

  it("renders property pills", () => {
    renderWithProviders(<AcatDetail acat={acat} onMutate={onMutate} />);
    const controlNums = screen.getAllByText("CTL-10421");
    expect(controlNums.length).toBeGreaterThanOrEqual(1);
    const apexAccts = screen.getAllByText("APX-1049201");
    expect(apexAccts.length).toBeGreaterThanOrEqual(1);
  });

  it("guides completion and saves the closeout details together", async () => {
    renderWithProviders(<AcatDetail acat={acat} onMutate={onMutate} />);

    fireEvent.click(screen.getByText("Mark Complete"));
    const dialog = screen.getByRole("dialog", { name: "Complete transfer" });
    expect(dialog).toBeInTheDocument();
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.some(
      (call) => call[0] === `/api/acats/${acat.id}` && call[1]?.method === "PATCH"
    )).toBe(false);

    fireEvent.change(within(dialog).getByLabelText(/Apex Completion Date/i), {
      target: { value: "2026-09-09" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm Complete" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        `/api/acats/${acat.id}`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            status: "Completed",
            apexCompletionDate: "2026-09-09",
            controlNumber: acat.controlNumber,
          }),
        })
      );
    });
  });

  it("renders status dropdown with current value", () => {
    renderWithProviders(<AcatDetail acat={acat} onMutate={onMutate} />);
    const select = screen.getByRole("combobox");
    expect(select).toHaveValue("PendingReview");
  });

  it("saves Waiting for Statement from the status dropdown", async () => {
    renderWithProviders(<AcatDetail acat={acat} onMutate={onMutate} />);
    expect(screen.getByRole("option", { name: "Waiting for Statement" })).toHaveValue("WaitingForStatement");
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "WaitingForStatement" },
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        `/api/acats/${acat.id}`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ status: "WaitingForStatement" }),
        })
      );
      expect(onMutate).toHaveBeenCalled();
    });
  });

  it("guides rejection from the status dropdown", async () => {
    renderWithProviders(<AcatDetail acat={acat} onMutate={onMutate} />);
    const select = screen.getByRole("combobox");

    fireEvent.change(select, { target: { value: "Rejected" } });

    const dialog = screen.getByRole("dialog", { name: "Reject transfer" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm Rejection" })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Rejection Reason/i), {
      target: { value: "Contra rejected the request" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm Rejection" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        `/api/acats/${acat.id}`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            status: "Rejected",
            rejectionReason: "Contra rejected the request",
          }),
        })
      );
    });
  });

  // ticket: the per-record "Flag to CS Slack" button was removed in
  // favor of the automated daily digest. The matching `Alert Sent`
  // state is therefore also gone. We assert here that neither label
  // can sneak back into the detail surface.
  it("no longer renders Flag to CS Slack button", () => {
    renderWithProviders(<AcatDetail acat={acat} onMutate={onMutate} />);
    expect(screen.queryByText("Flag to CS Slack")).not.toBeInTheDocument();
    expect(screen.queryByText("Alert Sent")).not.toBeInTheDocument();
  });

  describe("layout=drawer", () => {
    it("hides breadcrumbs in drawer layout", () => {
      renderWithProviders(
        <AcatDetail acat={acat} onMutate={onMutate} layout="drawer" />
      );
      expect(screen.queryByText("ACATs")).not.toBeInTheDocument();
    });

    it("still renders the client heading and all four sections in drawer layout", () => {
      renderWithProviders(
        <AcatDetail acat={acat} onMutate={onMutate} layout="drawer" />
      );
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
        "Sarah Jenkins"
      );
      expect(screen.getByText("Transfer Details")).toBeInTheDocument();
      expect(screen.getByText("Security Recon")).toBeInTheDocument();
      expect(screen.getByText("Fees")).toBeInTheDocument();
      expect(screen.getByText("History")).toBeInTheDocument();
    });

    it("allows the client name to be edited in drawer layout", () => {
      renderWithProviders(
        <AcatDetail acat={acat} onMutate={onMutate} layout="drawer" />
      );
      fireEvent.click(screen.getByRole("button", { name: "Edit Client Name" }));
      expect(screen.getByDisplayValue("Sarah Jenkins")).toBeInTheDocument();
    });

    it("renders all property pills in drawer layout", () => {
      renderWithProviders(
        <AcatDetail acat={acat} onMutate={onMutate} layout="drawer" />
      );
      expect(screen.getAllByText("CTL-10421").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("APX-1049201").length).toBeGreaterThanOrEqual(1);
    });

    it("starts Transfer Details open while keeping History collapsed", () => {
      renderWithProviders(
        <AcatDetail acat={acat} onMutate={onMutate} layout="drawer" />
      );
      // Find the actual section headers by `aria-expanded` (only collapsible
      // section buttons have that attribute) rather than by name regex —
      // InlineField now contributes role="button" pills whose accessible
      // names may overlap with section labels.
      const sectionHeaders = screen
        .getAllByRole("button")
        .filter((b) => b.hasAttribute("aria-expanded"));
      expect(sectionHeaders).toHaveLength(5);
      const transferDetailsHeader = sectionHeaders.find((button) =>
        button.textContent?.trim().startsWith("Transfer Details")
      );
      const securityReconHeader = sectionHeaders.find((button) =>
        button.textContent?.trim().startsWith("Security Recon")
      );
      const feesHeader = sectionHeaders.find((button) =>
        button.textContent?.trim().startsWith("Fees")
      );
      const historyHeader = sectionHeaders.find((button) =>
        button.textContent?.trim().startsWith("History")
      );

      expect(transferDetailsHeader).toHaveAttribute("aria-expanded", "true");
      expect(securityReconHeader).toHaveAttribute("aria-expanded", "true");
      expect(feesHeader).toHaveAttribute("aria-expanded", "true");
      expect(historyHeader).toHaveAttribute("aria-expanded", "false");
    });

    it("collapses and reopens Transfer Details when its header is clicked", () => {
      renderWithProviders(
        <AcatDetail acat={acat} onMutate={onMutate} layout="drawer" />
      );
      const transferDetailsHeader = screen
        .getAllByRole("button")
        .filter((button) => button.hasAttribute("aria-expanded"))
        .find((button) =>
          button.textContent?.trim().startsWith("Transfer Details")
        );
      expect(transferDetailsHeader).toBeDefined();
      expect(transferDetailsHeader!).toHaveAttribute("aria-expanded", "true");
      fireEvent.click(transferDetailsHeader!);
      expect(transferDetailsHeader!).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(transferDetailsHeader!);
      expect(transferDetailsHeader!).toHaveAttribute("aria-expanded", "true");
    });

    it("collapses and re-expands a section when its header is clicked", () => {
      renderWithProviders(
        <AcatDetail acat={acat} onMutate={onMutate} layout="drawer" />
      );
      const feesHeader = screen
        .getAllByRole("button")
        .filter((b) => b.hasAttribute("aria-expanded"))
        .find((b) => b.textContent?.trim().startsWith("Fees"));
      expect(feesHeader).toBeDefined();
      expect(feesHeader!).toHaveAttribute("aria-expanded", "true");
      fireEvent.click(feesHeader!);
      expect(feesHeader!).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(feesHeader!);
      expect(feesHeader!).toHaveAttribute("aria-expanded", "true");
    });

    it("does not render horizontal tab buttons in drawer layout", () => {
      renderWithProviders(
        <AcatDetail acat={acat} onMutate={onMutate} layout="drawer" />
      );
      // Tabs in page mode use an accent-colored active tab (bg-accent-light/50)
      expect(
        document.querySelector(".bg-accent-light\\/50")
      ).not.toBeInTheDocument();
    });
  });

  describe("delete flow", () => {
    it("hides the Delete button for non-admin users", () => {
      setSessionRole("USER");
      renderWithProviders(<AcatDetail acat={acat} onMutate={onMutate} />);
      expect(
        screen.queryByRole("button", { name: /delete acat record/i })
      ).not.toBeInTheDocument();
    });

    it("shows the Delete button for admin users", () => {
      renderWithProviders(<AcatDetail acat={acat} onMutate={onMutate} />);
      expect(
        screen.getByRole("button", { name: /delete acat record/i })
      ).toBeInTheDocument();
    });

    it("opens the confirm modal with the Delete action disabled until a reason is entered", () => {
      renderWithProviders(<AcatDetail acat={acat} onMutate={onMutate} />);

      fireEvent.click(
        screen.getByRole("button", { name: /delete acat record/i })
      );

      const dialog = screen.getByRole("dialog");
      expect(
        within(dialog).getByRole("heading", { name: /delete acat record/i })
      ).toBeInTheDocument();

      const confirmBtn = within(dialog)
        .getAllByRole("button", { name: /^delete$/i })
        .find((el) => (el as HTMLButtonElement).disabled !== undefined) as
        | HTMLButtonElement
        | undefined;
      expect(confirmBtn).toBeDefined();
      expect(confirmBtn!).toBeDisabled();

      fireEvent.change(within(dialog).getByLabelText(/reason/i), {
        target: { value: "hi" },
      });
      expect(confirmBtn!).toBeDisabled();

      fireEvent.change(within(dialog).getByLabelText(/reason/i), {
        target: { value: "client closed account" },
      });
      expect(confirmBtn!).not.toBeDisabled();
    });

    it("calls DELETE with the entered reason and fires onMutate + onDeleted on success", async () => {
      const onDeleted = vi.fn();
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true }),
      });
      global.fetch = fetchMock;

      renderWithProviders(
        <AcatDetail
          acat={acat}
          onMutate={onMutate}
          onDeleted={onDeleted}
        />
      );

      fireEvent.click(
        screen.getByRole("button", { name: /delete acat record/i })
      );
      const dialog = screen.getByRole("dialog");
      fireEvent.change(within(dialog).getByLabelText(/reason/i), {
        target: { value: "client closed account" },
      });
      const confirmBtn = within(dialog)
        .getAllByRole("button", { name: /^delete$/i })
        .find((el) => !(el as HTMLButtonElement).disabled) as HTMLButtonElement;
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          `/api/acats/${acat.id}`,
          expect.objectContaining({
            method: "DELETE",
            body: JSON.stringify({ reason: "client closed account" }),
          })
        );
      });

      await waitFor(() => {
        expect(onMutate).toHaveBeenCalled();
        expect(onDeleted).toHaveBeenCalled();
      });
    });

    it("shows an error toast and does not close the modal when the delete fails", async () => {
      const onDeleted = vi.fn();
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: "Forbidden" }),
      });

      renderWithProviders(
        <AcatDetail
          acat={acat}
          onMutate={onMutate}
          onDeleted={onDeleted}
        />
      );

      fireEvent.click(
        screen.getByRole("button", { name: /delete acat record/i })
      );
      const dialog = screen.getByRole("dialog");
      fireEvent.change(within(dialog).getByLabelText(/reason/i), {
        target: { value: "permission test" },
      });
      const confirmBtn = within(dialog)
        .getAllByRole("button", { name: /^delete$/i })
        .find((el) => !(el as HTMLButtonElement).disabled) as HTMLButtonElement;
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        expect(screen.getByText(/delete failed/i)).toBeInTheDocument();
      });
      expect(onDeleted).not.toHaveBeenCalled();
      // Modal remains open so the admin can see the failure and retry.
      expect(
        within(screen.getByRole("dialog")).getByRole("heading", {
          name: /delete acat record/i,
        })
      ).toBeInTheDocument();
    });
  });

  describe("inline edit (blur-to-save)", () => {
    it("commits a changed wealth advisor on blur", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(acat),
      });
      global.fetch = fetchMock;

      renderWithProviders(<AcatDetail acat={acat} onMutate={onMutate} />);

      fireEvent.click(
        screen.getByRole("button", { name: /edit wealthadvisor/i })
      );
      const input = screen.getByDisplayValue("Jeremy H.") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Tessa O." } });
      fireEvent.blur(input);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          `/api/acats/${acat.id}`,
          expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({ wealthAdvisor: "Tessa O." }),
          })
        );
      });
    });

    it("does NOT call PATCH when blurring without changes", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(acat),
      });
      global.fetch = fetchMock;

      renderWithProviders(<AcatDetail acat={acat} onMutate={onMutate} />);

      fireEvent.click(
        screen.getByRole("button", { name: /edit wealthadvisor/i })
      );
      const input = screen.getByDisplayValue("Jeremy H.") as HTMLInputElement;
      fireEvent.blur(input);

      await waitFor(() => {
        expect(screen.queryByDisplayValue("Jeremy H.")).not.toBeInTheDocument();
      });
      // No advisor PATCHes; only PATCHes from other tests don't exist here.
      const advisorPatches = fetchMock.mock.calls.filter((c) => {
        const body = c[1]?.body;
        return typeof body === "string" && body.includes("wealthAdvisor");
      });
      expect(advisorPatches).toHaveLength(0);
    });

    it("Escape cancels the wealth advisor edit", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(acat),
      });
      global.fetch = fetchMock;

      renderWithProviders(<AcatDetail acat={acat} onMutate={onMutate} />);

      fireEvent.click(
        screen.getByRole("button", { name: /edit wealthadvisor/i })
      );
      const input = screen.getByDisplayValue("Jeremy H.") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "ZZZ" } });
      fireEvent.keyDown(input, { key: "Escape" });

      await waitFor(() => {
        expect(screen.queryByDisplayValue("ZZZ")).not.toBeInTheDocument();
      });
      const advisorPatches = fetchMock.mock.calls.filter((c) => {
        const body = c[1]?.body;
        return typeof body === "string" && body.includes("wealthAdvisor");
      });
      expect(advisorPatches).toHaveLength(0);
    });

    it("commits notes edits on textarea blur", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(acat),
      });
      global.fetch = fetchMock;

      renderWithProviders(<AcatDetail acat={acat} onMutate={onMutate} />);

      fireEvent.click(screen.getByRole("button", { name: /edit notes/i }));
      const textarea = screen.getByDisplayValue(
        /TSLA qty mismatch under review/
      ) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "Updated note" } });
      fireEvent.blur(textarea);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          `/api/acats/${acat.id}`,
          expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({ notes: "Updated note" }),
          })
        );
      });
    });
  });

  describe("issue count derivation", () => {
    // Regression: AcatDetail.stats used to compute matched/issues from the raw
    // qty delta (expectedQty !== actualQty || actualQty === 0), which
    // contradicted SecurityReconTab.saveReconResults — that writes
    // `mapStatus: "Mapped"` for Apex surpluses and manual overrides. The stale
    // predicate kept the red Issues card + Security Recon tab pill lit even
    // after a clean save, so the fix trusts the persisted mapStatus instead.
    it("shows zero Issues for a Mapped surplus asset (mapStatus wins over qty delta)", () => {
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

      renderWithProviders(
        <AcatDetail acat={surplusAcat} onMutate={onMutate} />
      );

      const issuesCard = screen.getByText("Issues").closest("div.rounded-lg");
      expect(issuesCard).not.toBeNull();
      expect(issuesCard).toHaveTextContent(/^Issues0$/);

      const matchedCard = screen
        .getByText("Matched")
        .closest("div.rounded-lg");
      expect(matchedCard).not.toBeNull();
      expect(matchedCard).toHaveTextContent(/^Matched1$/);

      // In page layout the Security Recon tab only renders a numeric pill
      // when stats.issueAssets > 0. A surplus saved as Mapped must not
      // render the pill.
      const reconTabBtn = screen.getByRole("button", {
        name: /Security Recon/i,
      });
      expect(within(reconTabBtn).queryByText(/^\d+$/)).toBeNull();
    });

    it("shows Issues=1 and a `1` pill on the Security Recon tab when an asset is Unmapped", () => {
      const unmappedAcat: AcatRecord = {
        ...acat,
        assets: [
          {
            id: "U1",
            symbol: "MSFT",
            description: "Microsoft Corp.",
            cusip: "594918104",
            expectedQty: 400,
            actualQty: 0,
            mapStatus: "Unmapped",
            issue: "Not found in Apex CSV",
          },
        ],
      };

      renderWithProviders(
        <AcatDetail acat={unmappedAcat} onMutate={onMutate} />
      );

      const issuesCard = screen.getByText("Issues").closest("div.rounded-lg");
      expect(issuesCard).not.toBeNull();
      expect(issuesCard).toHaveTextContent(/^Issues1$/);

      const reconTabBtn = screen.getByRole("button", {
        name: /Security Recon/i,
      });
      expect(within(reconTabBtn).getByText("1")).toBeInTheDocument();
    });
  });

  describe("ticket item 4 — status dropdown excludes recon statuses", () => {
    function getStatusSelectOptions(): string[] {
      // The inline status select is the only <select> next to the status
      // PropertyPill cluster. Just enumerate every option label.
      const selects = document.querySelectorAll("select");
      // The first select with values matching ACAT statuses is the status
      // picker. Find it by checking for "AcatReceived" specifically.
      for (const sel of Array.from(selects)) {
        const values = Array.from(sel.options).map((o) => o.value);
        if (values.includes("AcatReceived")) {
          return Array.from(sel.options).map((o) => o.textContent ?? "");
        }
      }
      throw new Error("Status select not found");
    }

    it("does not render Matched / Mismatch / Pending in the status picker", () => {
      renderWithProviders(<AcatDetail acat={acat} onMutate={onMutate} />);
      const labels = getStatusSelectOptions();
      expect(labels).not.toContain("Recon: Matched");
      expect(labels).not.toContain("Recon: Mismatch");
      expect(labels).not.toContain("Recon: Pending");
      // Lifecycle statuses are still there.
      expect(labels).toContain("ACAT Received");
      expect(labels).toContain("Completed");
    });

    it("re-includes the current status (suffixed with '(legacy)') if a record is still on a retired recon status", () => {
      // Legacy data path: a record was saved with status = "Matched"
      // before this cleanup. The dropdown must still display it so the
      // operator can see what it is and migrate it to a real status.
      const legacyMatched: AcatRecord = { ...acat, status: "Matched" };
      renderWithProviders(
        <AcatDetail acat={legacyMatched} onMutate={onMutate} />
      );
      const labels = getStatusSelectOptions();
      expect(labels).toContain("Recon: Matched (legacy)");
      // Only the record's own legacy status is offered; the other two
      // recon statuses stay out of the picker.
      expect(labels).not.toContain("Recon: Mismatch (legacy)");
      expect(labels).not.toContain("Recon: Pending (legacy)");
      expect(labels).not.toContain("Recon: Mismatch");
      expect(labels).not.toContain("Recon: Pending");
    });
  });
});
