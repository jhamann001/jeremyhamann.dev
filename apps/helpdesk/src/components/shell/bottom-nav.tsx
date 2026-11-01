"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, CircleUser, Inbox, LayoutDashboard, Plus, ScrollText } from "lucide-react";
import type { Viewer } from "@/types/domain";
import { cn } from "@/lib/utils";
import { QueueBadge } from "@/components/tickets/queue-badge";
import { AccountSheet } from "@/components/shell/account-sheet";
import {
  bottomTabsFor,
  hidesBottomNav,
  isActivePath,
  navItemsFor,
  type NavItems,
} from "@/components/shell/nav-items";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/shell/responsive-sheet";

const TAB_CLASSES =
  "flex h-full min-w-11 flex-col items-center justify-center gap-0.5 rounded-md text-[11px] font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 aria-[current=page]:text-foreground aria-expanded:text-foreground [&_svg]:size-5";

type SheetKind = "queues" | "account";

/** Which sheet is open and the pathname it was opened on: a navigation closes it without an effect. */
type OpenSheet = { kind: SheetKind; at: string };

/**
 * Phone primary navigation: fixed bottom tab bar, `md:hidden`. Tabs come
 * from the same pure `navItemsFor` the sidebar uses, so the two navigations can never disagree.
 * Returns null on /tickets/** — the StickyActionBar owns the bottom edge there.
 */
export function BottomNav({
  viewer,
  heldIntakeCount,
  inboxUnread,
  pushEnabled,
  vapidPublicKey,
}: {
  viewer: Viewer;
  /** Passed straight through to the Account sheet, which is where the Admin entries live on a phone. */
  heldIntakeCount?: number;
  /** Wave B. Unread inbox rows, from the `(app)` layout. Absent at zero and on a failed read. */
  inboxUnread?: number;
  /** Passed straight through to the Account sheet, which now owns the web-push opt-in. */
  pushEnabled?: boolean;
  vapidPublicKey?: string | null;
}): React.JSX.Element | null {
  const pathname = usePathname();
  const [sheet, setSheet] = useState<OpenSheet | null>(null);

  if (hidesBottomNav(pathname)) return null;

  const items = navItemsFor(viewer, { heldIntake: heldIntakeCount, inboxUnread });
  const tabs = bottomTabsFor(items);
  const openKind: SheetKind | null = sheet !== null && sheet.at === pathname ? sheet.kind : null;
  const openSheet = (kind: SheetKind) => setSheet({ kind, at: pathname });
  const closeSheet = () => setSheet(null);
  const queuesActive = isActivePath(pathname, "/queues");

  return (
    <>
      <nav
        aria-label="Primary (phone)"
        data-bottom-nav
        className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 pb-safe pl-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)] supports-backdrop-filter:backdrop-blur md:hidden"
      >
        <ul className="grid h-(--wm-bottom-bar-h) auto-cols-fr grid-flow-col">
          {tabs.map((tab) => {
            switch (tab) {
              case "dashboard":
                return (
                  <li key={tab} className="min-w-0">
                    <Link
                      href="/dashboard"
                      prefetch={false}
                      aria-current={isActivePath(pathname, "/dashboard", true) ? "page" : undefined}
                      className={TAB_CLASSES}
                    >
                      <LayoutDashboard aria-hidden />
                      <span>Dashboard</span>
                    </Link>
                  </li>
                );
              case "queues":
                return (
                  <li key={tab} className="min-w-0">
                    {items.queues.length === 1 ? (
                      <Link
                        href={items.queues[0]!.href}
                        prefetch={false}
                        aria-current={queuesActive ? "page" : undefined}
                        className={TAB_CLASSES}
                      >
                        <Inbox aria-hidden />
                        <span>Queues</span>
                      </Link>
                    ) : (
                      <button
                        type="button"
                        aria-haspopup="dialog"
                        aria-expanded={openKind === "queues"}
                        aria-current={queuesActive ? "page" : undefined}
                        onClick={() => openSheet("queues")}
                        className={cn(TAB_CLASSES, "w-full")}
                      >
                        <Inbox aria-hidden />
                        <span>Queues</span>
                      </button>
                    )}
                  </li>
                );
              case "new":
                return (
                  <li key={tab} className="min-w-0">
                    <Link href="/tickets/new" prefetch={false} className={TAB_CLASSES}>
                      <span className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
                        <Plus aria-hidden />
                      </span>
                      <span>New</span>
                    </Link>
                  </li>
                );
              case "audit":
                return (
                  <li key={tab} className="min-w-0">
                    <Link
                      href="/compliance/audit"
                      prefetch={false}
                      aria-current={isActivePath(pathname, "/compliance/audit") ? "page" : undefined}
                      className={TAB_CLASSES}
                    >
                      <ScrollText aria-hidden />
                      <span>Audit</span>
                    </Link>
                  </li>
                );
              case "account":
                return (
                  <li key={tab} className="min-w-0">
                    <button
                      type="button"
                      aria-haspopup="dialog"
                      aria-expanded={openKind === "account"}
                      onClick={() => openSheet("account")}
                      className={cn(TAB_CLASSES, "w-full")}
                    >
                      <CircleUser aria-hidden />
                      <span>Account</span>
                    </button>
                  </li>
                );
            }
          })}
        </ul>
      </nav>

      {items.queues.length > 1 ? (
        <QueuesSheet
          items={items}
          pathname={pathname}
          open={openKind === "queues"}
          onOpenChange={(o) => (o ? openSheet("queues") : closeSheet())}
        />
      ) : null}
      <AccountSheet
        viewer={viewer}
        heldIntakeCount={heldIntakeCount}
        pushEnabled={pushEnabled}
        vapidPublicKey={vapidPublicKey}
        open={openKind === "account"}
        onOpenChange={(o) => (o ? openSheet("account") : closeSheet())}
      />
    </>
  );
}

/** One ≥ 48px link per readable queue; `aria-current="page"` on the current one; closes on navigation. */
function QueuesSheet({
  items,
  pathname,
  open,
  onOpenChange,
}: {
  items: NavItems;
  pathname: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  return (
    <ResponsiveSheet open={open} onOpenChange={onOpenChange} title="Queues" height="auto">
      <ResponsiveSheetBody className="px-0 pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]">
        <ul className="flex flex-col">
          {items.queues.map((q) => {
            const active = isActivePath(pathname, q.href);
            return (
              <li key={q.key}>
                <Link
                  href={q.href}
                  prefetch={false}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-12 items-center gap-3 px-4 text-base outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 active:bg-muted/60",
                    // QueueBadge carries the label (dot + name); scale it to a row-sized chip here.
                    "[&_[data-slot=badge]]:h-7 [&_[data-slot=badge]]:px-3 [&_[data-slot=badge]]:text-sm",
                    active && "bg-muted/50 [&_[data-slot=badge]]:font-medium",
                  )}
                >
                  <QueueBadge queueKey={q.key} />
                  <ChevronRight aria-hidden className="ml-auto size-4 text-muted-foreground" />
                </Link>
              </li>
            );
          })}
        </ul>
      </ResponsiveSheetBody>
    </ResponsiveSheet>
  );
}
