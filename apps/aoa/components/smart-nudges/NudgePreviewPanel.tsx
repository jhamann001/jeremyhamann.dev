"use client";

import { Button } from "@/components/ui";
import { PreviewPanel } from "@/components/workflow";
import type { Nudge } from "@/components/workflow";
import { ChannelMessageBlock } from "./ChannelMessageBlock";
import { ChannelPill } from "./ChannelPill";
import styles from "./NudgePreviewPanel.module.css";

// Slide-in nudge preview built on the C0 PreviewPanel chrome. Meta grid +
// channel-aware message block + status-aware footer. All actions are wired by the
// page to the ephemeral store (send/schedule/resend) — nothing is persisted.
export function NudgePreviewPanel({
  nudge,
  onClose,
  onSend,
  onSchedule,
  onResend,
}: {
  nudge: Nudge | null;
  onClose: () => void;
  onSend: () => void;
  onSchedule: () => void;
  onResend: () => void;
}) {
  const sent = nudge?.status === "sent";

  const footer = nudge ? (
    sent ? (
      <>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button onClick={onResend}>Resend</Button>
      </>
    ) : (
      <>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="ghost" onClick={onSchedule}>
          Schedule
        </Button>
        <Button onClick={onSend}>Send now</Button>
      </>
    )
  ) : null;

  return (
    <PreviewPanel open={!!nudge} onClose={onClose} title="Nudge preview" footer={footer}>
      {nudge ? (
        <>
          <dl className={styles.meta}>
            <dt className={styles.term}>To</dt>
            <dd className={styles.def}>{nudge.client}</dd>
            <dt className={styles.term}>Channel</dt>
            <dd className={styles.def}>
              <ChannelPill channel={nudge.channel} />
            </dd>
            <dt className={styles.term}>Send</dt>
            <dd className={styles.def}>{nudge.when}</dd>
            <dt className={styles.term}>Template</dt>
            <dd className={styles.def}>{nudge.templateId}</dd>
          </dl>
          <ChannelMessageBlock nudge={nudge} />
          <p className={styles.note}>
            Message body is a fixture — Phase E will AI-draft this per client / decision.
          </p>
        </>
      ) : null}
    </PreviewPanel>
  );
}
