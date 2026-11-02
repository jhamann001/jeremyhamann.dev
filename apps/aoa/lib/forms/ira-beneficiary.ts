import { PDFDict, PDFDocument, PDFHexString, PDFName, StandardFonts, type PDFFont, type PDFTextField } from "pdf-lib";
import {
  IRA_BENEFICIARY_ACCOUNT_FIELDS,
  IRA_BENEFICIARY_DEFINITION,
  iraBeneficiaryRowFields,
  type IraBeneficiaryPdfRow,
} from "./ira-beneficiary-definition";

export type IraBeneficiary = {
  fullName: string;
  relationship: string;
  dateOfBirth: string;
  telephoneNumber: string;
  sharePercentage: number;
  address: string;
  emailAddress: string;
  taxId: string;
};

export type IraBeneficiaryDraftRow = Omit<IraBeneficiary, "sharePercentage"> & {
  sharePercentage: number | null;
};

export type IraBeneficiaryDraft = {
  beneficiaryCompletion: "client" | "partial" | "staff";
  accountHolderName: string;
  accountHolderTaxId: string;
  accountNumber: string;
  certifyNotMarried: boolean;
  primary: IraBeneficiaryDraftRow[];
  contingent: IraBeneficiaryDraftRow[];
};

export type IraBeneficiaryValidationIssue = {
  path: string;
  message: string;
};

export type IraBeneficiaryParseResult =
  | { ok: true; value: IraBeneficiaryDraft }
  | { ok: false; issues: IraBeneficiaryValidationIssue[] };

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function requiredText(
  source: UnknownRecord,
  key: string,
  path: string,
  issues: IraBeneficiaryValidationIssue[],
  maxLength: number,
): string {
  const raw = source[key];
  if (typeof raw !== "string" || !raw.trim()) {
    issues.push({ path, message: "Required" });
    return "";
  }
  const value = raw.trim().replace(/\s+/g, " ");
  if (value.length > maxLength) {
    issues.push({ path, message: `Must be ${maxLength} characters or fewer` });
  }
  return value;
}

function taxId(
  source: UnknownRecord,
  key: string,
  path: string,
  issues: IraBeneficiaryValidationIssue[],
): string {
  const raw = requiredText(source, key, path, issues, 20);
  const digits = raw.replace(/\D/g, "");
  if (raw && digits.length !== 9) {
    issues.push({ path, message: "Enter a nine-digit SSN or TIN" });
  }
  return digits;
}

/** Used for draft-optional holder and partial-mode beneficiary tax IDs only. */
function optionalTaxId(
  source: UnknownRecord,
  key: string,
  path: string,
  issues: IraBeneficiaryValidationIssue[],
): string {
  const raw = source[key];
  if (raw === undefined || (typeof raw === "string" && !raw.trim())) return "";
  if (typeof raw !== "string" || raw.length > 20 || !/^[0-9 -]+$/.test(raw)) {
    issues.push({ path, message: "Enter a nine-digit SSN or TIN, or leave blank for the client" });
    return "";
  }
  const digits = raw.replace(/[ -]/g, "");
  if (digits.length !== 9) {
    issues.push({ path, message: "Enter a nine-digit SSN or TIN, or leave blank for the client" });
  }
  return digits;
}

function dateOfBirth(
  source: UnknownRecord,
  key: string,
  path: string,
  issues: IraBeneficiaryValidationIssue[],
): string {
  const value = requiredText(source, key, path, issues, 10);
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!value) return value;
  if (!match) {
    issues.push({ path, message: "Use MM/DD/YYYY" });
    return value;
  }
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getTime() < Date.now();
  if (!valid) issues.push({ path, message: "Enter a valid past date" });
  return value;
}

