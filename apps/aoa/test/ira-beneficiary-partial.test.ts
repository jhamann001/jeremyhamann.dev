import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, PDFHexString, PDFName } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  fillIraBeneficiaryPdf, iraBeneficiaryClientCompletionRequired, parseIraBeneficiaryDraft,
  type IraBeneficiary, type IraBeneficiaryDraft,
} from "@/lib/forms/ira-beneficiary";
import { IRA_BENEFICIARY_DEFINITION } from "@/lib/forms/ira-beneficiary-definition";

const holder = { accountHolderName: "Morgan Owner Sample", accountHolderTaxId: "900000001", accountNumber: "SYNTH-0001" };
const complete = (fullName = "John Sample", sharePercentage = 100): IraBeneficiary => ({
  fullName, relationship: "Husband", dateOfBirth: "01/02/1980", telephoneNumber: "202-555-0100",
  sharePercentage, address: "100 Example Lane, Test City, NY 10001", emailAddress: "john@example.test", taxId: "900000002",
});
const emptyRow = {
  fullName: "", relationship: "", dateOfBirth: "", telephoneNumber: "", sharePercentage: null,
  address: "", emailAddress: "", taxId: "",
};
const partial = (extra: Record<string, unknown> = {}) => ({ ...holder, beneficiaryCompletion: "partial", ...extra });
function parsed(extra: Record<string, unknown> = {}): IraBeneficiaryDraft {
  const result = parseIraBeneficiaryDraft(partial(extra));
  if (!result.ok) throw new Error(`Invalid synthetic test input: ${JSON.stringify(result.issues)}`);
  return result.value;
}
const rowNames = ["Name", "Relationship", "Date of Birth", "Telephone Number", "Share Percentage", "Address", "Email Address", "Social Security Number"];
const template = () => readFile(path.join(process.cwd(), IRA_BENEFICIARY_DEFINITION.template.relativePath));
const render = async (extra: Record<string, unknown> = {}) => PDFDocument.load(await fillIraBeneficiaryPdf(await template(), parsed(extra)));

