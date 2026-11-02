// Detail-column formatting for the Audit Log (WO ticket). Pure (no React) —
// unit-tested in test/audit-detail.test.ts.
//
// lib/audit.ts stores `detail` as JSON text (JSON.stringify of the entry
// payload) or null. The table shows a compact single-line preview, truncated
// with an expand affordance revealing the pretty-printed form. Non-JSON text
// (defensive — nothing writes it today) falls back to the raw string; this
// helper never throws on malformed input.

export type DetailView = {
  /** Single-line compact form, truncated at `max` with an ellipsis. */
  preview: string;
  /** Pretty-printed JSON (2-space indent), or null when there is nothing more to show. */
  full: string | null;
  /** True when an expand affordance is warranted (preview lost information). */
  expandable: boolean;
};

export const DETAIL_PREVIEW_MAX = 96;

export function formatDetail(
  detail: string | null | undefined,
  max: number = DETAIL_PREVIEW_MAX,
): DetailView {
  const raw = detail?.trim() ?? "";
  if (raw === "") return { preview: "—", full: null, expandable: false };

  let compact = raw;
  let pretty: string | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    compact = JSON.stringify(parsed);
    // Scalars ("WON", 3, true) gain nothing from pretty-printing.
    if (parsed !== null && typeof parsed === "object") {
      pretty = JSON.stringify(parsed, null, 2);
    }
  } catch {
    // Not JSON — show the raw text as-is.
  }

  const truncated = compact.length > max;
  const preview = truncated ? `${compact.slice(0, max - 1)}…` : compact;
  const full = truncated ? (pretty ?? compact) : pretty;
  // Expand only when the full form actually adds something over the preview.
  const expandable = full != null && (truncated || full !== preview);
  return { preview, full: expandable ? full : null, expandable };
}