function parseBeneficiaries(
  raw: unknown,
  kind: "primary" | "contingent",
  issues: IraBeneficiaryValidationIssue[],
): IraBeneficiary[] {
  const label = kind === "primary" ? "Primary" : "Contingent";
  if (!Array.isArray(raw)) {
    issues.push({ path: kind, message: `${label} beneficiaries must be a list` });
    return [];
  }
  const max = kind === "primary"
    ? IRA_BENEFICIARY_DEFINITION.limits.primaryBeneficiaries
    : IRA_BENEFICIARY_DEFINITION.limits.contingentBeneficiaries;
  if (raw.length > max) {
    issues.push({ path: kind, message: `The form supports at most ${max} ${kind} beneficiaries` });
  }

  return raw.slice(0, max).map((item, index) => {
    const path = `${kind}.${index}`;
    const row = isRecord(item) ? item : {};
    if (!isRecord(item)) issues.push({ path, message: "Beneficiary must be an object" });

    const shareRaw = row.sharePercentage;
    const share = typeof shareRaw === "number" ? shareRaw : Number(shareRaw);
    if (!Number.isInteger(share) || share <= 0 || share > 100) {
      issues.push({ path: `${path}.sharePercentage`, message: "Use a whole percentage from 1 to 100" });
    }

    const telephoneNumber = requiredText(row, "telephoneNumber", `${path}.telephoneNumber`, issues, 24);
    if (telephoneNumber && telephoneNumber.replace(/\D/g, "").length < 7) {
      issues.push({ path: `${path}.telephoneNumber`, message: "Enter a valid telephone number" });
    }

    const emailAddress = requiredText(row, "emailAddress", `${path}.emailAddress`, issues, 80);
    if (emailAddress && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress)) {
      issues.push({ path: `${path}.emailAddress`, message: "Enter a valid email address" });
    }

    return {
      fullName: requiredText(row, "fullName", `${path}.fullName`, issues, 80),
      relationship: requiredText(row, "relationship", `${path}.relationship`, issues, 40),
      dateOfBirth: dateOfBirth(row, "dateOfBirth", `${path}.dateOfBirth`, issues),
      telephoneNumber,
      sharePercentage: share,
      address: requiredText(row, "address", `${path}.address`, issues, 120),
      emailAddress,
      taxId: taxId(row, "taxId", `${path}.taxId`, issues),
    };
  });
}

function validateShareTotal(
  rows: IraBeneficiaryDraftRow[],
  kind: "primary" | "contingent",
  issues: IraBeneficiaryValidationIssue[],
) {
  if (rows.length === 0 && kind === "primary") {
    issues.push({ path: "primary", message: "Add at least one primary beneficiary" });
    return;
  }
  if (rows.length === 0) return;
  const total = rows.reduce((sum, row) => sum + (row.sharePercentage ?? 0), 0);
  if (total !== 100) {
    issues.push({ path: kind, message: `${kind === "primary" ? "Primary" : "Contingent"} shares must total 100% (currently ${total}%)` });
  }
}

function optionalText(
  source: UnknownRecord,
  key: string,
  path: string,
  issues: IraBeneficiaryValidationIssue[],
  maxLength: number,
): string {
  const raw = source[key];
  if (raw === undefined) return "";
  if (typeof raw !== "string") {
    issues.push({ path, message: "Enter text or leave blank for the client" });
    return "";
  }
  const value = raw.trim().replace(/\s+/g, " ");
  if (value.length > maxLength) issues.push({ path, message: `Must be ${maxLength} characters or fewer` });
  return value;
}

function parsePartialBeneficiaries(
  raw: unknown,
  kind: "primary" | "contingent",
  issues: IraBeneficiaryValidationIssue[],
): IraBeneficiaryDraftRow[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push({ path: kind, message: `${kind === "primary" ? "Primary" : "Contingent"} beneficiaries must be a list` });
    return [];
  }
  const max = IRA_BENEFICIARY_DEFINITION.limits[`${kind}Beneficiaries`];
  if (raw.length > max) issues.push({ path: kind, message: `The form supports at most ${max} ${kind} beneficiaries` });
  // Do not filter empty rows: their positions are the PDF row positions.
  const rows = raw.slice(0, max).map((item, index): IraBeneficiaryDraftRow => {
    const path = `${kind}.${index}`;
    const row = isRecord(item) ? item : {};
    if (!isRecord(item)) issues.push({ path, message: "Beneficiary must be an object" });
    const text = (key: string, limit: number) => optionalText(row, key, `${path}.${key}`, issues, limit);
    const birthDate = text("dateOfBirth", 10);
    if (birthDate && birthDate.length <= 10) dateOfBirth({ dateOfBirth: birthDate }, "dateOfBirth", `${path}.dateOfBirth`, issues);
    const telephoneNumber = text("telephoneNumber", 24);
    if (telephoneNumber && telephoneNumber.replace(/\D/g, "").length < 7) {
      issues.push({ path: `${path}.telephoneNumber`, message: "Enter a valid telephone number" });
    }
    const emailAddress = text("emailAddress", 80);
    if (emailAddress && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress)) {
      issues.push({ path: `${path}.emailAddress`, message: "Enter a valid email address" });
    }
    const rawShare = row.sharePercentage;
    const shareBlank = rawShare === undefined || rawShare === null || (typeof rawShare === "string" && !rawShare.trim());
    let sharePercentage: number | null = null;
    if (!shareBlank) {
      if (typeof rawShare !== "number" || !Number.isInteger(rawShare) || rawShare <= 0 || rawShare > 100) {
        issues.push({ path: `${path}.sharePercentage`, message: "Use a whole percentage from 1 to 100, or leave blank for the client" });
      } else sharePercentage = rawShare;
    }
    return {
      fullName: text("fullName", 80), relationship: text("relationship", 40), dateOfBirth: birthDate,
      telephoneNumber, sharePercentage, address: text("address", 120), emailAddress,
      taxId: optionalTaxId(row, "taxId", `${path}.taxId`, issues),
    };
  });
  const total = rows.reduce((sum, row) => sum + (row.sharePercentage ?? 0), 0);
  if (total > 100) issues.push({ path: kind, message: `${kind === "primary" ? "Primary" : "Contingent"} shares cannot exceed 100% (currently ${total}%)` });
  return rows;
}

