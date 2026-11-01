import { ShieldAlert } from "lucide-react";
import { PII_KIND_LABELS } from "@/lib/pii";
import { PII_KINDS } from "@/types/domain";
import type { PiiKind } from "@/types/domain";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Count-based only. Every caller has the real count (TicketListRow, TicketDetailDTO, CommentDTO all
 * carry `piiRedactionCount`); never pass a fabricated 1.
 *
 * `sanitizePII` recognises THREE kinds: SSN, payment card, account number. This
 * component carries an OPTIONAL `byKind` breakdown so a surface that has one can say WHICH kinds were
 * redacted rather than only how many values were. The list it iterates is `PII_KINDS`, so a kind
 * added or withdrawn there needs no change here.
 *
 * Why optional, and why nothing passes it yet: the per-row breakdown is not persisted. `Ticket` and
 * `Comment` store `piiRedacted` and `piiRedactionCount` and nothing else, and the kind-by-kind
 * tally exists only inside the `sanitizePII` result at write time and in the `PII_REDACTED` audit
 * row's `newValue` (`formatPiiCounts`). Persisting a breakdown would need a column on two
 * foundation-owned models, which this slice may not add; the request is filed in
 * the build record. Until then the breakdown is available to any caller
 * that already holds a `SanitizeResult` — the composer's post-write toast is the obvious one —
 * and the count-only rendering is unchanged.
 *
 * `R10`: nothing that matters is tooltip-only. The badge text carries the count as visible text, and
 * the breakdown is a refinement of an explanation that is already legible without it.
 */
export function PiiIndicator({
  count,
  scope,
  byKind,
}: {
  count: number;
  scope: "ticket" | "comment";
  /** Optional per-kind tally. Kinds with a zero count are not rendered. */
  byKind?: Partial<Record<PiiKind, number>>;
}): React.JSX.Element | null {
  if (count <= 0) return null;
  const noun = count === 1 ? "item was" : "items were";
  const present = byKind === undefined ? [] : PII_KINDS.filter((kind) => (byKind[kind] ?? 0) > 0);
  const breakdown = present.map((kind) => `${PII_KIND_LABELS[kind]} (${byKind?.[kind] ?? 0})`).join(", ");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className="gap-1 border-amber-400/70 text-amber-900 dark:border-amber-500/70 dark:text-amber-200"
          data-pii-scope={scope}
          aria-label={
            breakdown.length > 0 ? `PII redacted (${count}): ${breakdown}` : `PII redacted (${count})`
          }
        >
          <ShieldAlert aria-hidden />
          <span>PII redacted ({count})</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        {count} {noun} redacted before saving this {scope}.
        {breakdown.length > 0 ? <span className="mt-1 block">{breakdown}.</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}
