import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import RecordsView from "./RecordsView";
import { ToastProvider } from "./Toast";
import { mockAcats } from "@/lib/mock-data";

const sessionState: {
  current: {
    data: { user: { email: string; name: string; role: "ADMIN" | "USER" } };
    status: "authenticated";
  };
} = {
  current: {
    data: {
      user: {
        email: "jeremy@example.com",
        name: "Jeremy H.",
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

function renderWithProviders(ui: React.ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

const mockStorage: Record<string, string> = {};

beforeEach(() => {
  setSessionRole("ADMIN");
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
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-15T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RecordsView", () => {
  it("renders records grouped by status", () => {
    const { container } = render(
      <RecordsView
        acats={mockAcats}
        loading={false}
        error={null}
        selectedId={null}
        onOpenRecord={vi.fn()}
        onRefresh={vi.fn()}
      />
    );
    // Sarah Jenkins is PendingReview; Michael Torres is Completed
    expect(
      container.querySelector('section[data-status="PendingReview"]')
    ).not.toBeNull();
    expect(screen.getByText("Sarah Jenkins")).toBeInTheDocument();
    // Completed group exists but is collapsed by default, so Michael shouldn't render
    expect(
      container.querySelector('section[data-status="Completed"]')
    ).not.toBeNull();
    expect(screen.queryByText("Michael Torres")).not.toBeInTheDocument();
  });

  it("narrows records via search", () => {
    render(
      <RecordsView
        acats={mockAcats}
        loading={false}
        error={null}
        selectedId={null}
        onOpenRecord={vi.fn()}
        onRefresh={vi.fn()}
      />
    );
    const input = screen.getByPlaceholderText(/Search name/);
    fireEvent.change(input, { target: { value: "Sarah" } });
    expect(screen.getByText("Sarah Jenkins")).toBeInTheDocument();
    expect(screen.queryByText("Angela Whitfield")).not.toBeInTheDocument();
  });

  it("finds a historical joint record by either person's ID or canonical name", () => {
    const linkedClients = [{ cedarRidgeUserId: "user-synthetic-11111111", displayName: "Alex Example" }, { cedarRidgeUserId: "user-synthetic-22222222", displayName: "Jordan Example" }];
    render(<RecordsView acats={[{ ...mockAcats[0], clientName: "Historical joint account", cedarRidgeUserId: null, cedarRidgeUserIds: linkedClients.map((client) => client.cedarRidgeUserId), linkedClients }]} loading={false} error={null} selectedId={null} onOpenRecord={vi.fn()} onRefresh={vi.fn()} />);
    const input = screen.getByPlaceholderText(/Search name/);
    for (const query of ["Alex Example", "Jordan Example", "11111111", "22222222"]) {
      fireEvent.change(input, { target: { value: query } });
      expect(screen.getByText("Historical joint account")).toBeInTheDocument();
    }
    fireEvent.change(input, { target: { value: "Not a linked client" } });
    expect(screen.queryByText("Historical joint account")).not.toBeInTheDocument();
  });

  it("hides terminal statuses when Active filter is selected", () => {
    render(
      <RecordsView
        acats={mockAcats}
        loading={false}
        error={null}
        selectedId={null}
        onOpenRecord={vi.fn()}
        onRefresh={vi.fn()}
      />
    );
    const activeChip = screen.getByRole("button", { name: /^Active/ });
    fireEvent.click(activeChip);
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
  });

  it("filters to full and partial transfers with missing trade instructions", () => {
    const records = [
      { ...mockAcats[0], id: "MISSING", clientName: "Needs Instructions", type: "Full", tradeInstructions: "" },
      { ...mockAcats[0], id: "READY", clientName: "Has Instructions", type: "Partial", tradeInstructions: "Hold in kind" },
      { ...mockAcats[0], id: "RESIDUAL", clientName: "Residual Transfer", type: "Residual Credit", tradeInstructions: "" },
    ];
    render(
      <RecordsView
        acats={records}
        loading={false}
        error={null}
        selectedId={null}
        onOpenRecord={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /^Missing Trade Instructions/ }));
    expect(screen.getByText("Needs Instructions")).toBeInTheDocument();
    expect(screen.queryByText("Has Instructions")).not.toBeInTheDocument();
    expect(screen.queryByText("Residual Transfer")).not.toBeInTheDocument();
  });

  it("opens the correct record when a row is clicked", () => {
    const onOpen = vi.fn();
    render(
      <RecordsView
        acats={mockAcats}
        loading={false}
        error={null}
        selectedId={null}
        onOpenRecord={onOpen}
        onRefresh={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Open Sarah Jenkins/ }));
    expect(onOpen).toHaveBeenCalledWith("REC-001");
  });

  it("expands a collapsed group on header click", () => {
    const { container } = render(
      <RecordsView
        acats={mockAcats}
        loading={false}
        error={null}
        selectedId={null}
        onOpenRecord={vi.fn()}
        onRefresh={vi.fn()}
      />
    );
    expect(screen.queryByText("Michael Torres")).not.toBeInTheDocument();
    const completedHeader = container.querySelector(
      'section[data-status="Completed"] header'
    );
    expect(completedHeader).not.toBeNull();
    fireEvent.click(completedHeader!);
    expect(screen.getByText("Michael Torres")).toBeInTheDocument();
  });

  it("shows a loading state when no records have arrived yet", () => {
    render(
      <RecordsView
        acats={[]}
        loading={true}
        error={null}
        selectedId={null}
        onOpenRecord={vi.fn()}
        onRefresh={vi.fn()}
      />
    );
    expect(screen.getByText(/Loading records/)).toBeInTheDocument();
  });

  it("shows an error state when load fails with no data", () => {
    render(
      <RecordsView
        acats={[]}
        loading={false}
        error="Network down"
        selectedId={null}
        onOpenRecord={vi.fn()}
        onRefresh={vi.fn()}
      />
    );
    expect(screen.getByText(/Failed to load records/)).toBeInTheDocument();
    expect(screen.getByText("Network down")).toBeInTheDocument();
  });

  it("shows an empty-match state when filters eliminate everything", () => {
    render(
      <RecordsView
        acats={mockAcats}
        loading={false}
        error={null}
        selectedId={null}
        onOpenRecord={vi.fn()}
        onRefresh={vi.fn()}
      />
    );
    fireEvent.change(screen.getByPlaceholderText(/Search name/), {
      target: { value: "zzzzz-not-here" },
    });
    expect(screen.getByText("No records match")).toBeInTheDocument();
  });

  describe("show deleted toggle (admin)", () => {
    const deletedRecord = {
      ...mockAcats[0],
      id: "REC-DEL-1",
      clientName: "Deleted Client",
      deletedAt: "2026-04-10T12:00:00Z",
    };

    it("hides the Show deleted toggle for non-admins", () => {
      setSessionRole("USER");
      renderWithProviders(
        <RecordsView
          acats={mockAcats}
          loading={false}
          error={null}
          selectedId={null}
          onOpenRecord={vi.fn()}
          onRefresh={vi.fn()}
          onToggleShowDeleted={vi.fn()}
        />
      );
      expect(
        screen.queryByRole("button", { name: /show deleted/i })
      ).not.toBeInTheDocument();
    });

    it("hides the toggle when no onToggleShowDeleted handler is provided", () => {
      renderWithProviders(
        <RecordsView
          acats={mockAcats}
          loading={false}
          error={null}
          selectedId={null}
          onOpenRecord={vi.fn()}
          onRefresh={vi.fn()}
        />
      );
      expect(
        screen.queryByRole("button", { name: /show deleted/i })
      ).not.toBeInTheDocument();
    });

    it("invokes onToggleShowDeleted when an admin clicks the toggle", () => {
      const onToggle = vi.fn();
      renderWithProviders(
        <RecordsView
          acats={mockAcats}
          loading={false}
          error={null}
          selectedId={null}
          onOpenRecord={vi.fn()}
          onRefresh={vi.fn()}
          onToggleShowDeleted={onToggle}
        />
      );
      fireEvent.click(
        screen.getByRole("button", { name: /show deleted/i })
      );
      expect(onToggle).toHaveBeenCalledTimes(1);
    });

    it("renders deleted rows with a Restore button when showDeleted is true", () => {
      renderWithProviders(
        <RecordsView
          acats={[...mockAcats, deletedRecord]}
          loading={false}
          error={null}
          selectedId={null}
          onOpenRecord={vi.fn()}
          onRefresh={vi.fn()}
          showDeleted
          onToggleShowDeleted={vi.fn()}
        />
      );
      const section = document.querySelector('section[data-section="deleted"]');
      expect(section).not.toBeNull();
      expect(within(section as HTMLElement).getByText("Deleted Client")).toBeInTheDocument();
      expect(
        within(section as HTMLElement).getByRole("button", {
          name: /restore deleted client/i,
        })
      ).toBeInTheDocument();
    });

    it("keeps deleted rows out of the status groups", () => {
      const { container } = renderWithProviders(
        <RecordsView
          acats={[...mockAcats, deletedRecord]}
          loading={false}
          error={null}
          selectedId={null}
          onOpenRecord={vi.fn()}
          onRefresh={vi.fn()}
          showDeleted
          onToggleShowDeleted={vi.fn()}
        />
      );
      const pendingGroup = container.querySelector(
        'section[data-status="PendingReview"]'
      );
      expect(pendingGroup).not.toBeNull();
      expect(
        within(pendingGroup as HTMLElement).queryByText("Deleted Client")
      ).not.toBeInTheDocument();
    });

    it("calls POST /api/acats/:id/restore when Restore is clicked", async () => {
      // waitFor doesn't play nicely with fake timers; use real ones here.
      vi.useRealTimers();
      const onRefresh = vi.fn().mockResolvedValue(undefined);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true }),
      });
      global.fetch = fetchMock;

      renderWithProviders(
        <RecordsView
          acats={[deletedRecord]}
          loading={false}
          error={null}
          selectedId={null}
          onOpenRecord={vi.fn()}
          onRefresh={onRefresh}
          showDeleted
          onToggleShowDeleted={vi.fn()}
        />
      );

      fireEvent.click(
        screen.getByRole("button", { name: /restore deleted client/i })
      );

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          `/api/acats/${deletedRecord.id}/restore`,
          expect.objectContaining({ method: "POST" })
        );
      });
      await waitFor(() => {
        expect(onRefresh).toHaveBeenCalled();
      });
    });
  });

  describe("filter builder + column chooser", () => {
    function pickField(label: string) {
      const search = screen.getByPlaceholderText(/Search fields/i);
      fireEvent.change(search, { target: { value: label } });
      const popover = search.closest("div")!.parentElement!;
      const button = within(popover).getAllByRole("button").find(
        (b) => b.textContent?.trim().startsWith(label)
      );
      if (!button) throw new Error(`Field "${label}" not found in picker`);
      fireEvent.click(button);
    }

    it("filters records via a generic filter rule", () => {
      render(
        <RecordsView
          acats={mockAcats}
          loading={false}
          error={null}
          selectedId={null}
          onOpenRecord={vi.fn()}
          onRefresh={vi.fn()}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: /Add filter/i }));
      pickField("Client");
      const operand = screen.getAllByRole("textbox").find(
        (el) =>
          (el as HTMLInputElement).type === "text" &&
          !(el as HTMLInputElement).placeholder?.match(/Search/i)
      ) as HTMLInputElement;
      fireEvent.change(operand, { target: { value: "Sarah" } });
      expect(screen.getByText("Sarah Jenkins")).toBeInTheDocument();
    });

    it("hides records when the chip search yields no matches", () => {
      render(
        <RecordsView
          acats={mockAcats}
          loading={false}
          error={null}
          selectedId={null}
          onOpenRecord={vi.fn()}
          onRefresh={vi.fn()}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: /Add filter/i }));
      pickField("Client");
      const operand = screen.getAllByRole("textbox").find(
        (el) =>
          (el as HTMLInputElement).type === "text" &&
          !(el as HTMLInputElement).placeholder?.match(/Search/i)
      ) as HTMLInputElement;
      fireEvent.change(operand, { target: { value: "ZZZZ-no-match" } });
      expect(screen.getByText("No records match")).toBeInTheDocument();
    });

    it("toggles a column visibility via the column chooser", () => {
      const { container } = render(
        <RecordsView
          acats={mockAcats}
          loading={false}
          error={null}
          selectedId={null}
          onOpenRecord={vi.fn()}
          onRefresh={vi.fn()}
        />
      );
      // Direction column header is visible by default
      expect(
        container.querySelector('[role="columnheader"]')
      ).toBeInTheDocument();
      // Open the column chooser and uncheck Direction
      fireEvent.click(screen.getByRole("button", { name: /Columns/i }));
      const directionCb = document.getElementById(
        "column-toggle-direction"
      ) as HTMLInputElement;
      expect(directionCb.checked).toBe(true);
      fireEvent.click(directionCb);
      // The column header for Direction should now be gone
      const headers = Array.from(
        container.querySelectorAll('[role="columnheader"]')
      ).map((el) => (el as HTMLElement).textContent);
      expect(headers).not.toContain("Direction");
    });
  });

  describe("column drag-and-drop reorder", () => {
    function getHeaderLabels(container: HTMLElement): string[] {
      return Array.from(container.querySelectorAll('[role="columnheader"]'))
        .map((el) => (el as HTMLElement).textContent?.trim() ?? "")
        .filter((t) => t.length > 0);
    }

    it("moves a column to the left when its header is dragged onto an earlier header", () => {
      const { container } = render(
        <RecordsView
          acats={mockAcats}
          loading={false}
          error={null}
          selectedId={null}
          onOpenRecord={vi.fn()}
          onRefresh={vi.fn()}
        />
      );

      const before = getHeaderLabels(container);
      // Sanity: schema-default order has Client first, Status second.
      expect(before[0]).toBe("Client");
      expect(before[1]).toBe("Status");

      const statusHeader = container.querySelector(
        '[data-column-key="status"]'
      ) as HTMLElement;
      const clientHeader = container.querySelector(
        '[data-column-key="clientName"]'
      ) as HTMLElement;
      expect(statusHeader).not.toBeNull();
      expect(clientHeader).not.toBeNull();

      // Drag Status → drop on Client. With jsdom's all-zero
      // getBoundingClientRect, clientX=0 lands the drop on the *left* edge,
      // i.e. before the Client column.
      fireEvent.dragStart(statusHeader);
      fireEvent.dragOver(clientHeader, { clientX: 0 });
      fireEvent.drop(clientHeader, { clientX: 0 });
      fireEvent.dragEnd(statusHeader);

      const after = getHeaderLabels(container);
      expect(after[0]).toBe("Status");
      expect(after[1]).toBe("Client");
    });

    it("persists the new order to localStorage", () => {
      const { container } = render(
        <RecordsView
          acats={mockAcats}
          loading={false}
          error={null}
          selectedId={null}
          onOpenRecord={vi.fn()}
          onRefresh={vi.fn()}
        />
      );
      const statusHeader = container.querySelector(
        '[data-column-key="status"]'
      ) as HTMLElement;
      const clientHeader = container.querySelector(
        '[data-column-key="clientName"]'
      ) as HTMLElement;

      fireEvent.dragStart(statusHeader);
      fireEvent.dragOver(clientHeader, { clientX: 0 });
      fireEvent.drop(clientHeader, { clientX: 0 });
      fireEvent.dragEnd(statusHeader);

      const raw = mockStorage["records-view-column-order"];
      expect(raw).toBeTruthy();
      const persisted = JSON.parse(raw) as string[];
      expect(persisted.indexOf("status")).toBeLessThan(
        persisted.indexOf("clientName")
      );
    });

    it("loads a persisted column order on mount", () => {
      // Pre-seed localStorage with status placed before clientName.
      mockStorage["records-view-column-order"] = JSON.stringify([
        "id",
        "status",
        "clientName",
        "transferringContra",
      ]);
      const { container } = render(
        <RecordsView
          acats={mockAcats}
          loading={false}
          error={null}
          selectedId={null}
          onOpenRecord={vi.fn()}
          onRefresh={vi.fn()}
        />
      );
      const labels = getHeaderLabels(container);
      expect(labels[0]).toBe("Status");
      expect(labels[1]).toBe("Client");
    });

    it("does not reorder when a header is dropped on itself", () => {
      const { container } = render(
        <RecordsView
          acats={mockAcats}
          loading={false}
          error={null}
          selectedId={null}
          onOpenRecord={vi.fn()}
          onRefresh={vi.fn()}
        />
      );
      const before = getHeaderLabels(container);
      const clientHeader = container.querySelector(
        '[data-column-key="clientName"]'
      ) as HTMLElement;

      fireEvent.dragStart(clientHeader);
      fireEvent.drop(clientHeader, { clientX: 0 });
      fireEvent.dragEnd(clientHeader);

      expect(getHeaderLabels(container)).toEqual(before);
    });

    it("Reset in the column chooser restores the schema-default order", () => {
      const { container } = render(
        <RecordsView
          acats={mockAcats}
          loading={false}
          error={null}
          selectedId={null}
          onOpenRecord={vi.fn()}
          onRefresh={vi.fn()}
        />
      );
      const statusHeader = container.querySelector(
        '[data-column-key="status"]'
      ) as HTMLElement;
      const clientHeader = container.querySelector(
        '[data-column-key="clientName"]'
      ) as HTMLElement;
      fireEvent.dragStart(statusHeader);
      fireEvent.drop(clientHeader, { clientX: 0 });
      fireEvent.dragEnd(statusHeader);
      expect(getHeaderLabels(container)[0]).toBe("Status");

      fireEvent.click(screen.getByRole("button", { name: /Columns/i }));
      fireEvent.click(screen.getByText(/Reset/i));

      const after = getHeaderLabels(container);
      expect(after[0]).toBe("Client");
      expect(after[1]).toBe("Status");
    });
  });

  describe("sortable column headers", () => {
    const records = ["Charlie Client", "Alice Client", "Bravo Client"].map(
      (clientName, index) => ({
        ...mockAcats[0],
        id: `SORT-${index}`,
        clientName,
        status: "PendingReview" as const,
        acatDate: `2026-04-${10 + index}`,
      })
    );

    function renderedClientOrder(container: HTMLElement): string[] {
      const group = container.querySelector(
        'section[data-status="PendingReview"]'
      );
      if (!group) throw new Error("Pending Review group not found");
      return within(group as HTMLElement)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label"))
        .filter((label): label is string => label?.startsWith("Open ") ?? false)
        .map((label) => label.replace(/^Open /, "").replace(/ details$/, ""));
    }

    it("toggles a column between ascending and descending", () => {
      const { container } = render(
        <RecordsView
          acats={records}
          loading={false}
          error={null}
          selectedId={null}
          onOpenRecord={vi.fn()}
          onRefresh={vi.fn()}
        />
      );

      const sortButton = screen.getByRole("button", { name: "Sort by Client" });
      const clientHeader = sortButton.closest('[role="columnheader"]');
      expect(clientHeader).toHaveAttribute("aria-sort", "none");

      fireEvent.click(sortButton);
      expect(renderedClientOrder(container)).toEqual([
        "Alice Client",
        "Bravo Client",
        "Charlie Client",
      ]);
      expect(clientHeader).toHaveAttribute("aria-sort", "ascending");

      fireEvent.click(sortButton);
      expect(renderedClientOrder(container)).toEqual([
        "Charlie Client",
        "Bravo Client",
        "Alice Client",
      ]);
      expect(clientHeader).toHaveAttribute("aria-sort", "descending");
    });

    it("reorders status groups when sorting by Status", () => {
      const statusRecords = [
        { ...records[0], status: "Submitted" as const },
        { ...records[1], status: "PendingReview" as const },
        { ...records[2], status: "Accepted" as const },
      ];
      const { container } = render(
        <RecordsView
          acats={statusRecords}
          loading={false}
          error={null}
          selectedId={null}
          onOpenRecord={vi.fn()}
          onRefresh={vi.fn()}
        />
      );

      const groupOrder = () =>
        Array.from(container.querySelectorAll("section[data-status]")).map(
          (section) => section.getAttribute("data-status")
        );

      const sortButton = screen.getByRole("button", { name: "Sort by Status" });
      fireEvent.click(sortButton);
      expect(groupOrder()).toEqual(["Accepted", "PendingReview", "Submitted"]);

      fireEvent.click(sortButton);
      expect(groupOrder()).toEqual(["Submitted", "PendingReview", "Accepted"]);
    });

    it("sorts numeric columns numerically", () => {
      const numericRecords = records.map((record, index) => ({
        ...record,
        statementAmount: [200, 30, 100][index],
      }));
      const { container } = render(
        <RecordsView
          acats={numericRecords}
          loading={false}
          error={null}
          selectedId={null}
          onOpenRecord={vi.fn()}
          onRefresh={vi.fn()}
        />
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Sort by Statement Amount" })
      );
      expect(renderedClientOrder(container)).toEqual([
        "Alice Client",
        "Bravo Client",
        "Charlie Client",
      ]);
    });
  });

  it("sorts records newest first within a group", () => {
    const older = {
      ...mockAcats[0],
      id: "OLD",
      clientName: "Older Client",
      acatDate: "2026-01-01",
      status: "PendingReview" as const,
    };
    const newer = {
      ...mockAcats[0],
      id: "NEW",
      clientName: "Newer Client",
      acatDate: "2026-04-14",
      status: "PendingReview" as const,
    };
    const { container } = render(
      <RecordsView
        acats={[older, newer]}
        loading={false}
        error={null}
        selectedId={null}
        onOpenRecord={vi.fn()}
        onRefresh={vi.fn()}
      />
    );
    const group = container.querySelector(
      'section[data-status="PendingReview"]'
    );
    expect(group).not.toBeNull();
    const names = within(group as HTMLElement).getAllByText(/Client/);
    expect(names[0]).toHaveTextContent("Newer Client");
    expect(names[1]).toHaveTextContent("Older Client");
  });
});
