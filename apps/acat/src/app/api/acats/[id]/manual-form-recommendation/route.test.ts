// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { createHash } from "node:crypto";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));
vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

const { GET, POST, PUT } = await import("./route");
const { prisma } = await import("@/lib/prisma");

const context = { params: Promise.resolve({ id: "ACAT-1" }) };
const request = new Request(
  "http://localhost/api/acats/ACAT-1/manual-form-recommendation"
) as Parameters<typeof GET>[0];

function postRequest(
  body: Record<string, unknown>,
  options: { includeApexAccountTitleVerification?: boolean } = {}
) {
  const includeVerification =
    options.includeApexAccountTitleVerification !== false;
  return new Request(
    "http://localhost/api/acats/ACAT-1/manual-form-recommendation",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(includeVerification
          ? {
              apexAccountTitle: "Example Client - Traditional IRA",
              apexAccountTitleVerified: true,
            }
          : {}),
        ...body,
      }),
    }
  ) as Parameters<typeof POST>[0];
}

function putRequest(body: Record<string, unknown>) {
  return new Request(
    "http://localhost/api/acats/ACAT-1/manual-form-recommendation",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  ) as Parameters<typeof PUT>[0];
}

function mockGenerationRecord(name: string) {
  return {
    clientName: "Example Client",
    accountType: "Traditional IRA",
    apexAccountId: "BLU123",
    statementAccountNumber: "OLD456",
    transferringContra: name,
    transferWorkflow: "MANUAL",
    dtccNumber: name === "Victory Funds" ? "5686" : "0443",
    assets: [
      {
        symbol: "FUNDX",
        description: "Example Fund",
        cusip: "123456789",
        expectedQty: 10,
      },
    ],
    custodian: {
      id: `CUST-${name}`,
      name,
      receivingAccountNumber:
        name === "Victory Funds" ? "DEMOOMNI01" : null,
      signature: "Wet only",
      letterOfAcceptance: "Required",
      medallionRequired: "Required",
      liquidationMethod: "Check",
      returnMethod: "Fax",
      watchouts: "Review current documents.",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({
    user: { email: "ops@example.com", role: "USER" },
  });
});

describe("POST /api/acats/[id]/manual-form-recommendation", () => {
  it("generates the supplied Apex PDF and enforces Victory liquidation", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockGenerationRecord("Victory Funds")
    );

    const response = await POST(
      postRequest({
        ruleId: "victory-funds",
        // A caller cannot override Victory's fixed current rule.
        assetInstruction: "IN_KIND",
        apexAccountTitle: "Exact Apex Registration",
        receivingAccountNumber: "DEMOOMNI01",
        receivingAccountNumberVerified: true,
      }),
      context
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain(
      "Example-Client-Apex-CATR.pdf"
    );
    const pdf = await PDFDocument.load(await response.arrayBuffer());
    const form = pdf.getForm();
    expect(form.getCheckBox("TRANSFER-Liquidate 6").isChecked()).toBe(true);
    expect(form.getCheckBox("TRANSFER-Transfer In Kind 6").isChecked()).toBe(
      false
    );
    expect(
      form.getCheckBox("FUTURE DIVIDEND-Pay In Cash 1").isChecked()
    ).toBe(true);
    expect(
      form.getCheckBox("FUTURE CAPITAL GAINS-Pay In Cash 1").isChecked()
    ).toBe(true);
    expect(form.getTextField("SSNTAX ID NO").getText() ?? "").toBe("");
    expect(form.getTextField("DELIVERING FIRM NAME").getText()).toBe(
      "Victory Funds"
    );
    expect(form.getTextField("ACCOUNT NO_2").getText()).toBe("OLD456");
    expect(form.getTextField("APEX CLEARING ACCOUNT NO_2").getText()).toBe(
      "BLU123"
    );
    expect(form.getTextField("APEX CLEARING ACCOUNT NO").getText()).toBe(
      "BLU123"
    );
    expect(form.getTextField("ACCOUNT TITLE").getText()).toBe(
      "Exact Apex Registration"
    );
    expect(form.getTextField("ACCOUNT TITLE_4").getText()).toBe(
      "Exact Apex Registration"
    );
    expect(
      form.getTextField("CEDAR_RIDGE RECEIVING OMNIBUS ACCOUNT").getText()
    ).toBe("APEX OMNIBUS / HOUSE ACCT: DEMOOMNI01");
    expect(
      form
        .getTextField("CEDAR_RIDGE RECEIVING OMNIBUS ACCOUNT")
        .acroField.getDefaultAppearance()
    ).toContain("1 0 0 rg");
    expect(form.getTextField("RECEIVING FIRM NAME").getText()).toBe(
      "Apex Clearing Corporation"
    );
    expect(form.getTextField("FUND NAMESYMBOLCUSIPRow1").getText()).toContain(
      "FUNDX"
    );
    expect(form.getTextField("FUND NAMESYMBOLCUSIPRow1").getText()).toContain(
      "CUSIP 123456789"
    );
    expect(form.getTextField(" OF SHARESTransfer In Kind Liquidate").getText()).toBe(
      "All"
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "manual-form-generate",
        newValue: "victory-funds:LIQUIDATE",
      }),
    });
  });

  it("blocks Victory generation until the receiving house number is verified", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockGenerationRecord("Victory Funds")
    );

    const response = await POST(
      postRequest({
        ruleId: "victory-funds",
        receivingAccountNumber: "DEMOOMNI01",
      }),
      context
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        "Verify the receiving/house account number with Apex MF Ops before generating",
    });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("blocks generation until the receiving Apex account title is verified", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockGenerationRecord("T. Rowe Price / Pershing")
    );

    const response = await POST(
      postRequest(
        { ruleId: "t-rowe-price" },
        { includeApexAccountTitleVerification: false }
      ),
      context
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid form-generation request",
    });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("blocks inherited-account generation until the delivering title is verified", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockGenerationRecord("Charles Schwab"),
      accountType: "Inherited Traditional IRA (w/ beneficiaries)",
    });

    const response = await POST(
      postRequest({
        apexAccountTitle: "Example Client - Inherited Traditional IRA",
      }),
      context
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        "Confirm the exact delivering account title from the current statement before generating",
    });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("populates the LOA for an inherited-account title mismatch", async () => {
    const record = mockGenerationRecord("Charles Schwab");
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...record,
      accountType: "Inherited Traditional IRA (w/ beneficiaries)",
      custodian: {
        ...record.custodian,
        letterOfAcceptance: "Not required",
      },
    });

    const response = await POST(
      postRequest({
        apexAccountTitle: "Example Client - Inherited Traditional IRA",
        deliveringAccountTitle:
          "Example Client, Beneficiary of Previous Owner",
        deliveringAccountTitleVerified: true,
      }),
      context
    );

    expect(response.status).toBe(200);
    const pdf = await PDFDocument.load(await response.arrayBuffer());
    const form = pdf.getForm();
    expect(form.getTextField("ACCOUNT TITLE_2").getText()).toBe(
      "Example Client, Beneficiary of Previous Owner"
    );
    expect(form.getTextField("ACCOUNT TITLE_3").getText()).toBe(
      "Example Client, Beneficiary of Previous Owner"
    );
    expect(form.getTextField("ACCOUNT TITLE_4").getText()).toBe(
      "Example Client - Inherited Traditional IRA"
    );
    expect(form.getTextField("RECEIVING FIRM NAME").getText()).toBe(
      "Apex Clearing Corporation"
    );
  });

  it("leaves the LOA blank when verified inherited-account titles match", async () => {
    const record = mockGenerationRecord("Charles Schwab");
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...record,
      accountType: "Inherited Roth IRA",
      custodian: {
        ...record.custodian,
        letterOfAcceptance: "Not required",
      },
    });

    const exactTitle = "Example Client - Inherited Roth IRA";
    const response = await POST(
      postRequest({
        apexAccountTitle: exactTitle,
        deliveringAccountTitle: exactTitle,
        deliveringAccountTitleVerified: true,
      }),
      context
    );

    expect(response.status).toBe(200);
    const pdf = await PDFDocument.load(await response.arrayBuffer());
    const form = pdf.getForm();
    expect(form.getTextField("ACCOUNT TITLE_3").getText() ?? "").toBe("");
    expect(form.getTextField("ACCOUNT TITLE_4").getText() ?? "").toBe("");
  });

  it("uses T. Rowe Price's liquidation preference when no instruction is supplied", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockGenerationRecord("T. Rowe Price / Pershing")
    );

    const response = await POST(postRequest({ ruleId: "t-rowe-price" }), context);
    const pdf = await PDFDocument.load(await response.arrayBuffer());
    expect(pdf.getForm().getCheckBox("TRANSFER-Liquidate 6").isChecked()).toBe(
      true
    );
  });

  it("generates reviewed paperwork for a non-manual transfer workflow", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        ...mockGenerationRecord("Victory Funds"),
        transferWorkflow: "ACAT",
      }
    );

    const response = await POST(
      postRequest({
        ruleId: "victory-funds",
        receivingAccountNumber: "DEMOOMNI01",
        receivingAccountNumberVerified: true,
      }),
      context
    );

    expect(response.status).toBe(200);
    const pdf = await PDFDocument.load(await response.arrayBuffer());
    expect(pdf.getForm().getCheckBox("TRANSFER-Liquidate 6").isChecked()).toBe(
      true
    );
  });

  it("defaults other custodians to in kind", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        ...mockGenerationRecord("BNY Investments"),
        dtccNumber: "5523",
      }
    );

    const response = await POST(postRequest({ ruleId: "bny-mellon" }), context);
    const pdf = await PDFDocument.load(await response.arrayBuffer());
    expect(
      pdf.getForm().getCheckBox("TRANSFER-Transfer In Kind 6").isChecked()
    ).toBe(true);
  });

  it("generates a brokerage-firm transfer for Schwab without a specialized rule", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        ...mockGenerationRecord("Charles Schwab"),
        dtccNumber: "0164",
      }
    );

    const response = await POST(postRequest({}), context);

    expect(response.status).toBe(200);
    const pdf = await PDFDocument.load(await response.arrayBuffer());
    const form = pdf.getForm();
    expect(form.getCheckBox("BROKERAGE FIRM TRANSFER").isChecked()).toBe(true);
    expect(
      form.getCheckBox("LIQUIDATE ALL ASSETS & TRANSFER AS CASH").isChecked()
    ).toBe(false);
    expect(
      form.getCheckBox("TRANSFER-Transfer In Kind 6").isChecked()
    ).toBe(false);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        newValue: "default-brokerage-firm-transfer:IN_KIND",
      }),
    });
  });

  it("blocks partial-transfer paperwork while any holding is undecided", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockGenerationRecord("Charles Schwab"),
      type: "Partial",
      assets: [
        {
          symbol: "AAPL",
          description: "Apple",
          cusip: "037833100",
          expectedQty: 10,
          includeInTransfer: null,
        },
      ],
    });

    const response = await POST(postRequest({}), context);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/1 undecided/);
  });

  // This exercises real PDF generation and reopens the archived bytes. Allow
  // shared CI runners more than the default 5s without relaxing any assertions.
  it("puts only included holdings on partial-transfer paperwork", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockGenerationRecord("Charles Schwab"),
      type: "Partial",
      assets: [
        {
          symbol: "AAPL",
          description: "Apple",
          cusip: "037833100",
          expectedQty: 10,
          includeInTransfer: true,
        },
        {
          symbol: "MSFT",
          description: "Microsoft",
          cusip: "594918104",
          expectedQty: 20,
          includeInTransfer: false,
        },
      ],
    });

    const response = await POST(postRequest({}), context);
    expect(response.status).toBe(200);
    const bytes = Buffer.from(await response.arrayBuffer());
    const archived = vi.mocked(prisma.acatDocument.create).mock.calls[0][0].data;
    // Compare the complete PDF bytes without deep-walking a multi-MB Buffer.
    expect(Buffer.from(archived.content).equals(bytes)).toBe(true);
    expect(archived.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(archived).toMatchObject({
      kind: "TRANSFER_FORM", includedCount: 1, excludedCount: 1, undecidedCount: 0,
      createdBy: "ops@example.com", acatRecord: { connect: { id: "ACAT-1", deletedAt: null } },
    });
    expect(archived.inputCsv).toContain('"MSFT","Microsoft","594918104","20","","","No"');
    expect(response.headers.get("X-Transfer-Document-Id")).toBe("DOC-1");
    const pdf = await PDFDocument.load(bytes);
    const form = pdf.getForm();
    expect(form.getCheckBox("PARTIAL TRANSFER").isChecked()).toBe(true);
    expect(form.getTextField("ASSETS DESCRIPTIONSYMBOLRow1").getText()).toContain("AAPL");
    expect(form.getTextField("ASSETS DESCRIPTIONSYMBOLRow2").getText() ?? "").not.toContain("MSFT");
  }, 15_000);

  it("requires an explicit workflow when current documents must choose", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockGenerationRecord("Acorns")
    );

    const response = await POST(postRequest({}), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Select the form workflow supported by the current documentation",
    });
  });

  it("does not return an unarchived PDF if persistence fails", async () => {
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue(mockGenerationRecord("Charles Schwab") as never);
    vi.mocked(prisma.acatDocument.create).mockRejectedValueOnce(new Error("Archive unavailable"));
    const response = await POST(postRequest({}), context);
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).not.toBe("application/pdf");
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("denies advisor access before reading or saving documents", async () => {
    mockAuth.mockResolvedValue({ user: { email: "advisor@example.test", role: "ADVISOR" } });
    expect((await GET(request, context)).status).toBe(403);
    expect((await POST(postRequest({}), context)).status).toBe(403);
    expect((await PUT(putRequest({}), context)).status).toBe(403);
    expect(prisma.acatRecord.findUnique).not.toHaveBeenCalled();
    expect(prisma.acatDocument.create).not.toHaveBeenCalled();
  });

  it("switches the Apex transfer section when a Acorns client chooses liquidation", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockGenerationRecord("Acorns")
    );

    const response = await POST(
      postRequest({
        ruleId: "acorns-computershare",
        assetInstruction: "LIQUIDATE",
      }),
      context
    );
    const pdf = await PDFDocument.load(await response.arrayBuffer());
    const form = pdf.getForm();
    expect(
      form.getCheckBox("LIQUIDATE ALL ASSETS & TRANSFER AS CASH").isChecked()
    ).toBe(true);
    expect(form.getCheckBox("BROKERAGE FIRM TRANSFER").isChecked()).toBe(false);
  });

  it("rejects form generation without a session", async () => {
    mockAuth.mockResolvedValue(null);
    const response = await POST(postRequest({}), context);
    expect(response.status).toBe(401);
    expect(prisma.acatRecord.findUnique).not.toHaveBeenCalled();
  });
});

