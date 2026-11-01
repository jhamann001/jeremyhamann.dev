/**
 * Pure navigation derivation shared by `AppSidebar` (md+) and `BottomNav` (phones) so the two
 * navigations can never disagree. Convenience only: every page
 * re-checks its own RBAC on the server.
 */
import { QUEUE_LABELS, type QueueKey, type Viewer } from "@/types/domain";
import { demoMode } from "@/lib/demo/mode";
import {
  canAdminMacros,
  canAdminSla,
  canAdminSuppression,
  canAdminTokens,
  canAdminUsers,
  canAdminWebhooks,
  canReadFlags,
  canReadReports,
  canReviewHeldIntake,
  canStampReview,
  canUseInbox,
  canViewAudit,
  creatableQueues,
  queueSlug,
  readableQueues,
} from "@/lib/rbac";

/**
 * the Admin section. One entry per admin page, each gated by its own capability.
 *
 * `count` is an optional pending-work figure rendered as a Badge beside the label in BOTH surfaces
 * (sidebar Admin section, phone Account sheet). Present only when there is work — a "0" badge is
 * noise, and an absent count is not the same fact as a zero one (the layout also omits it when the
 * read fails). Today only `intake` carries one; see `NavCounts`.
 */
export type AdminNavItem = {
  key: "macros" | "users" | "intake" | "sla" | "webhooks" | "api-tokens" | "suppression" | "flags";
  href: string;
  label: string;
  count?: number;
};

/**
 * Server-supplied counts for nav entries. Kept out of `navItemsFor`'s own body because this module is
 * pure and client-reachable (G1: no `@/server/*` import from `src/components/**`) — the `(app)` layout
 * does the read and passes the number down.
 *
 * `heldIntake` is `heldIntakeCounts(viewer).total`: the NEW held-mail backlog. Reviewing held mail is a
 * daily duty, and without this number the entry has the same defect it was added to
 * fix — nothing anywhere in the app says that eleven client messages are sitting refused and unread.
 */
export type NavCounts = {
  heldIntake?: number;
  /**
   * Wave B. Unread rows in the viewer's inbox, from `unreadNotificationCount(viewer)`. Same rules as
   * `heldIntake`: the `(app)` layout does the read (G1 keeps `@/server/*` out of this module), no
   * badge at zero, and a failed read degrades to no badge rather than to an error boundary.
   */
  inboxUnread?: number;
};

export type NavItems = {
  /** readableQueues(groups) → `/queues/${queueSlug(k)}`, QUEUE_LABELS[k]. */
  queues: Array<{ key: QueueKey; href: string; label: string }>;
  /** creatableQueues(groups).length > 0 */
  canCreate: boolean;
  /** canViewAudit(groups) */
  showAudit: boolean;
  /**
   * Wave B. The personal inbox: shown to every viewer with a recognised group, because a notification
   * layer with no visible inbox is a layer that silently drops work. `inboxUnread` is the badge count
   * and is absent at zero — a "0" chip reads as "you are caught up" and so does no chip, but only one
   * of them survives a failed read honestly.
   */
  showInbox: boolean;
  inboxUnread?: number;
  /** Wave B. The reporting suite: anyone who can read a queue (`reports:read`). */
  showReports: boolean;
  /**
   * Wave B. The supervisory reply-review queue at /compliance/reviews (`review:stamp`). A WIDER
   * audience than `showAudit`: ops_team supervises correspondence too, and the page is not the ledger.
   */
  showReviews: boolean;
  /** Demo mode only (src/lib/demo/mode.ts): the Outbox of everything the desk would have sent. */
  showOutbox?: boolean;
  /**
   * Wave A. Macros for ops_team or compliance_officers; Users for ops_team; Held mail for either
   * (`intake:review`). Empty for everyone else, and an empty array means the whole Admin section is
   * absent — not an empty heading.
   */
  admin: AdminNavItem[];
};

