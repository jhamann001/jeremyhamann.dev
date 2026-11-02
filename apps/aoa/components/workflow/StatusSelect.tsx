import type { TaskStatus } from "@/lib/data/workflow-types";
import { TASK_STATUS_LABEL } from "./status-tone";
import { Select } from "./Select";

const OPTIONS = (Object.keys(TASK_STATUS_LABEL) as TaskStatus[]).map((v) => ({
  value: v,
  label: TASK_STATUS_LABEL[v],
}));

export function StatusSelect({
  value,
  onChange,
  ariaLabel = "Task status",
  disabled = false,
}: {
  value: TaskStatus;
  onChange: (value: TaskStatus) => void;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return <Select value={value} options={OPTIONS} onChange={onChange} ariaLabel={ariaLabel} disabled={disabled} />;
}
