import Link from "next/link";
import type { Meeting } from "@/lib/data/types";
import { Avatar, Button, Pill } from "@/components/ui";
import styles from "./MeetingRow.module.css";

// One meeting in the Command Center Meetings card (B1, TDD §6; prep actions
// P1, ticket). The client name links into the Client Portrait
// (`/client-portrait/[id]`). Without `onOpenPrep` the row keeps its original
// static prep pill; with it (MeetingsCard) the pill becomes the mockup's
// View prep / Generate prep button. `prepReady` overrides the fixture flag so
// an ephemeral session "generate" can flip the row (Phase C posture) — and, with
// AI_MEETING_PREP on, so a REAL stored brief flips it. `pending` renders the
// in-flight state while the Server Action runs (a Vertex round-trip is seconds,
// not milliseconds, so the row must say so).
//
// `hidePrepStatus` suppresses the static fixture pill entirely. REAL appointments
// (COMMAND_CENTER_MEETINGS_LIVE) with AI prep OFF have no prep concept at all —
// the mockup's "Prep ready/pending" pill is fixture-derived and would be pure
// noise against a live Slack-fed meeting. Mock/preview mode keeps the pill.
export function MeetingRow({
  meeting,
  prepReady,
  onOpenPrep,
  pending = false,
  hidePrepStatus = false,
}: {
  meeting: Meeting;
  prepReady?: boolean;
  onOpenPrep?: (generate: boolean) => void;
  /** AI_MEETING_PREP: a generation is in flight for THIS row. */
  pending?: boolean;
  /** Render no prep affordance at all (live appointments, AI prep off). */
  hidePrepStatus?: boolean;
}) {
  const ready = prepReady ?? meeting.prepReady;
  return (
    <div className={styles.row}>
      <Avatar name={meeting.client} size={34} />
      <div className={styles.content}>
        <Link className={styles.client} href={`/client-portrait/${meeting.clientId}`}>
          {meeting.client}
        </Link>
        <div className={styles.meta}>
          {meeting.when} · {meeting.type}
        </div>
      </div>
      {meeting.past ? (
        // Already happened — show status, not a prep action (owner ask 2026-07-23).
        <Pill tone="gray">Completed</Pill>
      ) : onOpenPrep ? (
        ready ? (
          <Button size="sm" variant="ghost" onClick={() => onOpenPrep(false)}>
            View prep
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => onOpenPrep(true)}
            disabled={pending}
            aria-busy={pending}
          >
            {pending ? "Generating…" : "Generate prep"}
          </Button>
        )
      ) : (
        !hidePrepStatus && (
          <Pill tone={ready ? "green" : "amber"} dot>
            {ready ? "Prep ready" : "Prep pending"}
          </Pill>
        )
      )}
    </div>
  );
}
