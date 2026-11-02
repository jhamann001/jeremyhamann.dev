"use client";

import { useState } from "react";
import type { MeetingPrep, SavedMeetingPrepBrief } from "@/lib/data/types";
import { Card, CardHeader, CardBody, Button, PreviewBadge } from "@/components/ui";
import { PrepPanel } from "@/components/prep/PrepPanel";
import { parseBrief } from "@/components/prep/brief-markdown";
import { Toast, useToast } from "@/components/prep/Toast";
import styles from "./PrepCard.module.css";

// Meeting Prep card on the Communications tab (P1, ticket — mockup `#n2prep`
// renderPrepCard): last meeting, talking points, 2-col recent signals / open
// items, optional advisor notes, and "Open full prep ↗" into the shared
// PrepPanel slide-over.
//
// TWO render paths (mirroring PrepPanel's own split):
//   • `savedBriefs` non-empty → the REAL, AI-generated brief(s) an advisor SAVED
//     to this portrait from the Command Center (app.meeting_prep.saved_at). Full
//     freeform markdown, a saved-at / generated-at / model provenance line, the
//     internal-draft warning, and "Open full prep ↗" into the panel (read-only:
//     no Regenerate from here, so the portrait can never re-bill Vertex).
//   • otherwise → the ORIGINAL mock `MeetingPrep` fixture path, untouched. With
//     AI_MEETING_PREP off the page passes `savedBriefs: []` and never reads the
//     table, so the card is byte-identical to today.

/** "Jul 29, 2026 · 10:00 AM" — which meeting this brief was written for. */
function meetingLabel(startsAt: Date): string {
  return startsAt.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Short absolute stamp for the provenance line (no "3 minutes ago" here — a
 *  saved brief is a record, and a record wants a date). */
function stamp(at: Date): string {
  return at.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function SavedBrief({
  brief,
  onOpen,
}: {
  brief: SavedMeetingPrepBrief;
  onOpen: () => void;
}) {
  return (
    <div className={styles.savedBrief}>
      <div className={styles.savedHead}>
        <div className={styles.savedMeeting}>{meetingLabel(brief.startsAt)}</div>
        <Button size="sm" variant="ghost" onClick={onOpen}>
          Open full prep ↗
        </Button>
      </div>
      <p className={styles.provenance}>
        Saved {stamp(brief.savedAt)}
        {brief.savedBy ? ` by ${brief.savedBy}` : ""} · generated{" "}
        {stamp(brief.generatedAt)} · {brief.model}
      </p>
      <div className={styles.briefBody}>
        {parseBrief(brief.text).map((b, i) =>
          b.kind === "heading" ? (
            <h3 key={i} className={styles.briefHeading}>
              {b.text}
            </h3>
          ) : b.kind === "bullets" ? (
            <ul key={i} className={styles.list}>
              {b.items.map((x, j) => (
                <li key={j}>{x}</li>
              ))}
            </ul>
          ) : (
            <p key={i} className={styles.briefPara}>
              {b.text}
            </p>
          ),
        )}
      </div>
      <p className={styles.internalNote}>
        Internal draft — AI-generated from AOA data. Verify before the call; never
        share with the client.
      </p>
    </div>
  );
}

export function PrepCard({
  prep,
  clientName,
  savedBriefs = [],
}: {
  prep: MeetingPrep | null;
  clientName: string;
  /** REAL saved AI briefs for this client, newest meeting first. Empty when
   *  AI_MEETING_PREP is off or nothing has been saved — the card then keeps its
   *  original mock behaviour exactly. */
  savedBriefs?: SavedMeetingPrepBrief[];
}) {
  const [open, setOpen] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const { toast, showToast } = useToast();
  const firstName = clientName.split(" ")[0];

  // --- REAL path: saved AI brief(s) supersede the fixture --------------------
  if (savedBriefs.length > 0) {
    const active =
      savedBriefs.find((b) => b.appointmentKey === openKey) ?? savedBriefs[0];
    return (
      <Card>
        <CardHeader>
          <h2>Meeting prep</h2>
        </CardHeader>
        <CardBody>
          {savedBriefs.map((b) => (
            <SavedBrief
              key={b.appointmentKey}
              brief={b}
              onOpen={() => {
                setOpenKey(b.appointmentKey);
                setOpen(true);
              }}
            />
          ))}
        </CardBody>

        {/* Read-only: no onRegenerate and no onSaveToPortrait — the brief is
            already here, and re-billing Vertex belongs to the Command Center.
            Export PDF stays available. */}
        <PrepPanel
          open={open}
          onClose={() => setOpen(false)}
          clientName={clientName}
          prep={null}
          brief={active}
          meeting={{
            when: meetingLabel(active.startsAt),
            type: "Saved meeting prep",
          }}
          onAction={showToast}
        />
        <Toast message={toast} />
      </Card>
    );
  }

  // --- MOCK path (unchanged) -------------------------------------------------
  if (!prep) {
    return (
      <Card>
        <CardHeader>
          <h2>Meeting prep</h2>
          <PreviewBadge />
        </CardHeader>
        <CardBody>
          <p className={styles.emptyCopy}>
            No meeting prep on file for {firstName} yet. Generate it from the Command
            Center → Meetings card.
          </p>
        </CardBody>
      </Card>
    );
  }

  const list = (items: string[]) =>
    items.length > 0 ? (
      <ul className={styles.list}>
        {items.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    ) : (
      <span className={styles.dash}>—</span>
    );

  return (
    <Card>
      <CardHeader>
        <h2>Meeting prep</h2>
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          Open full prep ↗
        </Button>
        <PreviewBadge />
      </CardHeader>
      <CardBody>
        {prep.lastMeeting ? (
          <div className={styles.lastMeeting}>Last meeting: {prep.lastMeeting}</div>
        ) : null}
        <div className={styles.sectionLabel}>Talking points</div>
        <div className={styles.talkingPoints}>{prep.talkingPoints}</div>
        <div className={styles.cols}>
          <div>
            <div className={styles.sectionLabel}>Recent signals</div>
            {list(prep.recentSignals)}
          </div>
          <div>
            <div className={styles.sectionLabel}>Open items</div>
            {list(prep.openItems)}
          </div>
        </div>
        {prep.notes ? (
          <div className={styles.notes}>
            <div className={styles.sectionLabel}>Advisor notes</div>
            <div className={styles.notesBody}>{prep.notes}</div>
          </div>
        ) : null}
      </CardBody>

      <PrepPanel
        open={open}
        onClose={() => setOpen(false)}
        clientName={clientName}
        prep={prep}
        onAction={showToast}
      />
      <Toast message={toast} />
    </Card>
  );
}
