/**
 * Filesystem-safe timestamps for download filenames — pure, node/edge safe, layer L2.
 *
 * A raw `Date#toISOString()` reads `2026-09-20T00:26:13.120Z`, and the two colons in it are not legal
 * in a Windows filename: depending on the browser the saved file is silently renamed, mangled into an
 * NTFS alternate data stream, or the save is refused outright. macOS Finder translates `:` to `/` in
 * the displayed name, so even where the save succeeds the name the examiner sees is not the name the
 * ledger implies. These are compliance artefacts whose names get quoted in tickets and audit responses,
 * so the name has to survive the trip intact on every desk.
 *
 * `20260920T002613Z` — ISO 8601 basic format, the one the standard defines for exactly this reason.
 * Still sorts lexicographically, still unambiguous, legal on NTFS, APFS, ext4 and in a Content-
 * Disposition header without quoting games. Sub-second precision is dropped: two exports inside one
 * second by one person is not a case worth an uglier name, and nothing keys off the filename.
 */

/** `20260920T002613Z` — UTC, second precision, no separators. */
export function exportFileStamp(at: Date): string {
  const iso = at.toISOString(); // always UTC, always `YYYY-MM-DDTHH:MM:SS.sssZ`
  return `${iso.slice(0, 19).replace(/[-:]/g, "")}Z`;
}

/**
 * `ticket-export-standard-20260920T002613Z.csv` — the whole download name for a CSV export.
 *
 * `kind` and `scope` are caller-controlled literals, never user input, but they are normalized anyway:
 * one bad refactor upstream should not be able to put a quote or a path separator inside a quoted
 * `Content-Disposition` value.
 */
export function csvExportFilename(kind: string, scope: string | null, at: Date): string {
  // The stamp is built here, not normalized here: `safeSegment` lower-cases, and `T`/`Z` carry meaning.
  const name = [kind, scope].filter((p): p is string => p !== null && p !== "").map(safeSegment);
  return `${[...name, exportFileStamp(at)].join("-")}.csv`;
}

/** Lower-case, `[a-z0-9]` runs joined by `-`; anything else is a separator. Never empty. */
function safeSegment(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned === "" ? "x" : cleaned;
}
