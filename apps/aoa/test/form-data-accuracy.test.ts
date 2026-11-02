import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, PDFName } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import {
  fillIraBeneficiaryPdf,
  parseIraBeneficiaryDraft,
  type IraBeneficiary,
} from "@/lib/forms/ira-beneficiary";
import { IRA_BENEFICIARY_DEFINITION } from "@/lib/forms/ira-beneficiary-definition";

// Independent expectations: do not use the renderer's mapping helper here.
// The first five rows are primary; the last five are contingent.
const rowFieldIds = [
  ["Name_2", "Relationship_2", "Date of Birth_2", "Telephone Number_2", "Share Percentage_2", "Address_2", "Email Address_2", "Social Security Number_2"],
  ["Name_3", "Relationship_3", "Date of Birth_3", "Telephone Number_3", "Share Percentage_3", "Address_3", "Email Address_3", "Social Security Number_3"],
  ["Name_4", "Relationship_4", "Date of Birth_4", "Telephone Number_4", "Share Percentage_4", "Address_4", "Email Address_4", "Social Security Number_4"],
  ["Name_5", "Relationship_5", "Date of Birth_5", "Telephone Number_5", "Share Percentage_5", "Address_5", "Email Address_5", "Social Security Number_5"],
  ["Name_6", "Relationship_6", "Date of Birth_6", "Telephone Number_6", "Share Percentage_6", "Address_6", "Email Address_6", "Social Security Number_6"],
  ["Name_7", "Relationship_7", "Date of Birth_7", "Telephone Number_7", "Share Percentage_7", "Address_7", "Email Address_7", "Social Security Number_7"],
  ["Name_8", "Relationship_8", "Date of Birth_8", "Telephone Number_8", "Share Percentage_8", "Address_8", "Email Address_8", "Social Security Number_8"],
  ["Name_9", "Relationship_9", "Date of Birth_9", "Telephone Number_9", "Share Percentage_9", "Address_9", "Email Address_9", "Social Security Number_9"],
  ["Name_10", "Relationship_10", "Date of Birth_10", "Telephone Number_10", "Share Percentage_10", "Address_10", "Email Address_10", "Social Security Number_10"],
  ["Name_11", "Relationship_11", "Date of Birth_11", "Telephone Number_11", "Share Percentage_11", "Address_11", "Email Address_11", "Social Security Number_11"],
] as const;

// Every value is fictional and distinct across people and categories. This
// makes swapped rows, owner values, and address/phone reuse observable.
const rowValues = [
  ["Primary Alpha Test", "Child Alpha", "01/02/1971", "202-555-0101", 11, "101 Example Lane, Test City, NY 10001", "primary.alpha@example.test", "900-00-0001"],
  ["Primary Bravo Test", "Sibling Bravo", "02/03/1972", "202-555-0102", 17, "102 Example Lane, Test City, NY 10002", "primary.bravo@example.test", "900-00-0002"],
  ["Primary Charlie Test", "Parent Charlie", "03/04/1973", "202-555-0103", 19, "103 Example Lane, Test City, NY 10003", "primary.charlie@example.test", "900-00-0003"],
  ["Primary Delta Test", "Friend Delta", "04/05/1974", "202-555-0104", 23, "104 Example Lane, Test City, NY 10004", "primary.delta@example.test", "900-00-0004"],
  ["Primary Echo Test", "Relative Echo", "05/06/1975", "202-555-0105", 30, "105 Example Lane, Test City, NY 10005", "primary.echo@example.test", "900-00-0005"],
  ["Contingent Foxtrot Test", "Child Foxtrot", "06/07/1976", "202-555-0106", 12, "206 Sample Street, Test City, NY 10006", "contingent.foxtrot@example.test", "900-00-0006"],
  ["Contingent Golf Test", "Sibling Golf", "07/08/1977", "202-555-0107", 13, "207 Sample Street, Test City, NY 10007", "contingent.golf@example.test", "900-00-0007"],
  ["Contingent Hotel Test", "Parent Hotel", "08/09/1978", "202-555-0108", 18, "208 Sample Street, Test City, NY 10008", "contingent.hotel@example.test", "900-00-0008"],
  ["Contingent India Test", "Friend India", "09/10/1979", "202-555-0109", 26, "209 Sample Street, Test City, NY 10009", "contingent.india@example.test", "900-00-0009"],
  ["Contingent Juliet Test", "Relative Juliet", "10/11/1980", "202-555-0110", 31, "210 Sample Street, Test City, NY 10010", "contingent.juliet@example.test", "900-00-0010"],
] as const;
const expectedTaxIds = [
  "900000001", "900000002", "900000003", "900000004", "900000005",
  "900000006", "900000007", "900000008", "900000009", "900000010",
] as const;
const checkboxId = "If you are not married certify here";

