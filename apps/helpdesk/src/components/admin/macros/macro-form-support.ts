import type { CommentVisibility, MacroActions } from "@/types/domain";
import { ESCALATION_TARGET_LABELS, QUEUE_LABELS, RESOLUTION_BEARING_STATUSES, RESOLUTION_LABELS } from "@/types/domain";
import { PRIORITY_LABELS, STATUS_LABELS } from "@/lib/format";

/**
 * Client-side support for the macro form. Pure data and pure helpers only — nothing here
 * may import a server module (guardrail G1).
 *
 * The server in `src/server/macros.ts` is the authority on every rule below: it re-validates the key
 * shape, re-checks the placeholders by RENDERING the body, and re-applies the channel/disclaimer
 * coherence rule. What lives here exists so the operator sees the problem while typing instead
 * of after a round trip, and so the preview can be rendered without one.
 */

/** The five placeholders `renderMacroTemplate` resolves, with what each one becomes. */
export const MACRO_PLACEHOLDERS: readonly { token: string; describes: string }[] = [
  { token: "{{ticket.number}}", describes: "HD-1042" },
  { token: "{{requester.name}}", describes: "the requester's full name" },
  { token: "{{requester.firstName}}", describes: "their first name" },
  { token: "{{agent.name}}", describes: "the staff member sending it" },
  { token: "{{today}}", describes: "today's date, written out" },
];

/**
 * The sample the preview renders against. Deliberately obviously-fake and deliberately NOT client
 * data: a preview a reviewer might screenshot must never contain a real requester's name.
 *
 * These are a cosmetic mirror of `MACRO_PREVIEW_*` in `src/server/macros.ts`; they are not imported
 * from there because `src/components/**` may not value-import a non-action server module, and
 * nothing depends on the two matching — the server's copy drives validation, this one drives display.
 */
export const PREVIEW_TICKET = { number: 1042, requesterName: "Sample Client" } as const;
export const PREVIEW_AGENT = "Sample Agent";
export const PREVIEW_DATE = new Date("2026-09-19T12:00:00Z");

/** One key segment. A single quantifier over one class, anchored — linear, with nothing to nest. */
const KEY_SEGMENT = /^[a-z0-9]+$/;

/**
 * Mirrors `isMacroKey` in `src/server/macros.ts`, which is the copy that decides. This one only
 * decides whether the form shows its own inline error before the action round-trips.
 *
 * Both were `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` until the security scanner sweep: `(?:…+)*` is the
 * quantifier-inside-a-quantified-group shape reported under CWE-1333, and the shape security scanner raised
 * against `isDeliverableAddress` in `src/server/outbox.ts` on the Wave B PR. The two copies must
 * keep the same answer, so they were changed together and in the same shape.
 */
export function isMacroKey(value: string): boolean {
  return value.split("-").every((segment) => KEY_SEGMENT.test(segment));
}

export const CHANNEL_LABELS: Readonly<Record<CommentVisibility, string>> = {
  PUBLIC: "Public reply",
  INTERNAL: "Internal note",
};

/**
 * Placeholders the renderer will not fill, read off text that has already been rendered.
 * Same technique as the server's `unknownPlaceholders`, on the same rendered output.
 *
 * The pattern — any `{{…}}` group, one bounded negated class, no nested quantifier — is written INLINE
 * rather than held in a module-level `RESIDUAL_PLACEHOLDER_PATTERN` const. security scanner CWE-185 fires on the
 * matcher, not only on a `new RegExp`: a pattern arriving at `.matchAll()` / `.match()` as an
 * identifier is reported even when the identifier is a literal with no interpolation in it
 * (and PR #1's threads on `src/types/domain.test.ts`). `src/server/macros.ts`
 * still holds the same pattern in a const of the same name; it is that area's file, and the two must
 * keep the same answer
 */
export function residualPlaceholders(rendered: string): string[] {
  const seen = new Set<string>();
  for (const m of rendered.matchAll(/\{\{[^{}]*\}\}/g)) seen.add(m[0]);
  return [...seen];
}

/** Suggests a key from a title: lower-case, non-alphanumerics to hyphens, trimmed to 64 chars. */
export function keyFromTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

/** The two modes the macro sheet runs in. Mirrors `MacroEditSheetProps["mode"]`. */
export type MacroFormMode = "create" | "edit";

export type KeyFieldState = {
  disabled: boolean;
  readOnly: boolean;
  ariaReadOnly: true | undefined;
  className: string | undefined;
};

/**
 * How the Key input renders. On EDIT the key is immutable — but it is also the one value an operator
 * copies OUT of this sheet, because it is how the macro is identified in the audit log, so it is
 * rendered `readOnly`, never `disabled`.
 *
 * `disabled` would apply the shadcn Input's `disabled:opacity-50 disabled:pointer-events-none`
 * (src/components/ui/input.tsx), dropping the key below 4.5:1 against the sheet in both themes and
 * making it unfocusable — so it could be neither long-pressed on a phone nor double-clicked on a
 * desktop to select and copy. `readOnly` already makes the value
 * immutable while keeping it focusable, selectable and at full contrast; `aria-readonly` says the
 * same thing to assistive tech, which reads "read only" rather than "dimmed/unavailable".
 *
 * `disabled` survives only for the in-flight case, where the whole form is inert for everyone.
 */
