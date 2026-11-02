// AI meeting prep — PURE, client-safe helpers shared by the Server Action and
// the Command Center card. No `server-only`, no Prisma, no React: the card is a
// client component and must be able to import these, and they are unit-tested
// directly (the lib/data/transfer-write.ts idiom).

/**
 * LIFETIME cap on generations for one prep row (owner decision, 2026-07-27).
 * The owner asked for "allow 5-10" regenerations; 10 is the generous end of
 * that range and is the single number to change if it proves wrong. `generations`
 * starts at 1 on the first Generate, so a row can be REgenerated 9 times.
 *
 * At the cap the action refuses with a static reason and writes NO new draft —
 * no Vertex call, no row update, no audit row. This is the cost stop the
 * blueprint left as an open question (§7: "a bored advisor can spam Regenerate").
 */
export const MEETING_PREP_GENERATION_CAP = 10;

/** True when this row has used its lifetime generations and must refuse. */
export function meetingPrepThrottled(generations: number | null | undefined): boolean {
  return (generations ?? 0) >= MEETING_PREP_GENERATION_CAP;
}

/** Generations still available on this row (never negative). A row that does not
 *  exist yet has the full cap available. */
export function meetingPrepRemaining(generations: number | null | undefined): number {
  return Math.max(0, MEETING_PREP_GENERATION_CAP - (generations ?? 0));
}

/**
 * Why Save is unavailable for an unlinked appointment. Shown INLINE next to the
 * disabled button and reused verbatim as the action's refusal label, so the UI
 * explanation and the server refusal can never drift apart. Deliberately says
 * what to do about it rather than just "cannot" — the fix is a CRM-side
 * name match, not something the advisor can retry.
 */
export const MEETING_PREP_NO_CLIENT_LINK_NOTE =
  "This meeting isn't linked to a client record, so there's no portrait to save it to.";

/**
 * Whether the "Save to client portrait" affordance can act. PURE so the panel,
 * the card and the tests all agree with the Server Action's own refusal. The
 * client sf_id comes from the appointment (Meeting.clientId, "" when unlinked);
 * the action re-derives it from the STORED row and is the real enforcement.
 */
export function canSaveMeetingPrepToPortrait(
  clientSfId: string | null | undefined,
): boolean {
  return (clientSfId ?? "").trim() !== "";
}

/**
 * Every way generateMeetingPrep can refuse. A STATIC enum — never a message from
 * the model, the Gemini config or the database, so nothing internal (and no PII)
 * can leak into a toast. `AiError.reason` values (lib/ai/gemini.ts) map through
 * one-for-one so a Vertex failure stays diagnosable without a stack trace.
 */
export type MeetingPrepFailure =
  | "flag_off"
  | "not_authorized"
  | "not_found"
  | "past_meeting"
  | "throttled"
  // Save/unsave only: the brief's appointment never name-matched a mirror.client
  // row, so there is no portrait to attach it to (the Priya-Raman seed case).
  | "no_client_link"
  | "write_failed"
  | "config_error"
  | "unauthorized"
  | "model_not_found"
  | "rate_limited"
  | "upstream_error"
  | "transport_error"
  | "empty_response";

const LABELS: Record<MeetingPrepFailure, string> = {
  flag_off: "Meeting prep is not enabled.",
  not_authorized: "Your role cannot generate meeting prep.",
  not_found: "That meeting is no longer on the schedule — refresh the page.",
  past_meeting: "That meeting has already happened.",
  throttled: `This brief has hit its limit of ${MEETING_PREP_GENERATION_CAP} generations.`,
  no_client_link: MEETING_PREP_NO_CLIENT_LINK_NOTE,
  write_failed: "Prep could not be saved — please try again.",
  config_error: "AI is not configured for this environment.",
  unauthorized: "AI access was denied — check the service account permissions.",
  model_not_found: "The AI model is unavailable right now.",
  rate_limited: "AI is rate limited right now — try again in a moment.",
  upstream_error: "AI could not generate the brief — please try again.",
  transport_error: "AI timed out — please try again.",
  empty_response: "AI returned nothing usable — please try again.",
};

/** User-facing toast text for a refusal. Total over the union, so a new reason
 *  cannot ship without a label. */
export function meetingPrepFailureLabel(reason: MeetingPrepFailure): string {
  return LABELS[reason];
}

/** What the Meetings card offers in a row's action slot.
 *  - `interactive` — the real Generate/View prep button (AI_MEETING_PREP on).
 *  - `pill`        — the mockup's static "Prep ready/pending" fixture pill.
 *  - `none`        — nothing at all.
 *
 *  With the flag OFF the button must NOT render: it would open the mockup panel
 *  over prep fixtures keyed by client sf_id, which a real Slack-fed appointment
 *  never matches — a control that looks functional and isn't. Against LIVE
 *  appointments the fixture pill is equally meaningless, so that slot goes
 *  empty; the mock/preview card keeps the pill so the mockup demo is unchanged.
 */
export type PrepAffordance = "interactive" | "pill" | "none";

export function prepAffordance(opts: {
  aiPrep: boolean;
  live: boolean;
}): PrepAffordance {
  if (opts.aiPrep) return "interactive";
  return opts.live ? "none" : "pill";
}
