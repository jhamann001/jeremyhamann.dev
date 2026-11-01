import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonFetcher } from "@/lib/fetcher";
import ManualTransferFormRecommendationCard from "./ManualTransferFormRecommendationCard";

function renderCard() {
  return render(
    <SWRConfig
      value={{
        fetcher: jsonFetcher,
        provider: () => new Map(),
        dedupingInterval: 0,
      }}
    >
      <ManualTransferFormRecommendationCard acatId="ACAT-TROWE" />
    </SWRConfig>
  );
}

let secondaryClientSignatureRequired = false;
let inheritedAccountTitleReviewRequired = false;
let apexAccountTitleConfirmation: {
  title: string;
  confirmedAt: string;
  confirmedBy: string;
} | null = null;

beforeEach(() => {
  secondaryClientSignatureRequired = false;
  inheritedAccountTitleReviewRequired = false;
  apexAccountTitleConfirmation = null;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:generated-form"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  global.fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const requestBody = JSON.parse(String(init.body));
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            requestBody.confirmed
              ? {
                  title: requestBody.apexAccountTitle,
                  confirmedAt: "2026-09-11T17:55:00.000Z",
                  confirmedBy: "ops@example.com",
                }
              : { title: null, confirmedAt: null, confirmedBy: null }
          ),
      } as Response);
    }
    if (init?.method === "POST") {
      return Promise.resolve({
        ok: true,
        blob: () => Promise.resolve(new Blob(["pdf"], { type: "application/pdf" })),
        headers: new Headers({
          "content-disposition":
            'attachment; filename="Example-Client-Apex-CATR.pdf"',
        }),
      } as Response);
    }
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          status: "ACTION_REQUIRED",
          inheritedAccountTitleReviewRequired,
          secondaryClientSignatureRequired,
          apexAccountTitleSuggestion: "Example Client - Traditional IRA",
          apexAccountTitleConfirmation,
          deliveringAccountTitleSuggestion: "Example Client",
          custodian: {
            id: "CUST-TROWE",
            name: "T. Rowe Price / Pershing",
            signature: "Wet only",
            letterOfAcceptance: "Required",
            medallionRequired: "Required",
            liquidationMethod: "Check",
            returnMethod: "Email / fax 410-581-5184",
            watchouts: "Apex signs the paperwork.",
          },
          candidates: [
            {
              id: "t-rowe-price",
              custodianName: "T. Rowe Price / Pershing",
              displayName: "T. Rowe Price",
              template: "APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST",
              apexTransferSelection: "MUTUAL_FUND_COMPANY_TRANSFER",
              assetHandling: {
                mode: "CLIENT_DIRECTED",
                options: ["IN_KIND", "LIQUIDATE"],
                defaultInstruction: "LIQUIDATE",
                preferredInstruction: "LIQUIDATE",
                watchout:
                  "T. Rowe Price has previously liquidated holdings despite in-kind instructions.",
              },
              apexSignatureRequirement: "WET_REQUIRED",
            },
          ],
          actions: [
            ...(secondaryClientSignatureRequired
              ? [
                  {
                    code: "REQUIRE_SECONDARY_CLIENT_SIGNATURE",
                    message:
                      "Joint account: a second client signature is mandatory. Both account holders must sign the transfer form and any populated letter of authorization.",
                  },
                ]
              : []),
            ...(inheritedAccountTitleReviewRequired
              ? [
                  {
                    code: "VERIFY_INHERITED_ACCOUNT_TITLES",
                    message:
                      "Inherited account: confirm the exact delivering title from the current statement. If it differs from the receiving Apex title, the letter of authorization is required and will be populated.",
                  },
                ]
              : []),
            {
              code: "CONFIRM_ASSET_INSTRUCTION",
              message:
                "Confirm whether the client directed an in-kind transfer or liquidation before generating the form.",
            },
          ],
          discrepancies: [],
          sourceGuidance: [
            "Treat DTC, address, and routing values as suggestions; current client-specific documentation wins.",
          ],
        }),
    } as Response);
  }) as typeof fetch;
});

