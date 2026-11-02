import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { PDFButton, PDFCheckBox, PDFDocument, PDFRadioGroup, PDFSignature, PDFTextField } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { MAPPED_FORM_SPECS } from "@/lib/forms/mapped-forms";
import { fillMappedPdf, MappedFormRenderError, MappedFormTemplateError } from "@/lib/forms/mapped-form-pdf";
import { mappedInputs, type MappedFormInput, type MappedFormSpec } from "@/lib/forms/mapped-form-spec";
import { parseMappedDraft } from "@/lib/forms/mapped-form-validation";

const template = (spec: MappedFormSpec) => readFile(path.join(process.cwd(), spec.definition.template.relativePath));
const draft = (spec: MappedFormSpec, fields: Record<string, string> = {}) => {
  const parsed = parseMappedDraft(spec, { fields, confirmAccount: true }, "SYN-00001", "Jordan Sample");
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.value;
};
const choices = MAPPED_FORM_SPECS.flatMap(spec => mappedInputs(spec)
  .filter(input => input.kind === "choice")
  .map(input => ({ spec, input, caseName: `${spec.definition.id}/${input.key}` })));
const elections = choices.flatMap(choice => (choice.input.options ?? [])
  .map(option => ({ ...choice, option, caseName: `${choice.caseName}/${option.value}` })));

async function render(spec: MappedFormSpec, fields: Record<string, string> = {}, dirty = false) {
  let bytes: Uint8Array = await template(spec);
  if (dirty) {
    // Renderer defense-in-depth: previously checked widgets and old text must
    // never survive. Production additionally pins the unchanged source checksum.
    const source = await PDFDocument.load(bytes);
    for (const field of source.getForm().getFields()) {
      if (spec.preserveFields?.includes(field.getName())) continue;
      if (field instanceof PDFCheckBox) field.check();
      else if (field instanceof PDFRadioGroup) {
        const first = field.getOptions()[0];
        if (first) field.select(first);
      } else if (field instanceof PDFTextField) field.setText("9");
    }
    bytes = await source.save();
  }
  return PDFDocument.load(await fillMappedPdf(spec, bytes, draft(spec, fields)));
}

type ChoiceOption = NonNullable<MappedFormInput["options"]>[number];
function assertOnlySelectedElection(pdf: PDFDocument, selected?: ChoiceOption) {
  const selectedFields = new Set(selected?.pdfFields ?? []);
  for (const field of pdf.getForm().getFields()) {
    if (field instanceof PDFCheckBox) {
      expect(field.isChecked(), field.getName()).toBe(selectedFields.has(field.getName()));
    } else if (field instanceof PDFRadioGroup) {
      expect(field.getSelected(), field.getName()).toBe(selectedFields.has(field.getName()) ? selected?.pdfValue : undefined);
    } else if (field instanceof PDFSignature) {
      expect(field.acroField.V(), field.getName()).toBeUndefined();
    }
  }
}

