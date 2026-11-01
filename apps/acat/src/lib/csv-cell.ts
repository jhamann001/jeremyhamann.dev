// One CSV cell, safe to open in a spreadsheet. Quoting alone does not stop formula execution: a cell
// that starts with = + - @ or a tab/return runs as a formula, so it gets a leading apostrophe. Plain
// numbers ("-125.50", "$1,000") are left as numbers. Safe to import from client code.

const FORMULA_START = /^[\s]*[=+@\-\t\r]/;
const PLAIN_NUMBER = /^-?\$?[\d,]*\.?\d+%?$/;

export function csvCell(value: string | number | null | undefined): string {
  const text = String(value ?? "");
  const safe = typeof value === "string" && FORMULA_START.test(text) && !PLAIN_NUMBER.test(text.trim())
    ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}
