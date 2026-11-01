"use client";

import { useState } from "react";
import { History } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/shell/responsive-sheet";

/**
 * Phone affordance for `RequesterHistory` (the build record mount points).
 *
 * `RequesterHistory` is an async SERVER component — it owns its own data load — so it cannot hold the
 * open state a bottom sheet needs. This is the thin client half: it receives the already-rendered rows
 * as `children` and does nothing but open and close around them. No data, no fetching, no duplication
 * of the list markup, and the rows are still rendered on the server.
 */
export function RequesterHistorySheet({
  count,
  label,
  children,
}: {
  /** Shown on the trigger so the operator knows whether it is worth a tap. */
  count: number;
  /**
   * The panel's name, passed in rather than written here, so the trigger, the md+ `<h2>` and the phone
   * empty state cannot drift apart.
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
        <History aria-hidden />
        {label}
        <Badge variant="secondary" className="ml-auto tabular-nums">
          {count}
        </Badge>
      </Button>

      <ResponsiveSheet open={open} onOpenChange={setOpen} title="Requester history" height="full">
        <ResponsiveSheetBody className="pb-[max(1rem,env(safe-area-inset-bottom,0px))]">{children}</ResponsiveSheetBody>
      </ResponsiveSheet>
    </>
  );
}
