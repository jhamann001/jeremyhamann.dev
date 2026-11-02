import type { AssetMapScheduleStatus } from "@/lib/data/asset-map";
import { Pill } from "@/components/ui";
import { scheduleLabel } from "./workspace-model";

export function ScheduleBadge({ schedule }: { schedule: AssetMapScheduleStatus | null }) {
  return schedule ? (
    <span data-schedule={schedule.active ? "live" : "asleep"}>
      <Pill tone={schedule.active ? "ok" : "neutral"} dot>{scheduleLabel(schedule)}</Pill>
    </span>
  ) : null;
}
