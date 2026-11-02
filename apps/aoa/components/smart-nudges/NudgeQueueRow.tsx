import { Pill } from "@/components/ui";
import { NUDGE_STATUS_LABEL, nudgeTone } from "@/components/workflow";
import type { Nudge } from "@/components/workflow";
import { ChannelPill } from "./ChannelPill";
import styles from "./NudgeQueueRow.module.css";

// A clickable Nudge Queue row — the `.rem` grammar (status-tinted rail + main +
// trailing affordance), but the whole row is a <button> so click/keyboard opens
// the preview panel. Client + subject, then a meta line with the channel pill,
// send-time, and the status pill.
export function NudgeQueueRow({
  nudge,
  onOpen,
}: {
  nudge: Nudge;
  onOpen: () => void;
}) {
  return (
    <button type="button" className={styles.row} onClick={onOpen}>
      <span className={`${styles.rail} ${styles[nudgeTone(nudge.status)]}`} aria-hidden="true" />
      <span className={styles.main}>
        <span className={styles.client}>{nudge.client}</span>
        <span className={styles.subject}>{nudge.subject}</span>
        <span className={styles.meta}>
          <ChannelPill channel={nudge.channel} />
          <span className={styles.when}>{nudge.when}</span>
          <Pill tone={nudgeTone(nudge.status)}>{NUDGE_STATUS_LABEL[nudge.status]}</Pill>
        </span>
      </span>
      <span className={styles.affordance} aria-hidden="true">
        Preview →
      </span>
    </button>
  );
}
