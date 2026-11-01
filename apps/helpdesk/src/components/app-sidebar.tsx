"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Bell, ClipboardCheck, Inbox, LayoutDashboard, Plus, ScrollText, Send } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Viewer } from "@/types/domain";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { ADMIN_NAV_ICONS } from "@/components/shell/admin-nav-icons";
import { isActivePath, navItemsFor } from "@/components/shell/nav-items";

type NavItem = { href: string; label: string; icon: LucideIcon; exact?: boolean; count?: number };

function NavLink({ item, active }: { item: NavItem; active: boolean }): React.JSX.Element {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      prefetch={false}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group/nav flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring/50",
        active
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
      )}
    >
      <Icon aria-hidden className="size-4 shrink-0 opacity-70 group-hover/nav:opacity-100" />
      <span className="truncate">{item.label}</span>
      {item.count !== undefined ? (
        // Pending work on the page behind the link (today: the held-mail backlog). Part of the link's
        // accessible name, so a screen reader hears "Held mail, 11 waiting" rather than a bare number.
        <Badge variant="secondary" className="ml-auto min-w-5 px-1.5 tabular-nums">
          {item.count}
          <span className="sr-only"> waiting</span>
        </Badge>
      ) : null}
    </Link>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="px-2 pt-4 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </div>
  );
}

/**
 * Primary navigation (md+; the `aside` around it is `hidden md:flex`). Items are derived from the
 * viewer's groups through the pure `navItemsFor` helper `BottomNav` also uses, so the two navigations
 * never disagree; the server re-checks every page, so this is convenience, not enforcement.
 */
export function AppSidebar({
  viewer,
  heldIntakeCount,
  inboxUnread,
}: {
  viewer: Viewer;
  /** `heldIntakeCounts(viewer).total` from the `(app)` layout; undefined when the viewer cannot review
   * held mail or the read failed. Rendered as the Admin → Held mail badge. */
  heldIntakeCount?: number;
  /** `unreadNotificationCount(viewer)` from the same layout. Absent at zero and on failure. */
  inboxUnread?: number;
}): React.JSX.Element {
  const pathname = usePathname();
  const items = navItemsFor(viewer, { heldIntake: heldIntakeCount, inboxUnread });

  return (
    <nav aria-label="Primary" className="flex h-full flex-col px-2 py-3">
      <div className="px-2 pb-2">
        <Link href="/dashboard" className="flex items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <span
            aria-hidden
            className="flex size-6 items-center justify-center rounded bg-primary font-mono text-[11px] font-semibold text-primary-foreground"
          >
            WM
          </span>
          <span className="text-sm font-semibold tracking-tight">Help Desk</span>
        </Link>
      </div>

      <div className="flex flex-col gap-0.5">
        <NavLink
          item={{ href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, exact: true }}
          active={isActivePath(pathname, "/dashboard", true)}
        />
        {items.showInbox ? (
          <NavLink
            item={{ href: "/inbox", label: "Inbox", icon: Bell, count: items.inboxUnread }}
            active={isActivePath(pathname, "/inbox")}
          />
        ) : null}
        {items.canCreate ? (
          <NavLink
            item={{ href: "/tickets/new", label: "New ticket", icon: Plus }}
            active={isActivePath(pathname, "/tickets/new", true)}
          />
        ) : null}
        {items.showReports ? (
          <NavLink
            item={{ href: "/reports", label: "Reports", icon: BarChart3 }}
            active={isActivePath(pathname, "/reports")}
          />
        ) : null}
        {items.showOutbox ? (
          <NavLink item={{ href: "/outbox", label: "Outbox", icon: Send }} active={isActivePath(pathname, "/outbox")} />
        ) : null}
      </div>

      {items.queues.length > 0 ? (
        <>
          <SectionLabel>Queues</SectionLabel>
          <div className="flex flex-col gap-0.5">
            {items.queues.map((q) => (
              <NavLink
                key={q.key}
                item={{ href: q.href, label: q.label, icon: Inbox }}
                active={isActivePath(pathname, q.href)}
              />
            ))}
          </div>
        </>
      ) : null}

      {items.showAudit || items.showReviews ? (
        <>
          <SectionLabel>Compliance</SectionLabel>
          <div className="flex flex-col gap-0.5">
            {items.showAudit ? (
              <NavLink
                item={{ href: "/compliance/audit", label: "Audit log", icon: ScrollText }}
                active={isActivePath(pathname, "/compliance/audit")}
              />
            ) : null}
            {/* Wave B: a WIDER audience than the ledger. ops_team supervises correspondence too, so
                the section can appear for a viewer who holds no `audit:view` at all. */}
            {items.showReviews ? (
              <NavLink
                item={{ href: "/compliance/reviews", label: "Reply reviews", icon: ClipboardCheck }}
                active={isActivePath(pathname, "/compliance/reviews")}
              />
            ) : null}
          </div>
        </>
      ) : null}

      {items.admin.length > 0 ? (
        <>
          <SectionLabel>Admin</SectionLabel>
          <div className="flex flex-col gap-0.5">
            {items.admin.map((a) => (
              <NavLink
                key={a.key}
                item={{ href: a.href, label: a.label, icon: ADMIN_NAV_ICONS[a.key], count: a.count }}
                active={isActivePath(pathname, a.href)}
              />
            ))}
          </div>
        </>
      ) : null}

      <div className="mt-auto px-2 pt-4 text-[11px] leading-snug text-muted-foreground">
        Every ticket view and change is recorded.
      </div>
    </nav>
  );
}
