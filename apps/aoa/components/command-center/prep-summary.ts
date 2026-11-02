import type { PillTone } from "@/components/ui";
import type { Meeting } from "@/lib/data/types";

// Pure header-pill summary for the Meetings card (P1, ticket), mirroring the
// mockup's "N need prep" / "all prepped" pill.
//
// `generated` holds MEETING KEYS whose prep exists — either an ephemeral
// this-session generate (the mock/Phase C posture) or a real stored
// app.meeting_prep brief (AI_MEETING_PREP). Keyed on `Meeting.key`, NOT
// clientId: `client_sf_id` is a best-effort name match and is often null on live
// appointments, so a clientId-keyed set collapses every unlinked meeting onto ""
// and a single generate would mark them all prepped.

export function prepSummary(
  meetings: Meeting[],
  generated: ReadonlySet<string>,
): { needPrep: number; label: string; tone: Extract<PillTone, "green" | "amber"> } {
  const needPrep = meetings.filter((m) => !m.prepReady && !generated.has(m.key)).length;
  return needPrep > 0
    ? { needPrep, label: `${needPrep} need prep`, tone: "amber" }
    : { needPrep: 0, label: "all prepped", tone: "green" };
}
