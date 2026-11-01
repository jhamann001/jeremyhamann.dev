"use client";

import Link from "next/link";
import { Bell, LogOut, ShieldAlert } from "lucide-react";
import type { Viewer } from "@/types/domain";
import { isDualRole } from "@/lib/rbac";
import { signOutAction } from "@/app/sign-in/sign-in.actions";
import { GROUP_LABELS } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { AccountSettingsMenu } from "@/components/shell/notification-settings";
import { UserAvatar } from "@/components/tickets/user-avatar";
import { portfolioSite } from "@/components/demo/portfolio-link";

type EnvLabel = "local" | "dev" | "demo" | "production";

const ENV_BANNER: Readonly<
  Record<Exclude<EnvLabel, "production">, { text: string; shortText: string; className: string }>
> = {
  local: {
    text: "Local environment — not production data",
    shortText: "LOCAL · NOT PRODUCTION",
    className: "bg-sky-600 text-white dark:bg-sky-700",
  },
  dev: {
    text: "Development environment — not production data",
    shortText: "DEV · NOT PRODUCTION",
    className: "bg-violet-600 text-white dark:bg-violet-700",
  },
  demo: {
    text: "Portfolio demo — every person, account and ticket is invented. Resets daily at 14:00 UTC",
    shortText: "DEMO · INVENTED DATA",
    className: "bg-emerald-700 text-white dark:bg-emerald-800",
  },
};

/**
 * Top bar: environment banner (a safety cue at every width), identity, role chips, theme, sign-out.
 * Phone (< md): compact — brand link, Dual role and DEV LOGIN chips only; group chips, avatar, theme
 * toggle and sign-out live in the Account sheet (BottomNav). md+: everything inline, as before.
 * There is no hamburger: phone navigation is the bottom tab bar.
 *
 * Wave B adds the INBOX here rather than as a sixth bottom tab. Five tabs is the hard
 * ceiling, and the only persona a sixth would have evicted something from is the dual-role compliance
 * officer — whose evicted tab would have been Audit. Taking the ledger off the thumb rail of the person
 * whose job is the ledger, to make room for their own notifications, is the wrong trade. A bell beside
 * the brand is where every messaging app on the device already puts this, it is `md:hidden` (the
 * sidebar carries it at md+), and the unread count travels as the control's accessible name rather than
 * as a number nobody can read at 20 px.
 *
 * Fix round 2: `data-topbar` and `data-env-banner` are read by `globals.css` — `--wm-topbar-h` is the
 * height anything else that sticks to the top of the document scroll must clear, and `:has([data-env-banner])`
 * is how that token knows whether the banner is on screen. Both are also the handles MOBILE_FIRST §7's
 * G14 probe selects on. Neither changes what this header renders.
 */
