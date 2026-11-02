import { beforeEach, describe, expect, it, vi } from "vitest";
import { IRA_BENEFICIARY_DEFINITION } from "@/lib/forms/ira-beneficiary-definition";
import { ACAT_DEFINITION } from "@/lib/forms/acat-definition";

vi.mock("server-only", () => ({}));

const { accountSpy, clientSpy, fillSpy, fillAcatSpy, templateSpy } = vi.hoisted(() => ({
  accountSpy: vi.fn(),
  clientSpy: vi.fn(),
  fillSpy: vi.fn(),
  fillAcatSpy: vi.fn(),
  templateSpy: vi.fn(),
}));

vi.mock("@/lib/data/account-aum", () => ({ apexAccountByCustodianId: accountSpy }));
vi.mock("@/lib/data/clients", () => ({ getClientWithHousehold: clientSpy }));
vi.mock("@/lib/forms/template.server", () => ({
  FormTemplateIntegrityError: class FormTemplateIntegrityError extends Error {},
  loadFormTemplate: templateSpy,
}));
vi.mock("@/lib/forms/ira-beneficiary", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/forms/ira-beneficiary")>();
  return { ...actual, fillIraBeneficiaryPdf: fillSpy };
});
vi.mock("@/lib/forms/acat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/forms/acat")>();
  return { ...actual, fillAcatPdf: fillAcatSpy };
});

import { generateForm } from "@/lib/forms/generate-form.server";
import { IraBeneficiaryRenderError } from "@/lib/forms/ira-beneficiary";
import { AcatRenderError, AcatTemplateError } from "@/lib/forms/acat";

const identity = { role: "OPERATIONS", email: "ops@example.test" };
const validValues = {
  accountHolderName: "Jordan Sample",
  accountHolderTaxId: "900000001",
  certifyNotMarried: false,
  primary: [
    {
      fullName: "Adah Sample",
      relationship: "Family",
      dateOfBirth: "01/02/1980",
      telephoneNumber: "202-555-0100",
      sharePercentage: 100,
      address: "100 Example Avenue, Sample City, NY 10001",
      emailAddress: "taylor@example.test",
      taxId: "900000002",
    },
  ],
  contingent: [],
};

const validRequest = {
  formId: IRA_BENEFICIARY_DEFINITION.id,
  clientId: "C-1",
  accountIds: ["custodian-account-1"],
  values: validValues,
};

