"use client";

import { useState } from "react";
import { Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/shell/responsive-sheet";

/**
 * Phone affordance for `TicketFollowers` (slice **B1**), the sibling of
 * `RequesterHistorySheet` and written to the same rules.
 *
 * `TicketFollowers` is an async SERVER component — it owns its own data load — so it cannot hold the
 * open state a bottom sheet needs. This is the thin client half: it receives the already-rendered
 * rows as `children` and does nothing but open and close around them. No data, no fetching, no second
 * copy of the list markup, and the rows are still rendered on the server.
 *
 * It deliberately does NOT contain the follow toggle. The toggle sits above this trigger at the top
 * level of the phone block, because following is a one-tap act and the reason this component exists
 * is that it had no tap at all below `md`.
 */
export function FollowersSheet({
  count,
  label,
  children,
}: {
  /** Shown on the trigger so the operator knows whether it is worth a tap. */
  count: number;
  /**
   * The panel's name, passed in rather than written here, so the trigger, the md+ `<h2>` and the
   * sheet title cannot drift apart.
   */
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="w-full justify-start"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Users aria-hidden />
        {label}
        <Badge variant="secondary" className="ml-auto tabular-nums">
          {count}
        </Badge>
      </Button>

      <ResponsiveSheet open={open} onOpenChange={setOpen} title={label} height="auto">
        <ResponsiveSheetBody className="pb-[max(1rem,env(safe-area-inset-bottom,0px))]">
          {children}
        </ResponsiveSheetBody>
      </ResponsiveSheet>
    </>
  );
}
