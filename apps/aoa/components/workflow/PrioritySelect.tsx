import type { TaskPriority } from "@/lib/data/workflow-types";
import { TASK_PRIORITY_LABEL } from "./status-tone";
import { Select } from "./Select";

const OPTIONS = (Object.keys(TASK_PRIORITY_LABEL) as TaskPriority[]).map((v) => ({
  value: v,
  label: TASK_PRIORITY_LABEL[v],
}));

export function PrioritySelect({
  value,
  onChange,
  ariaLabel = "Task priority",
  disabled = false,
}: {
  value: TaskPriority;
  onChange: (value: TaskPriority) => void;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return <Select value={value} options={OPTIONS} onChange={onChange} ariaLabel={ariaLabel} disabled={disabled} />;
}