describe("partial beneficiary validation and completion", () => {
  it("keeps a name and relationship exactly as provided and leaves all unknown data blank", () => {
    const draft = parsed({ primary: [{ fullName: " John ", relationship: "husband" }] });
    expect(draft.primary).toEqual([{ ...emptyRow, fullName: "John", relationship: "husband" }]);
    expect(draft.contingent).toEqual([]);
    expect(draft.certifyNotMarried).toBe(false);
    expect(iraBeneficiaryClientCompletionRequired(draft)).toBe(true);
  });

  it.each([undefined, null, "", " \t "])("normalizes an unknown percentage to null, never zero (%j)", (sharePercentage) => {
    expect(parsed({ primary: [{ fullName: "John", sharePercentage }] }).primary[0].sharePercentage).toBeNull();
  });

  it.each([false, true, [], [50], {}, "50", "50%", 0, -1, 101, 50.5, NaN, Infinity].map(sharePercentage => ({ sharePercentage })))("rejects nonnumeric or invalid provided percentages ($sharePercentage)", ({ sharePercentage }) => {
    expect(parseIraBeneficiaryDraft(partial({ primary: [{ fullName: "John", sharePercentage }] }))).toEqual({
      ok: false, issues: [{ path: "primary.0.sharePercentage", message: "Use a whole percentage from 1 to 100, or leave blank for the client" }],
    });
  });

  it.each(["fullName", "relationship", "dateOfBirth", "telephoneNumber", "address", "emailAddress", "taxId"])("rejects supplied nonstring %s without treating it as missing", (field) => {
    for (const value of [null, false, 123, [], {}]) {
      expect(parseIraBeneficiaryDraft(partial({ primary: [{ [field]: value }] }))).toMatchObject({
        ok: false, issues: expect.arrayContaining([expect.objectContaining({ path: `primary.0.${field}` })]),
      });
    }
  });

  it.each([
    ["fullName", "x".repeat(81)], ["relationship", "x".repeat(41)], ["address", "x".repeat(121)],
    ["telephoneNumber", "not a phone"], ["dateOfBirth", "02/30/1990"], ["dateOfBirth", "01/01/2999"],
    ["emailAddress", "bad-email"], ["taxId", "0002"], ["taxId", "***-**-0002"], ["taxId", "abc900000002"],
  ])("rejects invalid supplied %s", (field, value) => {
    expect(parseIraBeneficiaryDraft(partial({ primary: [{ [field]: value }] }))).toMatchObject({
      ok: false, issues: expect.arrayContaining([expect.objectContaining({ path: `primary.0.${field}` })]),
    });
  });

  it.each(["primary", "contingent"])("allows unfinished %s totals but rejects over-allocation", (kind) => {
    const draft = parsed({ [kind]: [complete("John Sample", 40), complete("Casey Sample", 20)] });
    expect(draft[kind as "primary" | "contingent"].map(row => row.sharePercentage)).toEqual([40, 20]);
    expect(iraBeneficiaryClientCompletionRequired(draft)).toBe(true);
    expect(parseIraBeneficiaryDraft(partial({ [kind]: [complete("John Sample", 70), complete("Casey Sample", 40)] }))).toMatchObject({
      ok: false, issues: expect.arrayContaining([expect.objectContaining({ path: kind, message: expect.stringContaining("cannot exceed 100%") })]),
    });
  });

  it("does not invent a remaining share when one row supplies 100% and another supplies no percentage", () => {
    const draft = parsed({ primary: [complete(), { fullName: "Casey" }] });
    expect(draft.primary[1].sharePercentage).toBeNull();
    expect(iraBeneficiaryClientCompletionRequired(draft)).toBe(true);
  });

  it("preserves blank positions and ignores entirely unused rows for completion", () => {
    const draft = parsed({ primary: [{}, complete(), {}], contingent: [{}, {}] });
    expect(draft.primary).toEqual([emptyRow, complete(), emptyRow]);
    expect(draft.contingent).toEqual([emptyRow, emptyRow]);
    expect(iraBeneficiaryClientCompletionRequired(draft)).toBe(false);
  });

  it("requires a primary designation even when contingent entries are complete", () => {
    expect(iraBeneficiaryClientCompletionRequired(parsed({ primary: [{}, {}], contingent: [complete()] }))).toBe(true);
    expect(iraBeneficiaryClientCompletionRequired(parsed())).toBe(true);
  });

  it("recognizes a fully supplied partial designation without weakening missing holder SSN", () => {
    const values = { primary: [complete("John Sample", 60), complete("Casey Sample", 40)], contingent: [complete("Abigail Sample")] };
    expect(iraBeneficiaryClientCompletionRequired(parsed(values))).toBe(false);
    expect(iraBeneficiaryClientCompletionRequired(parsed({ ...values, accountHolderTaxId: "" }))).toBe(true);
    expect(iraBeneficiaryClientCompletionRequired(parsed({ ...values, contingent: [{ ...complete(), emailAddress: "" }] }))).toBe(true);
  });

  it.each([null, {}, "wrong", [null], new Array(6).fill({})].map(primary => ({ primary })))("rejects malformed or excess row containers ($primary)", ({ primary }) => {
    expect(parseIraBeneficiaryDraft(partial({ primary }))).toMatchObject({ ok: false });
  });

  it("preserves client-mode hidden-data rejection and strict staff or omitted-mode rules", () => {
    for (const beneficiaryCompletion of ["client", "staff", undefined]) {
      expect(parseIraBeneficiaryDraft({ ...holder, beneficiaryCompletion, primary: [{ fullName: "John", relationship: "husband" }] })).toMatchObject({ ok: false });
    }
  });
});

