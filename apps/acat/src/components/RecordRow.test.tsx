import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import RecordRow from "./RecordRow";
import { AcatRecord } from "@/lib/types";
import { defaultVisibleColumns, RecordFieldKey } from "@/lib/record-fields";

const FAKE_NOW = new Date("2026-04-15T00:00:00Z").getTime();
const VISIBLE = defaultVisibleColumns();

function makeRecord(overrides: Partial<AcatRecord>): AcatRecord {
  return {
    id: "REC-1",
    clientName: "Alice Example",
    status: "PendingReview",
    apexAccountId: "APX-1",
    lastUpdated: "2026-04-10T00:00:00Z",
    crmDealId: "PF-1",
    custodianId: "c",
    custodianName: "Schwab",
    acatDate: "2026-04-10",
    slackAlerted: false,
    mappingSource: "",
    apexSource: "",
    assets: [],
    transferringContra: "Fidelity",
    direction: "In",
    controlNumber: "CTL-1",
    wealthAdvisor: "J. Hamann",
    statementAmount: 48264000,
    ...overrides,
  };
}

function renderRow(
  acat: AcatRecord,
  opts: Partial<{
    selected: boolean;
    visibleColumns: Set<RecordFieldKey>;
    onOpen: (id: string) => void;
    onMutate: () => void | Promise<void>;
  }> = {}
) {
  return render(
    <RecordRow
      acat={acat}
      selected={opts.selected ?? false}
      density="comfortable"
      now={FAKE_NOW}
      visibleColumns={opts.visibleColumns ?? VISIBLE}
      onOpen={opts.onOpen ?? vi.fn()}
      onMutate={opts.onMutate}
    />
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RecordRow", () => {
  describe("inline operational editing", () => {
    it("sends the version reviewed at account-edit start despite background refresh", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);
      const record = makeRecord({ cedarRidgeUserId: "user-synthetic", identityVersion: 4 });
      const props = { selected: false, density: "comfortable" as const, now: FAKE_NOW, visibleColumns: new Set<RecordFieldKey>(["clientName", "apexAccountId"]), onOpen: vi.fn(), onMutate: vi.fn() };
      const { rerender } = render(<RecordRow acat={record} {...props} />);
      fireEvent.click(screen.getByRole("button", { name: "Edit Apex Acct for Alice Example" }));
      const input = screen.getByDisplayValue("APX-1");
      fireEvent.change(input, { target: { value: "APX-2" } });
      rerender(<RecordRow acat={{ ...record, identityVersion: 5 }} {...props} />);
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/acats/REC-1", expect.objectContaining({ body: JSON.stringify({ apexAccountId: "APX-2", expectedIdentityVersion: 4 }) })));
    });

    it("sends an empty string when clearing a pending receiving account", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);
      const onMutate = vi.fn();
      renderRow(makeRecord({ status: "PendingAccountOpening", cedarRidgeUserId: "user-synthetic", identityVersion: 4 }), { onMutate });
      fireEvent.click(screen.getByRole("button", { name: "Edit Apex Acct for Alice Example" }));
      const input = screen.getByDisplayValue("APX-1");
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/acats/REC-1", expect.objectContaining({ body: JSON.stringify({ apexAccountId: "", expectedIdentityVersion: 4 }) })));
      await waitFor(() => expect(onMutate).toHaveBeenCalledOnce());
    });

    it("saves a pasted DTCC number without opening the record", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(makeRecord({ dtccNumber: "0226" })),
      });
      vi.stubGlobal("fetch", fetchMock);
      const onOpen = vi.fn();
      const onMutate = vi.fn().mockResolvedValue(undefined);
      const visible = new Set<RecordFieldKey>(["clientName", "dtccNumber"]);

      renderRow(makeRecord({ dtccNumber: "" }), {
        visibleColumns: visible,
        onOpen,
        onMutate,
      });

      fireEvent.click(
        screen.getByRole("button", {
          name: "Edit DTCC # for Alice Example",
        })
      );
      const input = screen.getByPlaceholderText("Add dtcc #");
      fireEvent.change(input, { target: { value: "0226" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/acats/REC-1",
          expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({ dtccNumber: "0226" }),
          })
        );
      });
      await waitFor(() => expect(onMutate).toHaveBeenCalled());
      expect(onOpen).not.toHaveBeenCalled();
    });

    it("clears optional fields with null", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(makeRecord({ controlNumber: "" })),
      });
      vi.stubGlobal("fetch", fetchMock);
      const visible = new Set<RecordFieldKey>(["clientName", "controlNumber"]);

      renderRow(makeRecord({ controlNumber: "CTL-1" }), {
        visibleColumns: visible,
        onMutate: vi.fn(),
      });

      fireEvent.click(
        screen.getByRole("button", {
          name: "Edit Control # for Alice Example",
        })
      );
      const input = screen.getByDisplayValue("CTL-1");
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.blur(input);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/acats/REC-1",
          expect.objectContaining({
            body: JSON.stringify({ controlNumber: null }),
          })
        );
      });
    });

    it("keeps the editor open and shows an error when saving fails", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 400 })
      );
      const visible = new Set<RecordFieldKey>(["clientName", "dtccNumber"]);

      renderRow(makeRecord({ dtccNumber: "" }), {
        visibleColumns: visible,
      });

      fireEvent.click(
        screen.getByRole("button", {
          name: "Edit DTCC # for Alice Example",
        })
      );
      const input = screen.getByPlaceholderText("Add dtcc #");
      fireEvent.change(input, { target: { value: "bad value" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(
        await screen.findByText("Save failed — retry or press Escape")
      ).toBeInTheDocument();
      expect(screen.getByDisplayValue("bad value")).toBeInTheDocument();
    });

    it("renders advisor as an inline select", () => {
      const visible = new Set<RecordFieldKey>(["clientName", "wealthAdvisor"]);
      renderRow(makeRecord({ wealthAdvisor: "Rachel" }), {
        visibleColumns: visible,
      });

      fireEvent.click(
        screen.getByRole("button", {
          name: "Edit Advisor for Alice Example",
        })
      );
      const select = screen.getByRole("combobox");
      expect(select).toHaveValue("Rachel");
    });
  });

  it("renders the client name", () => {
    renderRow(makeRecord({}));
    expect(screen.getByText("Alice Example")).toBeInTheDocument();
  });

  it("renders days open based on acat date", () => {
    renderRow(makeRecord({ acatDate: "2026-04-10" }));
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("renders an issue pill only when there are issues", () => {
    const { container, rerender } = renderRow(makeRecord({ assets: [] }));
    const issuesCellNoIssues = container.querySelector("[class*='--danger']");
    expect(issuesCellNoIssues).toBeNull();

    rerender(
      <RecordRow
        acat={makeRecord({
          assets: [
            {
              id: "a",
              symbol: "VTI",
              description: "",
              expectedQty: 10,
              actualQty: 8,
              mapStatus: "Unmapped",
            },
            {
              id: "b",
              symbol: "TSLA",
              description: "",
              expectedQty: 5,
              actualQty: 0,
              mapStatus: "Pending",
            },
          ],
        })}
        selected={false}
        density="comfortable"
        now={FAKE_NOW}
        visibleColumns={VISIBLE}
        onOpen={vi.fn()}
      />
    );
    const pill = container.querySelector("[class*='--danger']");
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe("1");
  });

  it("calls onOpen when clicked", () => {
    const onOpen = vi.fn();
    renderRow(makeRecord({}), { onOpen });
    fireEvent.click(screen.getByRole("button", { name: /Open Alice Example/ }));
    expect(onOpen).toHaveBeenCalledWith("REC-1");
  });

  it("opens via Enter key", () => {
    const onOpen = vi.fn();
    renderRow(makeRecord({}), { onOpen });
    fireEvent.keyDown(screen.getByRole("button", { name: /Open Alice/ }), {
      key: "Enter",
    });
    expect(onOpen).toHaveBeenCalledWith("REC-1");
  });

  it("renders direction tag for In records", () => {
    renderRow(makeRecord({ direction: "In" }));
    const tag = screen.getByText("IN");
    expect(tag.getAttribute("data-direction")).toBe("in");
  });

  it("applies selected highlight when selected", () => {
    renderRow(makeRecord({}), { selected: true });
    const row = screen.getByRole("button", { name: /Open Alice/ });
    expect(row.getAttribute("aria-current")).toBe("true");
  });

  it("only renders cells for visible columns", () => {
    const onlyClient = new Set<RecordFieldKey>(["clientName"]);
    renderRow(makeRecord({}), { visibleColumns: onlyClient });
    expect(screen.getByText("Alice Example")).toBeInTheDocument();
    expect(screen.queryByText("IN")).toBeNull();
    expect(screen.queryByText("CTL-1")).toBeNull();
  });

  it("renders extra columns when added to the visible set", () => {
    const withId = new Set<RecordFieldKey>(["clientName", "id"]);
    renderRow(makeRecord({ id: "REC-XYZ" }), {
      visibleColumns: withId,
    });
    expect(screen.getByText("REC-XYZ")).toBeInTheDocument();
  });

});
