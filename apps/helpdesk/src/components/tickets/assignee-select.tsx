"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AssigneeOption, UserRef } from "@/types/domain";
import { assignTicket } from "@/server/tickets.actions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserAvatar } from "@/components/tickets/user-avatar";

/** Radix Select forbids an empty-string item value, so "Unassigned" travels under a sentinel. */
const UNASSIGNED = "__unassigned__";

/**
 * Shared inline assignee control (S5 rows/preview, S6 properties panel). Calls `assignTicket`
 * with the caller's `version` (optimistic concurrency); a CONFLICT refreshes the page.
 */
export function AssigneeSelect({
  ticketId,
  version,
  value,
  options,
  disabled,
}: {
  ticketId: string;
  version: number;
  value: UserRef | null;
  options: AssigneeOption[];
  disabled: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();

  // Keep a departed/ineligible current assignee visible (read-only) so the control never shows a
  // blank for a ticket that is in fact assigned.
  const currentInOptions = value ? options.some((o) => o.id === value.id) : true;
  const selectValue = value ? value.id : UNASSIGNED;

  function onChange(next: string) {
    const assigneeId = next === UNASSIGNED ? null : next;
    if (assigneeId === (value?.id ?? null)) return;
    startTransition(async () => {
      const result = await assignTicket({ ticketId, version, assigneeId });
      if (result.ok) {
        const who = result.data.assignee;
        toast.success(who ? `Assigned to ${who.name?.trim() || who.email}` : "Assignee cleared");
        router.refresh();
        void queryClient.invalidateQueries({ queryKey: ["queue-summary"] });
        return;
      }
      switch (result.code) {
        case "CONFLICT":
          toast.warning("Ticket changed elsewhere — refreshing");
          router.refresh();
          return;
        case "FORBIDDEN":
        case "VALIDATION":
          toast.error(result.message);
          return;
        case "UNAUTHORIZED":
          toast.error("Your session has ended. Sign in again.");
          router.refresh();
          return;
        case "NOT_FOUND":
          toast.error("Ticket not found");
          router.refresh();
          return;
        case "INTERNAL":
          toast.error("Assignment failed. Nothing was changed.");
          return;
      }
    });
  }

  return (
    <Select value={selectValue} onValueChange={onChange} disabled={disabled || pending}>
      <SelectTrigger
        size="sm"
        className="w-full min-w-40 md:max-w-64"
        aria-label="Assignee"
        aria-busy={pending || undefined}
        data-ticket-id={ticketId}
      >
        <SelectValue placeholder="Unassigned" />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        <SelectItem value={UNASSIGNED}>
          <UserAvatar user={null} size="sm" />
        </SelectItem>
        {options.length > 0 ? <SelectSeparator /> : null}
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            <UserAvatar user={o} size="sm" />
          </SelectItem>
        ))}
        {value && !currentInOptions ? (
          <>
            <SelectSeparator />
            <SelectItem value={value.id} disabled>
              <UserAvatar user={value} size="sm" />
            </SelectItem>
          </>
        ) : null}
      </SelectContent>
    </Select>
  );
}
