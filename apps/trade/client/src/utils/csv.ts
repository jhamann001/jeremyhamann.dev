/**
 * Escapes a value for safe CSV output, guarding against formula injection
 * and properly quoting embedded double-quotes.
 */
export function csvEscape(value: string): string {
  let safe = value;
  if (/^[=+\-@\t\r]/.test(safe)) {
    safe = `'${safe}`;
  }
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * Triggers a browser download of `lines` as a CSV file.
 *
 * Revokes the object URL afterwards — without it each export leaks the whole
 * file for the lifetime of the tab, which adds up on a page people re-export
 * from repeatedly.
 */
export function downloadCsv(filename: string, lines: string[]): void {
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