export function Topbar({
  viewer,
  envLabel,
  inboxUnread,
  pushEnabled = false,
  vapidPublicKey = null,
}: {
  viewer: Viewer;
  envLabel: EnvLabel;
  /** unread inbox rows, from the `(app)` layout. Absent at zero and on a failed read. */
  inboxUnread?: number;
  /**
   * Fix round 2. `isWebPushEnabled(env)` and `env.VAPID_PUBLIC_KEY`, resolved on the SERVER by the
   * `(app)` layout — a client component may not import `@/lib/env`. They reach the phone through
   * `BottomNav` → `AccountSheet`; this is the md+ path to the same block, which had none.
   */
  pushEnabled?: boolean;
  vapidPublicKey?: string | null;
}): React.JSX.Element {
  const dualRole = isDualRole(viewer.groups);
  const banner = envLabel === "production" ? null : ENV_BANNER[envLabel];
  // The public demo's way back to the portfolio site (NEXT_PUBLIC_PORTFOLIO_URL; unset elsewhere).
  const site = portfolioSite();
  const displayName = viewer.name?.trim() || viewer.email;

  return (
    <header data-topbar className="sticky top-0 z-40 border-b bg-background/95 pt-safe supports-backdrop-filter:backdrop-blur">
      {banner ? (
        <div
          data-env-banner
          className={`flex h-5 items-center justify-center gap-3 px-3 text-[10px] font-medium tracking-wide uppercase md:h-6 md:text-[11px] ${banner.className}`}
        >
          <span role="status">
            <span className="md:hidden">{banner.shortText}</span>
            <span className="hidden md:inline">{banner.text}</span>
          </span>
          {envLabel === "demo" && site ? (
            <a href={site.url} className="hidden underline underline-offset-2 md:inline">
              {site.site}
            </a>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-h-11 items-center gap-2 px-3 md:min-h-12 md:px-4">
        <Link
          href="/dashboard"
          prefetch={false}
          className="flex min-h-11 shrink-0 items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:hidden"
        >
          <span
            aria-hidden
            className="flex size-6 items-center justify-center rounded bg-primary font-mono text-[11px] font-semibold text-primary-foreground"
          >
            WM
          </span>
          <span className="text-sm font-semibold tracking-tight">Help Desk</span>
        </Link>

        {/* Wave B: the phone inbox entry. A dot, not a number — 20 px of chrome cannot carry "17"
            legibly, and the count is on the page itself one tap away. The accessible name carries it,
            so a screen reader hears "Inbox, 17 unread" and a sighted operator sees that there is
            something. `md:hidden` because the sidebar has the same entry, with the real badge. */}
        <Link
          href="/inbox"
          prefetch={false}
          aria-label={inboxUnread === undefined ? "Inbox" : `Inbox, ${inboxUnread} unread`}
          data-inbox-link
          className="relative flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 md:hidden"
        >
          <Bell aria-hidden className="size-5" />
          {inboxUnread === undefined ? null : (
            <span
              aria-hidden
              data-inbox-unread
              className="absolute top-2 right-2 size-2 rounded-full bg-primary ring-2 ring-background"
            />
          )}
        </Link>

        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1.5 md:justify-start">
          {viewer.groups.map((g) => (
            <Badge key={g} variant="secondary" className="hidden shrink-0 font-normal md:inline-flex" data-group={g}>
              {GROUP_LABELS[g]}
            </Badge>
          ))}
          {viewer.groups.length === 0 ? (
            <Badge
              variant="outline"
              className="hidden shrink-0 border-dashed font-normal text-muted-foreground md:inline-flex"
            >
              No groups
            </Badge>
          ) : null}
          {dualRole ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  className="shrink-0 gap-1 border-transparent bg-red-600 text-white dark:bg-red-700"
                  data-dual-role
                >
                  <ShieldAlert aria-hidden />
                  Dual role
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                Compliance plus an operational group. Every audit row you write is flagged.
              </TooltipContent>
            </Tooltip>
          ) : null}
          {viewer.isDev ? (
            <Badge
              className="shrink-0 border-transparent bg-amber-400 font-semibold text-amber-950 dark:bg-amber-500"
              data-dev-login
            >
              DEV LOGIN
            </Badge>
          ) : null}
        </div>

        <div className="hidden shrink-0 items-center gap-1 md:flex">
          {/*
            Fix round 2. Notification preferences, OUT OF OFFICE and the push opt-in existed only inside
            `AccountSheet`, which only `BottomNav` renders and which is `md:hidden` — so at this width
            there was no way to set "I am away until Tuesday, hand my tickets to Sam", the two columns
            B4's handover job reads. Same component the phone sheet renders, so the surfaces cannot drift.
          */}
          <AccountSettingsMenu pushEnabled={pushEnabled} vapidPublicKey={vapidPublicKey} />
          <ThemeToggle />
          <div className="flex items-center gap-2 pl-1" title={viewer.email}>
            <UserAvatar
              user={{ id: viewer.id, name: viewer.name, email: viewer.email, image: viewer.image }}
              size="sm"
            />
          </div>
          <span className="sr-only">Signed in as {displayName}</span>
          <form action={signOutAction}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="submit" variant="ghost" size="icon-sm" aria-label="Sign out">
                  <LogOut aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Sign out</TooltipContent>
            </Tooltip>
          </form>
        </div>
      </div>
    </header>
  );
}
