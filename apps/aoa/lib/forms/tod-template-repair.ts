import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from "pdf-lib";

/**
 * The source page Annots also point at duplicate, stale widget dictionaries,
 * separate from the AcroForm field tree. Retarget each annotation to the field
 * tree's matching widget; otherwise readers render stale/blank appearances even
 * though field-value extraction reports the newly entered data.
 */
function reconnectPageWidgets(pdf: PDFDocument): void {
  const key = (dict: PDFDict) => {
    const name = dict.get(PDFName.of("T"));
    const identity = name instanceof PDFString || name instanceof PDFHexString
      ? `name:${name.decodeText()}`
      : `parent:${dict.get(PDFName.of("Parent"))?.toString()}`;
    return `${identity}|${dict.get(PDFName.of("Rect"))?.toString()}`;
  };
  const canonical = new Map<string, PDFRef>();
  for (const field of pdf.getForm().getFields()) for (const widget of field.acroField.getWidgets()) {
    const ref = pdf.context.getObjectRef(widget.dict);
    const widgetKey = key(widget.dict);
    if (!ref || canonical.has(widgetKey)) throw new Error("Unexpected TOD canonical widgets.");
    canonical.set(widgetKey, ref);
  }
  const matched = new Set<PDFRef>();
  for (const page of pdf.getPages()) {
    const annotations = page.node.Annots();
    if (!annotations) continue;
    for (let index = 0; index < annotations.size(); index++) {
      const dict = annotations.lookup(index, PDFDict);
      const ref = canonical.get(key(dict));
      if (!ref || matched.has(ref)) throw new Error("Unexpected TOD page annotation.");
      matched.add(ref);
      annotations.set(index, ref);
    }
  }
  if (matched.size !== canonical.size) throw new Error("Missing TOD page widgets.");
}

/**
 * Repair AcroForm-structure defects in the checksum-pinned supplied TOD
 * template. Page content, labels, wording and widget rectangles remain unchanged.
 * This operates only on the generated in-memory document.
 */
export function repairTodTemplate(pdf: PDFDocument): void {
  const form = pdf.getForm();
  const address = form.getTextField("Beneficiary 3 - Address");
  const widgets = address.acroField.getWidgets();
  const kids = address.acroField.Kids();
  const group = form.getField("Group 1");

  // Fail closed on a changed template, including a repeated repair attempt.
  if (
    form.getFieldMaybe("Beneficiary 6 - Address") ||
    !kids || kids.size() !== 2 || widgets.length !== 2 ||
    group.acroField.getWidgets().length !== 2
  ) throw new Error("Unexpected TOD form structure.");

  const index3 = widgets.findIndex((widget) => Math.abs(widget.getRectangle().y - 529.309) < 0.01);
  const index6 = widgets.findIndex((widget) => Math.abs(widget.getRectangle().y - 323.997) < 0.01);
  if (index3 < 0 || index6 < 0 || index3 === index6) throw new Error("Unexpected TOD address widgets.");
  const row3Ref = kids.get(index3);
  const row6Ref = kids.get(index6);
  if (!(row3Ref instanceof PDFRef) || !(row6Ref instanceof PDFRef)) throw new Error("Unexpected TOD widget references.");

  reconnectPageWidgets(pdf);

  // Reparent the existing lower widget rather than drawing a replacement box.
  // The page annotation now references this canonical widget, preserving its
  // position/style and making the two addresses independently editable.
  const row6 = form.createTextField("Beneficiary 6 - Address");
  row6.acroField.setKids([row6Ref]);
  widgets[index6].dict.set(PDFName.of("Parent"), row6.ref);
  row6.acroField.setDefaultAppearance(widgets[index6].getDefaultAppearance() ?? "/Helvetica 10 Tf 0 g");
  address.acroField.setKids([row3Ref]);
  address.acroField.setDefaultAppearance(widgets[index3].getDefaultAppearance() ?? "/Helvetica 10 Tf 0 g");

  // The source has the radio flags only on its child widgets, so pdf-lib
  // otherwise interprets the parent as a checkbox. Correct the parent flag.
  // Radio (bit 16) only: leaving the choice unanswered remains permitted.
  group.acroField.setFlags(32768);
  group.acroField.dict.set(PDFName.of("V"), PDFName.of("Off"));
  const radio = form.getRadioGroup("Group 1");
  if (radio.getOptions().join("|") !== "New|Update") throw new Error("Unexpected TOD designation options.");
  radio.clear();
}
