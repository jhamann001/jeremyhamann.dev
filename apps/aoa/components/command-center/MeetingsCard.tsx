"use client";

import { useState, useTransition } from "react";
import type { Meeting, MeetingPrep, MeetingPrepBrief } from "@/lib/data/types";
import { Card, CardHeader, CardBody, Pill, PreviewBadge } from "@/components/ui";
import { MeetingRow } from "./MeetingRow";
import { PrepPanel, type PrepMeetingContext } from "@/components/prep/PrepPanel";
import { Toast, useToast } from "@/components/prep/Toast";
import { prepSummary } from "./prep-summary";
import {
  canSaveMeetingPrepToPortrait,
  meetingPrepFailureLabel,
  prepAffordance,
} from "@/lib/data/meeting-prep-view";
import {
  generateMeetingPrep,
  saveMeetingPrepToPortrait,
  unsaveMeetingPrepFromPortrait,
} from "@/app/(authenticated)/command-center/actions";
import styles from "./MeetingsCard.module.css";

// Command Center Meetings card (P1, ticket — MEETINGS section only): week
// toggle (This week / Next week) flipping fixture sets, the date-range line +
// need-prep pill, and per-row View prep / Generate prep opening the shared
// PrepPanel.
//
// TWO modes:
//   • `aiPrep` OFF (default, AI_MEETING_PREP unset) — the original EPHEMERAL
//     stub: Generate toasts, marks the row ready in memory and resets on
//     refresh. No writes, no model call; behaviour identical to main.
//   • `aiPrep` ON — Generate calls the generateMeetingPrep Server Action, which
//     assembles context, calls Vertex, PERSISTS the brief and audits it. The row
//     shows "Generating…" while it runs; the panel then renders the real brief.
//     A stored brief re-opens instantly with NO second model call — only
//     Regenerate re-bills, and only up to the lifetime cap.
//
// Everything is keyed on `Meeting.key` (the appointment's external_key), never
// clientId: client_sf_id is often null on live appointments, so a clientId key
// collapses every unlinked meeting onto "".

type WeekId = "this" | "next";

