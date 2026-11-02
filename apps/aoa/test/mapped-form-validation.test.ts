import { describe, expect, it } from "vitest";
import { ACAT_DEFINITION } from "@/lib/forms/acat-definition";
import type { MappedFormInput, MappedFormSpec } from "@/lib/forms/mapped-form-spec";
import { formatMappedInput, parseMappedDraft } from "@/lib/forms/mapped-form-validation";

const inputs: MappedFormInput[] = [
  { key: "name", label: "Name", kind: "text", source: "clientName", requiredForDraft: true, pdfFields: ["Name"] },
  { key: "account", label: "Account", kind: "text", source: "accountNumber", pdfFields: ["Account"] },
  ...(["taxId", "taxIdLast4", "date", "phone", "email", "routing", "money", "percent"] as const).map(kind => ({ key: kind, label: kind, kind, pdfFields: [kind] })),
  { key: "share1", label: "Share 1", kind: "percent", min: 1, wholeNumber: true, pdfFields: ["Share1"] },
  { key: "share2", label: "Share 2", kind: "percent", min: 1, wholeNumber: true, pdfFields: ["Share2"] },
  { key: "choice", label: "Choice", kind: "choice", options: [{ value: "yes", label: "Yes", pdfFields: ["Yes"] }] },
];
const spec: MappedFormSpec = { definition: ACAT_DEFINITION, accountLabel: "Account", confirmation: "Confirm", sections: [{ title: "Fields", fields: inputs }], completionChecklist: [], percentageGroups: [["share1", "share2"]] };
const parse = (fields: Record<string, unknown> = {}, confirmAccount: unknown = true) => parseMappedDraft(spec, { fields, confirmAccount }, "SYN-00001", "Jordan Sample");

describe("optional mapped-form input contract", () => {
  it("allows all optional fields blank and only sources the authorized account and suggested name", () => {
    const result = parse(); expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fields).toEqual(Object.fromEntries(inputs.map(input => [input.key, input.key === "name" ? "Jordan Sample" : input.key === "account" ? "SYN-00001" : ""])));
  });
  it.each([null, [], "bad", { fields: [] }, { fields: null }])("rejects malformed envelopes", value => expect(parseMappedDraft(spec, value, "SYN-00001", "Jordan Sample").ok).toBe(false));
  it.each([false, "true", 1, null])("requires explicit confirmation", confirm => expect(parse({}, confirm).ok).toBe(false));
  it.each([null, false, 12, [], {}])("rejects non-text optional and source-suggestion values", value => {
    expect(parse({ name: value }).ok).toBe(false); expect(parse({ taxId: value }).ok).toBe(false);
  });
  it("rejects unknown fields and source overrides without echoing their contents", () => {
    const result = parse({ account: "PRIVATE-ACCOUNT", "PRIVATE-KEY": "PRIVATE-VALUE" });
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toMatch(/PRIVATE-/);
    expect(parseMappedDraft(spec, { fields: {}, confirmAccount: true, unsupported: "private" }, "SYN-00001", "Jordan Sample").ok).toBe(false);
  });
  it("does not replace an explicit blank owner name with the suggestion", () => expect(parse({ name: " " }).ok).toBe(false));
  it("normalizes dates, domestic phones and complete tax IDs without altering a leading-zero account", () => {
    const result = parse({ date: "01021990", phone: "(202) 555-0101", taxId: "900-00-0001", taxIdLast4: "0001", money: "$1,234.50" });
    expect(result).toMatchObject({ ok: true, value: { fields: { date: "01/02/1990", phone: "202-555-0101", taxId: "900000001", taxIdLast4: "0001", account: "SYN-00001", money: "1234.50" } } });
  });
  it.each(["1234", "***-**-1234", "9000000010", "nine00001"])("rejects incomplete/masked full tax IDs: %s", value => expect(parse({ taxId: value }).ok).toBe(false));
  it.each(["900000001", "123", "12345", "****"])("does not truncate values to last four: %s", value => expect(parse({ taxIdLast4: value }).ok).toBe(false));
  it.each(["02292023", "02302024", "13012000", "00/01/2000", "12/31/2199", "02/29/1900"])("rejects invalid/future dates: %s", value => expect(parse({ date: value }).ok).toBe(false));
  it("accepts a leap day", () => expect(parse({ date: "02292000" }).ok).toBe(true));
  it.each(["123", "12025550101", "202555010112", "2025550101 ext 22"])("does not drop phone country code/extensions/extra digits: %s", value => expect(parse({ phone: value }).ok).toBe(false));
  it.each(["0", "-1", "1e3", "Infinity", "1.234", "1,2", "999999999999999999"])("rejects ambiguous or invalid money: %s", value => expect(parse({ money: value }).ok).toBe(false));
  it.each(["-1", "101", "1e2", "2.123"])("validates percentages: %s", value => expect(parse({ percent: value }).ok).toBe(false));
  it("permits partial share totals but rejects fractional TOD-style shares and totals above100", () => {
    expect(parse({ share1: "30" }).ok).toBe(true); expect(parse({ share1: "30", share2: "70" }).ok).toBe(true);
    expect(parse({ share1: "30.5" }).ok).toBe(false); expect(parse({ share1: "0" }).ok).toBe(false);
    expect(parse({ share1: "60", share2: "60" }).ok).toBe(false);
  });
  it("requires exact choice and routing values", () => {
    expect(parse({ choice: "yes", routing: "012345678" }).ok).toBe(true);
    expect(parse({ choice: "Yes" }).ok).toBe(false); expect(parse({ routing: "12345678" }).ok).toBe(false);
  });
  it("does not infer a choice from any other value", () => {
    const result = parse({ money: "100" }); expect(result).toMatchObject({ ok: true, value: { fields: { choice: "" } } });
  });
  it("leaves incomplete input untouched while editing", () => {
    expect(formatMappedInput("date", "0102")).toBe("0102"); expect(formatMappedInput("phone", "202555")).toBe("202555");
    expect(formatMappedInput("phone", "12025550101")).toBe("12025550101");
  });
  it("splits only exactly supported Apex account numbers", () => {
    const segmented: MappedFormSpec = { ...spec, sections: [{ title: "Header", fields: [
      { key: "branch", label: "Branch", kind: "text", source: "accountNumber", accountPart: "branch", characterBoxes: true, pdfFields: ["B1", "B2", "B3"] },
      { key: "number", label: "Number", kind: "text", source: "accountNumber", accountPart: "number", characterBoxes: true, pdfFields: ["N1", "N2", "N3", "N4", "N5"] },
    ] }] };
    expect(parseMappedDraft(segmented, { fields: {}, confirmAccount: true }, "SYN-00123", "Jordan Sample")).toMatchObject({ ok: true, value: { fields: { branch: "SYN", number: "00123" } } });
    for (const number of ["SYNTH-00123", "SYN00123", "SYN-001234", "SYN-AB123", "SYN-00123-1"]) expect(parseMappedDraft(segmented, { fields: {}, confirmAccount: true }, number, "Jordan Sample").ok).toBe(false);
  });
});
