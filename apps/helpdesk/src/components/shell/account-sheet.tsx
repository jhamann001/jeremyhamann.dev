"use client";

import Link from "next/link";
import { useState } from "react";
import { LogOut, ShieldAlert } from "lucide-react";
import type { Viewer } from "@/types/domain";
import { isDualRole } from "@/lib/rbac";
import { GROUP_LABELS } from "@/lib/format";
import { signOutAction } from "@/app/sign-in/sign-in.actions";
import { PortfolioLink } from "@/components/demo/portfolio-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { UserAvatar } from "@/components/tickets/user-avatar";
import { ResponsiveSheet, ResponsiveSheetBody, ResponsiveSheetFooter } from "@/components/shell/responsive-sheet";
import { ThemeSegmented } from "@/components/shell/theme-toggle";
import { ADMIN_NAV_ICONS, OVERFLOW_NAV_ICONS } from "@/components/shell/admin-nav-icons";
import { adminOverflowFor, navItemsFor, navOverflowFor } from "@/components/shell/nav-items";
import { NotificationPrefsSheet } from "@/components/inbox/notification-prefs-sheet";
import { NotificationSettingsControls } from "@/components/shell/notification-settings";

/**
 * Phone home for everything the md+ topbar shows inline: identity, group chips, the Dual role and
 * DEV LOGIN chips (with the dual-role sentence as visible text — tooltips never fire on touch), the
 * theme control and sign-out.
 */
