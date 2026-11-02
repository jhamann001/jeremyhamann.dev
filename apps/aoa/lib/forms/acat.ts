import { PDFCheckBox, PDFDict, PDFDocument, PDFName, PDFSignature, PDFTextField, StandardFonts, type PDFFont } from "pdf-lib";
import { ACAT_ACCOUNT_FIELDS, ACAT_DEFINITION } from "./acat-definition";

export type AcatDraft = {
  accountHolderName: string;
  accountHolderTaxId: string;
  accountNumber: string;
  confirmAccountTitle: true;
};
export type AcatIssue = { path: string; message: string };
export type AcatParseResult = { ok: true; value: AcatDraft } | { ok: false; issues: AcatIssue[] };

const allowedValues = new Set(["accountHolderName", "accountHolderTaxId", "confirmAccountTitle"]);
const normalize = (value: string) => value.trim().replace(/\s+/g, " ");

/** The receiving account number is supplied separately by the authorized server read. */
export function parseAcatDraft(raw: unknown, authorizedAccountNumber: string): AcatParseResult {
  const issues: AcatIssue[] = [];
  const source = raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown> : {};
  if (source !== raw) issues.push({ path: "form", message: "Invalid form payload" });
  if (Object.keys(source).some((key) => !allowedValues.has(key))) {
    // Do not echo unknown property names or values; they may contain private data.
    issues.push({ path: "form", message: "This form accepts receiving account title, optional tax ID, and title confirmation only" });
  }
  const accountHolderName = typeof source.accountHolderName === "string" ? normalize(source.accountHolderName) : "";
  if (!accountHolderName) issues.push({ path: "accountHolderName", message: "Enter the receiving account title" });
  if (accountHolderName.length > 200) issues.push({ path: "accountHolderName", message: "Use 200 characters or fewer without abbreviating the registered title" });
  if (source.confirmAccountTitle !== true) {
    issues.push({ path: "confirmAccountTitle", message: "Confirm that this is the receiving account's registered title" });
  }
  let accountHolderTaxId = "";
  const rawTaxId = source.accountHolderTaxId;
  if (rawTaxId !== undefined) {
    if (typeof rawTaxId !== "string") {
      issues.push({ path: "accountHolderTaxId", message: "Enter a nine-digit SSN or tax ID, or leave blank" });
    } else if (rawTaxId.trim()) {
      accountHolderTaxId = rawTaxId.replace(/[\s-]/g, "");
      if (rawTaxId.length > 20 || !/^\d{9}$/.test(accountHolderTaxId)) {
        issues.push({ path: "accountHolderTaxId", message: "Enter a nine-digit SSN or tax ID, or leave blank" });
      }
    }
  }
  const accountNumber = typeof authorizedAccountNumber === "string" ? authorizedAccountNumber.trim() : "";
  if (!accountNumber || accountNumber.length > 32) {
    issues.push({ path: "accountIds", message: "Select an account with a confirmed Apex account number" });
  }
  return issues.length ? { ok: false, issues } : {
    ok: true,
    value: { accountHolderName, accountHolderTaxId, accountNumber, confirmAccountTitle: true },
  };
}

export class AcatRenderError extends Error {
  constructor(readonly issues: AcatIssue[]) {
    super("The supplied values cannot be safely displayed on this template");
    this.name = "AcatRenderError";
  }
}

export class AcatTemplateError extends Error {
  constructor() {
    super("The ACAT template does not match its registered field structure");
    this.name = "AcatTemplateError";
  }
}

function fillText(field: PDFTextField, value: string, font: PDFFont, path: string) {
  let unitWidth: number;
  try { unitWidth = font.widthOfTextAtSize(value, 1); } catch {
    throw new AcatRenderError([{ path, message: "This value contains characters this PDF cannot display. Prepare the form manually without changing the registered information." }]);
  }
  const widgets = field.acroField.getWidgets();
  if (widgets.length === 0) throw new AcatTemplateError();
  const availableWidth = Math.min(...widgets.map((widget) =>
    widget.getRectangle().width - 2 * ((widget.getBorderStyle()?.getWidth() ?? 0) + 1) - 1,
  ));
  const availableHeight = Math.min(...widgets.map((widget) => widget.getRectangle().height - 2));
  const fontSize = Math.min(10, unitWidth > 0 ? availableWidth / unitWidth : 10, availableHeight / font.heightAtSize(1));
  if (!Number.isFinite(fontSize) || fontSize < 8) {
    throw new AcatRenderError([{ path, message: "This value cannot fit legibly on the form. Prepare the form manually without abbreviating the registered information." }]);
  }
  field.setText(value);
  field.acroField.setDefaultAppearance(`0 g\n/${font.name} ${fontSize} Tf`);
  field.setFontSize(fontSize);
  for (const widget of widgets) widget.setDefaultAppearance(field.acroField.getDefaultAppearance()!);
}

export async function fillAcatPdf(templateBytes: Uint8Array, draft: AcatDraft): Promise<Uint8Array> {
  let pdf: PDFDocument;
  try { pdf = await PDFDocument.load(templateBytes); } catch { throw new AcatTemplateError(); }
  const form = pdf.getForm();
  const fields = form.getFields();
  if (pdf.getPageCount() !== ACAT_DEFINITION.template.pageCount || fields.length !== ACAT_DEFINITION.template.fieldCount) {
    throw new AcatTemplateError();
  }
  for (const name of Object.values(ACAT_ACCOUNT_FIELDS)) {
    if (!(form.getFieldMaybe(name) instanceof PDFTextField)) throw new AcatTemplateError();
  }
  for (const field of fields) {
    if (field instanceof PDFTextField) {
      field.setText("");
      field.disableReadOnly();
    } else if (field instanceof PDFCheckBox) {
      field.uncheck();
      field.disableReadOnly();
    } else if (!(field instanceof PDFSignature) || field.acroField.V() !== undefined) {
      // Signed or unexpected template structures must never be silently rewritten.
      throw new AcatTemplateError();
    }
  }
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const acroForm = pdf.catalog.lookup(PDFName.of("AcroForm"), PDFDict);
  const resources = acroForm.lookupMaybe(PDFName.of("DR"), PDFDict) ?? pdf.context.obj({});
  const fonts = resources.lookupMaybe(PDFName.of("Font"), PDFDict) ?? pdf.context.obj({});
  fonts.set(PDFName.of(font.name), font.ref);
  resources.set(PDFName.of("Font"), fonts);
  acroForm.set(PDFName.of("DR"), resources);

  fillText(form.getTextField(ACAT_ACCOUNT_FIELDS.accountHolderName), draft.accountHolderName, font, "accountHolderName");
  fillText(form.getTextField(ACAT_ACCOUNT_FIELDS.accountNumber), draft.accountNumber, font, "accountIds");
  if (draft.accountHolderTaxId) {
    fillText(form.getTextField(ACAT_ACCOUNT_FIELDS.accountHolderTaxId), draft.accountHolderTaxId, font, "accountHolderTaxId");
  }
  form.updateFieldAppearances(font);
  pdf.setTitle(ACAT_DEFINITION.name);
  pdf.setSubject("Receiving-account information only; requires CS completion and human review before signing or submission");
  pdf.setProducer("Always-On Advice form library");
  return pdf.save({ useObjectStreams: false });
}
