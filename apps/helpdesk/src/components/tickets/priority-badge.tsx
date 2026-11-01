import type { TicketPriority } from "@/types/domain";
import { Badge } from "@/components/ui/badge";
import { PRIORITY_LABELS } from "@/lib/format";
import { cn } from "@/lib/utils";

const PRIORITY_CLASSES: Readonly<Record<TicketPriority, string>> = {
  // URGENT: destructive tint (Badge variant below). Kept here so the map is exhaustive.
  URGENT: "font-semibold",
  HIGH: "border-amber-400 text-amber-900 dark:border-amber-500 dark:text-amber-200",
  STANDARD: "",
  LOW: "text-muted-foreground",
};

function variantFor(priority: TicketPriority): "destructive" | "outline" | "secondary" {
  switch (priority) {
    case "URGENT":
      return "destructive";
    case "HIGH":
      return "outline";
    case "STANDARD":
      return "secondary";
    case "LOW":
      return "outline";
  }
}

export function PriorityBadge({ priority }: { priority: TicketPriority }): React.JSX.Element {
  return (
    <Badge
      variant={variantFor(priority)}
      className={cn("tabular-nums", PRIORITY_CLASSES[priority])}
      data-priority={priority}
      aria-label={`Priority: ${PRIORITY_LABELS[priority]}`}
    >
      {PRIORITY_LABELS[priority]}
    </Badge>
  );
}