export function MeetingsCard({
  thisWeek,
  nextWeek,
  weekRanges,
  prep,
  briefs = {},
  aiPrep = false,
  live = false,
}: {
  thisWeek: Meeting[];
  nextWeek: Meeting[];
  weekRanges: { thisWeek: string; nextWeek: string };
  /** MOCK prep fixtures, keyed by client sf_id (the flag-OFF path). */
  prep: Record<string, MeetingPrep | null>;
  /** REAL stored AI briefs, keyed by MEETING KEY (AI_MEETING_PREP). */
  briefs?: Record<string, MeetingPrepBrief | null>;
  /** AI_MEETING_PREP — gates the real generate path (the action re-checks it). */
  aiPrep?: boolean;
  /** When true the card shows REAL appointments (Slack feed) — hide the preview badge. */
  live?: boolean;
}) {
  const [week, setWeek] = useState<WeekId>("this");
  // Ephemeral session writes (flag OFF, resets on refresh): meeting keys.
  const [generated, setGenerated] = useState<ReadonlySet<string>>(new Set());
  // Briefs generated in THIS session, merged over the server-supplied ones so a
  // fresh generate renders immediately, before the revalidated payload lands.
  const [sessionBriefs, setSessionBriefs] = useState<Record<string, MeetingPrepBrief>>(
    {},
  );
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // Save-to-portrait runs in its own transition so a slow attach never makes the
  // Generate button look busy (and vice versa).
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [isSaving, startSaveTransition] = useTransition();
  const [panel, setPanel] = useState<{
    clientName: string;
    clientId: string;
    key: string;
    meeting: PrepMeetingContext;
  } | null>(null);
  const { toast, showToast } = useToast();

  const meetings = week === "next" ? nextWeek : thisWeek;
  const range = week === "next" ? weekRanges.nextWeek : weekRanges.thisWeek;

  const briefFor = (key: string): MeetingPrepBrief | null =>
    sessionBriefs[key] ?? briefs[key] ?? null;

  // A row counts as prepped when it has a stored/session brief (AI path) or was
  // generated ephemerally (mock path).
  const readyKeys = new Set<string>([
    ...generated,
    ...(aiPrep ? meetings.filter((m) => briefFor(m.key) !== null).map((m) => m.key) : []),
  ]);
  const summary = prepSummary(meetings, readyKeys);
  const affordance = prepAffordance({ aiPrep, live });

  function showPanel(m: Meeting) {
    setPanel({
      clientName: m.client,
      clientId: m.clientId,
      key: m.key,
      meeting: { when: m.when, type: m.type },
    });
  }

  function runGenerate(m: Meeting, openOnSuccess: boolean) {
    setPendingKey(m.key);
    startTransition(async () => {
      const res = await generateMeetingPrep(m.key);
      setPendingKey(null);
      if (!res.ok) {
        // A STATIC label from the reason enum — never a model/DB message.
        showToast(meetingPrepFailureLabel(res.reason));
        return;
      }
      setSessionBriefs((prev) => ({ ...prev, [m.key]: res.brief }));
      if (openOnSuccess) showPanel(m);
    });
  }

  function openPrep(m: Meeting, generate: boolean) {
    if (!aiPrep) {
      // Original ephemeral stub (flag OFF) — unchanged behaviour.
      if (generate) {
        setGenerated((prev) => new Set(prev).add(m.key));
        showToast(`Prep generated for ${m.client} (preview — resets on refresh)`);
      }
      showPanel(m);
      return;
    }
    // A stored brief re-opens with NO model call (no re-billing).
    if (!generate || briefFor(m.key) !== null) {
      showPanel(m);
      return;
    }
    runGenerate(m, true);
  }

  /**
   * Attach / detach the stored brief on the client's portrait. The server action
   * re-derives the client from the STORED row and refuses an unlinked one, so
   * this only has to keep the panel honest afterwards: we merge the returned
   * savedAt into the session brief so the footer flips without a round trip.
   */
  function runSave(key: string, save: boolean) {
    const current = briefFor(key);
    if (!current) return;
    setSavingKey(key);
    startSaveTransition(async () => {
      const res = save
        ? await saveMeetingPrepToPortrait(key)
        : await unsaveMeetingPrepFromPortrait(key);
      setSavingKey(null);
      if (!res.ok) {
        showToast(meetingPrepFailureLabel(res.reason));
        return;
      }
      setSessionBriefs((prev) => ({
        ...prev,
        [key]: { ...(prev[key] ?? current), savedAt: res.savedAt },
      }));
      showToast(
        save
          ? "Prep saved to the client portrait."
          : "Prep removed from the client portrait.",
      );
    });
  }

  const panelBrief = panel && aiPrep ? briefFor(panel.key) : null;
  const panelMeeting = panel
    ? ([...thisWeek, ...nextWeek].find((m) => m.key === panel.key) ?? null)
    : null;

  return (
    <Card>
      <CardHeader>
        <h2>Meetings</h2>
        {!live && <PreviewBadge />}
        <div className={styles.toggle} role="group" aria-label="Meetings week">
          <button
            type="button"
            className={`${styles.toggleBtn} ${week === "this" ? styles.toggleActive : ""}`.trim()}
            aria-pressed={week === "this"}
            onClick={() => setWeek("this")}
          >
            This week
          </button>
          <button
            type="button"
            className={`${styles.toggleBtn} ${week === "next" ? styles.toggleActive : ""}`.trim()}
            aria-pressed={week === "next"}
            onClick={() => setWeek("next")}
          >
            Next week
          </button>
        </div>
      </CardHeader>
      <CardBody>
        <div className={styles.subhead}>
          <span className={styles.range}>{range}</span>
          {/* The "N need prep" roll-up is only meaningful when prep is an action
              the user can actually take — with no affordance it just poses a
              question the card can't answer. */}
          {affordance !== "none" && (
            <Pill tone={summary.tone} dot>
              {summary.label}
            </Pill>
          )}
        </div>
        {/* Action slot per prepAffordance (see meeting-prep-view.ts for why the
            button must not render with the flag off). */}
        {meetings.map((m) => (
          <MeetingRow
            key={m.key}
            meeting={m}
            prepReady={m.prepReady || readyKeys.has(m.key)}
            pending={isPending && pendingKey === m.key}
            onOpenPrep={
              affordance === "interactive"
                ? (generate) => openPrep(m, generate)
                : undefined
            }
            hidePrepStatus={affordance === "none"}
          />
        ))}
      </CardBody>

      <PrepPanel
        open={panel !== null}
        onClose={() => setPanel(null)}
        clientName={panel?.clientName ?? ""}
        prep={panel ? (prep[panel.clientId] ?? null) : null}
        brief={panelBrief}
        meeting={panel?.meeting ?? null}
        onAction={showToast}
        regenerating={isPending && pendingKey !== null && pendingKey === panel?.key}
        onRegenerate={() => {
          if (panelMeeting) runGenerate(panelMeeting, false);
        }}
        // Save/unsave only exist on the real-brief path; PrepPanel hides the
        // affordance entirely when these are absent (flag OFF ⇒ no brief ⇒ the
        // mock footer, unchanged).
        onSaveToPortrait={panel ? () => runSave(panel.key, true) : undefined}
        onUnsaveFromPortrait={panel ? () => runSave(panel.key, false) : undefined}
        savePending={isSaving && savingKey !== null && savingKey === panel?.key}
        // An appointment whose name never matched a mirror.client row has no
        // portrait to attach to (client_sf_id null ⇒ Meeting.clientId "").
        canSaveToPortrait={canSaveMeetingPrepToPortrait(panel?.clientId)}
      />
      <Toast message={toast} />
    </Card>
  );
}
