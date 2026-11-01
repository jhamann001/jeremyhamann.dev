import type { AuditAction } from "@/types/domain";
import { Badge } from "@/components/ui/badge";
import { ACTION_LABELS } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AUDIT_ACTION_CLASSES, auditActionVariant } from "@/components/audit/audit-action-style";

/**
 * The action chip in the audit ledger. The colour contract it renders — which actions are alarming,
 * which are routine — lives in `audit-action-style.ts` so it can be unit-tested without a DOM.
 */
export function AuditActionBadge({ action }: { action: AuditAction }): React.JSX.Element {
  return (
    <Badge
      variant={auditActionVariant(action)}
      className={cn("font-normal", AUDIT_ACTION_CLASSES[action])}
      data-audit-action={action}
      title={action}
    >
      {ACTION_LABELS[action]}
    </Badge>
  );
}