export function keyFieldState(mode: MacroFormMode, pending: boolean): KeyFieldState {
  const immutable = mode === "edit";
  return {
    disabled: pending,
    readOnly: immutable,
    ariaReadOnly: immutable || undefined,
    // Muted *surface*, untouched foreground: signals "you cannot type here" without dimming the text.
    className: immutable ? "bg-muted/40 text-foreground cursor-default" : undefined,
  };
}

// ---------------------------------------------------------------------------
// Macro ACTIONS
//
// Client-side support for the actions editor. Pure data and pure helpers, like everything above: the
// authority is `src/server/macros-apply.ts`, which re-validates with `macroActionsSchema` on save and
// re-checks every field against the real ticket at apply time. What lives here exists so the operator
// reads a sentence rather than a JSON blob.
// ---------------------------------------------------------------------------

/**
 * The hour of the FIRM day a macro's follow-up lands on. Mirrors `MACRO_FOLLOW_UP_HOUR` in
 * `src/server/macros-apply.ts`; cosmetic, like `PREVIEW_*` above — the server's copy decides, this one
 * only describes. `src/components/**` may not value-import a non-action server module.
 */
export const MACRO_FOLLOW_UP_HOUR = 9;

/** `assignee` as the editor offers it. A stored user id is shown but not chosen here — see below. */
export type MacroAssigneeChoice = "unchanged" | "me" | "clear" | "user";

export const MACRO_ASSIGNEE_LABELS: Readonly<Record<MacroAssigneeChoice, string>> = {
  unchanged: "Leave the assignee alone",
  me: "Assign to whoever sends the macro",
  clear: "Clear the assignee",
  user: "Assign to one named person",
};

/** Turns a stored `assignee` value into the editor's choice. */
export function assigneeChoiceOf(assignee: "me" | string | null | undefined): MacroAssigneeChoice {
  if (assignee === undefined) return "unchanged";
  if (assignee === null) return "clear";
  if (assignee === "me") return "me";
  return "user";
}

/**
 * The follow-up field's wording. `undefined` = untouched, `0` = clear, `n` = n firm days out at 09:00.
 */
export function followUpSentence(days: number | undefined): string | null {
  if (days === undefined) return null;
  if (days === 0) return "Clear the follow-up date";
  const at = `${String(MACRO_FOLLOW_UP_HOUR).padStart(2, "0")}:00 ET`;
  return days === 1 ? `Set the follow-up to tomorrow at ${at}` : `Set the follow-up to ${days} days from now at ${at}`;
}

/**
 * The actions as a list of plain sentences — the preview under the editor, and the summary on the
 * macro's row in `/admin/macros`.
 *
 * Sentences rather than a field/value table on purpose: what an administrator needs to check is
 * "what will this do to a ticket", and the failure this screen exists to prevent is somebody
 * configuring a macro whose effect they did not picture. An empty list means "insert the body only".
 */
export function describeMacroActions(actions: MacroActions | null): string[] {
  if (actions === null) return [];
  const lines: string[] = [];
  if (actions.status !== undefined) {
    lines.push(`Set the status to ${STATUS_LABELS[actions.status]}, when the state machine allows it`);
  }
  if (actions.resolution !== undefined) {
    lines.push(`Record the outcome as ${RESOLUTION_LABELS[actions.resolution]}, unless one is already recorded`);
  }
  if (actions.priority !== undefined) {
    lines.push(`Set the priority to ${PRIORITY_LABELS[actions.priority]} and re-stamp both SLA due dates`);
  }
  if (actions.queueKey !== undefined) {
    lines.push(`Hand the ticket to ${QUEUE_LABELS[actions.queueKey]}`);
  }
  if (actions.assignee !== undefined) {
    lines.push(
      actions.assignee === "me"
        ? "Assign the ticket to whoever sends the macro"
        : actions.assignee === null
          ? "Clear the assignee"
          : "Assign the ticket to one named person",
    );
  }
  const followUp = followUpSentence(actions.followUpInDays);
  if (followUp !== null) lines.push(followUp);
  if (actions.escalationTarget !== undefined) {
    lines.push(`Set the escalation to ${ESCALATION_TARGET_LABELS[actions.escalationTarget]}`);
  }
  return lines;
}

/**
 * The one coherence rule the outcome adds: an outcome is only ever written on a
 * transition that ENDS the ticket, so a macro carrying `resolution` without an ending `status` would
 * save happily and then do nothing at all, forever, with no error anywhere. Caught while the
 * administrator is still looking at the form rather than discovered from an empty `resolution-mix`.
 *
 * `src/server/macros.ts` re-checks this; this copy exists so the message arrives without a round trip.
 */
export function macroOutcomeProblem(actions: MacroActions | null): string | null {
  if (actions === null || actions.resolution === undefined) return null;
  const ends =
    actions.status !== undefined && (RESOLUTION_BEARING_STATUSES as readonly string[]).includes(actions.status);
  return ends
    ? null
    : "An outcome is only recorded when the macro also resolves or closes the ticket. Set the status, or clear the outcome.";
}
