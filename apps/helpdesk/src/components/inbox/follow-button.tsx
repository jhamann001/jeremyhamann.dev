"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bell, BellRing } from "lucide-react";
import { followTicket } from "@/server/notifications.actions";
import { Button } from "@/components/ui/button";

export type FollowButtonProps = {
  ticketId: string;
  ticketNumber: number;
  following: boolean;
};

/**
 * The client half of `TicketFollowers` (an async server component cannot hold the optimistic state
 * a toggle needs).
 *
 * Following is a READ-scoped act (see `followTicket`): anyone who can open the ticket may watch it,
 * and watching grants nothing. The control therefore never renders disabled with a reason — a
 * viewer who could not follow could not be looking at this panel.
 *
 * The label says what you ARE, not what the tap will do ("Following" / "Follow"), with the action in
 * the accessible name. A button whose visible label is the verb flips under the finger at the exact
 * moment the state changes, which on a phone reads as a mis-tap.
 */
export function FollowButton({ ticketId, ticketNumber, following }: FollowButtonProps): React.JSX.Element {
  const router = useRouter();
  const [optimistic, setOptimistic] = useState(following);
  const [pending, startTransition] = useTransition();

  // The server is the truth: a refresh that disagrees with the local guess wins.
  if (!pending && optimistic !== following) setOptimistic(following);

  function toggle(): void {
    const next = !optimistic;
    setOptimistic(next);
    startTransition(async () => {
      const result = await followTicket({ ticketId, follow: next });
      if (result.ok) {
        toast.success(next ? `Following HD-${ticketNumber}` : `No longer following HD-${ticketNumber}`);
        router.refresh();
        return;
      }
      setOptimistic(!next);
      switch (result.code) {
        case "FORBIDDEN":
          toast.error("You do not have access to this ticket's queue.");
          return;
        case "NOT_FOUND":
          toast.error("That ticket no longer exists — refreshing.");
          router.refresh();
          return;
        case "UNAUTHORIZED":
          toast.error("Your session has ended. Sign in again.");
          router.refresh();
          return;
        default:
          toast.error("The change was not saved.");
      }
    });
  }

  return (
    <Button
      type="button"
      variant={optimistic ? "secondary" : "outline"}
      size="sm"
      className="w-full min-w-11 justify-start md:w-auto"
      disabled={pending}
      aria-pressed={optimistic}
      aria-label={optimistic ? `Stop following ticket HD-${ticketNumber}` : `Follow ticket HD-${ticketNumber}`}
      onClick={toggle}
    >
      {optimistic ? <BellRing aria-hidden /> : <Bell aria-hidden />}
      {optimistic ? "Following" : "Follow"}
    </Button>
  );
}
