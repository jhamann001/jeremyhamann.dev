import { BadgeCheck, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import type { TicketDetailDTO, Viewer } from "@/types/domain";
import {
  CATEGORY_LABELS,
  IDENTITY_VERIFICATION_METHOD_LABELS,
  IDENTITY_VERIFICATION_RESULT_LABELS,
} from "@/types/domain";
import { formatDateTime } from "@/lib/format";
import { canVerifyIdentity } from "@/lib/rbac";
import { cn } from "@/lib/utils";
import { identityGateState, isIdentityGateRequired, listIdentityVerifications } from "@/server/identity-gate";
import { Badge } from "@/components/ui/badge";
import { IdentityVerificationControls } from "@/components/ticket/identity-verification-sheet";

/**
 * Identity verification panel — slice B6.
 *
 * MOUNT POINT: an async SERVER component that owns its own data load, behind the ticket page's
 * `<Suspense>` boundary. It is on G1's `SERVER_COMPONENT_MOUNT_POINTS` allowlist, so it
 * may import `@/server/identity-gate` and nothing else from the server layer.
 *
 * It renders on EVERY ticket, not only the five gated categories. Recording a callback on a ticket
 * that did not require one is useful evidence, and hiding the control until the category is one of the
 * five teaches people that verification is paperwork rather than practice. On a gated category it
 * additionally shows whether the ticket may be resolved, which is the one place in the app where the
 * refusal `changeTicketStatus` is about to throw is visible BEFORE somebody tries to resolve.
 *
 * NOT A VIEW. A verification record carries a method, a result, a reviewer and a sanitised
 * sentence about how the check was made — no description, no comment body, no client contact detail.
 * The page's own `TICKET_VIEWED` row already records that this person opened this ticket; a second
 * row here would double-count one navigation, the same argument the attachments and links panels make.
 */
export type IdentityVerificationPanelProps = { ticket: TicketDetailDTO; viewer: Viewer };

export async function IdentityVerificationPanel({
  ticket,
  viewer,
}: IdentityVerificationPanelProps): Promise<React.JSX.Element> {
  const [state, records] = await Promise.all([
    identityGateState({ ticketId: ticket.id, category: ticket.category }),
    listIdentityVerifications(ticket.id),
  ]);

  const required = isIdentityGateRequired(ticket.category);
  const canRecord = canVerifyIdentity(viewer.groups, ticket.queueKey) && ticket.permissions.canWrite;
  const isOps = viewer.groups.includes("ops_team");
  const canOverride = required && !state.satisfied && canRecord && isOps;

  return (
    <section
      aria-labelledby="identity-verification-heading"
      className="flex flex-col gap-3 rounded-lg border p-3 md:p-4"
      data-slot="identity-verification"
    >
      <header className="flex flex-wrap items-center gap-2">
        <BadgeCheck aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h2 id="identity-verification-heading" className="text-sm font-semibold">
          Identity verification
        </h2>
        <GateBadge required={required} satisfied={state.satisfied} />
      </header>

      <p className="text-xs text-muted-foreground">
        {required ? (
          <>
            <strong>{CATEGORY_LABELS[ticket.category]}</strong> tickets cannot be resolved without a
            verification on file, or an <code className="text-[0.95em]">ops_team</code> override with a
            recorded reason.
          </>
        ) : (
          <>
            Not required for <strong>{CATEGORY_LABELS[ticket.category]}</strong> tickets — record one
            anyway if you established who you were speaking to.
          </>
        )}
      </p>

      {records.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
          Nothing recorded on this ticket.
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {records.map((r) => (
            <li key={r.id} className="rounded-md border px-3 py-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Badge variant="outline" className={cn("gap-1", resultClasses(r.result))}>
                  {IDENTITY_VERIFICATION_RESULT_LABELS[r.result]}
                </Badge>
                <span className="text-xs font-medium">{IDENTITY_VERIFICATION_METHOD_LABELS[r.method]}</span>
                <span className="text-xs text-muted-foreground">
                  {r.verifiedBy.name ?? r.verifiedBy.email} · {formatDateTime(r.createdAt)}
                </span>
              </div>
              <p className="mt-1 text-sm leading-relaxed break-words">{r.note}</p>
            </li>
          ))}
        </ol>
      )}

      {/* The controls are the only client code in this panel; everything above is server-rendered. */}
      <IdentityVerificationControls
        ticketId={ticket.id}
        canRecord={canRecord}
        canOverride={canOverride}
        gateRequired={required}
        gateSatisfied={state.satisfied}
      />
    </section>
  );
}

function resultClasses(result: "VERIFIED" | "FAILED" | "OVERRIDDEN"): string {
  if (result === "VERIFIED") return "border-emerald-500/60 text-emerald-800 dark:text-emerald-300";
  if (result === "FAILED") return "border-destructive/60 text-destructive";
  return "border-amber-500/70 text-amber-900 dark:text-amber-200";
}

function GateBadge({ required, satisfied }: { required: boolean; satisfied: boolean }): React.JSX.Element | null {
  if (!required) {
    return (
      <Badge variant="outline" className="ml-auto gap-1 text-muted-foreground">
        <ShieldQuestion aria-hidden />
        <span>Not required</span>
      </Badge>
    );
  }
  return satisfied ? (
    <Badge variant="outline" className="ml-auto gap-1 border-emerald-500/60 text-emerald-800 dark:text-emerald-300">
      <ShieldCheck aria-hidden />
      <span>May be resolved</span>
    </Badge>
  ) : (
    <Badge variant="outline" className="ml-auto gap-1 border-amber-500/70 text-amber-900 dark:text-amber-200">
      <ShieldAlert aria-hidden />
      <span>Blocks resolve</span>
    </Badge>
  );
}