describe("ManualTransferFormRecommendationCard", () => {
  it("shows T. Rowe Price form logic and live Custodian Library requirements", async () => {
    renderCard();

    expect(
      await screen.findByText("Transfer paperwork recommendation")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Asset handling: Client-directed — in kind or liquidate")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Liquidation is preferred for this custodian; follow the client’s request."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText("Apex signature: Wet signature required")
    ).toBeInTheDocument();
    expect(screen.getByText("Custodian Library — source of truth")).toBeInTheDocument();
    expect(screen.getAllByText("Required")).toHaveLength(2);
    expect(screen.getByText("Wet only")).toBeInTheDocument();
    expect(screen.getByText("Email / fax 410-581-5184")).toBeInTheDocument();
    expect(screen.getByText("Apex signs the paperwork.")).toBeInTheDocument();
    expect(
      screen.getByText(/current client-specific documentation wins/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/SSN\/Tax ID, delivering address, signatures/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/mapped holdings already saved on this transfer/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/does not run a new asset-mapping sync/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Joint account — two client signatures required")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/both client signature lines must be completed/i)
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Receiving Apex account title" })
    ).toHaveValue("Example Client - Traditional IRA");
    expect(
      screen.getByText(/not a live Apex title/i)
    ).toBeInTheDocument();
  });

  it("shows the mandatory second-signature instructions for a joint account", async () => {
    secondaryClientSignatureRequired = true;
    renderCard();

    expect(
      await screen.findByText(
        "Joint account — two client signatures required"
      )
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(/both account holders must sign/i)
    ).toHaveLength(2);
    expect(
      screen.getByText(/both client signature lines must be completed/i)
    ).toBeInTheDocument();
  });

  it("requires the source title and flags an inherited-account mismatch for the LOA", async () => {
    inheritedAccountTitleReviewRequired = true;
    const fetchSpy = global.fetch as ReturnType<typeof vi.fn>;
    renderCard();

    const deliveringTitle = await screen.findByRole("textbox", {
      name: "Delivering account title from current statement",
    });
    const apexTitleVerification = screen.getByRole("checkbox", {
      name: "I confirmed this account title matches Apex.",
    });
    const deliveringTitleVerification = screen.getByRole("checkbox", {
      name: /I confirmed this delivering title against the current statement/i,
    });
    const button = screen.getByRole("button", {
      name: "Download prefilled form",
    });

    expect(deliveringTitle).toHaveValue("Example Client");
    expect(
      screen.getByText(
        "Titles differ — the letter of authorization will be populated."
      )
    ).toBeInTheDocument();
    expect(button).toBeDisabled();

    fireEvent.change(deliveringTitle, {
      target: {
        value: "Example Client, Beneficiary of Previous Owner",
      },
    });
    fireEvent.click(apexTitleVerification);
    fireEvent.click(deliveringTitleVerification);
    expect(button).toBeEnabled();
    fireEvent.click(button);

    await waitFor(() => {
      const postCall = fetchSpy.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST"
      );
      expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
        ruleId: "t-rowe-price",
        assetInstruction: "LIQUIDATE",
        apexAccountTitle: "Example Client - Traditional IRA",
        apexAccountTitleVerified: true,
        deliveringAccountTitle:
          "Example Client, Beneficiary of Previous Owner",
        deliveringAccountTitleVerified: true,
      });
    });
  });

  it("downloads the generated form with the visible client instruction", async () => {
    const fetchSpy = global.fetch as ReturnType<typeof vi.fn>;
    renderCard();
    const button = await screen.findByRole("button", {
      name: "Download prefilled form",
    });

    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Client asset instruction" })
      ).toHaveValue("LIQUIDATE");
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Receiving Apex account title" }),
      { target: { value: "Exact Apex Registration" } }
    );
    expect(button).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "I confirmed this account title matches Apex.",
      })
    );
    fireEvent.click(button);

    await waitFor(() => {
      const postCall = fetchSpy.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST"
      );
      expect(postCall).toBeDefined();
      expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
        ruleId: "t-rowe-price",
        assetInstruction: "LIQUIDATE",
        apexAccountTitle: "Exact Apex Registration",
        apexAccountTitleVerified: true,
      });
      expect(URL.createObjectURL).toHaveBeenCalled();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:generated-form");
    });
  });

  it("requires the Apex title to be reconfirmed after an edit", async () => {
    renderCard();

    const title = await screen.findByRole("textbox", {
      name: "Receiving Apex account title",
    });
    const verification = screen.getByRole("checkbox", {
      name: "I confirmed this account title matches Apex.",
    });
    const button = screen.getByRole("button", {
      name: "Download prefilled form",
    });

    fireEvent.click(verification);
    expect(button).toBeEnabled();

    fireEvent.change(title, { target: { value: "Corrected Apex Title" } });
    expect(verification).not.toBeChecked();
    expect(button).toBeDisabled();
  });

  it("saves the confirmed Apex title and shows the saved timestamp", async () => {
    const fetchSpy = global.fetch as ReturnType<typeof vi.fn>;
    renderCard();

    const title = await screen.findByRole("textbox", {
      name: "Receiving Apex account title",
    });
    fireEvent.change(title, {
      target: { value: "Wren Halvorsen - Apex C/F Traditional IRA" },
    });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "I confirmed this account title matches Apex.",
      })
    );

    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PUT"
      );
      expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
        apexAccountTitle: "Wren Halvorsen - Apex C/F Traditional IRA",
        confirmed: true,
      });
      expect(screen.getByText(/Saved Sep 11, 2026/i)).toBeInTheDocument();
    });
  });

  it("restores a previously confirmed Apex title when the card is reopened", async () => {
    apexAccountTitleConfirmation = {
      title: "Wren Halvorsen - Apex C/F Traditional IRA",
      confirmedAt: "2026-09-11T17:55:00.000Z",
      confirmedBy: "ops@example.com",
    };
    renderCard();

    expect(
      await screen.findByRole("textbox", {
        name: "Receiving Apex account title",
      })
    ).toHaveValue("Wren Halvorsen - Apex C/F Traditional IRA");
    expect(
      screen.getByRole("checkbox", {
        name: "I confirmed this account title matches Apex.",
      })
    ).toBeChecked();
    expect(screen.getByText(/Saved Sep 11, 2026/i)).toBeInTheDocument();
    expect(
      screen.getByText(/saved title previously confirmed against Apex/i)
    ).toBeInTheDocument();
  });

  it("requires Victory's last-known receiving house number to be verified", async () => {
    global.fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          blob: () =>
            Promise.resolve(
              new Blob(["pdf"], { type: "application/pdf" })
            ),
          headers: new Headers(),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            status: "ACTION_REQUIRED",
            apexAccountTitleSuggestion: "Example Client - Traditional IRA",
            custodian: {
              id: "CUST-VICTORY",
              name: "Victory Funds",
              receivingAccountNumber: "DEMOOMNI01",
              signature: "Wet only",
              letterOfAcceptance: "Required",
              medallionRequired: "Required",
              liquidationMethod: "Check",
              returnMethod: "Fax",
              watchouts: "Verify the live receiving number.",
            },
            candidates: [
              {
                id: "victory-funds",
                custodianName: "Victory Funds",
                displayName: "Victory Funds",
                template: "APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST",
                apexTransferSelection: "MUTUAL_FUND_COMPANY_TRANSFER",
                assetHandling: {
                  mode: "FIXED",
                  instruction: "LIQUIDATE",
                },
                requiresVerifiedReceivingAccountNumber: true,
              },
            ],
            actions: [
              {
                code: "VERIFY_RECEIVING_ACCOUNT_NUMBER",
                message:
                  "Verify the receiving/house account number with Apex MF Ops before generating.",
              },
            ],
            discrepancies: [],
            sourceGuidance: [],
          }),
      } as Response);
    }) as typeof fetch;

    const fetchSpy = global.fetch as ReturnType<typeof vi.fn>;
    renderCard();

    const input = await screen.findByRole("textbox", {
      name: "Verified receiving / house account number",
    });
    const verification = screen.getByRole("checkbox", {
      name: /I verified this receiving\/house number with Apex MF Ops/i,
    });
    const accountTitleVerification = screen.getByRole("checkbox", {
      name: "I confirmed this account title matches Apex.",
    });
    const button = screen.getByRole("button", {
      name: "Download prefilled form",
    });

    expect(input).toHaveValue("DEMOOMNI01");
    expect(
      screen.getByText(/DEMOOMNI01 is the last-known Victory value/i)
    ).toBeInTheDocument();
    expect(button).toBeDisabled();

    fireEvent.click(verification);
    fireEvent.click(accountTitleVerification);
    expect(button).toBeEnabled();
    fireEvent.click(button);

    await waitFor(() => {
      const postCall = fetchSpy.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST"
      );
      expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
        ruleId: "victory-funds",
        assetInstruction: "LIQUIDATE",
        receivingAccountNumber: "DEMOOMNI01",
        receivingAccountNumberVerified: true,
        apexAccountTitle: "Example Client - Traditional IRA",
        apexAccountTitleVerified: true,
      });
    });
  });

  it("shows the standard brokerage default for Schwab", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            status: "ACTION_REQUIRED",
            apexAccountTitleSuggestion: "Example Client - Brokerage / Individual",
            custodian: {
              id: "CUST-SCHWAB",
              name: "Charles Schwab",
              signature: "Full DocuSign",
              letterOfAcceptance: "Not required",
              medallionRequired: "Not required",
              liquidationMethod: null,
              returnMethod: null,
              watchouts: null,
            },
            candidates: [
              {
                id: "default-brokerage-firm-transfer",
                custodianName: "Charles Schwab",
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
                note: "No custodian-specific form rule is configured for Charles Schwab.",
              },
            ],
            actions: [
              {
                code: "VERIFY_DEFAULT_BROKERAGE_WORKFLOW",
                message:
                  "A custodian-specific form rule is not on file. Brokerage Firm Transfer is selected by default.",
              },
            ],
            discrepancies: [],
            sourceGuidance: [],
          }),
      } as Response)
    ) as typeof fetch;

    renderCard();

    expect(
      await screen.findByText("Standard brokerage transfer")
    ).toBeInTheDocument();
    expect(screen.getByText("Standard default")).toBeInTheDocument();
    expect(
      screen.getByText(/Apex section: brokerage firm transfer/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Client asset instruction" })
    ).toHaveValue("IN_KIND");
    const button = screen.getByRole("button", {
      name: "Download prefilled form",
    });
    expect(button).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "I confirmed this account title matches Apex.",
      })
    );
    expect(button).toBeEnabled();
  });
});
