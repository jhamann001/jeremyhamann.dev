import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import FeesTab from "./FeesTab";
import { ToastProvider } from "./Toast";
import { jsonFetcher } from "@/lib/fetcher";
import { mockAcats } from "@/lib/mock-data";

const acatWithFee = mockAcats[0]; // Sarah Jenkins — PendingReview, feeCharged: "Yes", feeAmount: "$50.00"
const acatNoFee = mockAcats[1]; // Michael Torres — Completed, feeCharged: "No"
const acatInProgressNoFee = mockAcats[3]; // David Chen — Submitted, feeCharged: "No"

// Isolated SWR cache per test so the /api/fees and /api/custodians reads
// don't leak between cases; dedupe/throttle off so focus events trigger
// an immediate revalidate.
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

describe("FeesTab", () => {
  const onMutate = vi.fn();

  beforeEach(() => {
    onMutate.mockClear();
    // FeesTab fires two fetches on mount: /api/fees (reimbursement log) and
    // /api/custodians?id=...&includeFees=1 (fee schedule). Route by URL so the
    // ordering of calls doesn't matter and we can override per-test as needed.
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/api/custodians")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ id: "CUST-001", name: "Contra", fees: [] }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders fee details for a record with fees", async () => {
    renderWithProviders(<FeesTab acat={acatWithFee} onMutate={onMutate} />);

    expect(screen.getByText("Fee Details")).toBeInTheDocument();
    expect(screen.getByText("Fee Charged")).toBeInTheDocument();
  });

  it('shows "No Fee" badge for terminal record without fees', async () => {
    renderWithProviders(<FeesTab acat={acatNoFee} onMutate={onMutate} />);

    expect(screen.getByText("No Fee")).toBeInTheDocument();
  });

  it.each(["No", ""])("does not prompt for automatic ACAT fees on DRS with answer %s", async (feeCharged) => {
    renderWithProviders(<FeesTab acat={{
      ...acatNoFee,
      direction: "Out",
      type: "Full",
      transferWorkflow: "DRS",
      feeCharged,
      feeAmount: "",
    }} onMutate={onMutate} />);

    expect(screen.getByText("No Fee")).toBeInTheDocument();
    expect(screen.queryByText(/verify the automatic fee credit/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Action Required/)).not.toBeInTheDocument();
    expect(screen.queryByText("Log Reimbursement")).not.toBeInTheDocument();
  });

  it("allows a DRS fee to be recorded manually", async () => {
    renderWithProviders(<FeesTab acat={{
      ...acatNoFee,
      direction: "Out",
      type: "Full",
      transferWorkflow: "DRS",
      feeAmount: "",
    }} onMutate={onMutate} />);

    const feeRow = screen.getByText("Fee Charged?").closest(".group") as HTMLElement;
    fireEvent.click(within(feeRow).getByText("No"));
    const select = within(feeRow).getByRole("combobox");
    fireEvent.change(select, { target: { value: "Yes" } });
    fireEvent.blur(select);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      `/api/acats/${acatNoFee.id}`,
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ feeCharged: "Yes" }) })
    ));
  });

  it("keeps reimbursement available for a recorded DRS fee", async () => {
    renderWithProviders(<FeesTab acat={{
      ...acatWithFee,
      direction: "Out",
      type: "Full",
      transferWorkflow: "DRS",
    }} onMutate={onMutate} />);

    expect(screen.getByText("Fee Charged")).toBeInTheDocument();
    expect(screen.getByText("Log Reimbursement")).toBeInTheDocument();
    expect(screen.queryByText(/verify the automatic fee credit/)).not.toBeInTheDocument();
  });

  it("shows no-fee charged message for terminal record without fees", async () => {
    renderWithProviders(<FeesTab acat={acatNoFee} onMutate={onMutate} />);

    expect(screen.getByText("No Fee Charged")).toBeInTheDocument();
    expect(screen.getByText(/No ACAT transfer fee was charged/)).toBeInTheDocument();
  });

  it('shows "Pending" badge for in-progress record without fees', async () => {
    renderWithProviders(<FeesTab acat={acatInProgressNoFee} onMutate={onMutate} />);

    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.queryByText("No Fee")).not.toBeInTheDocument();
    expect(screen.queryByText("No Fee Charged")).not.toBeInTheDocument();
  });

  it("shows fee-status-pending message for in-progress record without fees", async () => {
    renderWithProviders(<FeesTab acat={acatInProgressNoFee} onMutate={onMutate} />);

    expect(screen.getByText("Fee Status Pending")).toBeInTheDocument();
    expect(screen.getByText(/Fee information will be available/)).toBeInTheDocument();
  });

  it("fetches fee status on mount", async () => {
    renderWithProviders(<FeesTab acat={acatWithFee} onMutate={onMutate} />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/fees?"),
        expect.objectContaining({ cache: "no-store" })
      );
    });
  });

  it("revalidates fee status on window focus", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    renderWithProviders(<FeesTab acat={acatWithFee} onMutate={onMutate} />);

    await waitFor(() => {
      const feeCalls = fetchMock.mock.calls.filter(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("/api/fees?")
      );
      expect(feeCalls.length).toBeGreaterThanOrEqual(1);
    });

    const initialFeeCalls = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("/api/fees?")
    ).length;

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      const after = fetchMock.mock.calls.filter(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("/api/fees?")
      ).length;
      expect(after).toBeGreaterThan(initialFeeCalls);
    });
  });

  it("shows reimbursement action for records with fees", async () => {
    renderWithProviders(<FeesTab acat={acatWithFee} onMutate={onMutate} />);

    await waitFor(() => {
      expect(screen.getByText(/Action Required/)).toBeInTheDocument();
    });

    expect(screen.getByText("Log Reimbursement")).toBeInTheDocument();
  });

  it("shows duplicate warning when records already exist", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/api/custodians")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ id: "CUST-001", name: "Contra", fees: [] }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([{ id: 1, fee_amount: 50, status: "Pending" }]),
      });
    });

    renderWithProviders(<FeesTab acat={acatWithFee} onMutate={onMutate} />);

    await waitFor(() => {
      expect(screen.getByText("Log Reimbursement")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Log Reimbursement"));

    await waitFor(() => {
      expect(screen.getByText("Possible Duplicate")).toBeInTheDocument();
    });
  });

  it("renders editable fee fields", async () => {
    renderWithProviders(<FeesTab acat={acatWithFee} onMutate={onMutate} />);

    expect(screen.getByText("Fee Charged?")).toBeInTheDocument();
    expect(screen.getByText("Fee Amount")).toBeInTheDocument();
    expect(screen.getByText("Fee Request Submitted")).toBeInTheDocument();
    expect(screen.getByText("Fee Apex Ticket")).toBeInTheDocument();
    expect(screen.getByText("Fee Credit Req ID")).toBeInTheDocument();
  });

  it("submits the fee-specific Apex ticket and links the assigned Fee Store request ID", async () => {
    const acat = { ...acatWithFee, feeApexTicket: "APEX-FEE-42" };
    global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      if (url.includes("/api/custodians")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: "CUST-001", fees: [] }) });
      }
      if (url === "/api/fees" && options?.method === "POST") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 314 }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    renderWithProviders(<FeesTab acat={acat} onMutate={onMutate} />);
    await screen.findByText("Log Reimbursement");
    fireEvent.click(screen.getByText("Log Reimbursement"));

    await waitFor(() => {
      const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const post = calls.find((call) => call[0] === "/api/fees" && call[1]?.method === "POST");
      expect(JSON.parse(post![1].body)).toMatchObject({ apexRequest: "APEX-FEE-42" });
      const patch = calls.find(
        (call) => call[0] === `/api/acats/${acat.id}` && call[1]?.method === "PATCH"
      );
      expect(JSON.parse(patch![1].body)).toMatchObject({ feeCreditRequestId: "314" });
    });
  });

  it("highlights and starts editing a fee field opened from Data Quality", () => {
    renderWithProviders(
      <FeesTab
        acat={{ ...acatWithFee, feeAmount: "bad" }}
        onMutate={onMutate}
        focus={{
          ruleKey: "invalid_fee_amount",
          title: "Fee amount is not valid",
          detail: "Enter a numeric fee amount.",
          tab: "fees",
          field: "feeAmount",
          fieldLabel: "Fee Amount",
        }}
      />
    );

    expect(screen.getByText("Fixing: Fee amount is not valid")).toBeInTheDocument();
    expect(screen.getByDisplayValue("bad")).toHaveFocus();
    expect(screen.getByDisplayValue("bad").closest('[data-quality-target="true"]')).not.toBeNull();
  });

  describe("fee schedule direction filter", () => {
    // Custodian fixture: one OUT-tagged transfer-out fee and one ANY IRA
    // maintenance fee. The OUT fee should only appear for records whose
    // direction is "In" (contra releasing assets); the IRA fee is not
    // direction-scoped so it always shows when the accountType matches.
    const custodianPayload = {
      id: "CUST-001",
      name: "Morgan Stanley",
      fees: [
        {
          id: "ms-acat-out",
          custodianId: "CUST-001",
          feeType: "ACAT Out",
          accountType: "ANY",
          transferType: "ANY",
          direction: "OUT",
          amount: 125,
          amountText: null,
          notes: null,
          documentation: null,
        },
        {
          id: "ms-ira-term",
          custodianId: "CUST-001",
          feeType: "IRA Termination Fee",
          accountType: "IRA",
          transferType: "ANY",
          direction: "ANY",
          amount: 125,
          amountText: null,
          notes: null,
          documentation: null,
        },
      ],
    };

    const mockCustodianFetch = () => {
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (typeof url === "string" && url.includes("/api/custodians")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(custodianPayload),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });
    };

    it("shows an OUT-tagged fee when the ACAT direction is In", async () => {
      mockCustodianFetch();
      const acat = {
        ...acatInProgressNoFee,
        accountType: "Traditional IRA",
        direction: "In",
      };
      renderWithProviders(<FeesTab acat={acat} onMutate={onMutate} />);

      await waitFor(() => {
        expect(screen.getByText("ACAT Out")).toBeInTheDocument();
      });
      expect(screen.getByText("IRA Termination Fee")).toBeInTheDocument();
    });

    it("shows every fee in the schedule regardless of ACAT direction (ticket)", async () => {
      // ticket: the fees panel no longer filters the custodian's
      // schedule by direction. Ops sees ALL configured fees and picks
      // which ones to apply. This test (formerly asserting the
      // direction-Out filter HID the OUT-tagged fee) inverts: with
      // direction="Out", the OUT-tagged fee should still render.
      mockCustodianFetch();
      const acat = {
        ...acatInProgressNoFee,
        accountType: "Traditional IRA",
        direction: "Out",
      };
      renderWithProviders(<FeesTab acat={acat} onMutate={onMutate} />);

      await waitFor(() => {
        expect(screen.getByText("IRA Termination Fee")).toBeInTheDocument();
      });
      expect(screen.getByText("ACAT Out")).toBeInTheDocument();
    });
  });

  // ticket: inline fee-field editing — blur-to-save, Escape-discards,
  // Escape-then-edit still saves (cancel-flag reset), and blanking CLEARS.
  describe("inline fee edit (ticket)", () => {
    const patchCalls = () =>
      (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) =>
          typeof c[0] === "string" &&
          (c[0] as string).includes(`/api/acats/${acatWithFee.id}`) &&
          (c[1] as RequestInit | undefined)?.method === "PATCH"
      );
    const lastPatchBody = () => {
      const calls = patchCalls();
      return calls.length
        ? ((calls[calls.length - 1][1] as RequestInit).body as string)
        : undefined;
    };
    // The "Fee Amount" / "Fee Memo" rows; re-fetched each time since they
    // re-render on edit.
    const amountRow = () =>
      screen.getByText("Fee Amount").parentElement as HTMLElement;
    const memoRow = () =>
      screen.getByText("Fee Memo").parentElement as HTMLElement;

    // Fetch mock where the FIRST PATCH hangs until released — lets us drive the
    // "field A still saving while B is edited" races (fixes #2 and #3).
    function mockWithDeferredFirstPatch() {
      let release: (() => void) | null = null;
      let patchN = 0;
      global.fetch = vi.fn().mockImplementation(
        (url: string, opts?: RequestInit) => {
          if (typeof url === "string" && url.includes("/api/custodians")) {
            return Promise.resolve({
              ok: true,
              json: () =>
                Promise.resolve({ id: "C", name: "Contra", fees: [] }),
            });
          }
          if (
            typeof url === "string" &&
            url.includes(`/api/acats/${acatWithFee.id}`) &&
            opts?.method === "PATCH"
          ) {
            patchN += 1;
            if (patchN === 1) {
              return new Promise((resolve) => {
                release = () =>
                  resolve({ ok: true, json: () => Promise.resolve([]) });
              });
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
          }
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        }
      );
      return { release: () => release?.() };
    }

    it("saves a fee field on blur (click-away)", async () => {
      renderWithProviders(<FeesTab acat={acatWithFee} onMutate={onMutate} />);
      await screen.findByText("Fee Details");

      fireEvent.click(within(amountRow()).getByText("$50.00"));
      fireEvent.change(within(amountRow()).getByRole("textbox"), {
        target: { value: "$75.00" },
      });
      fireEvent.blur(within(amountRow()).getByRole("textbox"));

      await waitFor(() =>
        expect(lastPatchBody()).toBe(JSON.stringify({ feeAmount: "$75.00" }))
      );
    });

    it("discards on Escape without a PATCH", async () => {
      renderWithProviders(<FeesTab acat={acatWithFee} onMutate={onMutate} />);
      await screen.findByText("Fee Details");

      fireEvent.click(within(amountRow()).getByText("$50.00"));
      fireEvent.change(within(amountRow()).getByRole("textbox"), {
        target: { value: "$999.00" },
      });
      fireEvent.keyDown(within(amountRow()).getByRole("textbox"), {
        key: "Escape",
      });

      await waitFor(() =>
        expect(within(amountRow()).getByText("$50.00")).toBeInTheDocument()
      );
      expect(patchCalls()).toHaveLength(0);
    });

    it("still saves on the next edit after a prior Escape (flag reset)", async () => {
      renderWithProviders(<FeesTab acat={acatWithFee} onMutate={onMutate} />);
      await screen.findByText("Fee Details");

      // Escape once — in the bug this poisoned the cancel flag.
      fireEvent.click(within(amountRow()).getByText("$50.00"));
      fireEvent.keyDown(within(amountRow()).getByRole("textbox"), {
        key: "Escape",
      });
      await waitFor(() =>
        expect(within(amountRow()).getByText("$50.00")).toBeInTheDocument()
      );

      // Re-edit and blur — must still save.
      fireEvent.click(within(amountRow()).getByText("$50.00"));
      fireEvent.change(within(amountRow()).getByRole("textbox"), {
        target: { value: "$60.00" },
      });
      fireEvent.blur(within(amountRow()).getByRole("textbox"));

      await waitFor(() =>
        expect(lastPatchBody()).toBe(JSON.stringify({ feeAmount: "$60.00" }))
      );
    });

    it("clears the field when blanked (sends empty string, not dropped)", async () => {
      renderWithProviders(<FeesTab acat={acatWithFee} onMutate={onMutate} />);
      await screen.findByText("Fee Details");

      fireEvent.click(within(amountRow()).getByText("$50.00"));
      fireEvent.change(within(amountRow()).getByRole("textbox"), {
        target: { value: "" },
      });
      fireEvent.blur(within(amountRow()).getByRole("textbox"));

      await waitFor(() =>
        expect(lastPatchBody()).toBe(JSON.stringify({ feeAmount: "" }))
      );
    });

    it("does not close field B's editor when field A's save resolves late", async () => {
      const { release } = mockWithDeferredFirstPatch();
      renderWithProviders(<FeesTab acat={acatWithFee} onMutate={onMutate} />);
      await screen.findByText("Fee Details");

      // Edit Fee Amount + blur → PATCH A starts but hangs.
      fireEvent.click(within(amountRow()).getByText("$50.00"));
      fireEvent.change(within(amountRow()).getByRole("textbox"), {
        target: { value: "$75.00" },
      });
      fireEvent.blur(within(amountRow()).getByRole("textbox"));

      // Open Fee Memo and type.
      fireEvent.click(within(memoRow()).getByText("—"));
      fireEvent.change(within(memoRow()).getByRole("textbox"), {
        target: { value: "waived" },
      });

      // A's save resolves late — must NOT close B's editor (pre-fix bug).
      await act(async () => {
        release();
      });

      await waitFor(() =>
        expect(within(memoRow()).getByRole("textbox")).toHaveValue("waived")
      );
    });

    it("saves field B while field A's save is still in flight", async () => {
      const { release } = mockWithDeferredFirstPatch();
      renderWithProviders(<FeesTab acat={acatWithFee} onMutate={onMutate} />);
      await screen.findByText("Fee Details");

      // A in flight (hangs).
      fireEvent.click(within(amountRow()).getByText("$50.00"));
      fireEvent.change(within(amountRow()).getByRole("textbox"), {
        target: { value: "$75.00" },
      });
      fireEvent.blur(within(amountRow()).getByRole("textbox"));

      // B must still PATCH (pre-fix: the global guard dropped it).
      fireEvent.click(within(memoRow()).getByText("—"));
      fireEvent.change(within(memoRow()).getByRole("textbox"), {
        target: { value: "waived" },
      });
      fireEvent.blur(within(memoRow()).getByRole("textbox"));

      await waitFor(() =>
        expect(
          patchCalls().some(
            (c) =>
              (c[1] as RequestInit).body ===
              JSON.stringify({ feeMemo: "waived" })
          )
        ).toBe(true)
      );

      await act(async () => {
        release();
      });
    });
  });
});
