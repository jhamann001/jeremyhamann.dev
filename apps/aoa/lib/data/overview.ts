import type { Identity, CommandCenterData, FunnelStage } from "./types";
import { commandCenter } from "@/lib/mock/command-center";
import {
  aiMeetingPrepEnabled,
  commandCenterFunnelLiveEnabled,
  commandCenterMeetingsLiveEnabled,
} from "@/lib/flags";
import { weekMeetings } from "./appointments";
import { readMeetingPreps } from "./meeting-prep";
import { dealFunnel } from "./deal-funnel";

// MOCK-backed (TDD §3, ADR-1/ADR-2) EXCEPT two sections, each behind its OWN flag:
//
//  • Meetings, behind COMMAND_CENTER_MEETINGS_LIVE — real upcoming appointments
//    (mirror.appointment ← the #appointments-feed Slack digest), bucketed
//    this-week / next-week and sorted soonest-first.
//  • The Transfer-pipeline funnel, behind COMMAND_CENTER_FUNNEL_LIVE — real
//    app.deal stage counts + the "At risk" overlay (lib/data/deal-funnel.ts).
//
// The two are INDEPENDENT: either, both or neither can be live. Everything else
// (stalled, signals, prep) stays on the typed lib/mock fixtures until its real
// source lands. Both live reads are RLS-scoped through `id`.
//
// AI_MEETING_PREP layers on top: when THAT flag is also on, the stored briefs for
// the visible meetings are read from app.meeting_prep (RLS-scoped — a VIEWER's
// SELECT is denied by the policy, so a VIEWER gets {}). Flag OFF ⇒ meetingBriefs
// stays {} and nothing reads the table at all.
export async function commandCenterData(id: Identity): Promise<CommandCenterData> {
  // Funnel flag OFF ⇒ the fixture array itself, by reference and untouched.
  const funnel: FunnelStage[] = commandCenterFunnelLiveEnabled()
    ? await dealFunnel(id)
    : commandCenter.funnel;

  if (!commandCenterMeetingsLiveEnabled()) {
    // Both flags off ⇒ the exact fixture object returned before this change.
    return funnel === commandCenter.funnel
      ? commandCenter
      : { ...commandCenter, funnel };
  }
  const { meetings, meetingsNextWeek, meetingWeekRanges } = await weekMeetings(id);
  const keys = [...meetings, ...meetingsNextWeek].map((m) => m.key);
  const meetingBriefs = aiMeetingPrepEnabled() ? await readMeetingPreps(id, keys) : {};
  return {
    ...commandCenter,
    funnel,
    meetings,
    meetingsNextWeek,
    meetingWeekRanges,
    meetingPrep: {}, // the mock prep fixtures do not apply to live appointments
    meetingBriefs,
  };
}