// An in-memory, independently constructed PDF keeps foundation coverage real
// when all optional form registrations are disabled or individually reverted.
async function syntheticFixture() {
  const pdf = await PDFDocument.create();
  const first = pdf.addPage([612, 792]);
  const second = pdf.addPage([612, 792]);
  const form = pdf.getForm();
  const textNames = ["Synthetic Owner", "Synthetic Account", "Synthetic Optional", "Synthetic Unmapped", "Synthetic Signature Date"];
  for (const [index, name] of textNames.entries()) {
    const field = form.createTextField(name);
    field.addToPage(index < 3 ? first : second, { x: 40, y: 680 - index * 35, width: 250, height: 24 });
    field.setText("STALE VALUE");
    field.enableReadOnly();
    field.enableRequired();
  }
  for (const [index, name] of ["Synthetic Yes", "Synthetic No"].entries()) {
    const field = form.createCheckBox(name);
    field.addToPage(first, { x: 40 + index * 35, y: 450, width: 18, height: 18 });
    field.check();
  }
  const radio = form.createRadioGroup("Synthetic Radio");
  radio.addOptionToPage("First", second, { x: 40, y: 400, width: 18, height: 18 });
  radio.addOptionToPage("Second", second, { x: 75, y: 400, width: 18, height: 18 });
  radio.select("First");
  const bytes = await pdf.save();
  const spec: MappedFormSpec = {
    definition: {
      id: "synthetic_renderer_fixture", code: "SYNTHETIC", name: "Synthetic renderer fixture",
      version: "2026-09-18", effectiveOn: null, retiresOn: null, status: "internal_pilot",
      reviewState: "ready_for_human_review", entryPathSegment: "synthetic-renderer-fixture",
      summary: "Test-only document", callToAction: "Prepare draft",
      template: { relativePath: "synthetic-only.pdf", sha256: createHash("sha256").update(bytes).digest("hex"), pageCount: 2, fieldCount: 8 },
      eligibility: { context: "single_account", accountTypeIncludes: [], description: "Synthetic fixture only" },
      limits: {}, fields: [], rules: [], warnings: [], outputFilenamePattern: "synthetic-{timestamp}.pdf",
    },
    accountLabel: "Selected synthetic account", confirmation: "Confirm the synthetic account", completionChecklist: ["Complete missing fields"],
    sections: [{ title: "Synthetic fields", fields: [
      { key: "ownerName", label: "Owner", kind: "text", pdfFields: ["Synthetic Owner"], source: "clientName", requiredForDraft: true },
      { key: "accountNumber", label: "Account", kind: "text", pdfFields: ["Synthetic Account"], source: "accountNumber" },
      { key: "optional", label: "Optional", kind: "text", pdfFields: ["Synthetic Optional"] },
      { key: "checkboxChoice", label: "Checkbox election", kind: "choice", options: [
        { value: "yes", label: "Yes", pdfFields: ["Synthetic Yes"] },
        { value: "no", label: "No", pdfFields: ["Synthetic No"] },
      ] },
      { key: "radioChoice", label: "Radio election", kind: "choice", options: [
        { value: "first", label: "First", pdfFields: ["Synthetic Radio"], pdfValue: "First" },
        { value: "second", label: "Second", pdfFields: ["Synthetic Radio"], pdfValue: "Second" },
      ] },
    ] }],
  };
  return { bytes, spec };
}

