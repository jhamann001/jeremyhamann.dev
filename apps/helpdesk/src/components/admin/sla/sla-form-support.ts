import type { TicketPriority } from "@/types/domain";

/**
 * Client-side support for the SLA policy form. Pure data and pure helpers only — nothing
 * here may import a server module (guardrail G1) or `@/lib/env`.
 *
 * `src/server/sla-policies.ts` is the authority on every rule below: it re-parses the numbers,
 * re-applies the bounds and re-checks the cross-field rule. What lives here exists so the
 * administrator sees the problem while typing instead of after a round trip, and so the consequence
 * of a number can be spelled out before it is saved.
 *
 * The bounds are a COSMETIC MIRROR of `SLA_POLICY_LIMITS`, not an import of it, for the same reason
 * `macro-form-support.ts` mirrors the macro preview constants: a component may not value-import a
 * non-action server module. Nothing depends on the two matching — the server's copy decides what is
 * stored, this one decides what is said — and `sla-form-support.test.ts` pins the pairs that must not
 * drift by reading both files.
 */

/** Mirrors `SLA_POLICY_LIMITS` in `src/server/sla-policies.ts`. */
export const SLA_FIELD_BOUNDS = {
  firstResponseMinutes: { min: 1, max: 10_080 },
  resolutionMinutes: { min: 1, max: 129_600 },
  warningMinutes: { min: 0, max: 10_080 },
} as const;

export type SlaField = keyof typeof SLA_FIELD_BOUNDS;

export const SLA_FIELDS = ["firstResponseMinutes", "resolutionMinutes", "warningMinutes"] as const satisfies readonly SlaField[];

export const SLA_FIELD_LABELS: Readonly<Record<SlaField, string>> = {
  firstResponseMinutes: "First response",
  resolutionMinutes: "Resolution",
  warningMinutes: "Warning",
};

/**
 * What each number actually does, in the desk's own terms. Rendered under the field, not hidden in a
 * tooltip: a phone has no hover, and R10 forbids putting anything that matters in one.
 */
export const SLA_FIELD_HINTS: Readonly<Record<SlaField, string>> = {
  firstResponseMinutes: "Minutes from arrival to the first reply. Stamped on each new ticket.",
  resolutionMinutes: "Minutes from arrival to RESOLVED. Stamped on each new ticket.",
  warningMinutes: "Minutes before a due time the badge turns amber. Read live — 0 turns it off.",
};

export const PRIORITY_ORDER = ["URGENT", "HIGH", "STANDARD", "LOW"] as const satisfies readonly TicketPriority[];

/**
 * A field's value as typed, with its verdict. Returns the parsed number only when it is usable, so a
 * caller can never submit a half-typed box because it looked non-empty.
 */
export type FieldVerdict = { value: number | null; error: string | null };

export function parseMinutes(raw: string, field: SlaField): FieldVerdict {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { value: null, error: `${SLA_FIELD_LABELS[field]} is required.` };
  if (!/^\d+$/.test(trimmed)) {
    return { value: null, error: `${SLA_FIELD_LABELS[field]} must be a whole number of minutes.` };
  }
  const value = Number(trimmed);
  const { min, max } = SLA_FIELD_BOUNDS[field];
  if (value < min) return { value: null, error: `${SLA_FIELD_LABELS[field]} must be at least ${min}.` };
  if (value > max) return { value: null, error: `${SLA_FIELD_LABELS[field]} must be at most ${max}.` };
  return { value, error: null };
}

export type SlaDraft = Record<SlaField, string>;

export type DraftVerdict = {
  values: Record<SlaField, number> | null;
  errors: Partial<Record<SlaField, string>>;
};

/**
 * The whole form. The cross-field rule is the server's too: a resolution clock that expires before
 * the first-response clock cannot be met by any sequence of events.
 */
export function validateDraft(draft: SlaDraft): DraftVerdict {
  const errors: Partial<Record<SlaField, string>> = {};
  const parsed = {} as Record<SlaField, number>;
  let ok = true;
  for (const field of SLA_FIELDS) {
    const verdict = parseMinutes(draft[field], field);
    if (verdict.error !== null || verdict.value === null) {
      errors[field] = verdict.error ?? `${SLA_FIELD_LABELS[field]} is required.`;
      ok = false;
      continue;
    }
    parsed[field] = verdict.value;
  }
  if (ok && parsed.resolutionMinutes < parsed.firstResponseMinutes) {
    errors.resolutionMinutes = "The resolution clock cannot expire before the first-response clock.";
    ok = false;
  }
  return { values: ok ? parsed : null, errors };
}

/** Whether anything in the draft differs from what is stored — a no-op save writes no audit row. */
export function isDirty(draft: SlaDraft, saved: Record<SlaField, number>): boolean {
  return SLA_FIELDS.some((f) => draft[f].trim() !== String(saved[f]));
}

export function draftFrom(saved: Record<SlaField, number>): SlaDraft {
  return {
    firstResponseMinutes: String(saved.firstResponseMinutes),
    resolutionMinutes: String(saved.resolutionMinutes),
    warningMinutes: String(saved.warningMinutes),
  };
}

/** `45m`, `2h`, `2h 30m`, `1d 12h`. A cosmetic mirror of `formatSlaMinutes` in `src/lib/sla.ts`. */
export function humanMinutes(minutes: number): string {
  const total = Math.max(0, Math.floor(minutes));
  if (total === 0) return "0m";
  const days = Math.floor(total / (60 * 24));
  const hours = Math.floor((total % (60 * 24)) / 60);
  const mins = total % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  return parts.join(" ");
}

/**
 * Notes about a draft that are TRUE but not errors — the things an administrator should read before
 * saving rather than discover from a board that looks wrong the next morning.
 */
export function draftNotes(values: Record<SlaField, number>): string[] {
  const notes: string[] = [];
  if (values.warningMinutes === 0) {
    notes.push("No amber band: tickets at this priority go from on track straight to breached.");
  } else if (values.warningMinutes >= values.firstResponseMinutes) {
    notes.push(
      `The warning band (${humanMinutes(values.warningMinutes)}) is at least as long as the first-response clock ` +
        `(${humanMinutes(values.firstResponseMinutes)}), so every new ticket at this priority is amber from the moment it arrives.`,
    );
  }
  if (values.warningMinutes > values.resolutionMinutes) {
    notes.push(
      "The warning band is longer than the whole resolution clock, so the resolution badge is amber for its entire life.",
    );
  }
  return notes;
}