function fixture() {
  const beneficiaries: IraBeneficiary[] = rowValues.map(([
    fullName, relationship, dateOfBirth, telephoneNumber, sharePercentage,
    address, emailAddress, taxId,
  ]) => ({
    fullName, relationship, dateOfBirth, telephoneNumber, sharePercentage,
    address, emailAddress, taxId,
  }));
  return {
    accountHolderName: "  Morgan   Owner Test  ",
    accountHolderTaxId: "990-00-0999",
    accountNumber: "  SYNTHETIC-ACCT-ACCURACY  ",
    primary: beneficiaries.slice(0, 5),
    contingent: beneficiaries.slice(5),
  };
}

describe("IRA beneficiary data accuracy with synthetic inputs", () => {
  let template: Uint8Array;

  beforeAll(async () => {
    template = await readFile(path.join(
      process.cwd(), IRA_BENEFICIARY_DEFINITION.template.relativePath,
    ));
  });

  async function render(payload: unknown) {
    const parsed = parseIraBeneficiaryDraft(payload);
    if (!parsed.ok) throw new Error(`Invalid synthetic fixture: ${JSON.stringify(parsed.issues)}`);
    return PDFDocument.load(await fillIraBeneficiaryPdf(template, parsed.value));
  }

  it("keeps all 80 beneficiary fields with the correct person and category", async () => {
    const pdf = await render(fixture());
    const form = pdf.getForm();

    expect(pdf.getPageCount()).toBe(2);
    expect(form.getFields()).toHaveLength(91);
    expect(form.getTextField("Name").getText()).toBe("Morgan Owner Test");
    expect(form.getTextField("Social Security Number").getText()).toBe("990000999");
    expect(form.getTextField("Account Number").getText()).toBe("SYNTHETIC-ACCT-ACCURACY");

    rowValues.forEach((row, rowIndex) => row.forEach((rawValue, column) => {
      const fieldId = rowFieldIds[rowIndex][column];
      const expected = column === 7 ? expectedTaxIds[rowIndex] : String(rawValue);
      expect(form.getTextField(fieldId).getText(), fieldId).toBe(expected);
    }));
  });

  it("leaves every unused primary and contingent field blank after a previous full draft", async () => {
    const originalBytes = Uint8Array.from(template);
    await render({ ...fixture(), certifyNotMarried: true });
    const shortDraft = {
      ...fixture(),
      accountHolderName: "Second Synthetic Owner",
      accountHolderTaxId: "990-00-0888",
      accountNumber: "DEMO-NEW2",
      primary: [{
        ...fixture().primary[0], fullName: "Replacement Primary Test", sharePercentage: 100,
      }],
      contingent: [],
    };

    // Each request must use the original blank template, not a prior output.
    for (let pass = 0; pass < 2; pass++) {
      const form = (await render(shortDraft)).getForm();
      expect(form.getTextField("Name").getText()).toBe("Second Synthetic Owner");
      expect(form.getTextField("Social Security Number").getText()).toBe("990000888");
      expect(form.getTextField("Account Number").getText()).toBe("DEMO-NEW2");
      expect(form.getTextField("Name_2").getText()).toBe("Replacement Primary Test");
      expect(form.getTextField("Share Percentage_2").getText()).toBe("100");
      expect(form.getCheckBox(checkboxId).isChecked()).toBe(false);
      for (const fieldId of rowFieldIds.slice(1).flat()) {
        expect(form.getTextField(fieldId).getText() ?? "", fieldId).toBe("");
      }
    }
    expect(Uint8Array.from(template)).toEqual(originalBytes);
  });

  it.each(["client", "staff"])("keeps holder SSN blank after generating a populated draft, without reusing beneficiary tax IDs (%s)", async (beneficiaryCompletion) => {
    const originalBytes = Uint8Array.from(template);
    await render(fixture());
    const form = (await render({
      ...fixture(), beneficiaryCompletion, accountHolderTaxId: "",
      primary: beneficiaryCompletion === "client" ? [] : fixture().primary,
      contingent: beneficiaryCompletion === "client" ? [] : fixture().contingent,
    })).getForm();
    expect(form.getTextField("Social Security Number").getText() ?? "").toBe("");
    expect(form.getTextField("Social Security Number").isRequired()).toBe(true);
    expect(form.getTextField("Social Security Number").isReadOnly()).toBe(false);
    expect(form.getTextField("Name").getText()).toBe("Morgan Owner Test");
    expect(form.getTextField("Account Number").getText()).toBe("SYNTHETIC-ACCT-ACCURACY");
    rowFieldIds.forEach((fields, index) => {
      expect(form.getTextField(fields[7]).getText() ?? "").toBe(beneficiaryCompletion === "client" ? "" : expectedTaxIds[index]);
    });
    expect(Uint8Array.from(template)).toEqual(originalBytes);
  });

  it.each([
    { label: "omitted", input: undefined, expected: false },
    { label: "false", input: false, expected: false },
    { label: "explicitly true", input: true, expected: true },
  ])("certification is $expected when $label", async ({ input, expected }) => {
    const payload = input === undefined ? fixture() : { ...fixture(), certifyNotMarried: input };
    const pdf = await render(payload);
    const checkbox = pdf.getForm().getCheckBox(checkboxId);

    expect(checkbox.isChecked()).toBe(expected);
    expect(checkbox.isReadOnly()).toBe(false);
    expect(checkbox.acroField.getWidgets().length).toBeGreaterThan(0);
    expect(checkbox.acroField.getWidgets()[0].dict.get(PDFName.of("Subtype"))?.toString()).toBe("/Widget");
  });

  it("preserves an editable certification checkbox through save and reload", async () => {
    const pdf = await render(fixture());
    pdf.getForm().getCheckBox(checkboxId).check();
    const checked = await PDFDocument.load(await pdf.save());
    expect(checked.getForm().getCheckBox(checkboxId).isChecked()).toBe(true);

    checked.getForm().getCheckBox(checkboxId).uncheck();
    const unchecked = await PDFDocument.load(await checked.save());
    expect(unchecked.getForm().getCheckBox(checkboxId).isChecked()).toBe(false);
    expect(unchecked.getForm().getCheckBox(checkboxId).isReadOnly()).toBe(false);
    expect(unchecked.getForm().getCheckBox(checkboxId).acroField.getWidgets().length).toBeGreaterThan(0);
  });

  it("never supplies signatures or signing dates", async () => {
    const form = (await render({ ...fixture(), certifyNotMarried: true })).getForm();
    const signatures = form.getFields().filter(field => field.constructor.name === "PDFSignature");

    expect(signatures).toHaveLength(3);
    for (const signature of signatures) {
      expect(signature.acroField.dict.get(PDFName.of("V"))).toBeUndefined();
    }
    for (const fieldId of ["Date_3", "Date", "Date_2"]) {
      expect(form.getTextField(fieldId).getText() ?? "", fieldId).toBe("");
    }
  });

  it.each(["primary", "contingent"] as const)("flags missing %s telephone information", kind => {
    const draft = fixture();
    draft[kind][0].telephoneNumber = "";
    const parsed = parseIraBeneficiaryDraft(draft);

    expect(parsed).toEqual({
      ok: false,
      issues: [{ path: `${kind}.0.telephoneNumber`, message: "Required" }],
    });
  });

  it("flags impossible birth dates and incomplete beneficiary tax IDs at their own paths", () => {
    const draft = fixture();
    draft.primary[1].dateOfBirth = "02/30/1990";
    draft.contingent[3].taxId = "90000001";

    expect(parseIraBeneficiaryDraft(draft)).toEqual({
      ok: false,
      issues: [
        { path: "primary.1.dateOfBirth", message: "Enter a valid past date" },
        { path: "contingent.3.taxId", message: "Enter a nine-digit SSN or TIN" },
      ],
    });
  });
});
