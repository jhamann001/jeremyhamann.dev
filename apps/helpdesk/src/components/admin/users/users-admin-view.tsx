"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import type { OktaGroup } from "@/types/domain";
import type { StaffUserRow } from "@/server/users";
import { GROUP_LABELS } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UserAvatar } from "@/components/tickets/user-avatar";
import { UserActiveDialog } from "@/components/admin/users/user-active-dialog";
import { cn } from "@/lib/utils";

/** The three states of the active filter, in the order the chips render. */
const ACTIVE_FILTERS = [
  { key: "all", label: "All", value: undefined },
  { key: "active", label: "Active", value: true },
  { key: "inactive", label: "Deactivated", value: false },
] as const;

const SEARCH_DEBOUNCE_MS = 300;

export type UsersAdminViewProps = {
  /** The signed-in operator, so their own row can say why it cannot be deactivated. */
  viewerId: string;
  users: StaffUserRow[];
  search: string;
  isActive: boolean | undefined;
};

function hrefFor(pathname: string, search: string, isActive: boolean | undefined): string {
  const params = new URLSearchParams();
  const trimmed = search.trim();
  if (trimmed.length > 0) params.set("search", trimmed);
  if (isActive !== undefined) params.set("active", String(isActive));
  const qs = params.toString();
  return qs.length > 0 ? `${pathname}?${qs}` : pathname;
}

/**
 * `/admin/users` (docs/MOBILE_FIRST.md R1–R12).
 *
 * Mobile-first with one layout flip at `md`: below it each account is a stacked card with a
 * full-width action; from `md` the same card lays out in a row. Same data, same component, same URL
 * in both — there is no phone-only list and no desktop-only table to keep in step.
 *
 * Filters are URL state written by this component and read by the page's server render, so the
 * back button works and "show me everyone who is deactivated" is a link somebody can paste into a
 * ticket. The search box is debounced and uses `router.replace`, so typing does not fill the history.
 */
export function UsersAdminView({ viewerId, users, search, isActive }: UsersAdminViewProps): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const [draft, setDraft] = useState(search);
  const [pending, startTransition] = useTransition();
  const committed = useRef(search);

  // Keep the box in step when the URL changes underneath it (back button, a chip, a refresh).
  useEffect(() => {
    committed.current = search;
    setDraft(search);
  }, [search]);

  useEffect(() => {
    if (draft === committed.current) return;
    const t = setTimeout(() => {
      committed.current = draft;
      startTransition(() => router.replace(hrefFor(pathname, draft, isActive), { scroll: false }));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [draft, isActive, pathname, router]);

  function setFilter(next: boolean | undefined): void {
    startTransition(() => router.replace(hrefFor(pathname, draft, next), { scroll: false }));
  }

  const activeCount = users.filter((u) => u.isActive).length;

  return (
    <section className="flex flex-col gap-4" data-slice="S8-users-admin">
      <header className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">Staff accounts</h2>
        <p className="text-sm text-muted-foreground">
          Deactivating an account ends its sessions, refuses its next Okta sign-in and returns its open tickets
          to the queue. Group membership itself is changed in Okta, not here.
        </p>
      </header>

      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search name or email"
            aria-label="Search staff accounts"
            maxLength={200}
            // `pr-12` clears the clear-search button: globals.css gives an icon Button a 44 px minimum
            // on phones, so it owns the rightmost 48 px of the field and typed text ran underneath it.
            className="pl-9 pr-12"
          />
          {draft.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Clear search"
              className="absolute top-1/2 right-1 -translate-y-1/2"
              onClick={() => setDraft("")}
            >
              <X aria-hidden />
            </Button>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by account status">
          {ACTIVE_FILTERS.map((f) => {
            const selected = f.value === isActive;
            return (
              <Button
                key={f.key}
                type="button"
                variant={selected ? "secondary" : "outline"}
                size="sm"
                // R3 / G2: the global phone rule sets a 44 px minimum HEIGHT but no minimum width, so
                // a short label ("All") measured 38 px. The fix is the size, never an opt-out.
                className="min-w-11"
                aria-pressed={selected}
                onClick={() => setFilter(f.value)}
              >
                {f.label}
              </Button>
            );
          })}
        </div>
      </div>

      <p className="text-xs text-muted-foreground" aria-live="polite" aria-busy={pending || undefined}>
        {users.length === 0
          ? "No accounts match."
          : `${users.length} ${users.length === 1 ? "account" : "accounts"}, ${activeCount} active.`}
      </p>

      {users.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          Nobody matches that search. Accounts appear here after their first sign-in — the desk does not create
          them, Okta does.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {users.map((u) => (
            <UserRowCard key={u.id} user={u} isSelf={u.id === viewerId} />
          ))}
        </ul>
      )}
    </section>
  );
}

function UserRowCard({ user, isSelf }: { user: StaffUserRow; isSelf: boolean }): React.JSX.Element {
  const displayName = user.name?.trim() || user.email;
  return (
    <li
      data-user-id={user.id}
      data-active={user.isActive ? "true" : "false"}
      className={cn(
        "flex flex-col gap-3 rounded-xl bg-card p-3 text-card-foreground ring-1 ring-foreground/10",
        "md:flex-row md:items-center md:justify-between md:gap-4",
        !user.isActive && "bg-muted/40",
      )}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <UserAvatar user={user} size="md" />
          {isSelf ? (
            <Badge variant="outline" className="shrink-0 font-normal">
              You
            </Badge>
          ) : null}
        </div>
        <p className="truncate text-xs text-muted-foreground" title={user.email}>
          {user.email}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          {user.isActive ? (
            <Badge variant="secondary" className="font-normal">
              Active
            </Badge>
          ) : (
            <Badge variant="destructive" className="font-normal">
              Deactivated
            </Badge>
          )}
          {user.groups.length === 0 ? (
            <Badge variant="outline" className="border-dashed font-normal text-muted-foreground">
              No groups
            </Badge>
          ) : (
            user.groups.map((g: OktaGroup) => (
              <Badge key={g} variant="outline" data-group={g} className="font-normal">
                {GROUP_LABELS[g]}
              </Badge>
            ))
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {user.openAssignments === 0
            ? "No open tickets assigned"
            : `${user.openAssignments} open ${user.openAssignments === 1 ? "ticket" : "tickets"} assigned`}
        </p>
      </div>

      <div className="md:shrink-0">
        <UserActiveDialog
          userId={user.id}
          displayName={displayName}
          isActive={user.isActive}
          openAssignments={user.openAssignments}
          isSelf={isSelf}
        />
      </div>
    </li>
  );
}
