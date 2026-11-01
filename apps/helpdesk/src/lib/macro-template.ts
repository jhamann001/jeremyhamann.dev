/**
 * Macro placeholder rendering — pure, layer L1, safe in client bundles (docs/ARCHITECTURE.md §g S3,
 * Decision 8). Rendering happens client-side in the composer; `macroId` rides along with the comment so
 * `MACRO_APPLIED` is audited at write time.
 *
 * Placeholders: {{ticket.number}} {{requester.name}} {{requester.firstName}} {{agent.name}} {{today}}.
 * Unknown placeholders are left verbatim.
 */
import { format } from "date-fns";
import type { MacroVars } from "@/types/domain";

/**
 * `{{ key }}` with optional inner whitespace; the key starts with a letter and then carries letters,
 * digits and dots.
 *
 * The key used to be spelled as a dotted identifier in the pattern itself —
 * `[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*` — an unbounded quantified group whose body is
 * itself quantified, the shape security scanner's ReDoS rule (CWE-1333) flags. Flattening the key to one character
 * class changes nothing a caller can observe: `renderMacroTemplate` replaces a placeholder ONLY when
 * the captured key is one of the five known ones, and all five are well-formed dotted identifiers, so
 * a key the old pattern refused (`a.`, `a..b`, `a.1b`) is now captured and then left verbatim by the
 * `hasOwnProperty` check — the same output, by a different route.
 */
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9.]*)\s*\}\}/g;

function placeholderValues(vars: MacroVars): Readonly<Record<string, string>> {
  return {
    "ticket.number": vars.ticket.number,
    "requester.name": vars.requester.name,
    "requester.firstName": vars.requester.firstName,
    "agent.name": vars.agent.name,
    today: vars.today,
  };
}

/** Replaces the five known placeholders; anything else (including malformed braces) stays as written. */
export function renderMacroTemplate(body: string, vars: MacroVars): string {
  const values = placeholderValues(vars);
  return body.replace(PLACEHOLDER_PATTERN, (match: string, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match,
  );
}

/**
 * Builds the variables for a ticket: `number` → "HD-<n>", `firstName` = first whitespace-separated token
 * of the requester name, `today` → "September 16, 2026" (local calendar date).
 * CONTRACT-GAP: no fallback is specified for an agent without a display name; the placeholder renders
 * as an empty string rather than an invented label.
 */
export function macroVarsFor(
  ticket: { number: number; requesterName: string },
  agentName: string | null,
  today: Date = new Date(),
): MacroVars {
  const name = ticket.requesterName.trim();
  const firstName = name.length > 0 ? name.split(/\s+/)[0] : "";
  return {
    ticket: { number: `HD-${ticket.number}` },
    requester: { name, firstName },
    agent: { name: agentName?.trim() ?? "" },
    today: format(today, "MMMM d, yyyy"),
  };
}
