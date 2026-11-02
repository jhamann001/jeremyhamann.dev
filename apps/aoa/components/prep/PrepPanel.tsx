"use client";

import { useEffect, useRef } from "react";
import type { MeetingPrep, MeetingPrepBrief } from "@/lib/data/types";
import { Button, PreviewBadge } from "@/components/ui";
import { parseBrief } from "./brief-markdown";
import { exportBriefToPdf } from "./print-brief";
import {
  MEETING_PREP_GENERATION_CAP,
  MEETING_PREP_NO_CLIENT_LINK_NOTE,
  meetingPrepRemaining,
  meetingPrepThrottled,
} from "@/lib/data/meeting-prep-view";
import styles from "./PrepPanel.module.css";

// Shared Meeting Prep slide-over (P1, ticket — mockup `#prepPanel`), opened
// from BOTH the Portrait Communications prep card and the Command Center
// meeting rows. The mock path stays ephemeral (Phase C posture): the
// talking-points / notes fields are editable in place but reset on refresh, and
// its "Save prep" remains a toast stub via `onAction`.
//
// FOOTER (owner ask, 2026-07-27 — "make the save and export buttons work, maybe
// it just needs to be Save and Export"):
//   • Share       — REMOVED. The owner dropped it, and the blueprint is explicit
//                   that the brief is never shared with anyone outside AOA.
//   • Save        — on the AI path, REAL: attaches the stored brief to the
//                   client's portrait via saveMeetingPrepToPortrait (host-wired
//                   through onSaveToPortrait). Disabled with an inline reason
//                   when the appointment has no linked client record.
//   • Export PDF  — REAL, via the browser's print dialog (print-brief.ts). Not a
//                   direct file download; see that file for why no PDF library.
//
// TWO render paths (AI_MEETING_PREP, slice 1):
//   • `brief` present  → the REAL, stored AI brief: freeform markdown, a
//     "Generated … · model" provenance line, a Regenerate button, and NO
//     PreviewBadge (real data never wears the preview badge — the `live`
//     convention in MeetingsCard). The talking-points / notes textareas stay off
//     this path: nothing is written back anywhere in slice 1.
//   • otherwise → the original mock `MeetingPrep` structured path, untouched, so
//     the flag-OFF Command Center and the Client Portrait behave exactly as
//     before.
//
// A11y: role="dialog" + aria-modal, Esc closes, backdrop click closes, initial
// focus moves into the panel, Tab is contained inside it, and focus returns to
// the opener on close (the browser restores it because we never unmount the
// opener; we also re-focus explicitly for soft-nav safety).

export type PrepMeetingContext = { when: string; type: string };

