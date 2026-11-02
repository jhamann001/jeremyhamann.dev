import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { commandCenterData } from "@/lib/data/overview";
import {
  aiMeetingPrepEnabled,
  commandCenterFunnelLiveEnabled,
  commandCenterMeetingsLiveEnabled,
} from "@/lib/flags";
import { canWriteTransfers } from "@/lib/data/transfer-write";
import {
  Card,
  CardHeader,
  CardBody,
  Pill,
  Feed,
  FeedItem,
  PreviewBadge,
  SectionLabel,
} from "@/components/ui";
import { Funnel } from "@/components/command-center/Funnel";
import { MeetingsCard } from "@/components/command-center/MeetingsCard";
import { StalledCard } from "@/components/command-center/StalledCard";
import { signalRoleBadge } from "@/components/command-center/cc-interactivity";
// P2 parity fields (ticket): `forRole` badges + the resolved-stalled fixture
// are not part of the frozen `lib/data/types` seam contract (widened in Phase
// D, not here). The Command Center is mock-fed either way — commandCenterData()
// returns these exact fixture objects — so the two P2 sections read the
// extended fixtures straight from the mock module.
import {
  signals as signalsWithRoles,
  resolvedStalled,
} from "@/lib/mock/command-center";

// Command Center — the post-login home (TDD §6, ADR-3). UI-first: every card is
// fed by `commandCenterData()` which returns typed `lib/mock` fixtures for now, so
// every card wears a <PreviewBadge/> (honest placeholder, ADR-2). Identity is read
// from auth() exactly like the dashboard and passed through the seam for future
// per-user scoping.

// A page-level time-period toggle used to live here (mockup chrome, rendered as
// inert <span>s). REMOVED (owner 2026-07-28): this page is a work queue, not an
// analytics dashboard — the funnel's stage counts, the stalled list and the
// transfer counts are all CURRENT STATE, for which "last quarter" has no
// meaning, and Meetings already carries the only time control that makes sense
// for it (this week / next week). A wired-up global range would have been
// ignored by most cards, which is worse than absent.

// Map a signal's type to a Feed dot tone (kind). Unknown types fall back neutral.
const SIGNAL_KIND: Record<string, string> = {
  "Cash flow": "event",
  Engagement: "email",
  Intake: "note",
};

export default async function CommandCenter() {
  const session = await auth();
  if (!session?.user) redirect("/");

  const role = (session.user as { role?: string }).role ?? "VIEWER";
  const email = session.user.email ?? null;

  const data = await commandCenterData({ role, email });

  return (
    <>
      <h1>Command Center</h1>
      <p style={{ color: "var(--muted)", marginTop: 6 }}>
        {session.user.name ?? session.user.email} · role: <b>{role}</b>
      </p>

      {/* Funnel / Transfer pipeline — LIVE deal counts behind
          COMMAND_CENTER_FUNNEL_LIVE; the preview badge is dropped once the card
          is showing real app.deal data (same rule as the Meetings card). */}
      <div style={{ marginTop: 24 }}>
        <Card>
          <CardHeader>
            <h2>Transfer pipeline</h2>
            {!commandCenterFunnelLiveEnabled() && <PreviewBadge />}
          </CardHeader>
          <CardBody>
            <Funnel stages={data.funnel} />
          </CardBody>
        </Card>
      </div>

      {/* 3-col grid: Meetings · Stalled & At Risk · Signals */}
      <div style={{ marginTop: 16 }}>
        <SectionLabel>This week</SectionLabel>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: 16,
          marginTop: 10,
        }}
      >
        {/* Meetings (P1, ticket): week toggle + prep buttons + shared PrepPanel */}
        <MeetingsCard
          thisWeek={data.meetings}
          nextWeek={data.meetingsNextWeek}
          weekRanges={data.meetingWeekRanges}
          prep={data.meetingPrep}
          briefs={data.meetingBriefs}
          // AI_MEETING_PREP gates the UI affordance; the Server Action re-checks
          // the same flag AND the role (defense in depth), and the
          // app.meeting_prep RLS policies exclude VIEWER at the DB.
          aiPrep={aiMeetingPrepEnabled() && canWriteTransfers(role)}
          live={commandCenterMeetingsLiveEnabled()}
        />

        {/* Stalled & At Risk — P2 interactivity (ticket): snooze / create
            task / expandable Resolved, all ephemeral (resets on refresh). */}
        <StalledCard items={data.stalled} resolved={resolvedStalled} />

        {/* Recent client signals */}
        <Card>
          <CardHeader>
            <h2>Recent client signals</h2>
            <PreviewBadge />
          </CardHeader>
          <CardBody>
            <Feed>
              {signalsWithRoles.map((s) => {
                const badge = signalRoleBadge(s.forRole);
                return (
                  <FeedItem
                    key={`${s.client}-${s.signal}`}
                    kind={SIGNAL_KIND[s.type] ?? "note"}
                    time={s.time}
                    title={
                      <>
                        {s.signal} <Pill tone={badge.tone}>{badge.label}</Pill>
                      </>
                    }
                    desc={
                      <>
                        {s.client} · {s.role} · {s.type} · {s.src}
                      </>
                    }
                  />
                );
              })}
            </Feed>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
