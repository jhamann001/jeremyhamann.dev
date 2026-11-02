import { Card, CardBody, CardHeader, Pill, PreviewBadge } from "@/components/ui";
import {
  ListRow,
  channelTone,
  decisionTone,
  nudgeTone,
  CHANNEL_LABEL,
  DECISION_STATUS_LABEL,
  NUDGE_STATUS_LABEL,
} from "@/components/workflow";
import type { Decision, Nudge } from "@/lib/data/workflow-types";
import styles from "./ClientRemindersPanel.module.css";

// The client-scoped two-panel Reminders layout (Phase F / F2, mockup Node 4):
// (a) Client-facing reminders — this client's nudges, the client's-eye view of
// the Phase C outbound queue; (b) Advisor lens — this household's decisions.
// Rows are the REUSED Phase C ListRow + status-tone grammar (no new engine,
// TDD ADR-3); this view is read-only (ADR-4). The Smart Nudges shortcut is
// temporarily hidden (ticket).
// Server-safe (no state).

const NUDGE_ICON = { ready: "○", scheduled: "◔", sent: "●" } as const;
const DECISION_ICON = { open: "○", snoozed: "◑", decided: "●" } as const;

export function ClientRemindersPanel({
  clientName,
  decisions,
  nudges,
}: {
  clientName: string;
  decisions: Decision[];
  nudges: Nudge[];
}) {
  return (
    <div className={styles.grid}>
      {/* Panel A — the client's-eye view of their queued/sent nudges. */}
      <Card>
        <CardHeader>
          <div>
            <h2>Client-facing reminders</h2>
            <div className={styles.sub}>What {clientName} receives</div>
          </div>
          <PreviewBadge />
        </CardHeader>
        <CardBody>
          {nudges.length === 0 ? (
            <p className={styles.empty}>
              No client-facing reminders queued for {clientName}.
            </p>
          ) : (
            nudges.map((n) => (
              <ListRow
                key={n.id}
                tone={nudgeTone(n.status)}
                icon={<span aria-hidden="true">{NUDGE_ICON[n.status]}</span>}
              >
                <h4 className={styles.title}>{n.subject}</h4>
                <div className={styles.body}>{n.body}</div>
                <div className={styles.meta}>
                  <Pill tone={channelTone(n.channel)}>{CHANNEL_LABEL[n.channel]}</Pill>
                  <span className={styles.when}>{n.when}</span>
                  <Pill tone={nudgeTone(n.status)} dot>
                    {NUDGE_STATUS_LABEL[n.status]}
                  </Pill>
                </div>
              </ListRow>
            ))
          )}
        </CardBody>
      </Card>

      {/* Panel B — the advisor's lens: this household's decisions. */}
      <Card>
        <CardHeader>
          <div>
            <h2>Advisor lens</h2>
            <div className={styles.sub}>Decisions for this household</div>
          </div>
          <PreviewBadge />
        </CardHeader>
        <CardBody>
          {decisions.length === 0 ? (
            <p className={styles.empty}>No decisions for this household yet.</p>
          ) : (
            decisions.map((d) => (
              <div key={d.id} className={styles.group}>
                <div className={styles.meeting}>{d.meeting}</div>
                {d.items.map((item) => (
                  <ListRow
                    key={item.id}
                    tone={decisionTone(item.status)}
                    icon={<span aria-hidden="true">{DECISION_ICON[item.status]}</span>}
                  >
                    <h4 className={styles.title}>{item.what}</h4>
                    <div className={styles.body}>
                      <span className={styles.label}>Rec:</span> {item.rec}
                    </div>
                    <div className={styles.meta}>
                      <span className={styles.when}>{item.owner.label}</span>
                      <Pill tone={decisionTone(item.status)} dot>
                        {DECISION_STATUS_LABEL[item.status]}
                      </Pill>
                    </div>
                  </ListRow>
                ))}
              </div>
            ))
          )}
        </CardBody>
      </Card>
    </div>
  );
}
