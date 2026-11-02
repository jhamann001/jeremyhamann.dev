import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { decodePDFRawStream, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFTextField, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  fillIraBeneficiaryPdf,
  isIraAccountType,
  parseIraBeneficiaryDraft,
  type IraBeneficiary,
} from "@/lib/forms/ira-beneficiary";
import { IRA_BENEFICIARY_DEFINITION, iraBeneficiaryRowFields } from "@/lib/forms/ira-beneficiary-definition";

const row = (name: string, sharePercentage = 100): IraBeneficiary => ({
  fullName: name,
  relationship: "Family",
  dateOfBirth: "01/02/1980",
  telephoneNumber: "202-555-0100",
  sharePercentage,
  address: "100 Example Avenue, Sample City, NY 10001",
  emailAddress: `${name.toLowerCase().replace(/\s/g, ".")}@example.test`,
  taxId: "900000001",
});

const validDraft = {
  beneficiaryCompletion: "staff" as const,
  accountHolderName: "Jordan Sample",
  accountHolderTaxId: "900-00-0002",
  accountNumber: "BVI5933",
  certifyNotMarried: true,
  primary: [row("Primary Sample")],
  contingent: [],
};

describe("IRA beneficiary validation", () => {
  it.each([undefined, []])("accepts a holder-only client draft with omitted or empty rows (%s)", (rows) => {
    const result = parseIraBeneficiaryDraft({
      accountHolderName: validDraft.accountHolderName,
      accountHolderTaxId: validDraft.accountHolderTaxId,
      accountNumber: validDraft.accountNumber,
      beneficiaryCompletion: "client",
      primary: rows,
      contingent: rows,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        beneficiaryCompletion: "client",
        accountHolderName: "Jordan Sample",
        accountHolderTaxId: "900000002",
        accountNumber: "BVI5933",
        certifyNotMarried: false,
        primary: [],
        contingent: [],
      },
    });
  });

  it.each(["invalid", "", null, true])("rejects invalid completion modes (%s)", (beneficiaryCompletion) => {
    const result = parseIraBeneficiaryDraft({ ...validDraft, beneficiaryCompletion });
    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([{ path: "beneficiaryCompletion", message: "Choose client, partial, or staff completion" }]),
    });
  });

  it.each(["primary", "contingent"])("rejects populated or malformed client-completion %s rows", (kind) => {
    for (const rows of [[row("Hidden Sample")], [{}], null, {}]) {
      expect(parseIraBeneficiaryDraft({
        ...validDraft, beneficiaryCompletion: "client", primary: [], contingent: [], [kind]: rows,
      })).toMatchObject({
        ok: false,
        issues: expect.arrayContaining([{ path: kind, message: "Leave beneficiary rows empty for the client to complete" }]),
      });
    }
  });

  it.each([
    ["accountHolderName", "", "Required"],
    ["accountHolderTaxId", "123", "Enter a nine-digit SSN or TIN, or leave blank for the client"],
    ["accountNumber", "", "Required"],
  ])("keeps holder validation in client completion: %s %s", (key, value, message) => {
    expect(parseIraBeneficiaryDraft({
      ...validDraft, beneficiaryCompletion: "client", primary: [], contingent: [], [key]: value,
    })).toMatchObject({ ok: false, issues: expect.arrayContaining([{ path: key, message }]) });
  });

  describe.each(["client", "staff"] as const)("%s mode account-holder tax ID", (beneficiaryCompletion) => {
    const values = { ...validDraft, beneficiaryCompletion, primary: beneficiaryCompletion === "client" ? [] : validDraft.primary };

    it.each([undefined, "", "   ", "\t\n "])("leaves an omitted or blank value for the client (%j)", (accountHolderTaxId) => {
      expect(parseIraBeneficiaryDraft({ ...values, accountHolderTaxId })).toMatchObject({
        ok: true, value: { accountHolderTaxId: "", beneficiaryCompletion },
      });
    });

    it.each(["900000002", "900-00-0002", " 900 00 0002 "])("accepts and normalizes a complete supplied value (%s)", (accountHolderTaxId) => {
      expect(parseIraBeneficiaryDraft({ ...values, accountHolderTaxId })).toMatchObject({
        ok: true, value: { accountHolderTaxId: "900000002" },
      });
    });

    it.each(["0002", "***-**-0002", "XXX-XX-0002", "900.00.0002", "abc900000002", "900\t00\t0002", "9000000020", null, 900000002, false, {}, []])("rejects partial, masked, malformed or non-string values without echoing them (%j)", (accountHolderTaxId) => {
      expect(parseIraBeneficiaryDraft({ ...values, accountHolderTaxId })).toEqual({
        ok: false, issues: [{ path: "accountHolderTaxId", message: "Enter a nine-digit SSN or TIN, or leave blank for the client" }],
      });
    });
  });

  it("keeps beneficiary completeness mandatory in staff mode when holder SSN is blank", () => {
    expect(parseIraBeneficiaryDraft({ ...validDraft, accountHolderTaxId: "", primary: [] })).toMatchObject({
      ok: false, issues: [{ path: "primary", message: "Add at least one primary beneficiary" }],
    });
    const result = parseIraBeneficiaryDraft({ ...validDraft, accountHolderTaxId: "", primary: [{ ...validDraft.primary[0], taxId: "" }] });
    expect(result).toEqual({ ok: false, issues: [{ path: "primary.0.taxId", message: "Required" }] });
  });

  it.each([undefined, "staff"])("keeps strict designation validation for staff or omitted modes (%s)", (beneficiaryCompletion) => {
    const parsed = parseIraBeneficiaryDraft({ ...validDraft, beneficiaryCompletion });
    expect(parsed).toMatchObject({ ok: true, value: { beneficiaryCompletion: "staff" } });
    expect(parseIraBeneficiaryDraft({ ...validDraft, beneficiaryCompletion, primary: [] })).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([{ path: "primary", message: "Add at least one primary beneficiary" }]),
    });
    expect(parseIraBeneficiaryDraft({
      ...validDraft, beneficiaryCompletion, contingent: [{ ...row("Contingent Sample", 50), emailAddress: "" }],
    })).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        { path: "contingent.0.emailAddress", message: "Required" },
        { path: "contingent", message: "Contingent shares must total 100% (currently 50%)" },
      ]),
    });
  });

  it("normalizes tax IDs and accepts a complete 100% primary designation", () => {
    const result = parseIraBeneficiaryDraft(validDraft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.accountHolderTaxId).toBe("900000002");
    expect(result.value.primary[0].taxId).toBe("900000001");
  });

  it("blocks incomplete allocations and malformed restricted fields", () => {
    const result = parseIraBeneficiaryDraft({
      ...validDraft,
      accountHolderTaxId: "123",
      primary: [row("One Sample", 40), row("Two Sample", 40)],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { path: "accountHolderTaxId", message: "Enter a nine-digit SSN or TIN, or leave blank for the client" },
        { path: "primary", message: "Primary shares must total 100% (currently 80%)" },
      ]),
    );
  });

  it("recognizes the account types used by the AoA seed without accepting taxable accounts", () => {
    expect(isIraAccountType("Traditional IRA")).toBe(true);
    expect(isIraAccountType("Roth IRA")).toBe(true);
    expect(isIraAccountType("SEP IRA")).toBe(true);
    expect(isIraAccountType("Individual Brokerage")).toBe(false);
    expect(isIraAccountType(null)).toBe(false);
  });
});

