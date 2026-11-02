import type {
  CommandCenterData,
  FunnelStage,
  Meeting,
  StalledItem,
  Signal,
} from "@/lib/data/types";
import { prepByClient } from "@/lib/mock/client-portrait";

// Deterministic mock fixtures for the Command Center (TDD §3/§7, ADR-2/ADR-4).
// No randomness — renders are stable. Wired to real sources in Phase D
// (Statement Pipeline, calendar, rules engine, event stream); the seam signature stays.

export const funnel: FunnelStage[] = [
  { stage: "Prospect", count: 8, desc: "New leads in intake", tone: "blue" },
  { stage: "Proposal", count: 5, desc: "Advice plan drafted", tone: "gold" },
  { stage: "Transfer initiated", count: 3, desc: "ACAT in flight", tone: "amber" },
  { stage: "Funded", count: 6, desc: "Assets received · all time", tone: "green" },
  { stage: "At risk", count: 2, desc: "Stalled > 30 days", tone: "red" },
];

// `clientId` values are REAL seeded client sf_ids (prisma/seed.ts CLIENTS), so
// meeting rows deep-link to resolvable `/client-portrait/[id]` routes instead
// of 404ing on invented fixture keys.
export const meetings: Meeting[] = [
  {
    client: "Stone Family Trust",
    clientId: "C-1", // Sam Stone · HH-1001
    key: "mock|stone-family-trust|q-review",
    when: "Today · 2:00 PM",
    type: "Quarterly review",
    prepReady: true,
  },
  {
    client: "Walker Household",
    clientId: "C-5", // Neil Walker · HH-2001
    key: "mock|walker-household|onboarding",
    when: "Tomorrow · 10:30 AM",
    type: "Onboarding kickoff",
    prepReady: false,
  },
  {
    client: "Nguyen Household",
    clientId: "C-3", // Minh Nguyen · HH-1002
    key: "mock|nguyen-household|financial-plan",
    when: "Thu · 9:00 AM",
    type: "Financial plan",
    prepReady: true,
  },
];

// P1 (ticket): the Meetings card week toggle flips between the fixture sets.
// Same rule as above — `clientId` values are REAL seeded sf_ids. Dates invented.
export const meetingsNextWeek: Meeting[] = [
  {
    client: "Okafor Household",
    clientId: "C-4", // Ada Okafor · HH-1003
    key: "mock|okafor-household|funding",
    when: "Mon 7/6 · 11:00 AM",
    type: "Funding check-in",
    prepReady: false,
  },
  {
    client: "Patel Family",
    clientId: "C-6", // Asha Patel · HH-2002
    key: "mock|patel-family|mid-year",
    when: "Tue 7/7 · 1:30 PM",
    type: "Mid-year check-in",
    prepReady: true,
  },
  {
    client: "Stone Family Trust",
    clientId: "C-2", // Jo Stone · HH-1001
    key: "mock|stone-family-trust|estate",
    when: "Thu 7/9 · 9:00 AM",
    type: "Estate document review",
    prepReady: false,
  },
];

export const meetingWeekRanges = {
  thisWeek: "This week · Jun 29 – Jul 3",
  nextWeek: "Next week · Jul 6 – 10",
};

export const stalledItems: StalledItem[] = [
  { what: "Walker ACAT — missing signature", type: "Transfer", age: "12 days" },
  { what: "Okafor proposal — awaiting client", type: "Proposal", age: "8 days" },
  { what: "Stone RMD paperwork", type: "Task", age: "5 days" },
];

// --- P2 parity fields (ticket) -------------------------------------------
// The audit (§2) flagged the mockup's role-tinted signal badges and the
// expandable "Resolved" stalled section as B1 misses. The extra fields are
// modeled here as intersections over the frozen seam types — `lib/data/types`
// is the stable Phase B contract and is widened in Phase D, not in a parity WO.

/** Which desk a signal is routed to (mockup `sigRoleColor`, :3702). */
export type SignalRole = "Advisor" | "Client Service" | "Operations" | "All";

export type SignalWithRole = Signal & { forRole: SignalRole };

/** A stalled item that was worked to done (mockup RESOLVED_STALE, :3444). */
export type ResolvedStalledItem = StalledItem & {
  resolvedBy: string;
  resolvedWhen: string;
};

export const signals: SignalWithRole[] = [
  {
    client: "Stone Family Trust",
    signal: "Large deposit received",
    type: "Cash flow",
    time: "2h ago",
    src: "Custodian",
    role: "Primary",
    forRole: "Advisor",
  },
  {
    client: "Walker Household",
    signal: "Replied to onboarding email",
    type: "Engagement",
    time: "5h ago",
    src: "Email",
    role: "Spouse",
    forRole: "Client Service",
  },
  {
    client: "Nguyen Household",
    signal: "Risk questionnaire completed",
    type: "Intake",
    time: "Yesterday",
    src: "Intake form",
    role: "Primary",
    forRole: "Operations",
  },
];

// Resolved stalled items — keyed to the seed personas like everything above.
export const resolvedStalled: ResolvedStalledItem[] = [
  {
    what: "Patel beneficiary forms",
    type: "Missing docs",
    age: "14 days",
    resolvedBy: "Riley Ops",
    resolvedWhen: "2 days ago",
  },
  {
    what: "Nguyen duplicate account link",
    type: "Data issue",
    age: "8 days",
    resolvedBy: "Avery Stone",
    resolvedWhen: "3 days ago",
  },
];

export const commandCenter: CommandCenterData = {
  funnel,
  meetings,
  stalled: stalledItems,
  signals,
  meetingsNextWeek,
  meetingWeekRanges,
  // Prep payloads keyed by client sf_id — shared with the Client Portrait prep
  // fixtures so the Command Center panel and the portrait card tell one story.
  meetingPrep: prepByClient,
  // No AI-generated briefs in the mock world — the live app.meeting_prep read is
  // behind AI_MEETING_PREP and only applies to real appointments.
  meetingBriefs: {},
};