describe("generateForm", () => {
  beforeEach(() => {
    accountSpy.mockReset();
    clientSpy.mockReset();
    fillSpy.mockReset();
    fillAcatSpy.mockReset();
    templateSpy.mockReset();
    clientSpy.mockResolvedValue({
      sf_id: "C-1",
      name: "Jordan Sample",
      email: null,
      household: null,
    });
    accountSpy.mockResolvedValue({
      custodianAccountId: "custodian-account-1",
      apexAccountNumber: "DBW-9974",
      accountType: "Traditional IRA",
      accountStatus: "OPEN",
      clientSfId: "C-1",
    });
    templateSpy.mockResolvedValue(new Uint8Array([1, 2, 3]));
    fillSpy.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
    fillAcatSpy.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
  });

  it("rejects an unknown form before reading client data", async () => {
    const result = await generateForm(identity, { ...validRequest, formId: "unknown_form" });
    expect(result).toEqual({ ok: false, status: 404, code: "form_not_found" });
    expect(clientSpy).not.toHaveBeenCalled();
    expect(accountSpy).not.toHaveBeenCalled();
  });

  it.each(["client", "partial", "staff"])("fails closed when the account belongs to a different client (%s completion)", async (beneficiaryCompletion) => {
    accountSpy.mockResolvedValue({
      custodianAccountId: "custodian-account-1",
      apexAccountNumber: "DBW-9974",
      accountType: "Traditional IRA",
      clientSfId: "C-2",
    });
    const result = await generateForm(identity, {
      ...validRequest,
      values: { ...validValues, beneficiaryCompletion, primary: beneficiaryCompletion === "client" ? [] : validValues.primary },
    });
    expect(result).toEqual({ ok: false, status: 404, code: "client_account_not_found" });
    expect(fillSpy).not.toHaveBeenCalled();
  });

  it("blocks an ineligible account using registry metadata", async () => {
    accountSpy.mockResolvedValue({
      custodianAccountId: "custodian-account-1",
      apexAccountNumber: "DBW-9974",
      accountType: "Individual Brokerage",
      clientSfId: "C-1",
    });
    const result = await generateForm(identity, validRequest);
    expect(result).toMatchObject({ ok: false, status: 422, code: "account_not_eligible" });
    expect(fillSpy).not.toHaveBeenCalled();
  });

  it("returns form-specific validation issues without rendering", async () => {
    const result = await generateForm(identity, {
      ...validRequest,
      values: { ...validValues, primary: [] },
    });
    expect(result).toMatchObject({
      ok: false,
      status: 422,
      code: "validation_failed",
      issues: expect.arrayContaining([
        { path: "primary", message: "Add at least one primary beneficiary" },
      ]),
    });
    expect(fillSpy).not.toHaveBeenCalled();
  });

  it("renders a holder-only client draft with the authorized account and explicit completion metadata", async () => {
    const result = await generateForm(identity, {
      ...validRequest,
      values: {
        beneficiaryCompletion: "client",
        accountHolderTaxId: validValues.accountHolderTaxId,
        accountNumber: "WRONG-ACCOUNT",
      },
    });
    expect(result).toMatchObject({ ok: true, clientCompletionRequired: true, reviewState: "ready_for_human_review" });
    expect(fillSpy).toHaveBeenCalledWith(expect.any(Uint8Array), {
      beneficiaryCompletion: "client",
      accountHolderName: "Jordan Sample",
      accountHolderTaxId: "900000001",
      accountNumber: "DBW-9974",
      certifyNotMarried: false,
      primary: [],
      contingent: [],
    });
    if (!result.ok) return;
    for (const metadata of [result.provenance, result.audit]) {
      expect(JSON.stringify(metadata)).not.toContain("900000001");
      expect(JSON.stringify(metadata)).not.toContain("Jordan Sample");
      expect(JSON.stringify(metadata)).not.toContain("DBW-9974");
    }
  });

  it.each([
    [{ beneficiaryCompletion: "invalid", primary: [] }, "beneficiaryCompletion"],
    [{ beneficiaryCompletion: "client" }, "primary"],
    [{ beneficiaryCompletion: "client", primary: [], accountHolderTaxId: "0001" }, "accountHolderTaxId"],
  ])("rejects invalid client-draft values without loading or rendering a PDF (%j)", async (values, issuePath) => {
    const result = await generateForm(identity, { ...validRequest, values: { ...validValues, ...values } });
    expect(result).toMatchObject({
      ok: false,
      status: 422,
      code: "validation_failed",
      issues: expect.arrayContaining([expect.objectContaining({ path: issuePath })]),
    });
    expect(templateSpy).not.toHaveBeenCalled();
    expect(fillSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["client", undefined, true], ["client", "", true], ["client", "   ", true], ["client", "900-00-0001", true],
    ["staff", undefined, true], ["staff", "", true], ["staff", "   ", true], ["staff", "900-00-0001", false],
  ] as const)("reports client completion for %s mode and holder tax ID %j as %s", async (beneficiaryCompletion, accountHolderTaxId, clientCompletionRequired) => {
    const result = await generateForm(identity, {
      ...validRequest,
      values: {
        ...validValues, beneficiaryCompletion, accountHolderTaxId,
        primary: beneficiaryCompletion === "client" ? [] : validValues.primary,
      },
    });
    expect(result).toMatchObject({ ok: true, reviewState: "ready_for_human_review", clientCompletionRequired });
    expect(fillSpy).toHaveBeenCalledWith(expect.any(Uint8Array), expect.objectContaining({
      accountHolderTaxId: accountHolderTaxId?.trim() ? "900000001" : "",
      accountNumber: "DBW-9974",
    }));
    if (!result.ok) return;
    expect(result.provenance).toContainEqual(expect.objectContaining({
      canonicalKey: "account.owner.tax_id", source: "manual", sourcePath: null, valueRetention: "transient_only",
    }));
    expect(JSON.stringify([result.provenance, result.audit])).not.toContain("900000001");
  });

  it("never fills a missing holder SSN from client or account source fields, including last four", async () => {
    clientSpy.mockResolvedValue({ sf_id: "C-1", name: "Jordan Sample", taxIdLast4: "9876", accountHolderTaxId: "900999876" });
    accountSpy.mockResolvedValue({
      custodianAccountId: "custodian-account-1", apexAccountNumber: "DBW-9974", accountType: "Traditional IRA",
      clientSfId: "C-1", taxIdLast4: "9876", accountHolderTaxId: "900999876",
    });
    const result = await generateForm(identity, {
      ...validRequest, values: { beneficiaryCompletion: "client", primary: [], contingent: [] },
    });
    expect(result).toMatchObject({ ok: true, clientCompletionRequired: true });
    expect(fillSpy).toHaveBeenCalledWith(expect.any(Uint8Array), expect.objectContaining({ accountHolderTaxId: "" }));
    expect(JSON.stringify(fillSpy.mock.calls)).not.toContain("9876");
    expect(JSON.stringify(result)).not.toContain("9876");
  });

  it.each(["0001", "***-**-0001", "abc900000001", "900.00.0001", null, 900000001])("rejects a provided incomplete or malformed holder SSN before loading a PDF (%j)", async (accountHolderTaxId) => {
    const result = await generateForm(identity, { ...validRequest, values: { ...validValues, accountHolderTaxId } });
    expect(result).toEqual({ ok: false, status: 422, code: "validation_failed", issues: [{ path: "accountHolderTaxId", message: "Enter a nine-digit SSN or TIN, or leave blank for the client" }] });
    expect(templateSpy).not.toHaveBeenCalled();
    expect(fillSpy).not.toHaveBeenCalled();
  });

  it("uses the server-authorized account number and returns metadata-only provenance", async () => {
    const result = await generateForm(identity, {
      ...validRequest,
      values: { ...validValues, accountHolderName: "Jordan Legal Sample", accountNumber: "WRONG-ACCOUNT" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(fillSpy).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({
        accountNumber: "DBW-9974",
        accountHolderName: "Jordan Legal Sample",
      }),
    );
    expect(result.filename).toBe("5050P-UBEN-9974.pdf");
    expect(result.reviewState).toBe("ready_for_human_review");
    expect(result.clientCompletionRequired).toBe(false);
    expect(result.audit).toMatchObject({
      generatedBy: "ops@example.test",
      formId: IRA_BENEFICIARY_DEFINITION.id,
      formVersion: "2025-07-17",
    });
    expect(result.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonicalKey: "account.owner.full_legal_name",
          sourcePath: "mirror.client.first_name + mirror.client.last_name",
          overridden: true,
          valueRetention: "transient_only",
        }),
        expect.objectContaining({
          canonicalKey: "account.owner.tax_id",
          source: "manual",
          sensitivity: "restricted_pii",
          valueRetention: "transient_only",
        }),
      ]),
    );
    expect(JSON.stringify(result.provenance)).not.toContain("900000001");
    expect(JSON.stringify(result.provenance)).not.toContain("900000002");
  });

  it("returns actionable rendering issues rather than a partial or clipped PDF", async () => {
    const issues = [{ path: "primary.0.fullName", message: "This value cannot fit legibly on the form." }];
    fillSpy.mockRejectedValue(new IraBeneficiaryRenderError(issues));
    expect(await generateForm(identity, validRequest)).toEqual({
      ok: false, status: 422, code: "validation_failed", issues,
    });
  });

  describe("partial beneficiary adapter", () => {
    it("passes only known beneficiary fields to the PDF and never fills gaps from holder data", async () => {
      clientSpy.mockResolvedValue({
        sf_id: "C-1", name: "Morgan Owner", telephoneNumber: "202-555-0199", emailAddress: "holder@example.test",
        dateOfBirth: "01/02/1960", address: "PRIVATE-HOLDER-ADDRESS", taxId: "900999999",
      });
      const result = await generateForm(identity, { ...validRequest, values: {
        accountHolderName: "Morgan Owner", accountHolderTaxId: "900000001", beneficiaryCompletion: "partial",
        accountNumber: "FORGED-NUMBER", primary: [{}, { fullName: "John", relationship: "husband" }],
      } });
      expect(result).toMatchObject({ ok: true, clientCompletionRequired: true });
      expect(fillSpy).toHaveBeenCalledWith(expect.any(Uint8Array), expect.objectContaining({
        accountNumber: "DBW-9974", certifyNotMarried: false,
        primary: [
          { fullName: "", relationship: "", dateOfBirth: "", telephoneNumber: "", emailAddress: "", address: "", taxId: "", sharePercentage: null },
          { fullName: "John", relationship: "husband", dateOfBirth: "", telephoneNumber: "", emailAddress: "", address: "", taxId: "", sharePercentage: null },
        ],
      }));
      for (const privateValue of ["PRIVATE-HOLDER-ADDRESS", "900999999", "holder@example.test", "FORGED-NUMBER"]) expect(JSON.stringify(fillSpy.mock.calls)).not.toContain(privateValue);
      if (!result.ok) return;
      for (const privateValue of ["John", "husband", "900000001"]) expect(JSON.stringify([result.audit, result.provenance])).not.toContain(privateValue);
    });

    it.each([
      [{ primary: validValues.primary }, false],
      [{ primary: validValues.primary, accountHolderTaxId: "" }, true],
      [{ primary: [{ ...validValues.primary[0], sharePercentage: 50 }] }, true],
      [{ primary: [{ ...validValues.primary[0], emailAddress: "" }] }, true],
      [{ primary: [], contingent: validValues.primary }, true],
    ])("returns accurate partial completion metadata (%j)", async (extra, clientCompletionRequired) => {
      const result = await generateForm(identity, { ...validRequest, values: { ...validValues, beneficiaryCompletion: "partial", ...extra } });
      expect(result).toMatchObject({ ok: true, reviewState: "ready_for_human_review", clientCompletionRequired });
    });

    it.each([
      [{ fullName: "John", sharePercentage: true }],
      [{ fullName: "John", taxId: "0001" }],
      [{ fullName: "John", emailAddress: "bad-email" }],
      [{ fullName: "John", sharePercentage: 70 }, { fullName: "Casey", sharePercentage: 40 }],
    ].map(primary => ({ primary })))("rejects malformed supplied partial values before loading a template ($primary)", async ({ primary }) => {
      expect(await generateForm(identity, { ...validRequest, values: { ...validValues, beneficiaryCompletion: "partial", primary } })).toMatchObject({ ok: false, status: 422, code: "validation_failed" });
      expect(templateSpy).not.toHaveBeenCalled();
      expect(fillSpy).not.toHaveBeenCalled();
    });
  });

  describe("generic ACAT adapter", () => {
    const acatRequest = {
      ...validRequest,
      formId: ACAT_DEFINITION.id,
      values: { accountHolderName: "Jordan Sample", confirmAccountTitle: true },
    };

    it.each(["Individual Brokerage", "Joint", null])("uses the authorized selected account with account type %s", async (accountType) => {
      accountSpy.mockResolvedValue({
        custodianAccountId: "custodian-account-2", apexAccountNumber: "SYNTH-0002", accountType, clientSfId: "C-1",
      });
      const result = await generateForm(identity, { ...acatRequest, accountIds: ["custodian-account-2"] });
      expect(accountSpy).toHaveBeenCalledExactlyOnceWith(identity, "custodian-account-2");
      expect(fillAcatSpy).toHaveBeenCalledWith(expect.any(Uint8Array), {
        accountHolderName: "Jordan Sample", accountHolderTaxId: "", confirmAccountTitle: true, accountNumber: "SYNTH-0002",
      });
      expect(templateSpy).toHaveBeenCalledWith(ACAT_DEFINITION);
      expect(fillSpy).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: true, filename: "APEX-ACAT-0002.pdf", reviewState: "ready_for_human_review", clientCompletionRequired: false });
    });

    it("rejects another owner's selected account without rendering", async () => {
      accountSpy.mockResolvedValue({ custodianAccountId: "other", apexAccountNumber: "SYNTH-0003", accountType: "Joint", clientSfId: "C-2" });
      expect(await generateForm(identity, acatRequest)).toEqual({ ok: false, status: 404, code: "client_account_not_found" });
      expect(fillAcatSpy).not.toHaveBeenCalled();
      expect(templateSpy).not.toHaveBeenCalled();
    });

    it("rejects unavailable client/account context and missing Apex numbers", async () => {
      clientSpy.mockResolvedValue(null);
      expect(await generateForm(identity, acatRequest)).toMatchObject({ ok: false, status: 404 });
      clientSpy.mockResolvedValue({ sf_id: "C-1", name: "Jordan Sample" });
      accountSpy.mockResolvedValue(null);
      expect(await generateForm(identity, acatRequest)).toMatchObject({ ok: false, status: 404 });
      accountSpy.mockResolvedValue({ clientSfId: "C-1", accountType: "Individual Brokerage", apexAccountNumber: "" });
      expect(await generateForm(identity, acatRequest)).toMatchObject({ ok: false, status: 404 });
      expect(fillAcatSpy).not.toHaveBeenCalled();
    });

    it.each([
      { accountNumber: "FORGED-NUMBER" }, { deliveringAccountTitle: "PRIVATE-TRANSFER-DATA" },
      { assets: [{ symbol: "PRIVATE-TRANSFER-DATA" }] }, { transferType: "full" },
    ])("rejects browser number overrides and hidden transfer values (%j)", async (extra) => {
      const result = await generateForm(identity, { ...acatRequest, values: { ...acatRequest.values, ...extra } });
      expect(result).toMatchObject({ ok: false, status: 422, code: "validation_failed" });
      expect(JSON.stringify(result)).not.toContain("PRIVATE-TRANSFER-DATA");
      expect(JSON.stringify(result)).not.toContain("FORGED-NUMBER");
      expect(templateSpy).not.toHaveBeenCalled();
      expect(fillAcatSpy).not.toHaveBeenCalled();
    });

    it.each([
      { accountHolderName: "", confirmAccountTitle: true },
      { accountHolderName: "Jordan Sample", confirmAccountTitle: false },
      { accountHolderName: "Jordan Sample", confirmAccountTitle: true, accountHolderTaxId: "123" },
    ])("keeps title, confirmation and provided tax-ID validation (%j)", async (values) => {
      expect(await generateForm(identity, { ...acatRequest, values })).toMatchObject({ ok: false, status: 422, code: "validation_failed" });
      expect(templateSpy).not.toHaveBeenCalled();
    });

    it("records a title correction as transient metadata without retaining entered values", async () => {
      const result = await generateForm(identity, { ...acatRequest, values: {
        ...acatRequest.values, accountHolderName: "Jordan and Casey Sample JTWROS", accountHolderTaxId: "900-00-0001",
      } });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(fillAcatSpy).toHaveBeenCalledWith(expect.any(Uint8Array), expect.objectContaining({ accountHolderTaxId: "900000001" }));
      expect(result.provenance).toContainEqual(expect.objectContaining({ canonicalKey: "account.registration_title", overridden: true, valueRetention: "transient_only" }));
      for (const metadata of [result.provenance, result.audit]) {
        for (const privateValue of ["Jordan and Casey Sample JTWROS", "900000001", "DBW-9974"]) expect(JSON.stringify(metadata)).not.toContain(privateValue);
      }
    });

    it("reports safe rendering failures and template structural failures", async () => {
      const issues = [{ path: "accountHolderName", message: "This value cannot fit legibly on the form." }];
      fillAcatSpy.mockRejectedValue(new AcatRenderError(issues));
      expect(await generateForm(identity, acatRequest)).toEqual({ ok: false, status: 422, code: "validation_failed", issues });
      fillAcatSpy.mockRejectedValue(new AcatTemplateError());
      expect(await generateForm(identity, acatRequest)).toEqual({ ok: false, status: 503, code: "template_version_mismatch" });
    });
  });
});