/** Relative "3 minutes ago" for the provenance line; falls back to a date. */
function agoLabel(then: Date, now: Date): string {
  const mins = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  return then.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function PrepPanel({
  open,
  onClose,
  clientName,
  prep,
  brief = null,
  meeting,
  onAction,
  onRegenerate,
  regenerating = false,
  onSaveToPortrait,
  onUnsaveFromPortrait,
  savePending = false,
  canSaveToPortrait = true,
}: {
  open: boolean;
  onClose: () => void;
  clientName: string;
  prep: MeetingPrep | null;
  /** The REAL stored AI brief (AI_MEETING_PREP). Takes over the body when set. */
  brief?: MeetingPrepBrief | null;
  /** Present when opened from a Command Center meeting row. */
  meeting?: PrepMeetingContext | null;
  /** Stub-action feedback (Phase C posture) — host shows a toast. */
  onAction?: (message: string) => void;
  /** Re-run the generation for this meeting. Omit to hide Regenerate — the
   *  Client Portrait opens saved briefs read-only, with no way to re-bill. */
  onRegenerate?: () => void;
  regenerating?: boolean;
  /** Attach this brief to the client portrait. Omit to hide the affordance
   *  entirely (the portrait itself never offers "save to portrait"). */
  onSaveToPortrait?: () => void;
  /** Detach it again. Rendered when the brief is already saved. */
  onUnsaveFromPortrait?: () => void;
  savePending?: boolean;
  /** False when the appointment has no linked client record — Save is disabled
   *  with an inline explanation rather than erroring on click. */
  canSaveToPortrait?: boolean;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      // Contain Tab inside the dialog (simple wrap-around trap).
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const opener = openerRef.current;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  /** Already attached to the client portrait (app.meeting_prep.saved_at). */
  const savedAt = brief?.savedAt ?? null;

  const list = (items: string[], empty: string) =>
    items.length > 0 ? (
      <ul className={styles.list}>
        {items.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    ) : (
      <p className={styles.empty}>{empty}</p>
    );

  return (
    <div className={styles.backdrop} role="presentation" onClick={onClose}>
      <aside
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={`${clientName} — meeting prep`}
        onClick={(e) => e.stopPropagation()}
        /* Export PDF scopes the printed page to exactly this subtree (globals.css
           @media print). Everything the printout must carry — client name, the
           meeting date/time, the generated-at + model provenance line, the brief
           body and the internal-draft footer — lives inside it. */
        data-print-root
      >
        <header className={styles.head}>
          <h2 className={styles.title}>{clientName} — Prep</h2>
          {/* Real generated data carries no preview badge (the `live` convention). */}
          {brief ? null : <PreviewBadge />}
          <button
            ref={closeRef}
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="Close prep panel"
            data-print-hide
          >
            ✕
          </button>
        </header>

        {brief ? (
          <div className={styles.body}>
            {meeting ? (
              <section className={styles.section}>
                <div className={styles.sectionLabel}>This meeting</div>
                <div className={styles.box}>
                  <b>{meeting.when}</b> · {meeting.type}
                </div>
              </section>
            ) : null}

            <p className={styles.provenance}>
              Generated {agoLabel(new Date(brief.generatedAt), new Date())} ·{" "}
              {brief.model}
              {brief.generatedBy ? ` · ${brief.generatedBy}` : ""} · generation{" "}
              {brief.generations} of {MEETING_PREP_GENERATION_CAP}
            </p>
            {brief.finishReason && brief.finishReason !== "STOP" ? (
              <p className={styles.truncNote}>
                The model stopped early ({brief.finishReason}) — this brief may be
                incomplete.
              </p>
            ) : null}
            {brief.truncated ? (
              <p className={styles.truncNote}>
                Some context was trimmed to fit the budget; the oldest items were
                dropped first.
              </p>
            ) : null}

            <section className={styles.section}>
              <div className={styles.box}>
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
            </section>

            <p className={styles.status}>
              Internal draft — AI-generated from AOA data. Verify before the call;
              never share with the client.
            </p>
          </div>
        ) : (
        <div className={styles.body}>
          <div className={styles.meta}>
            <div className={styles.metaItem}>
              <div className={styles.metaLabel}>Advisor</div>
              <div className={styles.metaValue}>{prep?.advisor ?? "—"}</div>
            </div>
            <div className={styles.metaItem}>
              <div className={styles.metaLabel}>AUM</div>
              <div className={styles.metaValue}>{prep?.aum ?? "—"}</div>
            </div>
            <div className={styles.metaItem}>
              <div className={styles.metaLabel}>Risk profile</div>
              <div className={styles.metaValue}>{prep?.riskProfile ?? "—"}</div>
            </div>
            <div className={styles.metaItem}>
              <div className={styles.metaLabel}>Last meeting</div>
              <div className={styles.metaValue}>{prep?.lastMeeting ?? "—"}</div>
            </div>
          </div>

          {meeting ? (
            <section className={styles.section}>
              <div className={styles.sectionLabel}>This meeting</div>
              <div className={styles.box}>
                <b>{meeting.when}</b> · {meeting.type}
              </div>
            </section>
          ) : null}

          <section className={styles.section}>
            <div className={styles.sectionLabel}>Recent signals</div>
            <div className={styles.box}>
              {list(prep?.recentSignals ?? [], "No recent signals")}
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionLabel}>Open action items</div>
            <div className={styles.box}>{list(prep?.openItems ?? [], "No open items")}</div>
          </section>

          <section className={styles.section}>
            <label className={styles.sectionLabel} htmlFor="prep-talking-points">
              Talking points <span className={styles.editableTag}>editable</span>
            </label>
            <textarea
              id="prep-talking-points"
              className={styles.editable}
              rows={4}
              defaultValue={prep?.talkingPoints ?? ""}
              placeholder="Add talking points for this meeting…"
            />
          </section>

          <section className={styles.section}>
            <label className={styles.sectionLabel} htmlFor="prep-advisor-notes">
              Advisor notes <span className={styles.editableTag}>editable</span>
            </label>
            <textarea
              id="prep-advisor-notes"
              className={styles.editable}
              rows={3}
              defaultValue={prep?.notes ?? ""}
              placeholder="Add notes, reminders, or context for this meeting…"
            />
          </section>

          <p className={styles.status}>
            Preview · edits are in-memory only and reset on refresh
          </p>
        </div>
        )}

        {/* Footer — buttons and their inline notes never print. */}
        <footer className={styles.foot} data-print-hide>
          <div className={styles.footRow}>
            {brief ? (
              onRegenerate ? (
                <Button
                  size="sm"
                  className={styles.grow}
                  onClick={() => onRegenerate()}
                  disabled={regenerating || meetingPrepThrottled(brief.generations)}
                  aria-busy={regenerating}
                >
                  {regenerating
                    ? "Regenerating…"
                    : meetingPrepThrottled(brief.generations)
                      ? "Regeneration limit reached"
                      : `Regenerate (${meetingPrepRemaining(brief.generations)} left)`}
                </Button>
              ) : null
            ) : (
              <Button
                size="sm"
                className={styles.grow}
                onClick={() => {
                  onAction?.("Prep saved (preview — resets on refresh)");
                  onClose();
                }}
              >
                Save prep
              </Button>
            )}

            {/* Save → attach the stored brief to the client portrait. Only on
                the REAL brief path, and only where a host wired the action. */}
            {brief && onSaveToPortrait ? (
              savedAt && onUnsaveFromPortrait ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className={onRegenerate ? undefined : styles.grow}
                  onClick={() => onUnsaveFromPortrait()}
                  disabled={savePending}
                  aria-busy={savePending}
                >
                  {savePending ? "Removing…" : "Remove from portrait"}
                </Button>
              ) : (
                <Button
                  size="sm"
                  className={onRegenerate ? undefined : styles.grow}
                  onClick={() => onSaveToPortrait()}
                  disabled={savePending || !canSaveToPortrait}
                  aria-busy={savePending}
                  aria-describedby={
                    canSaveToPortrait ? undefined : "prep-save-unavailable"
                  }
                >
                  {savePending ? "Saving…" : "Save to portrait"}
                </Button>
              )
            ) : null}

            <Button size="sm" variant="ghost" onClick={() => exportBriefToPdf()}>
              Export PDF
            </Button>
          </div>

          {brief && onSaveToPortrait && !canSaveToPortrait ? (
            <p className={styles.footNote} id="prep-save-unavailable">
              {MEETING_PREP_NO_CLIENT_LINK_NOTE}
            </p>
          ) : null}
          {brief && onSaveToPortrait && savedAt ? (
            <p className={styles.footNote}>
              Saved to the client portrait · {agoLabel(new Date(savedAt), new Date())}
            </p>
          ) : null}
        </footer>
      </aside>
    </div>
  );
}