describe("shared PDF renderer without any registered form", () => {
  it("fills only trusted source values, clears stale values and elections, and retains editable blank fields on both pages", async () => {
    const { bytes, spec } = await syntheticFixture();
    const pdf = await PDFDocument.load(await fillMappedPdf(spec, bytes, draft(spec)));
    expect(pdf.getPageCount()).toBe(2);
    expect(pdf.getForm().getFields()).toHaveLength(8);
    expect(pdf.getForm().getTextField("Synthetic Owner").getText()).toBe("Jordan Sample");
    expect(pdf.getForm().getTextField("Synthetic Account").getText()).toBe("SYN-00001");
    for (const name of ["Synthetic Optional", "Synthetic Unmapped", "Synthetic Signature Date"]) {
      const field = pdf.getForm().getTextField(name);
      expect(field.getText() ?? "").toBe("");
      expect(field.isReadOnly()).toBe(false);
      expect(field.isRequired()).toBe(false);
    }
    assertOnlySelectedElection(pdf);
    // The recipient can still enter a missing value after saving/reopening.
    pdf.getForm().getTextField("Synthetic Optional").setText("Adah Sample");
    const reopened = await PDFDocument.load(await pdf.save());
    expect(reopened.getForm().getTextField("Synthetic Optional").getText()).toBe("Adah Sample");
    expect(reopened.getPageCount()).toBe(2);
  });

  it("applies explicit manual text, checkbox and radio choices to their literal independent targets", async () => {
    const { bytes, spec } = await syntheticFixture();
    const pdf = await PDFDocument.load(await fillMappedPdf(spec, bytes, draft(spec, {
      optional: "Adah Sample", checkboxChoice: "no", radioChoice: "second",
    })));
    expect(pdf.getForm().getTextField("Synthetic Optional").getText()).toBe("Adah Sample");
    expect(pdf.getForm().getCheckBox("Synthetic Yes").isChecked()).toBe(false);
    expect(pdf.getForm().getCheckBox("Synthetic No").isChecked()).toBe(true);
    expect(pdf.getForm().getRadioGroup("Synthetic Radio").getSelected()).toBe("Second");
    expect(pdf.getForm().getTextField("Synthetic Unmapped").getText() ?? "").toBe("");
    expect(pdf.getForm().getTextField("Synthetic Signature Date").getText() ?? "").toBe("");
  });

  it("fails closed on an unregistered template repair even when the source shape matches", async () => {
    const { bytes, spec } = await syntheticFixture();
    const unknownRepair = { ...spec, repair: "unregistered-synthetic-repair" };
    await expect(fillMappedPdf(unknownRepair, bytes, draft(spec))).rejects.toBeInstanceOf(MappedFormTemplateError);
  });

  it.each(["pageCount", "fieldCount"] as const)("rejects an unexpected source %s", async key => {
    const { bytes, spec } = await syntheticFixture();
    const wrongShape = { ...spec, definition: { ...spec.definition, template: {
      ...spec.definition.template, [key]: spec.definition.template[key] + 1,
    } } };
    await expect(fillMappedPdf(wrongShape, bytes, draft(spec))).rejects.toBeInstanceOf(MappedFormTemplateError);
  });

  it("rejects values that would be illegible instead of silently truncating or shrinking below the floor", async () => {
    const { bytes, spec } = await syntheticFixture();
    await expect(fillMappedPdf(spec, bytes, draft(spec, { optional: "W".repeat(150) }))).rejects.toBeInstanceOf(MappedFormRenderError);
  });
});