export function navItemsFor(viewer: Pick<Viewer, "groups">, counts: NavCounts = {}): NavItems {
  const admin: AdminNavItem[] = [];
  if (canAdminMacros(viewer.groups)) admin.push({ key: "macros", href: "/admin/macros", label: "Macros" });
  if (canAdminUsers(viewer.groups)) admin.push({ key: "users", href: "/admin/users", label: "Users" });
  // Held inbound mail. Without this entry the page is URL-only, which is not a review surface: a
  // message the desk refused is invisible until someone already knows to look for it. The badge is the
  // other half of that: an entry with no number tells nobody there is anything to review.
  if (canReviewHeldIntake(viewer.groups)) {
    const intake: AdminNavItem = { key: "intake", href: "/admin/intake", label: "Held mail" };
    const held = counts.heldIntake;
    if (typeof held === "number" && Number.isFinite(held) && held > 0) intake.count = Math.floor(held);
    admin.push(intake);
  }
  // Wave B admin pages, in the order an operator meets them: the policy the desk runs on, then the two
  // credential surfaces, then the list that decides whose mail stops, then the read-only capability
  // view. Each is gated by its own predicate — the section is not "you are an admin, here is
  // everything", and compliance sees only the two it holds (Macros, Held mail, Flags).
  if (canAdminSla(viewer.groups)) admin.push({ key: "sla", href: "/admin/sla", label: "SLA policy" });
  if (canAdminWebhooks(viewer.groups)) admin.push({ key: "webhooks", href: "/admin/webhooks", label: "Webhooks" });
  if (canAdminTokens(viewer.groups)) admin.push({ key: "api-tokens", href: "/admin/api-tokens", label: "API tokens" });
  if (canAdminSuppression(viewer.groups)) {
    admin.push({ key: "suppression", href: "/admin/suppression", label: "Suppression" });
  }
  if (canReadFlags(viewer.groups)) admin.push({ key: "flags", href: "/admin/flags", label: "Capabilities" });

  const unread = counts.inboxUnread;
  const inboxUnread =
    typeof unread === "number" && Number.isFinite(unread) && unread > 0 ? Math.floor(unread) : undefined;

  return {
    queues: readableQueues(viewer.groups).map((key) => ({
      key,
      href: `/queues/${queueSlug(key)}`,
      label: QUEUE_LABELS[key],
    })),
    canCreate: creatableQueues(viewer.groups).length > 0,
    showAudit: canViewAudit(viewer.groups),
    showInbox: canUseInbox(viewer.groups),
    ...(inboxUnread === undefined ? {} : { inboxUnread }),
    showReports: canReadReports(viewer.groups),
    showReviews: canStampReview(viewer.groups),
    ...(demoMode() ? { showOutbox: true } : {}),
    admin,
  };
}

/** The sidebar's isActive, lifted: exact → pathname === href; else pathname === href || pathname.startsWith(`${href}/`). */
export function isActivePath(pathname: string, href: string, exact = false): boolean {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Phone bottom-tab kinds, in display order (docs/MOBILE_FIRST.md §2 persona × tab matrix). */
export type BottomTab = "dashboard" | "queues" | "new" | "audit" | "account";

/**
 * Dashboard and Account are unconditional; Queues / New / Audit follow `NavItems`. Never more than five.
 *
 * Wave A overflow rule: Admin does NOT get its own tab. Five is the hard
 * ceiling for a phone tab bar, the supervisor persona already reaches five, and admin work is a rare,
 * deliberate errand rather than a lane someone lives in. `adminOverflowFor` puts the same entries in
 * the Account sheet instead, which is where every other "settings-shaped" control already lives.
 */
export function bottomTabsFor(items: NavItems): BottomTab[] {
  const tabs: BottomTab[] = ["dashboard"];
  if (items.queues.length > 0) tabs.push("queues");
  if (items.canCreate) tabs.push("new");
  if (items.showAudit) tabs.push("audit");
  tabs.push("account");
  return tabs;
}

/**
 * the tab bar is UNCHANGED, and that is a decision rather than an omission.
 *
 * The inbox is the surface a notification layer lives or dies by, so the obvious move was to give it a
 * sixth tab. Five is the hard ceiling (docs/MOBILE_FIRST.md §2: at 360 px a sixth tab is 60 px, which
 * cannot carry a 44 px target and a label, R3), and the only way to fit it was to evict something —
 * which in practice meant evicting **Audit** from the one persona that has it, the dual-role
 * compliance officer. Taking the ledger off the thumb rail of the person whose job is the ledger, to
 * make room for their own notifications, is the wrong trade.
 *
 * So the inbox is a **topbar action on phones** — a bell with an unread dot, beside the brand, where
 * every messaging app on the device already puts it — and a sidebar entry at md+. Reports goes in the
 * Account sheet's overflow with the admin pages: it is a sit-down activity on a large screen.
 *
 * The persona × tab matrix in docs/MOBILE_FIRST.md §2 is therefore unchanged by this wave.
 */
export const MAX_BOTTOM_TABS = 5;

/** The admin entries a phone shows inside the Account sheet rather than as a sixth bottom tab. */
export function adminOverflowFor(items: NavItems): AdminNavItem[] {
  return items.admin;
}

/**
 * Wave B. Entries the Account sheet shows ABOVE the Admin block: surfaces that are not administration
 * and did not win a bottom tab — Reports (a sit-down activity on a large screen) and the reply-review
 * queue (a supervisor's errand, and a wider audience than the Audit tab's). Empty means the block is
 * absent, not an empty heading.
 */
export type OverflowNavItem = { key: "reports" | "reviews" | "outbox"; href: string; label: string };

export function navOverflowFor(items: NavItems): OverflowNavItem[] {
  const out: OverflowNavItem[] = [];
  if (items.showReports) out.push({ key: "reports", href: "/reports", label: "Reports" });
  if (items.showReviews) out.push({ key: "reviews", href: "/compliance/reviews", label: "Reply reviews" });
  if (items.showOutbox) out.push({ key: "outbox", href: "/outbox", label: "Outbox" });
  return out;
}

/** §2 route rule: `BottomNav` renders nothing on /tickets/** — the StickyActionBar owns the bottom edge there. */
export function hidesBottomNav(pathname: string): boolean {
  return /^\/tickets\//.test(pathname);
}
