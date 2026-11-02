import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFButton, PDFDocument, PDFName, PDFRadioGroup, PDFSignature, PDFTextField } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { mappedInputs } from "@/lib/forms/mapped-form-spec";
import { TOD_SPEC, todBeneficiaryFields } from "@/lib/forms/tod-spec";
import { repairTodTemplate } from "@/lib/forms/tod-template-repair";
import { isDefinitionEligibleForAccountType } from "@/lib/forms/form-definition";
import { fillMappedPdf, MappedFormRenderError } from "@/lib/forms/mapped-form-pdf";
import { parseMappedDraft } from "@/lib/forms/mapped-form-validation";

const sourceBytes = () => readFile(path.join(process.cwd(), TOD_SPEC.definition.template.relativePath));
const blankTextFields = ["ACCOUNT OWNER SIGNATURE", "ACCOUNT OWNER NAME", "DATE", "JOINT ACCOUNT OWNER SIGNATURE", "JOINT ACCOUNT OWNER NAME", "DATE_2", "SIGNATURE OF SPOUSE3", "NAME OF SPOUSE", "DATE_3"];

describe("TOD snapshot and input allowlist", () => {
  it("pins the original five-page 107-field supplied snapshot without altering its content", async () => {
    const bytes = await sourceBytes();
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("13b9365e1d1736e35aab3b1274d2916eed0b3aabe96b38a9c8f8eed87dd970cb");
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(5);
    expect(pdf.getForm().getFields()).toHaveLength(107);
    expect(TOD_SPEC.definition.effectiveOn).toBeNull();
    expect(TOD_SPEC.definition.status).toBe("internal_pilot");
  });

  it("maps all six primary and six contingent rows to distinct fields, after the isolated repair", async () => {
    const pdf = await PDFDocument.load(await sourceBytes());
    repairTodTemplate(pdf);
    const form = pdf.getForm();
    const mapped = mappedInputs(TOD_SPEC);
    const keys = mapped.map((field) => field.key);
    expect(new Set(keys).size).toBe(keys.length);
    const textIds = mapped.flatMap((field) => field.pdfFields ?? []);
    expect(new Set(textIds).size).toBe(textIds.length);
    for (const id of textIds) expect(form.getField(id), id).toBeInstanceOf(PDFTextField);
    for (const kind of ["primary", "contingent"] as const) {
      for (let row = 1; row <= 6; row++) {
        const fields = todBeneficiaryFields(kind, row);
        expect(fields).toHaveLength(7);
        expect(fields.every((field) => !field.requiredForDraft)).toBe(true);
        expect(fields.find((field) => field.kind === "percent")).toMatchObject({ min: 1, wholeNumber: true });
      }
    }
    expect(mapped.filter((field) => field.requiredForDraft).map((field) => field.key)).toEqual(["accountHolderName"]);
    expect(mapped.filter((field) => field.source === "accountNumber").map((field) => field.pdfFields)).toEqual([["Primary - Apex Account Number"]]);
    for (const name of blankTextFields) expect(textIds).not.toContain(name);
    expect(textIds).not.toContain("Logo Placement_af_image");
    expect(textIds).not.toContain("ACCOUNT INFORMATION");
    expect(textIds).not.toContain("BENEFICIARY DESIGNATION");
    expect(mapped.some((field) => field.kind === "email")).toBe(false); // This template has no email boxes.
    expect(TOD_SPEC.percentageGroups?.map((group) => group.length)).toEqual([6, 6]);
  });

  it.each([0, 7, 1.5, NaN])("rejects unmapped beneficiary row %s", (row) => {
    expect(() => todBeneficiaryFields("primary", row)).toThrow();
  });

  it.each(["Individual", "Joint", "JTWROS", "JTIC", "Individual TOD"])("allows a known non-retirement registration candidate (%s)", (type) => {
    expect(isDefinitionEligibleForAccountType(TOD_SPEC.definition, type)).toBe(true);
  });

  it.each([null, undefined, "", "Unknown", "IRA", "Traditional IRA", "Roth IRA", "Individual IRA", "Individual Trust", "Individual Custodial", "Individual UTMA", "Individual UGMA", "Individual 401(k)", "Individual 403(b)", "Individual 457(b)", "Individual Pension", "Individual Keogh"])("does not advertise TOD for unknown or excluded registrations (%s)", (type) => {
    expect(isDefinitionEligibleForAccountType(TOD_SPEC.definition, type)).toBe(false);
  });
});

