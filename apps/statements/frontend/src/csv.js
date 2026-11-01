// Cells for the Export CSV button. A cell a spreadsheet would read as a formula (one starting with =, +, -, @, a
// tab or a carriage return) gets a leading apostrophe, so text someone typed, an override note say, can't run as
// one when a colleague opens the file. Numbers, negative ones included, stay numbers.

const FORMULA_START = /^[=+\-@\t\r]/;
const NUMBER = /^-?\d+(\.\d+)?$/;

export function csvCell(value) {
  if (value == null) return '';
  let s = String(value);
  if (FORMULA_START.test(s) && !NUMBER.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(values) {
  return values.map(csvCell).join(',');
}
