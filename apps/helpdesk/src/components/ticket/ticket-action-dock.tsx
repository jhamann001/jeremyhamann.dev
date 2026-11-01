"use client";

import { useState } from "react";
import { ChevronLeft, Lock, Send, SlidersHorizontal, Zap } from "lucide-react";
import { QUEUE_LABELS, type AssigneeOption, type TicketDetailDTO, type Viewer } from "@/types/domain";
import { queueSlug } from "@/lib/rbac";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/shell/responsive-sheet";
import { StickyActionBar, StickyActionItem } from "@/components/shell/sticky-action-bar";
import {
  Composer,
  internalNoteDisabledReason,
  publicReplyDisabledReason,
  type ComposerMacro,
} from "@/components/ticket/composer";
import { RecordContactSheet } from "@/components/ticket/record-contact-sheet";
import {
  PropertiesPanel,
  TicketMoveQueueControl,
  TicketQuickActions,
} from "@/components/ticket/properties-panel";

/**
 * Phone dock for the ticket detail (docs/MOBILE_FIRST.md §2 route rule). Owns the bottom edge on
 * `/tickets/[id]` (BottomNav is null there): ← Queue · Details · Actions · Note · Reply. Each sheet is a
 * 90 svh bottom sheet; on md+ the bar is hidden and the inline panel / composer take over.
 *
 * Behaviour invariants: the sheets only host the same components the desktop layout renders — the
 * `PropertiesPanel`, the `Composer`, and the panel's own `TicketQuickActions` and
 * `TicketMoveQueueControl`. Every mutation still ends in that component's single `router.refresh()`, and
 * the dock's `open` state survives the RSC re-render because this is a client component.
 *
 * R10 and a disabled item: the reason is NOT painted on the bar — that would make the fixed bar taller
 * than the single `--wm-bottom-bar-h` `<main>` reserves and cover content (probe G10), and §7 pins
 * `[data-sticky-action-bar] > *` at five. It rides as an `sr-only` node the item points at with
 * `aria-describedby`, and it is VISIBLE one tap away: `anyComment` guarantees at least one of Note /
 * Reply is enabled, and the composer sheet either one opens prints the other channel's reason as a `<p>`
 * under its `TabsList` (§2 of ticket-components-fixes-round2.md). A `title` alone never
 * satisfied R10 — tooltips do not fire on touch.
 *
 * Why "Actions" is a sheet and not three more bar items: five is the bar's ceiling at 360 px and it is
 * already at five. The sheet holds "Assign to me", "Record client contact" and "Move to queue" —
 * the last of which Decision #67 has just opened to Client Service, so it needs to be reachable from a
 * phone and not only from the Details panel's Queue field.
 */
type DockSheet = null | "details" | "actions" | "note" | "reply";

export function TicketActionDock({
  ticket,
  macros,
  viewer,
  assignees,
}: {
  ticket: TicketDetailDTO;
  /**
   * `ComposerMacro`, not `MacroDTO`: the dock's Reply sheet mounts the same `Composer`, and the
   * macro-effects disclosure it renders needs `actions` to survive this hop. The
   * field is optional, so a caller still passing a bare `MacroDTO[]` compiles and simply shows no
   * disclosure.
   */
  macros: ComposerMacro[];
  viewer: Viewer;
  assignees: AssigneeOption[];
}): React.JSX.Element {
  const [open, setOpen] = useState<DockSheet>(null);
  // Hoisted out of TicketQuickActions so it opens at the top level, never inside the Actions sheet.
  const [contactOpen, setContactOpen] = useState(false);
  const { permissions } = ticket;
  const closed = ticket.status === "CLOSED";
  const anyComment = permissions.canInternalNote || permissions.canPublicReply;
  const composerOpen = open === "note" || open === "reply";
  const canAct = (permissions.canWrite && !closed) || permissions.canMove;

  function closeIf(o: boolean): void {
    if (!o) setOpen(null);
  }

  return (
    <>
      <StickyActionBar label="Ticket actions">
        <StickyActionItem
          href={`/queues/${queueSlug(ticket.queueKey)}`}
          icon={ChevronLeft}
          label={QUEUE_LABELS[ticket.queueKey]}
        />
        <StickyActionItem
          onClick={() => setOpen("details")}
          icon={SlidersHorizontal}
          label="Details"
          active={open === "details"}
          aria-haspopup="dialog"
          aria-expanded={open === "details"}
        />
        {canAct ? (
          <StickyActionItem
            onClick={() => setOpen("actions")}
            icon={Zap}
            label="Actions"
            active={open === "actions"}
            aria-haspopup="dialog"
            aria-expanded={open === "actions"}
          />
        ) : null}
        {anyComment ? (
          <>
            <StickyActionItem
              onClick={() => setOpen("note")}
              icon={Lock}
              label="Note"
              active={open === "note"}
              disabled={!permissions.canInternalNote}
              disabledReason={internalNoteDisabledReason()}
              aria-haspopup="dialog"
              aria-expanded={open === "note"}
            />
            <StickyActionItem
              onClick={() => setOpen("reply")}
              icon={Send}
              label="Reply"
              active={open === "reply"}
              disabled={!permissions.canPublicReply}
              disabledReason={publicReplyDisabledReason(closed)}
              aria-haspopup="dialog"
              aria-expanded={open === "reply"}
            />
          </>
        ) : null}
      </StickyActionBar>

      {/* ---------------------------------------------------------------- Details sheet */}
      <ResponsiveSheet open={open === "details"} onOpenChange={closeIf} title="Details" height="full">
        <ResponsiveSheetBody className="pb-[max(1rem,env(safe-area-inset-bottom,0px))]">
          <PropertiesPanel ticket={ticket} assignees={assignees} viewerId={viewer.id} variant="plain" />
        </ResponsiveSheetBody>
      </ResponsiveSheet>

      {/* ---------------------------------------------------------------- Actions sheet */}
      <ResponsiveSheet
        open={open === "actions"}
        onOpenChange={closeIf}
        title="Actions"
        description="The same actions the desktop properties panel offers."
        height="auto"
      >
        <ResponsiveSheetBody className="flex flex-col gap-4 pb-[max(1rem,env(safe-area-inset-bottom,0px))]">
          <TicketQuickActions
            ticket={ticket}
            viewerId={viewer.id}
            layout="stacked"
            onRecordContact={() => {
              setOpen(null);
              setContactOpen(true);
            }}
            onDone={() => setOpen(null)}
          />
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Move to queue</span>
            <TicketMoveQueueControl ticket={ticket} />
            {!permissions.canMove ? (
              <p className="text-xs text-muted-foreground">
                {closed
                  ? "Closed tickets cannot be moved."
                  : "Your groups cannot hand this ticket to another queue."}
              </p>
            ) : null}
          </div>
        </ResponsiveSheetBody>
      </ResponsiveSheet>

      <RecordContactSheet ticket={ticket} open={contactOpen} onOpenChange={setContactOpen} />

      {/* ---------------------------------------------------------------- Composer sheet */}
      <ResponsiveSheet
        open={composerOpen}
        onOpenChange={closeIf}
        title={open === "reply" ? "Reply to client" : "Internal note"}
        height="full"
      >
        <ResponsiveSheetBody className="pb-0">
          {composerOpen ? (
            <Composer
              key={open}
              ticket={ticket}
              macros={macros}
              viewer={viewer}
              layout="sheet"
              initialChannel={open === "reply" ? "public" : "internal"}
              onSubmitted={() => setOpen(null)}
            />
          ) : null}
        </ResponsiveSheetBody>
      </ResponsiveSheet>
    </>
  );
}