describe("output-only TOD AcroForm repair", () => {
  it("separates row 3 and row 6 addresses and reconnects stale page widgets without moving or removing fields", async () => {
    const pdf = await PDFDocument.load(await sourceBytes());
    const beforePages = pdf.getPages().map((page) => ({
      contents: page.node.get(PDFName.of("Contents"))?.toString(),
      annotationCount: page.node.Annots()?.size(),
    }));
    const original = pdf.getForm().getTextField("Beneficiary 3 - Address");
    const originalRectangles = original.acroField.getWidgets().map((widget) => widget.getRectangle());
    const logo = pdf.getForm().getField("Logo Placement_af_image");
    const logoDictionary = logo.acroField.dict.toString();
    expect(logo).toBeInstanceOf(PDFButton);
    repairTodTemplate(pdf);
    const form = pdf.getForm();
    expect(form.getFields()).toHaveLength(108);
    const field3 = form.getTextField("Beneficiary 3 - Address");
    const field6 = form.getTextField("Beneficiary 6 - Address");
    expect(field3.acroField.getWidgets()).toHaveLength(1);
    expect(field6.acroField.getWidgets()).toHaveLength(1);
    expect(field3.acroField.getWidgets()[0].getRectangle()).toEqual(originalRectangles[0]);
    expect(field6.acroField.getWidgets()[0].getRectangle()).toEqual(originalRectangles[1]);
    expect(field6.acroField.getWidgets()[0].dict.get(PDFName.of("Parent"))).toEqual(field6.ref);
    expect(form.getField("Logo Placement_af_image").acroField.dict.toString()).toBe(logoDictionary);
    expect(pdf.getPages().map((page) => ({ contents: page.node.get(PDFName.of("Contents"))?.toString(), annotationCount: page.node.Annots()?.size() }))).toEqual(beforePages);
    const pageRefs = new Set(pdf.getPages().flatMap((page) => page.node.Annots()?.asArray() ?? []).map((ref) => ref.toString()));
    for (const field of form.getFields()) for (const widget of field.acroField.getWidgets()) {
      expect(pageRefs.has(pdf.context.getObjectRef(widget.dict)!.toString()), field.getName()).toBe(true);
    }

    field3.setText("3 Example Street, Example City, NY 10001");
    field6.setText("6 Sample Avenue, Example City, NY 10002");
    // updateFieldAppearances:false avoids updating unrelated source widgets.
    const reloaded = await PDFDocument.load(await pdf.save({ updateFieldAppearances: false }));
    expect(reloaded.getForm().getTextField("Beneficiary 3 - Address").getText()).toBe("3 Example Street, Example City, NY 10001");
    expect(reloaded.getForm().getTextField("Beneficiary 6 - Address").getText()).toBe("6 Sample Avenue, Example City, NY 10002");
    expect(reloaded.getForm().getFields()).toHaveLength(108);
    for (const name of blankTextFields) expect(reloaded.getForm().getTextField(name).getText() ?? "", name).toBe("");
  });

  it.each(["New", "Update"])("makes %s a single exclusive radio choice and permits later client editing", async (value) => {
    const pdf = await PDFDocument.load(await sourceBytes());
    repairTodTemplate(pdf);
    const group = pdf.getForm().getRadioGroup("Group 1");
    expect(group).toBeInstanceOf(PDFRadioGroup);
    expect(group.getSelected()).toBeUndefined();
    expect(group.getOptions()).toEqual(["New", "Update"]);
    group.select(value);
    expect(group.acroField.getWidgets().map((widget) => widget.getAppearanceState()?.decodeText())).toEqual(value === "New" ? ["New", "Off"] : ["Off", "Update"]);
    const reloaded = await PDFDocument.load(await pdf.save({ updateFieldAppearances: false }));
    const saved = reloaded.getForm().getRadioGroup("Group 1");
    expect(saved.getSelected()).toBe(value);
    saved.select(value === "New" ? "Update" : "New");
    expect(saved.getSelected()).not.toBe(value);
    saved.clear();
    expect(saved.getSelected()).toBeUndefined();
  });

  it("fails closed if source address widget positions change or if applied twice", async () => {
    const moved = await PDFDocument.load(await sourceBytes());
    moved.getForm().getTextField("Beneficiary 3 - Address").acroField.getWidgets()[1].setRectangle({ x: 1, y: 1, width: 100, height: 10 });
    expect(() => repairTodTemplate(moved)).toThrow("Unexpected TOD address widgets");
    const twice = await PDFDocument.load(await sourceBytes());
    repairTodTemplate(twice);
    expect(() => repairTodTemplate(twice)).toThrow("Unexpected TOD form structure");
  });
});

