import { QUEUE_LABELS, type QueueKey } from "@/types/domain";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Queues are identity, not state: a single neutral treatment plus a small colour dot per queue. */
const QUEUE_DOT: Readonly<Record<QueueKey, string>> = {
  OPERATIONS: "bg-slate-500 dark:bg-slate-400",
  CLIENT_SERVICE: "bg-teal-600 dark:bg-teal-400",
  ADVICE: "bg-indigo-600 dark:bg-indigo-400",
};

export function QueueBadge({ queueKey }: { queueKey: QueueKey }): React.JSX.Element {
  return (
    <Badge variant="outline" className="gap-1.5 font-normal" data-queue={queueKey}>
      <span aria-hidden className={cn("inline-block size-1.5 rounded-full", QUEUE_DOT[queueKey])} />
      {QUEUE_LABELS[queueKey]}
    </Badge>
  );
}
