import { Button } from "@/components/ui";
import type { NudgeTemplate } from "@/components/workflow";
import { ChannelPill } from "./ChannelPill";
import styles from "./TemplateRow.module.css";

// A Template Library row: name / description / usage stats + a Schedule button.
// `uses` is a fabricated demo metric (the page labels it). Schedule is a stub —
// no client-picker flow is wired in Phase C.
export function TemplateRow({
  template,
  onSchedule,
}: {
  template: NudgeTemplate;
  onSchedule: () => void;
}) {
  return (
    <div className={styles.row}>
      <div className={styles.main}>
        <div className={styles.head}>
          <span className={styles.name}>{template.name}</span>
          {template.channel ? <ChannelPill channel={template.channel} /> : null}
        </div>
        <div className={styles.desc}>{template.desc}</div>
        <div className={styles.stats}>
          {template.uses} uses · last used {template.lastUsed}
        </div>
      </div>
      <div className={styles.actions}>
        <Button variant="ghost" size="sm" onClick={onSchedule}>
          Schedule
        </Button>
      </div>
    </div>
  );
}
