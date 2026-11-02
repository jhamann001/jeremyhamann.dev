export type FieldSource = "aoa" | "manual" | "correction" | "client";

export type EditableBeneficiary = {
  fullName: string;
  relationship: string;
  dateOfBirth: string;
  telephoneNumber: string;
  sharePercentage: string;
  address: string;
  emailAddress: string;
  taxId: string;
};

// Formatting is not date validation. Keep incomplete/invalid input visible so
// the client can edit it and the server can still report calendar errors.
export function formatBeneficiaryDateInput(value: string): string {
  const compact = value.trim();
  return /^\d{8}$/.test(compact)
    ? `${compact.slice(0, 2)}/${compact.slice(2, 4)}/${compact.slice(4)}`
    : value;
}

// Only normalize complete domestic numbers with ordinary separators. Preserve
// country codes, extensions, extra digits and unrecognized text without loss.
export function formatBeneficiaryPhoneInput(value: string): string {
  const compact = value.trim();
  if (!/^[\d ()-]+$/.test(compact)) return value;
  const digits = compact.replace(/[ ()-]/g, "");
  return /^\d{10}$/.test(digits)
    ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
    : value;
}

export function hasBeneficiaryValues(row: EditableBeneficiary): boolean {
  return Object.values(row).some((value) => value.trim() !== "");
}

// Preserve blank percentages. Number("") would invent a 0% election.
export function beneficiaryDraftValues(rows: EditableBeneficiary[]) {
  return rows.map((row) => {
    const share = row.sharePercentage.trim();
    const numeric = /^\d+$/.test(share) && Number.isSafeInteger(Number(share));
    return { ...row, sharePercentage: share === "" ? null : numeric ? Number(share) : share };
  });
}

export function accountHolderNameSource(initialName: string, currentName: string): FieldSource {
  return currentName === initialName ? "aoa" : "correction";
}

// Authentication middleware can redirect an expired session to an HTML login
// page with a final 200 response. Never treat that response as a generated PDF.
export function formDownloadResponseIssue({
  status,
  redirected,
  contentType,
}: {
  status: number;
  redirected: boolean;
  contentType: string | null;
}): string | null {
  const retryMessage = "Your session may have expired. Sign in again, then retry. No file was downloaded.";
  if (status === 401 || redirected || (status >= 300 && status < 400)) {
    return retryMessage;
  }
  const mimeType = contentType?.split(";", 1)[0].trim().toLowerCase();
  if (status >= 200 && status < 300 && mimeType !== "application/pdf") {
    return `AoA did not return a PDF. ${retryMessage}`;
  }
  return null;
}

const fieldLabels: Record<string, string> = {
  accountHolderName: "Account-holder name",
  accountHolderTaxId: "Account-holder SSN or TIN",
  accountNumber: "Apex account number",
  accountId: "IRA account",
  accountIds: "IRA account",
  certifyNotMarried: "Not-married certification",
  beneficiaryCompletion: "Beneficiary completion",
  fullName: "Full legal name",
  relationship: "Relationship",
  dateOfBirth: "Date of birth",
  telephoneNumber: "Telephone number",
  sharePercentage: "Share percentage",
  address: "Address",
  emailAddress: "Email address",
  taxId: "SSN or TIN",
};

export function formatIraBeneficiaryIssue(issue: { path: string; message: string }): string {
  const path = issue.path.replace(/^values\./, "");
  const row = /^(primary|contingent)\.(\d+)(?:\.(.+))?$/.exec(path);
  if (row) {
    const group = row[1] === "primary" ? "Primary" : "Contingent";
    const field = row[3] ? ` — ${fieldLabels[row[3]] ?? row[3]}` : "";
    return `${group} beneficiary ${Number(row[2]) + 1}${field}: ${issue.message}`;
  }
  if (path === "primary" || path === "contingent") {
    const group = path === "primary" ? "Primary" : "Contingent";
    return `${group} beneficiaries: ${issue.message}`;
  }
  return fieldLabels[path] ? `${fieldLabels[path]}: ${issue.message}` : issue.message;
}
