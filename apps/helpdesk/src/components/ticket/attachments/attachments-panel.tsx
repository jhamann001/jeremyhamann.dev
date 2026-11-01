import { Download, Inbox, Paperclip } from "lucide-react";
import type { TicketDetailDTO, Viewer } from "@/types/domain";
import { formatDateTime, formatRelative } from "@/lib/format";
import { DEMO_UPLOADS_OFF, demoMode } from "@/lib/demo/mode";
import { canReadAttachment, canWriteAttachment } from "@/lib/rbac";
import { listTicketAttachments } from "@/server/attachments.actions";
import { Badge } from "@/components/ui/badge";
import { AttachmentRemoveButton } from "@/components/ticket/attachments/attachment-remove-button";
import { AttachmentUpload } from "@/components/ticket/attachments/attachment-upload";
import {
  ATTACHMENT_MAX_LABEL,
  EMAIL_PART_ORIGIN_BADGE,
  attachmentOriginLabel,
  formatBytes,
  isInboundAttachment,
  mimeIcon,
  mimeLabel,
} from "@/components/ticket/attachments/attachment-meta";

/**
 * Attachments on a ticket (docs/MOBILE_FIRST.md R1–R11).
 *
 * An async server component that owns its own load, mounted below the timeline on every width. The
 * props are the contract and have not changed from the foundation's stub.
 *
 * INTERNAL-only in v1. Nothing here is reachable from the client view or the export routes, and the
 * panel says so in one line rather than leaving a rep to assume otherwise — the assumption a client
 * can see what is attached is exactly the kind that ends in a disclosure.
 *
 * Loading goes through `listTicketAttachments` (a `.actions` module) rather than importing
 * `listAttachments` directly, because guardrail G1 treats everything under `src/components/**` as a
 * client surface and forbids it from importing a non-action server module. Same query, same RBAC,
 * same absence of an audit row — listing metadata is not a read of client material (CONTRACT §3
 * rule 3); the DOWNLOAD is, and the route audits it before it mints anything.
 *
 * `canUpload` derives from the same rule `createUploadIntent` enforces — WRITE on the ticket's queue,
 * and not CLOSED — so the visible control and the server check cannot disagree. `compliance_officers`
 * therefore sees the list and can download (read-plus-annotate) but is never offered the control.
 *
 * **Direction is rendered, not assumed.** `src/server/email-intake.ts` stores an inbound email part with
 * `uploaderId: null` and `kind: "EMAIL_PART"`, so an uploader-only line attributed a form the CLIENT
 * emailed in to the firm, and the panel's blanket "never sent to the client" was untrue of a file the
 * client had itself sent. `attachmentOriginLabel` branches on the kind, an inbound file carries a badge
 * beside its filename (the meta line truncates on a phone), and the standing sentence now says what is
 * actually promised — nothing LEAVES the desk — with the inbound case spelled out when one is present.
 */
export type AttachmentsPanelProps = {
  ticket: TicketDetailDTO;
  viewer: Viewer;
};

export async function AttachmentsPanel({ ticket, viewer }: AttachmentsPanelProps): Promise<React.JSX.Element> {
  const canRead = canReadAttachment(viewer.groups, ticket.queueKey);
  const canWrite = canWriteAttachment(viewer.groups, ticket.queueKey) && ticket.status !== "CLOSED";
  // Demo mode serves only the seeded files: removing stays (the reset restores them), adding does not.
  const uploadsOff = demoMode();
  const canUpload = canWrite && !uploadsOff;

  const result = canRead ? await listTicketAttachments({ ticketId: ticket.id }) : null;
  const attachments = result?.ok ? result.data : [];
  const failed = result !== null && !result.ok;
  const hasInbound = attachments.some((a) => isInboundAttachment(a.kind));

  return (
    <section
      aria-labelledby="attachments-heading"
      data-slice="S4-attachments"
      data-can-upload={canUpload}
      className="rounded-lg border bg-card p-4 text-card-foreground"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Paperclip aria-hidden className="size-4 text-muted-foreground" />
        <h2 id="attachments-heading" className="text-sm font-semibold">
          Attachments
        </h2>
        <Badge variant="secondary" className="tabular-nums">
          {attachments.length}
          <span className="sr-only"> attached</span>
        </Badge>
        <Badge variant="outline" className="uppercase">
          Internal only
        </Badge>
      </div>

      <p className="mt-1 text-xs text-muted-foreground">
        Nothing on this list leaves the desk: the desk never sends these files to the client and none of them
        appear in the client portal. Every download is logged.
      </p>

      {hasInbound ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Files marked &ldquo;{EMAIL_PART_ORIGIN_BADGE}&rdquo; arrived on a client&rsquo;s email reply — the client
          already has those.
        </p>
      ) : null}

      {failed ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          Attachments could not be loaded. Refresh the page — nothing has changed on the ticket.
        </p>
      ) : null}

      {attachments.length === 0 && !failed ? (
        <p className="mt-3 text-sm text-muted-foreground">
          {canUpload
            ? `Nothing attached yet. PDF, images, CSV, text, Excel or Word, up to ${ATTACHMENT_MAX_LABEL}.`
            : "Nothing attached yet."}
        </p>
      ) : null}

      {attachments.length > 0 ? (
        <ul className="mt-3 divide-y rounded-md border">
          {attachments.map((a) => {
            const Icon = mimeIcon(a.mime);
            return (
              <li key={a.id} className="flex items-center gap-3 p-2 sm:p-3">
                <Icon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-medium">
                    <span className="min-w-0 truncate" title={a.filename}>
                      {a.filename}
                    </span>
                    {isInboundAttachment(a.kind) ? (
                      <Badge variant="outline" className="shrink-0 gap-1 font-normal" data-attachment-kind={a.kind}>
                        <Inbox aria-hidden />
                        {EMAIL_PART_ORIGIN_BADGE}
                      </Badge>
                    ) : null}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    <span className="tabular-nums">{formatBytes(a.size)}</span>
                    {" · "}
                    {mimeLabel(a.mime)}
                    {" · "}
                    {attachmentOriginLabel(a.kind, a.uploader)}
                    {" · "}
                    <time dateTime={a.createdAt} title={formatDateTime(a.createdAt)}>
                      {formatRelative(a.createdAt)}
                    </time>
                  </p>
                </div>
                <a
                  href={`/api/attachments/${a.id}/download`}
                  className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none md:min-h-9"
                  rel="noopener"
                >
                  <Download aria-hidden className="size-4" />
                  <span className="sr-only sm:not-sr-only">Download</span>
                  <span className="sr-only"> {a.filename}</span>
                </a>
                {canWrite ? <AttachmentRemoveButton attachmentId={a.id} filename={a.filename} /> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {canUpload ? <AttachmentUpload ticketId={ticket.id} className="mt-3" /> : null}
      {canWrite && uploadsOff ? <p className="mt-3 text-xs text-muted-foreground">{DEMO_UPLOADS_OFF}</p> : null}

      {!canUpload && ticket.status === "CLOSED" && attachments.length > 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          This ticket is closed — attachments can be downloaded but not added or removed.
        </p>
      ) : null}
    </section>
  );
}