export function AccountSheet({
  viewer,
  open,
  onOpenChange,
  heldIntakeCount,
  pushEnabled = false,
  vapidPublicKey = null,
}: {
  viewer: Viewer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `isWebPushEnabled(env)` from the `(app)` layout. False everywhere on this branch. */
  pushEnabled?: boolean;
  /** `env.VAPID_PUBLIC_KEY` when push is on, else null. Never read from the client. */
  vapidPublicKey?: string | null;
  /**
   * `heldIntakeCounts(viewer).total` from the `(app)` layout; undefined when the viewer cannot review
   * held mail or the read failed. On a phone the Admin entry is two taps deep, so without this number
   * nothing prompts the daily held-mail review at all.
   */
  heldIntakeCount?: number;
}): React.JSX.Element {
  // Wave B. The notification preferences open from here, as a SIBLING sheet rather than a
  // nested one: the Account sheet closes as the settings sheet opens, so a phone never stacks two
  // bottom sheets and Back always means "one step", not "which of these two am I closing".
  const [prefsOpen, setPrefsOpen] = useState(false);
  const dualRole = isDualRole(viewer.groups);
  const displayName = viewer.name?.trim() || viewer.email;
  // Admin is not a sixth bottom tab (five is the ceiling); it lives here, with the other
  // settings-shaped controls. Same entries the md+ sidebar renders — one derivation, two surfaces.
  const navItems = navItemsFor(viewer, { heldIntake: heldIntakeCount });
  const admin = adminOverflowFor(navItems);
  // Wave B. Reports and the reply-review queue did not win a
  // bottom tab and are not administration, so they render here, ABOVE the Admin block, from the SAME
  // `navItemsFor` call the sidebar uses at md+. `navOverflowFor` existed and was tested from the first
  // integration round, but nothing rendered it: below 768 px both pages were reachable only by typing
  // the URL, and an ops_team member — `reports:read` and `review:stamp` but no `audit:view`, so no
  // Compliance tab either — could reach neither of this wave's two new app-wide surfaces on a phone.
  const overflow = navOverflowFor(navItems);

  return (
    <>
    <ResponsiveSheet open={open} onOpenChange={onOpenChange} title="Account" height="auto">
      <ResponsiveSheetBody className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <UserAvatar
            user={{ id: viewer.id, name: viewer.name, email: viewer.email, image: viewer.image }}
            size="md"
          />
          {displayName !== viewer.email ? (
            <p className="pl-10 text-xs break-all text-muted-foreground">{viewer.email}</p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {viewer.groups.map((g) => (
              <Badge key={g} variant="secondary" className="font-normal" data-group={g}>
                {GROUP_LABELS[g]}
              </Badge>
            ))}
            {viewer.groups.length === 0 ? (
              <Badge variant="outline" className="border-dashed font-normal text-muted-foreground">
                No groups
              </Badge>
            ) : null}
            {dualRole ? (
              <Badge className="gap-1 border-transparent bg-red-600 text-white dark:bg-red-700" data-dual-role>
                <ShieldAlert aria-hidden />
                Dual role
              </Badge>
            ) : null}
            {viewer.isDev ? (
              <Badge
                className="border-transparent bg-amber-400 font-semibold text-amber-950 dark:bg-amber-500"
                data-dev-login
              >
                DEV LOGIN
              </Badge>
            ) : null}
          </div>
          {dualRole ? (
            <p className="text-xs leading-snug text-muted-foreground">
              Compliance plus an operational group. Every audit row you write is flagged.
            </p>
          ) : null}
        </div>

        {overflow.length > 0 ? (
          <>
            <Separator />
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">More</p>
              <div className="flex flex-col gap-1.5">
                {overflow.map((o) => {
                  const Icon = OVERFLOW_NAV_ICONS[o.key];
                  return (
                    <Button key={o.key} asChild variant="outline" className="min-h-11 w-full justify-start">
                      <Link href={o.href} prefetch={false} onClick={() => onOpenChange(false)}>
                        <Icon aria-hidden />
                        {o.label}
                      </Link>
                    </Button>
                  );
                })}
              </div>
            </div>
          </>
        ) : null}

        {admin.length > 0 ? (
          <>
            <Separator />
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Admin</p>
              <div className="flex flex-col gap-1.5">
                {admin.map((a) => {
                  const Icon = ADMIN_NAV_ICONS[a.key];
                  return (
                    <Button key={a.key} asChild variant="outline" className="min-h-11 w-full justify-start">
                      <Link href={a.href} prefetch={false} onClick={() => onOpenChange(false)}>
                        <Icon aria-hidden />
                        {a.label}
                        {a.count !== undefined ? (
                          <Badge variant="secondary" className="ml-auto min-w-5 px-1.5 tabular-nums">
                            {a.count}
                            <span className="sr-only"> waiting</span>
                          </Badge>
                        ) : null}
                      </Link>
                    </Button>
                  );
                })}
              </div>
            </div>
          </>
        ) : null}

        <Separator />

        {/*
          Wave B (B1): how this person is told about their own work. It sits with the other
          settings-shaped controls rather than on an admin page, because it is a statement about
          yourself — including "I am away until Tuesday, hand my tickets to Sam".

          Fix round 2: the block itself lives in `notification-settings.tsx` and the md+ topbar renders
          the SAME component. It used to exist only here, and this sheet is phone-only — so above
          768 px there was no way to reach notification preferences, out of office or the push opt-in
          at all.
        */}
        <NotificationSettingsControls
          pushEnabled={pushEnabled}
          vapidPublicKey={vapidPublicKey}
          onOpenPrefs={() => {
            onOpenChange(false);
            setPrefsOpen(true);
          }}
        />

        <Separator />

        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Theme</p>
          <ThemeSegmented />
        </div>
      </ResponsiveSheetBody>

      <ResponsiveSheetFooter className="flex-col items-stretch gap-2">
        <form action={signOutAction}>
          <Button type="submit" variant="outline" className="w-full">
            <LogOut aria-hidden />
            Sign out
          </Button>
        </form>
        <p className="text-center text-xs text-muted-foreground">Every ticket view and change is recorded.</p>
        {/* The public demo's way back on a phone, where the banner's link is too small to tap. */}
        <PortfolioLink className="self-center" />
      </ResponsiveSheetFooter>
    </ResponsiveSheet>

    <NotificationPrefsSheet open={prefsOpen} onOpenChange={setPrefsOpen} />
    </>
  );
}
