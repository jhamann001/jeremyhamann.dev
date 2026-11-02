// Changes-column formatting for the field-level audit view
// (tkt-audit-row-change-ui). Pure (no React) — unit-tested in
// test/row-change-detail.test.ts. The component renders the display model this
// returns; all shaping/stringifying/truncation lives here.
//
// The `changed` jsonb the audit.log_row_change() trigger writes has two shapes:
//   * UPDATE      → { col: { from: <old>, to: <new> } } per changed column
//                   (updated_at excluded by the trigger).
//   * INSERT/DEL  → a full row snapshot { col: <value>, ... }.
// This helper never throws on a malformed / empty `changed`.

export const CHANGE_VALUE_MAX = 80;

/** One changed field on an UPDATE: readable from/to strings. */
export type ChangeFieldDiff = { field: string; from: string; to: string };

/** One field of an INSERT/DELETE snapshot: readable value string. */
export type ChangeFieldValue = { field: string; value: string };

export type ChangeSummary =
  | { kind: "updated"; fields: ChangeFieldDiff[] }
  | { kind: "created"; fields: ChangeFieldValue[] }
  | { kind: "deleted"; fields: ChangeFieldValue[] };

/**
 * Render a jsonb value readably: null/undefined → "—", strings/numbers/booleans
 * as-is, objects/arrays as compact JSON. Long values are truncated with an
 * ellipsis. Never throws.
 */
export function formatValue(value: unknown, max: number = CHANGE_VALUE_MAX): string {
  let s: string;
  if (value === null || value === undefined) {
    s = "—";
  } else if (typeof value === "string") {
    s = value;
  } else if (typeof value === "number" || typeof value === "boolean") {
    s = String(value);
  } else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  if (s === "") return '""'; // an empty string is a real value, not a dash
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function isFromTo(v: unknown): v is { from?: unknown; to?: unknown } {
  return v !== null && typeof v === "object" && ("from" in v || "to" in v);
}

/**
 * Shape the trigger's `changed` jsonb into a display model keyed on the op.
 * `op` is matched case-insensitively; anything other than UPDATE/INSERT/DELETE
 * falls back to a "created"-style value list (defensive — nothing writes it).
 */
export function summarizeChange(
  op: string,
  changed: Record<string, unknown> | null | undefined,
): ChangeSummary {
  const obj = changed && typeof changed === "object" ? changed : {};
  const entries = Object.entries(obj);
  const verb = (op ?? "").toUpperCase();

  if (verb === "UPDATE") {
    const fields: ChangeFieldDiff[] = entries.map(([field, v]) => {
      if (isFromTo(v)) {
        return { field, from: formatValue(v.from), to: formatValue(v.to) };
      }
      // Defensive: a non-{from,to} value — show it as the new value only.
      return { field, from: "—", to: formatValue(v) };
    });
    return { kind: "updated", fields };
  }

  const fields: ChangeFieldValue[] = entries.map(([field, v]) => ({
    field,
    value: formatValue(v),
  }));
  return { kind: verb === "DELETE" ? "deleted" : "created", fields };
}