describe("partial beneficiary PDF completion cues", () => {
  it("fills John/husband only, marking the other six fields for the client and leaving unused rows optional", async () => {
    const pdf = await render({ primary: [{ fullName: "John", relationship: "husband" }] });
    const form = pdf.getForm();
    expect(pdf.getPageCount()).toBe(2);
    expect(form.getFields()).toHaveLength(91);
    for (const name of rowNames) {
      const field = form.getTextField(`${name}_2`);
      const supplied = name === "Name" || name === "Relationship";
      expect(field.getText() ?? "").toBe(name === "Name" ? "John" : name === "Relationship" ? "husband" : "");
      expect(field.isReadOnly()).toBe(false);
      expect(field.isRequired()).toBe(!supplied);
      if (!supplied) expect(field.acroField.dict.lookup(PDFName.of("TU"), PDFHexString).decodeText()).toMatch(/^Client to complete: primary beneficiary /);
    }
    for (let suffix = 3; suffix <= 11; suffix++) {
      for (const name of rowNames) {
        const field = form.getTextField(`${name}_${suffix}`);
        expect(field.getText() ?? "").toBe("");
        expect(field.isRequired()).toBe(false);
        expect(field.isReadOnly()).toBe(false);
      }
    }
    expect(form.getCheckBox("If you are not married certify here").isChecked()).toBe(false);
    for (const name of ["Signature of Account Holder", "Signature of Spouse", "Signature of Witness"]) expect(form.getSignature(name).acroField.V()).toBeUndefined();
    for (const name of ["Date", "Date_2", "Date_3"]) expect(form.getTextField(name).getText() ?? "").toBe("");
    form.getTextField("Name_2").setText("John Client Corrected");
    form.getTextField("Share Percentage_2").setText("100");
    const edited = (await PDFDocument.load(await pdf.save())).getForm();
    expect(edited.getTextField("Name_2").getText()).toBe("John Client Corrected");
    expect(edited.getTextField("Share Percentage_2").getText()).toBe("100");
  });

  it("retains a populated second primary row without making the preceding blank row mandatory", async () => {
    const form = (await render({ primary: [{}, { fullName: "John", relationship: "husband" }] })).getForm();
    for (const name of rowNames) {
      expect(form.getTextField(`${name}_2`).getText() ?? "").toBe("");
      expect(form.getTextField(`${name}_2`).isRequired()).toBe(false);
    }
    expect(form.getTextField("Name_3").getText()).toBe("John");
    expect(form.getTextField("Relationship_3").getText()).toBe("husband");
    expect(form.getTextField("Date of Birth_3").isRequired()).toBe(true);
    expect(form.getTextField("Share Percentage_3").getText() ?? "").toBe("");
  });

  it("marks the first primary row and missing used contingent fields when only a contingent beneficiary is provided", async () => {
    const form = (await render({ primary: [{}, {}], contingent: [{}, { fullName: "Abigail" }] })).getForm();
    for (const name of rowNames) {
      expect(form.getTextField(`${name}_2`).isRequired()).toBe(true);
      expect(form.getTextField(`${name}_3`).isRequired()).toBe(false);
      expect(form.getTextField(`${name}_7`).isRequired()).toBe(false);
    }
    expect(form.getTextField("Name_8").getText()).toBe("Abigail");
    expect(form.getTextField("Name_8").isRequired()).toBe(false);
    expect(form.getTextField("Relationship_8").isRequired()).toBe(true);
  });

  it("preserves every supplied complete designation value and under-allocated shares without filling the remainder", async () => {
    const form = (await render({ primary: [complete("John Sample", 60), complete("Casey Sample", 20)] })).getForm();
    expect(form.getTextField("Name_2").getText()).toBe("John Sample");
    expect(form.getTextField("Share Percentage_2").getText()).toBe("60");
    expect(form.getTextField("Share Percentage_3").getText()).toBe("20");
    expect(form.getTextField("Share Percentage_4").getText() ?? "").toBe("");
    for (const suffix of [2, 3]) for (const name of rowNames) expect(form.getTextField(`${name}_${suffix}`).isRequired()).toBe(false);
  });

  it("still rejects supplied text that cannot fit or render safely", async () => {
    await expect(fillIraBeneficiaryPdf(await template(), parsed({ primary: [{ fullName: "W".repeat(80) }] }))).rejects.toMatchObject({
      issues: [{ path: "primary.0.fullName", message: expect.stringContaining("fit legibly") }],
    });
  });
});
