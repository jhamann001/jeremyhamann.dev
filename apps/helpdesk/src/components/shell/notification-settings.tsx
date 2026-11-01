"use client";

import { useState } from "react";
import { Bell, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PushSubscribe } from "@/components/shell/push-subscribe";
import { NotificationPrefsSheet } from "@/components/inbox/notification-prefs-sheet";

/**
 * "How you are told about your own work" — the two controls, in ONE place, rendered by both surfaces
 *.
 *
 * They shipped inside `AccountSheet`, which only `BottomNav` renders, and `BottomNav` is `md:hidden`
 * and additionally returns null on every `/tickets/**` route. So below 768 px they existed and above
 * it they did not: an ops lead on a laptop could not set "I am away until Tuesday, hand my tickets to
 * Sam" at all, and a supervisor could not turn a notification kind off. Out of office is not a comfort
 * setting — `outOfOfficeUntil` and `backupUserId` are the two columns B4's job reads to hand a person's
 * open tickets to their backup, so a desk that cannot set them silently loses the handover. The
 * INTEGRATION_LOG recorded only the push half of this gap ("no web-push opt-in at md+"); preferences
 * and out-of-office went with it and nothing said so.
 *
 * The fix is one component, not a second copy of the block: the phone sheet and the md+ menu render
 * THIS, so the two surfaces cannot drift into offering different settings.
 */
export function NotificationSettingsControls({
  onOpenPrefs,
  pushEnabled = false,
  vapidPublicKey = null,
}: {
  /**
   * What the "Notification settings" button does. The prefs sheet is a SIBLING of whatever is open,
   * never a child: on a phone the Account sheet closes as it opens, so a device never stacks two
   * bottom sheets and Back always means "one step". The caller owns that sequencing, because only the
   * caller knows what it has to close first.
   */
  onOpenPrefs: () => void;
  /** `isWebPushEnabled(env)`, resolved on the server. `PushSubscribe` renders nothing while it is false. */
  pushEnabled?: boolean;
  /** `env.VAPID_PUBLIC_KEY` when push is on, else null. Never read from the client. */
  vapidPublicKey?: string | null;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Notifications</p>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 w-full justify-start md:min-h-9"
        aria-haspopup="dialog"
        onClick={onOpenPrefs}
      >
        <Bell aria-hidden />
        Notification settings
      </Button>
      {/*
        Integration round 1 (CONTRACT §9, B10's note §1.1): the web-push opt-in MOVED out of the `(app)`
        layout, where it was a flex sibling of the sidebar and the main column and would have taken width
        from <main> the moment a VAPID key was set. A notification opt-in is a setting and belongs beside
        "how you are told"; a floating "enable notifications?" card on every page is the pattern this
        codebase is right to reject. Renders null while push is off. Both props are resolved on the
        SERVER and passed down — a client component may not import `@/lib/env` (G1).
      */}
      <PushSubscribe enabled={pushEnabled} vapidPublicKey={vapidPublicKey} />
    </div>
  );
}

/**
 * The md+ surface for the same block: a settings button in the topbar's right-hand
 * cluster, opening a popover that holds exactly what the phone Account sheet holds.
 *
 * A popover rather than a page: these are two controls, one of which is a switch, and a settings PAGE
 * for them would be a route with RBAC, a loading state and a back button for a panel that fits in a
 * 288 px card. The prefs sheet itself is a `ResponsiveSheet`, so it already renders as a right-hand
 * sheet at this width — nothing about B1's form needed a second layout.
 */
export function AccountSettingsMenu({
  pushEnabled = false,
  vapidPublicKey = null,
}: {
  pushEnabled?: boolean;
  vapidPublicKey?: string | null;
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);

  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Settings">
            <Settings aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72">
          <NotificationSettingsControls
            pushEnabled={pushEnabled}
            vapidPublicKey={vapidPublicKey}
            // Close the popover first, for the same reason the phone closes the Account sheet: a dialog
            // opening on top of an open popover leaves two dismissable layers and one Escape key.
            onOpenPrefs={() => {
              setMenuOpen(false);
              setPrefsOpen(true);
            }}
          />
        </PopoverContent>
      </Popover>

      <NotificationPrefsSheet open={prefsOpen} onOpenChange={setPrefsOpen} />
    </>
  );
}