describe("all mapped forms share a collision-free reviewed contract", () => {
  it("keeps enabled form identifiers and URL segments unique for any registration subset", () => {
    expect(new Set(MAPPED_FORM_SPECS.map(spec => spec.definition.id)).size).toBe(MAPPED_FORM_SPECS.length);
    expect(new Set(MAPPED_FORM_SPECS.map(spec => spec.definition.entryPathSegment)).size).toBe(MAPPED_FORM_SPECS.length);
  });

  it.each(MAPPED_FORM_SPECS)("has unique input keys and no cross-input PDF collisions: $definition.id", spec => {
    const inputs = mappedInputs(spec);
    expect(new Set(inputs.map(input => input.key)).size).toBe(inputs.length);
    expect(inputs.length).toBeGreaterThan(0);
    const owners = new Map<string, string>();
    for (const input of inputs) {
      expect(input.key).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
      expect(input.label.trim()).not.toBe("");
      const names = input.kind === "choice" ? input.options?.flatMap(option => option.pdfFields) ?? [] : input.pdfFields ?? [];
      expect(names.length, input.key).toBeGreaterThan(0);
      if (input.kind !== "choice") expect(new Set(names).size, input.key).toBe(names.length);
      for (const name of names) {
        // Reusing one radio-group field is intentional within a single choice
        // input, but two independent input keys may not control the same field.
        expect(owners.get(name) ?? input.key, `${name} is mapped by ${input.key}`).toBe(input.key);
        owners.set(name, input.key);
      }
      if (input.source === "accountNumber") expect(input.kind).toBe("text");
      if (input.allowedWhen) {
        const controllingInput = inputs.find(candidate => candidate.key === input.allowedWhen!.key);
        expect(controllingInput?.kind).toBe("choice");
        for (const value of input.allowedWhen.values) expect(controllingInput?.options?.some(option => option.value === value)).toBe(true);
      }
    }
    const definitionKeys = spec.definition.fields.map(field => field.canonicalKey);
    expect(new Set(definitionKeys).size).toBe(definitionKeys.length);
    expect([...definitionKeys].sort()).toEqual(inputs.map(input => input.key).sort());
    for (const group of spec.percentageGroups ?? []) for (const key of group) expect(inputs.find(input => input.key === key)?.kind).toBe("percent");
  });

  it.each(MAPPED_FORM_SPECS)("preserves only existing static artwork, never a mapped input: $definition.id", async spec => {
    const source = await PDFDocument.load(await template(spec));
    const names = mappedInputs(spec).flatMap(input => [...(input.pdfFields ?? []), ...(input.options?.flatMap(option => option.pdfFields) ?? [])]);
    expect(new Set(spec.preserveFields ?? []).size).toBe(spec.preserveFields?.length ?? 0);
    for (const name of spec.preserveFields ?? []) {
      expect(source.getForm().getField(name), name).toBeInstanceOf(PDFButton);
      expect(names).not.toContain(name);
    }
    for (const field of source.getForm().getFields()) if (field instanceof PDFButton) expect(spec.preserveFields).toContain(field.getName());
  });

  it.each(MAPPED_FORM_SPECS)("resolves every text mapping to the correct field type after template repairs: $definition.id", async spec => {
    const pdf = await render(spec);
    for (const input of mappedInputs(spec)) {
      if (input.kind === "choice") continue;
      for (const name of input.pdfFields ?? []) expect(pdf.getForm().getField(name), name).toBeInstanceOf(PDFTextField);
      if (input.characterBoxes) {
        expect(input.pdfFields!.length).toBe(input.kind === "routing" ? 9 : input.accountPart === "branch" ? 3 : 5);
      }
    }
  });

  it.each(MAPPED_FORM_SPECS)("clears stale optional text and elections before producing a minimal draft: $definition.id", async spec => {
    const values = draft(spec).fields;
    const expected = Object.fromEntries(mappedInputs(spec).filter(input => input.kind !== "choice")
      .flatMap(input => (input.pdfFields ?? []).map((name, index) => [name, input.characterBoxes ? values[input.key][index] ?? "" : values[input.key]])));
    const pdf = await render(spec, {}, true);
    assertOnlySelectedElection(pdf);
    for (const field of pdf.getForm().getFields()) if (field instanceof PDFTextField) expect(field.getText() ?? "", field.getName()).toBe(expected[field.getName()] ?? "");
  });
});

// The foundation (or a text-only form) legitimately has no registered elections.
if (choices.length > 0) describe("all explicit election options", () => {
  it.each(choices)("has no blank-default election and valid option targets: $caseName", async ({ spec, input }) => {
    const pdf = await render(spec);
    assertOnlySelectedElection(pdf);
    expect(input.options?.length).toBeGreaterThan(0);
    expect(new Set(input.options?.map(option => option.value)).size).toBe(input.options?.length);
    const distinctSelections = new Set<string>();
    for (const option of input.options ?? []) {
      expect(option.value.trim()).not.toBe("");
      expect(option.pdfFields.length).toBeGreaterThan(0);
      expect(new Set(option.pdfFields).size).toBe(option.pdfFields.length);
      const selection = JSON.stringify({ fields: [...option.pdfFields].sort(), exportValue: option.pdfValue ?? null });
      expect(distinctSelections.has(selection), `${input.key}/${option.value} must produce a distinct selection`).toBe(false);
      distinctSelections.add(selection);
      for (const name of option.pdfFields) {
        if (option.pdfValue === undefined) expect(pdf.getForm().getField(name)).toBeInstanceOf(PDFCheckBox);
        else {
          const field = pdf.getForm().getRadioGroup(name);
          expect(field.getOptions()).toContain(option.pdfValue);
        }
      }
    }
  });

  it.each(elections)("sets only its explicit election even when source widgets have old values: $caseName", async ({ spec, input, option }) => {
    const pdf = await render(spec, { [input.key]: option.value }, true);
    assertOnlySelectedElection(pdf, option);
    // A later blank draft cannot retain the preceding election.
    const blank = await render(spec);
    assertOnlySelectedElection(blank);
  });
});
