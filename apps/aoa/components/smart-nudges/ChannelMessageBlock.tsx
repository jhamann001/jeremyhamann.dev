import type { Nudge } from "@/components/workflow";
import styles from "./ChannelMessageBlock.module.css";

// The one genuinely new bit of Smart Nudges (mockup): render a nudge body with
// channel-appropriate chrome. Email = subject bar + body; text = green
// iMessage-style bubble; portal = a client-portal card; phone_prep = an internal
// talking-points card (no client-facing bubble — it's a call script). The body
// itself is a fixture (Phase E will AI-draft it) — the page labels that.
export function ChannelMessageBlock({ nudge }: { nudge: Nudge }) {
  switch (nudge.channel) {
    case "email":
      return (
        <div className={styles.email}>
          <div className={styles.emailHead}>
            <span className={styles.emailLabel}>Subject</span>
            <span className={styles.emailSubject}>{nudge.subject}</span>
          </div>
          <div className={styles.emailBody}>{nudge.body}</div>
        </div>
      );
    case "text":
      return (
        <div className={styles.textWrap}>
          <div className={styles.bubble}>{nudge.body}</div>
          <div className={styles.caption}>Text message</div>
        </div>
      );
    case "portal":
      return (
        <div className={styles.card}>
          <div className={styles.caption}>Client portal message</div>
          <div className={styles.cardBody}>{nudge.body}</div>
        </div>
      );
    case "phone_prep":
      return (
        <div className={styles.card}>
          <div className={styles.caption}>Call prep · talking points</div>
          <div className={styles.cardBody}>{nudge.body}</div>
        </div>
      );
    default:
      return null;
  }
}