describe("GET /api/acats/[id]/manual-form-recommendation", () => {
  it("returns a recommendation joined to the Custodian Library", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      clientName: "Example Client",
      accountType: "Traditional IRA",
      transferWorkflow: "MANUAL",
      dtccNumber: "0443",
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
    });

    const response = await GET(request, context);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe("ACTION_REQUIRED");
    expect(data.apexAccountTitleSuggestion).toBe(
      "Example Client - Traditional IRA"
    );
    expect(data.deliveringAccountTitleSuggestion).toBe("Example Client");
    expect(data.candidates[0]).toEqual(
      expect.objectContaining({
        id: "t-rowe-price",
        apexSignatureRequirement: "WET_REQUIRED",
      })
    );
    expect(data.custodian).toEqual(
      expect.objectContaining({
        letterOfAcceptance: "Required",
        returnMethod: "Email / fax 410-581-5184",
      })
    );
    expect(prisma.acatRecord.findUnique).toHaveBeenCalledWith({
      where: { id: "ACAT-1", deletedAt: null },
      select: expect.objectContaining({
        clientName: true,
        accountType: true,
        transferringContra: true,
        dtccNumber: true,
        custodian: expect.any(Object),
      }),
    });
  });

  it("offers the standard brokerage fallback when no custodian is linked", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      clientName: "Example Client",
      accountType: null,
      transferWorkflow: "MANUAL",
      transferringContra: "Legacy Brokerage",
      dtccNumber: null,
      custodian: null,
    });

    const response = await GET(request, context);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        status: "ACTION_REQUIRED",
        apexAccountTitleSuggestion: "Example Client",
        deliveringAccountTitleSuggestion: "Example Client",
        custodian: null,
        candidates: [
          expect.objectContaining({
            id: "default-brokerage-firm-transfer",
            custodianName: "Legacy Brokerage",
          }),
        ],
      })
    );
  });

  it("returns the saved verified Apex title instead of regenerating the default", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      clientName: "Wren Halvorsen",
      accountType: "Traditional IRA",
      type: "Partial",
      transferringContra: "Morgan Stanley",
      dtccNumber: "0015",
      verifiedApexAccountTitle: "Wren Halvorsen - Apex C/F Traditional IRA",
      verifiedApexAccountTitleAt: "2026-09-11T17:55:00.000Z",
      verifiedApexAccountTitleBy: "ops@example.com",
      assets: [],
      custodian: null,
    });

    const response = await GET(request, context);
    const data = await response.json();
    expect(data.apexAccountTitleSuggestion).toBe(
      "Wren Halvorsen - Apex C/F Traditional IRA"
    );
    expect(data.apexAccountTitleConfirmation).toEqual({
      title: "Wren Halvorsen - Apex C/F Traditional IRA",
      confirmedAt: "2026-09-11T17:55:00.000Z",
      confirmedBy: "ops@example.com",
    });
  });

  it("requires source-title review for an inherited account", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      clientName: "Example Client",
      accountType: "Inherited Roth IRA",
      transferWorkflow: "ACAT",
      transferringContra: "Charles Schwab",
      dtccNumber: "0164",
      custodian: mockGenerationRecord("Charles Schwab").custodian,
    });

    const response = await GET(request, context);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.inheritedAccountTitleReviewRequired).toBe(true);
    expect(data.deliveringAccountTitleSuggestion).toBe("Example Client");
    expect(data.actions).toContainEqual(
      expect.objectContaining({
        code: "VERIFY_INHERITED_ACCOUNT_TITLES",
      })
    );
  });

  it("flags both client signatures as mandatory for a joint account", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      clientName: "Example Clients",
      accountType: "Joint Account (JTWROS - Rights of Survivorship)",
      transferWorkflow: "ACAT",
      transferringContra: "Charles Schwab",
      dtccNumber: "0164",
      custodian: {
        ...mockGenerationRecord("Charles Schwab").custodian,
        signature: "Full DocuSign",
      },
    });

    const response = await GET(request, context);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.secondaryClientSignatureRequired).toBe(true);
    expect(data.actions).toContainEqual(
      expect.objectContaining({
        code: "REQUIRE_SECONDARY_CLIENT_SIGNATURE",
        message: expect.stringMatching(/both account holders must sign/i),
      })
    );
  });

  it("returns 401 without a session", async () => {
    mockAuth.mockResolvedValue(null);
    const response = await GET(request, context);
    expect(response.status).toBe(401);
    expect(prisma.acatRecord.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown record", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      null
    );
    const response = await GET(request, context);
    expect(response.status).toBe(404);
  });

  it("returns 500 when the database read fails", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("DB down")
    );
    const response = await GET(request, context);
    expect(response.status).toBe(500);
  });
});