describe("TOD draft validation and actual PDF rendering", () => {
  function parse(fields: Record<string, string>) {
    const result = parseMappedDraft(TOD_SPEC, { fields, confirmAccount: true }, "SYN-00001", "Jordan Sample");
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.value;
  }

  it("generates an account-only draft with all client details and elections blank and editable", async () => {
    const original = await PDFDocument.load(await sourceBytes());
    const pdf = await PDFDocument.load(await fillMappedPdf(TOD_SPEC, await sourceBytes(), parse({ accountHolderName: "Jordan Sample" })));
    const form = pdf.getForm();
    expect(form.getFields()).toHaveLength(108);
    for (const field of form.getFields()) {
      if (field instanceof PDFTextField) {
        const expected = field.getName() === "Primary - Account Holder Name" ? "Jordan Sample" : field.getName() === "Primary - Apex Account Number" ? "SYN-00001" : "";
        expect(field.getText() ?? "", field.getName()).toBe(expected);
        expect(field.isReadOnly()).toBe(false);
      } else if (field instanceof PDFRadioGroup) {
        expect(field.getSelected()).toBeUndefined();
        expect(field.isReadOnly()).toBe(false);
      } else if (field instanceof PDFSignature) expect(field.acroField.V()).toBeUndefined();
      else expect(field.getName()).toBe("Logo Placement_af_image");
    }
    expect(form.getField("Logo Placement_af_image").acroField.dict.toString()).toBe(original.getForm().getField("Logo Placement_af_image").acroField.dict.toString());
    expect(pdf.getPageCount()).toBe(5);
    for (let index = 0; index < 5; index++) expect(pdf.getPage(index).node.get(PDFName.of("Contents"))?.toString()).toBe(original.getPage(index).node.get(PDFName.of("Contents"))?.toString());
  });

  it("fills every known row and preserves independent primary 3/6 addresses through actual rendering", async () => {
    const values: Record<string, string> = {
      accountHolderName: "Jordan Sample", accountHolderTaxId: "900-00-0001", accountHolderDob: "01021990",
      jointHolderName: "Adah Sample", jointHolderTaxId: "900-00-0002", jointHolderDob: "03041991", designationType: "change",
    };
    for (const kind of ["primary", "contingent"] as const) for (let row = 1; row <= 6; row++) {
      Object.assign(values, {
        [`${kind}${row}Name`]: `${kind === "primary" ? "Primary" : "Contingent"} ${row} Sample`,
        [`${kind}${row}Relationship`]: "Other",
        [`${kind}${row}Share`]: row === 6 ? "50" : "10",
        [`${kind}${row}Address`]: `${row} ${kind === "primary" ? "Example Street" : "Sample Avenue"}, Example City, NY 10001`,
        [`${kind}${row}Phone`]: `202555010${row}`,
        [`${kind}${row}Dob`]: `010${row}1990`,
        [`${kind}${row}TaxId`]: `90000010${row}`,
      });
    }
    const pdf = await PDFDocument.load(await fillMappedPdf(TOD_SPEC, await sourceBytes(), parse(values)));
    const form = pdf.getForm();
    expect(form.getTextField("Primary - SSN/Tax ID").getText()).toBe("900000001");
    expect(form.getTextField("Primary - Date of Birth").getText()).toBe("01/02/1990");
    expect(form.getTextField("Joint - Account Holder Name").getText()).toBe("Adah Sample");
    expect(form.getTextField("Joint - SSN/Tax ID").getText()).toBe("900000002");
    expect(form.getRadioGroup("Group 1").getSelected()).toBe("Update");
    for (const [kind, prefix] of [["primary", "Beneficiary"], ["contingent", "ConBeneficiary"]] as const) for (let row = 1; row <= 6; row++) {
      expect(form.getTextField(`${prefix} ${row} - Name`).getText()).toBe(`${kind === "primary" ? "Primary" : "Contingent"} ${row} Sample`);
      expect(form.getTextField(`${prefix} ${row} - Address`).getText()).toBe(`${row} ${kind === "primary" ? "Example Street" : "Sample Avenue"}, Example City, NY 10001`);
      expect(form.getTextField(`${prefix} ${row} - Relationship`).getText()).toBe("Other");
      expect(form.getTextField(`${prefix} ${row} - Percentage`).getText()).toBe(row === 6 ? "50" : "10");
      expect(form.getTextField(`${prefix} ${row} - Date of Birth`).getText()).toBe(`01/0${row}/1990`);
      expect(form.getTextField(`${prefix} ${row} - Telephone Number`).getText()).toBe(`202-555-010${row}`);
      expect(form.getTextField(`${prefix} ${row} - SSN`).getText()).toBe(`90000010${row}`);
    }
    for (const name of blankTextFields) expect(form.getTextField(name).getText() ?? "", name).toBe("");
  });

  it("permits a partial row without requiring a name, SSN, address or share", async () => {
    const pdf = await PDFDocument.load(await fillMappedPdf(TOD_SPEC, await sourceBytes(), parse({ primary1Relationship: "Husband", primary3Address: "3 Example Street", primary6Address: "6 Sample Avenue" })));
    const form = pdf.getForm();
    expect(form.getTextField("Beneficiary 1 - Relationship").getText()).toBe("Husband");
    expect(form.getTextField("Beneficiary 1 - Name").getText() ?? "").toBe("");
    expect(form.getTextField("Beneficiary 1 - Percentage").getText() ?? "").toBe("");
    expect(form.getTextField("Beneficiary 3 - Address").getText()).toBe("3 Example Street");
    expect(form.getTextField("Beneficiary 6 - Address").getText()).toBe("6 Sample Avenue");
  });

  it.each([
    { accountHolderName: "" }, { accountHolderTaxId: "0001" }, { primary1TaxId: "0001" },
    { primary1Dob: "02311990" }, { primary1Phone: "202555010" }, { primary1Share: "0" },
    { primary1Share: "10.5" }, { primary1Share: "75", primary2Share: "26" },
    { contingent1Share: "101" }, { designationType: "unconfirmed" }, { accountNumber: "EMFBLL-5229" },
  ])("rejects invalid supplied values without requiring missing ones: %j", (fields) => {
    expect(parseMappedDraft(TOD_SPEC, { fields, confirmAccount: true }, "SYN-00001", "Jordan Sample")).toMatchObject({ ok: false });
  });

  it("does not silently truncate a long legal name to fit the PDF", async () => {
    const draft = parse({ primary1Name: "W".repeat(120) });
    await expect(fillMappedPdf(TOD_SPEC, await sourceBytes(), draft)).rejects.toBeInstanceOf(MappedFormRenderError);
  });
});