describe("IRA beneficiary PDF generation", () => {
  const templatePath = path.join(process.cwd(), IRA_BENEFICIARY_DEFINITION.template.relativePath);

  it.each(["client", "staff"] as const)("leaves holder SSN blank, editable and client-required in %s mode", async (beneficiaryCompletion) => {
    const parsed = parseIraBeneficiaryDraft({
      ...validDraft, beneficiaryCompletion, accountHolderTaxId: "",
      primary: beneficiaryCompletion === "client" ? [] : validDraft.primary,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const pdf = await PDFDocument.load(await fillIraBeneficiaryPdf(await readFile(templatePath), parsed.value));
    const form = pdf.getForm();
    const field = form.getTextField("Social Security Number");
    expect(field.getText() ?? "").toBe("");
    expect(field.isReadOnly()).toBe(false);
    expect(field.isRequired()).toBe(true);
    expect(field.acroField.dict.lookup(PDFName.of("TU"), PDFHexString).decodeText()).toBe("Client to complete before signing: account-holder nine-digit SSN or TIN");
    expect(form.getTextField("Name").getText()).toBe("Jordan Sample");
    expect(form.getTextField("Account Number").getText()).toBe("BVI5933");
    expect(form.getTextField("Name_2").getText() ?? "").toBe(beneficiaryCompletion === "client" ? "" : "Primary Sample");
    expect(pdf.getPageCount()).toBe(2);
    expect(form.getFields()).toHaveLength(91);
    for (const name of ["Signature of Account Holder", "Signature of Spouse", "Signature of Witness"]) {
      expect(form.getSignature(name).acroField.V()).toBeUndefined();
    }
    for (const name of ["Date", "Date_2", "Date_3"]) expect(form.getTextField(name).getText() ?? "").toBe("");
    field.setText("900000002");
    const completed = await PDFDocument.load(await pdf.save());
    expect(completed.getForm().getTextField("Social Security Number").getText()).toBe("900000002");
    expect(completed.getForm().getTextField("Social Security Number").isReadOnly()).toBe(false);
  });

  it("leaves client beneficiary fields blank and editable with only the first primary row required", async () => {
    const parsed = parseIraBeneficiaryDraft({
      ...validDraft, beneficiaryCompletion: "client", primary: [], contingent: [], certifyNotMarried: undefined,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const source = await readFile(templatePath);
    const template = await PDFDocument.load(source);
    const pdf = await PDFDocument.load(await fillIraBeneficiaryPdf(source, parsed.value));
    const form = pdf.getForm();
    expect(pdf.getPageCount()).toBe(template.getPageCount());
    expect(form.getFields().map((field) => field.getName())).toEqual(template.getForm().getFields().map((field) => field.getName()));
    expect(form.getTextField("Name").getText()).toBe("Jordan Sample");
    expect(form.getTextField("Social Security Number").getText()).toBe("900000002");
    expect(form.getTextField("Account Number").getText()).toBe("BVI5933");
    const requiredNames = Object.values(iraBeneficiaryRowFields(0, "primary"));
    for (const kind of ["primary", "contingent"] as const) {
      for (let index = 0; index < 5; index++) {
        for (const name of Object.values(iraBeneficiaryRowFields(index, kind))) {
          const field = form.getTextField(name);
          expect(field.getText() ?? "", name).toBe("");
          expect(field.isReadOnly(), name).toBe(false);
          expect(field.isRequired(), name).toBe(kind === "primary" && index === 0);
          expect(field.acroField.getDefaultAppearance(), name).toMatch(/\s10\s+Tf/);
          if (requiredNames.includes(name)) {
            expect(field.acroField.dict.lookup(PDFName.of("TU"), PDFHexString).decodeText()).toMatch(/^Client to complete: /);
          }
        }
      }
    }
    const certification = form.getCheckBox("If you are not married certify here");
    expect(certification.isChecked()).toBe(false);
    expect(certification.isReadOnly()).toBe(false);
    for (const name of ["Signature of Account Holder", "Signature of Spouse", "Signature of Witness", "Date", "Date_2", "Date_3"]) {
      const original = template.getForm().getField(name);
      const output = form.getField(name);
      expect(output.acroField.V()).toEqual(original.acroField.V());
      expect(output.acroField.getFlags()).toBe(original.acroField.getFlags());
      expect(output.acroField.getDefaultAppearance()).toBe(original.acroField.getDefaultAppearance());
    }
    form.getTextField("Name_2").setText("Client Entered Sample");
    const edited = await PDFDocument.load(await pdf.save());
    expect(edited.getForm().getTextField("Name_2").getText()).toBe("Client Entered Sample");
    expect(edited.getForm().getTextField("Name_2").isRequired()).toBe(true);
  });

  it.each([false, true])("uses one 10-point size for ordinary values and blank rows (all rows used: %s)", async (allRowsUsed) => {
    const shortRow = { ...row("Alex Sample", allRowsUsed ? 20 : 100), address: "100 Example Lane", emailAddress: "alex@example.test" };
    const draft = {
      ...validDraft,
      primary: Array.from({ length: allRowsUsed ? 5 : 1 }, () => ({ ...shortRow })),
      contingent: allRowsUsed ? Array.from({ length: 5 }, () => ({ ...shortRow })) : [],
    };
    const pdf = await PDFDocument.load(await fillIraBeneficiaryPdf(await readFile(templatePath), draft));
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const rowFields = ["Name", "Relationship", "Date of Birth", "Telephone Number", "Share Percentage", "Address", "Email Address", "Social Security Number"];
    const fieldNames = ["Name", "Social Security Number", "Account Number", ...Array.from({ length: 10 }, (_, index) => rowFields.map((base) => `${base}_${index + 2}`)).flat()];
    expect(fieldNames).toHaveLength(83);
    for (const name of fieldNames) {
      const field = pdf.getForm().getTextField(name);
      expect(field.acroField.getDefaultAppearance(), name).toMatch(/\s10\s+Tf/);
      for (const widget of field.acroField.getWidgets()) {
        expect(widget.getDefaultAppearance(), name).toMatch(/\s10\s+Tf/);
        const stream = pdf.context.lookup(widget.getNormalAppearance());
        if (!(stream instanceof PDFRawStream)) throw new Error(`Missing appearance stream: ${name}`);
        const painted = new TextDecoder().decode(decodePDFRawStream(stream).decode());
        expect(painted, name).toMatch(/\s10\s+Tf/);
        expect(font.heightAtSize(10), name).toBeLessThanOrEqual(widget.getRectangle().height - 2);
      }
    }
    if (!allRowsUsed) expect(pdf.getForm().getTextField("Name_11").getText() ?? "").toBe("");
  });

  it("registers the editable font without removing template fonts or changing signing fields", async () => {
    const source = await readFile(templatePath);
    const template = await PDFDocument.load(source);
    const pdf = await PDFDocument.load(await fillIraBeneficiaryPdf(source, validDraft));
    expect(pdf.getTitle()).toBe("IRA Beneficiary Designation");
    expect(pdf.getSubject()).toContain("requires human review and signature");
    const defaultFonts = (doc: PDFDocument) => doc.catalog.lookup(PDFName.of("AcroForm"), PDFDict)
      .lookup(PDFName.of("DR"), PDFDict).lookup(PDFName.of("Font"), PDFDict);
    const fontResources = defaultFonts(pdf);
    for (const key of defaultFonts(template).keys()) expect(fontResources.has(key), key.toString()).toBe(true);
    expect(fontResources.lookup(PDFName.of("Helvetica"), PDFDict).lookup(PDFName.of("BaseFont"), PDFName).toString()).toBe("/Helvetica");
    for (const field of pdf.getForm().getFields()) {
      if (!(field instanceof PDFTextField) || /^Date(?:_\d+)?$/.test(field.getName())) continue;
      const appearances = [field.acroField.getDefaultAppearance(), ...field.acroField.getWidgets().map((widget) => widget.getDefaultAppearance())];
      for (const appearance of appearances) {
        const fontName = /\/([^\s]+)\s+[\d.]+\s+Tf/.exec(appearance ?? "")?.[1];
        expect(fontName, field.getName()).toBe("Helvetica");
        expect(fontResources.has(PDFName.of(fontName!)), field.getName()).toBe(true);
      }
    }
    for (const field of template.getForm().getFields().filter((field) => field.getName().startsWith("Signature") || /^Date(?:_\d+)?$/.test(field.getName()))) {
      const output = pdf.getForm().getField(field.getName());
      expect(output.acroField.getDefaultAppearance()).toBe(field.acroField.getDefaultAppearance());
      expect(output.acroField.getWidgets().map((widget) => widget.getDefaultAppearance())).toEqual(field.acroField.getWidgets().map((widget) => widget.getDefaultAppearance()));
    }
  });

  it("keeps a formerly blank row editable at 10 points after save and reload", async () => {
    const pdf = await PDFDocument.load(await fillIraBeneficiaryPdf(await readFile(templatePath), validDraft));
    const field = pdf.getForm().getTextField("Name_11");
    expect(field.isReadOnly()).toBe(false);
    expect(field.getText() ?? "").toBe("");
    field.setText("Casey Sample");
    pdf.getForm().updateFieldAppearances(await pdf.embedFont(StandardFonts.Helvetica));
    const reloaded = await PDFDocument.load(await pdf.save());
    const edited = reloaded.getForm().getTextField("Name_11");
    expect(edited.getText()).toBe("Casey Sample");
    expect(edited.acroField.getDefaultAppearance()).toMatch(/\s10\s+Tf/);
    for (const widget of edited.acroField.getWidgets()) {
      expect(widget.getDefaultAppearance()).toMatch(/\s10\s+Tf/);
      const stream = reloaded.context.lookup(widget.getNormalAppearance());
      if (!(stream instanceof PDFRawStream)) throw new Error("Missing edited appearance stream");
      expect(new TextDecoder().decode(decodePDFRawStream(stream).decode())).toMatch(/\s10\s+Tf/);
    }
  });

  it("fits long values without truncation or inconsistent widget defaults", async () => {
    const draft = { ...validDraft, primary: [{ ...row("Anthony Rau Montgomery-Richardson"), emailAddress: "anthony.montgomery-richardson@example.test" }] };
    const pdf = await PDFDocument.load(await fillIraBeneficiaryPdf(await readFile(templatePath), draft));
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (const name of ["Name_2", "Email Address_2"]) {
      const field = pdf.getForm().getTextField(name);
      for (const widget of field.acroField.getWidgets()) {
        const size = Number(/([\d.]+)\s+Tf/.exec(widget.getDefaultAppearance() ?? "")?.[1]);
        expect(size).toBeGreaterThanOrEqual(6);
        expect(size).toBeLessThan(10);
        expect(font.widthOfTextAtSize(field.getText()!, size)).toBeLessThanOrEqual(widget.getRectangle().width - 2);
        const stream = pdf.context.lookup(widget.getNormalAppearance());
        if (!(stream instanceof PDFRawStream)) throw new Error(`Missing appearance stream: ${name}`);
        const painted = new TextDecoder().decode(decodePDFRawStream(stream).decode());
        expect(Number(/([\d.]+)\s+Tf/.exec(painted)?.[1])).toBeCloseTo(size, 5);
      }
    }
    expect(pdf.getForm().getTextField("Name_2").getText()).toBe(draft.primary[0].fullName);
  });

  it("rejects unreadable or unsupported text with a field-specific issue, never changing the value", async () => {
    for (const [value, message] of [["W".repeat(80), "fit legibly"], ["Łukasz Sample", "characters"]]) {
      const draft = { ...validDraft, primary: [row(value)] };
      await expect(fillIraBeneficiaryPdf(await readFile(templatePath), draft)).rejects.toMatchObject({
        issues: [{ path: "primary.0.fullName", message: expect.stringContaining(message) }],
      });
    }
  });

  it("pins the exact approved Apex template", async () => {
    const template = await readFile(templatePath);
    expect(createHash("sha256").update(template).digest("hex")).toBe(
      IRA_BENEFICIARY_DEFINITION.template.sha256,
    );
  });

  it("fills one primary beneficiary, checks certification, and preserves signature fields", async () => {
    const parsed = parseIraBeneficiaryDraft(validDraft);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const template = await readFile(templatePath);
    const output = await fillIraBeneficiaryPdf(template, parsed.value);
    const pdf = await PDFDocument.load(output);
    const form = pdf.getForm();

    expect(pdf.getPageCount()).toBe(2);
    expect(form.getFields()).toHaveLength(91);
    expect(form.getTextField("Name").getText()).toBe("Jordan Sample");
    expect(form.getTextField("Social Security Number").getText()).toBe("900000002");
    expect(form.getTextField("Account Number").getText()).toBe("BVI5933");
    expect(form.getTextField("Name_2").getText()).toBe("Primary Sample");
    expect(form.getTextField("Share Percentage_2").getText()).toBe("100");
    expect(form.getCheckBox("If you are not married certify here").isChecked()).toBe(true);
    expect(form.getSignature("Signature of Account Holder")).toBeDefined();
    expect(form.getTextField("Date_3").getText()).toBeUndefined();
    // Widget-level defaults must not silently override the configured size.
    for (const name of ["Relationship_2", "Date of Birth_2", "Telephone Number_2", "Share Percentage_2"]) {
      const field = form.getTextField(name);
      for (const widget of field.acroField.getWidgets()) {
        expect(widget.getDefaultAppearance()).toMatch(/\s10\s+Tf/);
      }
    }
    for (const widget of form.getTextField("Address_2").acroField.getWidgets()) {
      expect(widget.getDefaultAppearance()).toMatch(/\s10\s+Tf/);
    }
  });

  it("fills every primary and contingent row independently", async () => {
    const primary = Array.from({ length: 5 }, (_, index) => row(`Primary ${index + 1} Sample`, 20));
    const contingent = Array.from(
      { length: 5 },
      (_, index) => row(`Contingent ${index + 1} Sample`, 20),
    );
    const parsed = parseIraBeneficiaryDraft({ ...validDraft, primary, contingent });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const template = await readFile(templatePath);
    const output = await fillIraBeneficiaryPdf(template, parsed.value);
    const pdf = await PDFDocument.load(output);
    const form = pdf.getForm();

    expect(form.getTextField("Name_2").getText()).toBe("Primary 1 Sample");
    expect(form.getTextField("Name_6").getText()).toBe("Primary 5 Sample");
    expect(form.getTextField("Name_7").getText()).toBe("Contingent 1 Sample");
    expect(form.getTextField("Name_11").getText()).toBe("Contingent 5 Sample");
    expect(form.getTextField("Address_11").getText()).toContain("Example Avenue");
  });
});