describe("PUT /api/acats/[id]/manual-form-recommendation", () => {
  it("persists a confirmed Apex title with who and when", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      verifiedApexAccountTitle: null,
    });
    (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      verifiedApexAccountTitle: "Wren Halvorsen - Apex C/F Traditional IRA",
      verifiedApexAccountTitleAt: "2026-09-11T17:55:00.000Z",
      verifiedApexAccountTitleBy: "ops@example.com",
    });

    const response = await PUT(
      putRequest({
        apexAccountTitle: "Wren Halvorsen - Apex C/F Traditional IRA",
        confirmed: true,
      }),
      context
    );

    expect(response.status).toBe(200);
    expect(prisma.acatRecord.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ACAT-1" },
        data: expect.objectContaining({
          verifiedApexAccountTitle: "Wren Halvorsen - Apex C/F Traditional IRA",
          verifiedApexAccountTitleBy: "ops@example.com",
        }),
      })
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "apex-account-title-confirm",
        field: "verifiedApexAccountTitle",
      }),
    });
  });

  it("rejects saving a title without a session", async () => {
    mockAuth.mockResolvedValue(null);
    const response = await PUT(
      putRequest({ apexAccountTitle: "Exact title", confirmed: true }),
      context
    );
    expect(response.status).toBe(401);
  });
});

describe("POST /api/acats/[id]/manual-form-recommendation in the public demo", () => {
  beforeEach(() => {
    vi.stubEnv("PERSONA_SIGN_IN", "on");
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue(mockGenerationRecord("Charles Schwab") as never);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("refuses before building the PDF when the demo holds its documents cap", async () => {
    vi.mocked(prisma.acatDocument.count).mockResolvedValue(300);
    const response = await POST(postRequest({}), context);
    expect(response.status).toBe(429);
    expect((await response.json()).error).toMatch(/^The demo holds up to 300 documents/);
    // Refused before the PDF was built: the save, which takes the cap's lock, was never reached.
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.acatDocument.create).not.toHaveBeenCalled();
  });

  it("holds the byte cap in the save's own transaction", async () => {
    vi.mocked(prisma.acatDocument.count).mockResolvedValue(40);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ n: BigInt(50 * 1024 * 1024 - 1000) }] as never);
    const response = await POST(postRequest({}), context);
    expect(response.status).toBe(429);
    expect((await response.json()).error).toMatch(/^The demo holds up to 50 MB of documents/);
    expect(prisma.$executeRaw).toHaveBeenCalled();
    expect(prisma.acatDocument.create).not.toHaveBeenCalled();
  });
});
