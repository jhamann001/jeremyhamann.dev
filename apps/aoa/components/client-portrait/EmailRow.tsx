import { Avatar, Button } from "@/components/ui";
import type { PortraitEmail } from "@/lib/data/types";
import styles from "./EmailRow.module.css";

// One inbound-email row (mock via the B0 seam). Avatar + unread marker + subject/
// preview/time, with a disabled "Generate draft" action (Phase E Gemini stub — no
// handler, so this stays a server component).
export function EmailRow({ email }: { email: PortraitEmail }) {
  return (
    <li className={styles.row}>
      {email.unread ? (
        <span className={styles.unread} aria-label="Unread" title="Unread" />
      ) : (
        <span className={styles.unreadSpacer} aria-hidden="true" />
      )}
      <Avatar name={email.from} size={32} />
      <div className={styles.content}>
        <div className={styles.head}>
          <span className={styles.subject}>{email.subject}</span>
          <span className={styles.time}>{email.time}</span>
        </div>
        <div className={styles.from}>{email.from}</div>
        <p className={styles.preview}>{email.preview}</p>
      </div>
      <Button variant="ghost" size="sm" disabled>
        Generate draft
      </Button>
    </li>
  );
}