function isUsedBeneficiary(row: IraBeneficiaryDraftRow): boolean {
  return Object.values(row).some((value) => value !== "" && value !== null);
}

/** Completion describes pending client work, not permission to sign or submit. */
export function iraBeneficiaryClientCompletionRequired(draft: IraBeneficiaryDraft): boolean {
  if (!draft.accountHolderTaxId || draft.beneficiaryCompletion === "client") return true;
  if (draft.beneficiaryCompletion === "staff") return false;
  const primary = draft.primary.filter(isUsedBeneficiary);
  const contingent = draft.contingent.filter(isUsedBeneficiary);
  if (primary.length === 0) return true;
  return [primary, contingent].some((rows) => rows.length > 0 && (
    rows.some((row) => Object.values(row).some((value) => value === "" || value === null)) ||
    rows.reduce((sum, row) => sum + (row.sharePercentage ?? 0), 0) !== 100
  ));
}

export function parseIraBeneficiaryDraft(raw: unknown): IraBeneficiaryParseResult {
  const issues: IraBeneficiaryValidationIssue[] = [];
  const source = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) issues.push({ path: "form", message: "Invalid form payload" });
  // Existing callers that omit the mode keep the complete-designation rules.
  const beneficiaryCompletion = source.beneficiaryCompletion === "client" ? "client"
    : source.beneficiaryCompletion === "partial" ? "partial" : "staff";
  if (source.beneficiaryCompletion !== undefined &&
      source.beneficiaryCompletion !== "client" && source.beneficiaryCompletion !== "partial" && source.beneficiaryCompletion !== "staff") {
    issues.push({ path: "beneficiaryCompletion", message: "Choose client, partial, or staff completion" });
  }
  if (beneficiaryCompletion === "client") {
    for (const kind of ["primary", "contingent"] as const) {
      const rows = source[kind];
      if (rows !== undefined && (!Array.isArray(rows) || rows.length > 0)) {
        issues.push({ path: kind, message: "Leave beneficiary rows empty for the client to complete" });
      }
    }
  }

  const value: IraBeneficiaryDraft = {
    beneficiaryCompletion,
    accountHolderName: requiredText(source, "accountHolderName", "accountHolderName", issues, 100),
    accountHolderTaxId: optionalTaxId(source, "accountHolderTaxId", "accountHolderTaxId", issues),
    accountNumber: requiredText(source, "accountNumber", "accountNumber", issues, 32),
    certifyNotMarried: source.certifyNotMarried === true,
    primary: beneficiaryCompletion === "client" ? [] : beneficiaryCompletion === "partial"
      ? parsePartialBeneficiaries(source.primary, "primary", issues) : parseBeneficiaries(source.primary, "primary", issues),
    contingent: beneficiaryCompletion === "client" ? [] : beneficiaryCompletion === "partial"
      ? parsePartialBeneficiaries(source.contingent, "contingent", issues) : parseBeneficiaries(source.contingent ?? [], "contingent", issues),
  };

  if (beneficiaryCompletion === "staff") {
    validateShareTotal(value.primary, "primary", issues);
    validateShareTotal(value.contingent, "contingent", issues);
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

export function isIraAccountType(accountType: string | null | undefined): boolean {
  return typeof accountType === "string" && /\bIRA\b/i.test(accountType);
}

export class IraBeneficiaryRenderError extends Error {
  constructor(readonly issues: IraBeneficiaryValidationIssue[]) {
    super("The supplied values cannot be safely displayed on this template");
    this.name = "IraBeneficiaryRenderError";
  }
}

const TEXT_FONT_SIZE = 10;
const MIN_TEXT_FONT_SIZE = 6;

function setTextFont(field: PDFTextField, font: PDFFont, size: number) {
  // Both levels must agree: some Apex widgets override the parent field's DA.
  // A named, registered font also keeps later PDF edits from using a fallback.
  field.acroField.setDefaultAppearance(`0 g\n/${font.name} ${size} Tf`);
  field.setFontSize(size);
  for (const widget of field.acroField.getWidgets()) {
    widget.setDefaultAppearance(field.acroField.getDefaultAppearance()!);
  }
}

function fillTextField(
  form: ReturnType<PDFDocument["getForm"]>,
  fieldName: string,
  value: string,
  font: PDFFont,
  issuePath: string,
) {
  const field = form.getTextField(fieldName);
  let unitWidth: number;
  try {
    unitWidth = font.widthOfTextAtSize(value, 1);
  } catch {
    throw new IraBeneficiaryRenderError([{
      path: issuePath,
      message: "This value contains characters this PDF template cannot display. Do not change the legal information; prepare this form manually.",
    }]);
  }
  const availableWidth = Math.min(...field.acroField.getWidgets().map((widget) =>
    widget.getRectangle().width - 2 * ((widget.getBorderStyle()?.getWidth() ?? 0) + 1) - 1,
  ));
  const fittedSize = Math.min(TEXT_FONT_SIZE, unitWidth > 0 ? availableWidth / unitWidth : TEXT_FONT_SIZE);
  if (fittedSize < MIN_TEXT_FONT_SIZE) {
    throw new IraBeneficiaryRenderError([{
      path: issuePath,
      message: "This value cannot fit legibly on the form. Review it without abbreviating legal information, or prepare this form manually.",
    }]);
  }
  field.setText(value);
  setTextFont(field, font, fittedSize);
}

function fillBeneficiaryRow(
  form: ReturnType<PDFDocument["getForm"]>,
  row: IraBeneficiaryDraftRow,
  index: number,
  kind: "primary" | "contingent",
  font: PDFFont,
) {
  const fields = iraBeneficiaryRowFields(index, kind);
  const values: IraBeneficiaryPdfRow = {
    fullName: row.fullName,
    relationship: row.relationship,
    dateOfBirth: row.dateOfBirth,
    telephoneNumber: row.telephoneNumber,
    sharePercentage: row.sharePercentage === null ? "" : String(row.sharePercentage),
    address: row.address,
    emailAddress: row.emailAddress,
    taxId: row.taxId,
  };
  (Object.keys(fields) as Array<keyof IraBeneficiaryPdfRow>).forEach((key) => {
    fillTextField(form, fields[key], values[key], font, `${kind}.${index}.${key}`);
  });
}

function markMissingBeneficiaryFields(
  form: ReturnType<PDFDocument["getForm"]>,
  kind: "primary" | "contingent",
  index: number,
  row?: IraBeneficiaryDraftRow,
) {
  const labels: Record<keyof IraBeneficiaryPdfRow, string> = {
    fullName: "full legal name", relationship: "relationship", dateOfBirth: "date of birth (MM/DD/YYYY)",
    telephoneNumber: "telephone number", sharePercentage: `share percentage (${kind} shares must total 100%)`,
    address: "address", emailAddress: "email address", taxId: "nine-digit SSN or TIN",
  };
  const fields = iraBeneficiaryRowFields(index, kind);
  for (const key of Object.keys(fields) as Array<keyof IraBeneficiaryPdfRow>) {
    if (row && row[key] !== "" && row[key] !== null) continue;
    const field = form.getTextField(fields[key]);
    field.enableRequired();
    field.acroField.dict.set(PDFName.of("TU"), PDFHexString.fromText(`Client to complete: ${kind} beneficiary ${labels[key]}`));
  }
}

export async function fillIraBeneficiaryPdf(
  templateBytes: Uint8Array,
  draft: IraBeneficiaryDraft,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(templateBytes);
  const form = pdf.getForm();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  // Appearance streams have their own font resources; editable /DA entries
  // additionally need the same font in AcroForm's default resources.
  const acroForm = pdf.catalog.lookup(PDFName.of("AcroForm"), PDFDict);
  const resources = acroForm.lookupMaybe(PDFName.of("DR"), PDFDict) ?? pdf.context.obj({});
  const fonts = resources.lookupMaybe(PDFName.of("Font"), PDFDict) ?? pdf.context.obj({});
  fonts.set(PDFName.of(font.name), font.ref);
  resources.set(PDFName.of("Font"), fonts);
  acroForm.set(PDFName.of("DR"), resources);

  const accountFields = [
    IRA_BENEFICIARY_ACCOUNT_FIELDS.accountHolderName,
    IRA_BENEFICIARY_ACCOUNT_FIELDS.accountHolderTaxId,
    IRA_BENEFICIARY_ACCOUNT_FIELDS.accountNumber,
  ];
  const beneficiaryFields = (["primary", "contingent"] as const).flatMap((kind) =>
    Array.from({ length: IRA_BENEFICIARY_DEFINITION.limits[`${kind}Beneficiaries`] }, (_, index) =>
      Object.values(iraBeneficiaryRowFields(index, kind)),
    ).flat(),
  );
  // Normalize empty rows too, without adding values or changing signing fields.
  for (const name of [...accountFields, ...beneficiaryFields]) {
    setTextFont(form.getTextField(name), font, TEXT_FONT_SIZE);
  }

  fillTextField(form, IRA_BENEFICIARY_ACCOUNT_FIELDS.accountHolderName, draft.accountHolderName, font, "accountHolderName");
  fillTextField(form, IRA_BENEFICIARY_ACCOUNT_FIELDS.accountHolderTaxId, draft.accountHolderTaxId, font, "accountHolderTaxId");
  fillTextField(form, IRA_BENEFICIARY_ACCOUNT_FIELDS.accountNumber, draft.accountNumber, font, "accountNumber");

  const holderTaxId = form.getTextField(IRA_BENEFICIARY_ACCOUNT_FIELDS.accountHolderTaxId);
  holderTaxId.disableReadOnly();
  if (!draft.accountHolderTaxId) {
    holderTaxId.enableRequired();
    holderTaxId.acroField.dict.set(
      PDFName.of("TU"),
      PDFHexString.fromText("Client to complete before signing: account-holder nine-digit SSN or TIN"),
    );
  }

  if (draft.beneficiaryCompletion !== "staff") {
    for (const name of beneficiaryFields) {
      const field = form.getTextField(name);
      field.setText("");
      field.disableReadOnly();
      field.disableRequired();
    }
  }
  if (draft.beneficiaryCompletion === "client") {
    markMissingBeneficiaryFields(form, "primary", 0);
  } else {
    draft.primary.forEach((row, index) => fillBeneficiaryRow(form, row, index, "primary", font));
    draft.contingent.forEach((row, index) => fillBeneficiaryRow(form, row, index, "contingent", font));
    if (draft.beneficiaryCompletion === "partial") {
      for (const kind of ["primary", "contingent"] as const) {
        draft[kind].forEach((row, index) => {
          if (isUsedBeneficiary(row)) markMissingBeneficiaryFields(form, kind, index, row);
        });
      }
      if (!draft.primary.some(isUsedBeneficiary)) markMissingBeneficiaryFields(form, "primary", 0);
    }
  }

  const notMarried = form.getCheckBox(IRA_BENEFICIARY_ACCOUNT_FIELDS.certifyNotMarried);
  if (draft.certifyNotMarried) notMarried.check();
  else notMarried.uncheck();

  // Leave the three signature widgets and their date fields untouched. The
  // pilot output remains interactive for review and later signing.
  form.updateFieldAppearances(font);
  pdf.setTitle(IRA_BENEFICIARY_DEFINITION.name);
  pdf.setSubject("Prepared in Always-On Advice; requires human review and signature");
  pdf.setProducer("Always-On Advice form library");
  return pdf.save({ useObjectStreams: false });
}
