import { mappedInputs, type MappedFormInput, type MappedFormSpec } from "./mapped-form-spec";

export type MappedFormIssue = { path: string; message: string };
export type MappedDraft = { fields: Record<string, string> };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function formatMappedInput(kind: MappedFormInput["kind"], value: string): string {
  const text = value.trim();
  if (kind === "date" && /^\d{8}$/.test(text)) return `${text.slice(0, 2)}/${text.slice(2, 4)}/${text.slice(4)}`;
  if (kind === "phone" && /^[\d ()-]+$/.test(text)) {
    const digits = text.replace(/[ ()-]/g, "");
    if (/^\d{10}$/.test(digits)) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return value;
}

function validDate(value: string) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return false;
  const [, month, day, year] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1900 && year <= 2199 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function parseMappedDraft(spec: MappedFormSpec, raw: unknown, authorizedAccountNumber: string, clientName: string):
  { ok: true; value: MappedDraft } | { ok: false; issues: MappedFormIssue[] } {
  const issues: MappedFormIssue[] = [];
  if (!isRecord(raw) || !isRecord(raw.fields)) return { ok: false, issues: [{ path: "form", message: "Enter the known form values and confirm the selected account" }] };
  if (Object.keys(raw).some(key => key !== "fields" && key !== "confirmAccount")) issues.push({ path: "form", message: "This form contains unsupported information" });
  if (raw.confirmAccount !== true) issues.push({ path: "confirmAccount", message: "Confirm the selected account, its role and the account-holder name" });
  const inputs = mappedInputs(spec);
  const allowed = new Set(inputs.filter(input => input.source !== "accountNumber").map(input => input.key));
  if (Object.keys(raw.fields).some(key => !allowed.has(key))) issues.push({ path: "form", message: "This form contains unsupported fields; account numbers must come from the selected account" });
  const accountNumber = authorizedAccountNumber.trim();
  if (!accountNumber || accountNumber.length > 32) issues.push({ path: "accountIds", message: "Select an account with a confirmed Apex account number" });
  const fields: Record<string, string> = {};
  for (const input of inputs) {
    const path = input.key;
    if (input.source === "accountNumber") {
      if (input.accountPart) {
        const match = /^([A-Za-z0-9]{3})-(\d{5})$/.exec(accountNumber);
        if (!match) issues.push({ path: "accountIds", message: "This template needs an Apex account number in ABC-12345 format. Prepare it manually rather than shortening or guessing the number." });
        fields[path] = match?.[input.accountPart === "branch" ? 1 : 2] ?? "";
      } else fields[path] = accountNumber;
      continue;
    }
    const supplied = Object.prototype.hasOwnProperty.call(raw.fields, path) ? raw.fields[path] : (input.source === "clientName" ? clientName : "");
    if (typeof supplied !== "string") { issues.push({ path, message: "Enter text or leave this field blank" }); continue; }
    let value = formatMappedInput(input.kind, supplied).trim().replace(/\s+/g, " ");
    if (value.length > (input.maxLength ?? 200)) { issues.push({ path, message: `Use ${input.maxLength ?? 200} characters or fewer without abbreviating legal information` }); continue; }
    if (!value) {
      fields[path] = "";
      if (input.requiredForDraft) issues.push({ path, message: "Enter this information before generating a form" });
      continue;
    }
    let invalid: string | null = null;
    switch (input.kind) {
      case "taxId":
        value = value.replace(/[\s-]/g, "");
        if (!/^\d{9}$/.test(value)) invalid = "Enter a full nine-digit SSN or tax ID, or leave blank for the client. Last four digits are not sufficient.";
        break;
      case "taxIdLast4":
        if (!/^\d{4}$/.test(value)) invalid = "This field asks only for the last four digits. Enter exactly four digits, or leave blank.";
        break;
      case "routing":
        if (!/^\d{9}$/.test(value)) invalid = "Enter all nine routing digits, or leave blank. Confirm the routing instructions separately.";
        break;
      case "date": {
        if (!validDate(value)) invalid = "Enter a valid date as MM/DD/YYYY, or leave blank";
        else if (!input.allowFutureDate && `${value.slice(6)}-${value.slice(0, 2)}-${value.slice(3, 5)}` > new Date().toISOString().slice(0, 10)) invalid = "This date cannot be in the future";
        break;
      }
      case "phone": if (!/^\d{3}-\d{3}-\d{4}$/.test(value)) invalid = "Enter a ten-digit domestic phone number, or leave blank for manual completion"; break;
      case "email": if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) invalid = "Enter a valid email address, or leave blank"; break;
      case "choice": if (!input.options?.some(option => option.value === value)) invalid = "Select one of the listed options, or leave blank"; break;
      case "money": {
        if (!/^\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/.test(value)) invalid = "Enter a positive dollar amount with at most two decimal places, or leave blank";
        else {
          value = value.replace(/[$,]/g, "");
          if (!Number.isFinite(Number(value)) || Number(value) <= 0 || Number(value) > 999999999999) invalid = "Enter a positive amount of at most 999,999,999,999, or leave blank";
        }
        break;
      }
      case "percent": {
        const valid = input.wholeNumber ? /^\d+$/.test(value) : /^\d+(?:\.\d{1,2})?$/.test(value);
        if (!valid || !Number.isFinite(Number(value)) || Number(value) < (input.min ?? 0) || Number(value) > 100) invalid = `Enter ${input.wholeNumber ? "a whole-number percentage" : "a percentage"} from ${input.min ?? 0} to 100, or leave blank`;
        break;
      }
    }
    if (invalid) issues.push({ path, message: invalid });
    fields[path] = value;
  }
  for (const group of spec.percentageGroups ?? []) {
    if (group.reduce((total, key) => total + Number(fields[key] || 0), 0) > 100) issues.push({ path: group[0], message: "The entered shares in this beneficiary group cannot total more than 100%. Leave unknown shares blank." });
  }
  for (const input of inputs) {
    const condition = input.allowedWhen;
    if (fields[input.key] && condition && fields[condition.key] && !condition.values.includes(fields[condition.key])) {
      issues.push({ path: input.key, message: "This value conflicts with the selected instruction. Clear it or correct the instruction; no value will be silently discarded." });
    }
  }
  return issues.length ? { ok: false, issues } : { ok: true, value: { fields } };
}
