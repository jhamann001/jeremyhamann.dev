import type { Viewer } from "@/types/domain";
import { requireUser } from "@/lib/session";
import { env, isWebPushEnabled } from "@/lib/env";
import { logError } from "@/lib/logger";
import { canReviewHeldIntake, canUseInbox } from "@/lib/rbac";
import { heldIntakeCounts } from "@/server/suspended-intake";
import { unreadNotificationCount } from "@/server/notifications";
import { AppSidebar } from "@/components/app-sidebar";
import { Topbar } from "@/components/topbar";
import { BottomNav } from "@/components/shell/bottom-nav";
// --- Wave B MOUNT POINTS. All four render once, here, because all four
// are app-wide: a shortcut must work on every page, a badge must reflect the whole app, and an install
// prompt that only appeared on the dashboard would be missed by anyone who lives on a queue. ---
import { BadgeSync } from "@/components/shell/badge-sync";
import { KeyboardShortcuts } from "@/components/shell/keyboard-shortcuts";
import { PwaInstallPrompt } from "@/components/shell/pwa-install-prompt";

/**
 * Authenticated shell. `requireUser` redirects to /sign-in when there is no active viewer; each
 * page re-checks its own RBAC (middleware and this layout are coarse gates only).
 *
 * Phone (< md): compact topbar + bottom tab bar (`BottomNav`, hidden on /tickets/** where the
 * StickyActionBar owns the bottom edge); <main> reserves one bar height (`pb-bar-safe`) on every phone
 * route so fixed bars never cover content. md+: the sidebar, as before. docs/MOBILE_FIRST.md §2.
 */
export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.JSX.Element> {
  const viewer = await requireUser();
  // Two nav counts, in parallel: neither blocks the other and neither may take the shell down.
  const [heldIntakeCount, inboxUnread] = await Promise.all([
    heldMailBadgeCount(viewer),
    inboxBadgeCount(viewer),
  ]);
  // Resolved on the SERVER and passed down: `PushSubscribe` is a client component and may not import
  // `@/lib/env`. `vapidPublicKey` is a PUBLIC key by construction — it is handed to every browser
  // that subscribes — so passing it to the client is the point, not a leak.
  const pushEnabled = isWebPushEnabled(env);

  return (
    <div className="flex min-h-svh bg-background text-foreground">
      <aside className="hidden w-56 shrink-0 border-r bg-sidebar text-sidebar-foreground md:sticky md:top-0 md:flex md:h-svh md:flex-col">
        <AppSidebar viewer={viewer} heldIntakeCount={heldIntakeCount} inboxUnread={inboxUnread} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* `pushEnabled` / `vapidPublicKey`: fix round 2 — the topbar carries the md+ copy of the
            notification settings block, which until now existed only in the phone Account sheet. */}
        <Topbar
          viewer={viewer}
          envLabel={env.APP_ENV}
          inboxUnread={inboxUnread}
          pushEnabled={pushEnabled}
          vapidPublicKey={pushEnabled ? (env.VAPID_PUBLIC_KEY ?? null) : null}
        />
        <main id="main" className="flex-1 px-safe pt-4 pb-bar-safe md:px-6 md:py-5">
          {children}
        </main>
        <BottomNav
          viewer={viewer}
          heldIntakeCount={heldIntakeCount}
          inboxUnread={inboxUnread}
          pushEnabled={pushEnabled}
          vapidPublicKey={pushEnabled ? (env.VAPID_PUBLIC_KEY ?? null) : null}
        />
      </div>

      {/* Wave B: app-wide, invisible until their slice lands. None of them renders layout. */}
      <KeyboardShortcuts />
      <BadgeSync count={inboxUnread ?? 0} />
      <PwaInstallPrompt />
    </div>
  );
}

/**
 * The number behind the Admin → "Held mail" badge, in both navigations.
 *
 * Reviewing held inbound mail is a daily duty and the nav entry carried no number,
 * so nothing anywhere in the app said that client messages were sitting refused and unread — the same
 * defect the entry itself was added to fix. `heldIntakeCounts` defaults to the `NEW` backlog, which is
 * exactly the work waiting.
 *
 * The capability is checked HERE so the read never writes an `AUTHZ_DENIED` row for a viewer who was
 * only rendering the shell; `heldIntakeCounts` checks it again. A badge must never be able to take
 * down every authenticated page, so a failed read degrades to no badge rather than to an error boundary.
 */
async function heldMailBadgeCount(viewer: Viewer): Promise<number | undefined> {
  if (!canReviewHeldIntake(viewer.groups)) return undefined;
  try {
    return (await heldIntakeCounts(viewer)).total;
  } catch (e) {
    // CWE-209: `e instanceof Error ? e.name` is itself a read of the caught
    // error, and console is the sink the rule watches. `logError` records only `errorLabel(e)`.
    logError("layout:(app)", e, { op: "held-mail-nav-count" });
    return undefined;
  }
}

/**
 * the number behind the Inbox badge, in both navigations.
 *
 * Same three rules as the held-mail count beside it, for the same reasons: the capability is checked
 * HERE so rendering the shell never writes an `AUTHZ_DENIED` row for a badge; there is no badge at
 * zero; and a failed read degrades to no badge rather than taking every authenticated page down. A
 * count is not a view — it returns a number and no record content.
 */
async function inboxBadgeCount(viewer: Viewer): Promise<number | undefined> {
  if (!canUseInbox(viewer.groups)) return undefined;
  try {
    const n = await unreadNotificationCount(viewer.id);
    return n > 0 ? n : undefined;
  } catch (e) {
    // Same CWE-209 rule as the held-mail count above: reading `e.name` and
    // handing it to `console` is the finding, not a mitigation of it. `logError` records
    // `errorLabel(e)` and the structured fields, and never the message, stack or cause.
    logError("layout:(app)", e, { op: "inbox-nav-count" });
    return undefined;
  }
}
