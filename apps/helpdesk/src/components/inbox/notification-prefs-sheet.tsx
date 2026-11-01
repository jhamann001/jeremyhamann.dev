"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import type { NotificationChannel, NotificationKind, NotificationPrefs, UserRef } from "@/types/domain";
import {
  LIVE_NOTIFICATION_KINDS,
  NOTIFICATION_KIND_LABELS,
  NOTIFICATION_PREFS_DEFAULT,
} from "@/types/domain";
import { firmDateTimeLocalToIso, isoToFirmDateTimeLocal } from "@/lib/firm-time";
import { DISPLAY_TIME_ZONE_LABEL } from "@/lib/format";
import { loadNotificationSettings, setNotificationPrefs } from "@/server/notifications.actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  ResponsiveSheet,
  ResponsiveSheetBody,
  ResponsiveSheetFooter,
} from "@/components/shell/responsive-sheet";

export type NotificationPrefsSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * "How you are told" — slice B1's half of the Account sheet.
 *
 * THE INBOX IS NOT ON THIS FORM, and that is the point. Every kind always writes an in-app row; what
 * a person controls is the two INTERRUPTING channels and the daily digest. A notification anyone
 * could switch off entirely would make "you were told" unprovable, which is exactly the claim a
 * books-and-records desk has to be able to answer (`NOTIFICATION_PREFS_DEFAULT`).
 *
 * It loads its own settings through a `runAction`-wrapped read, because a client component may not
 * import a non-`.actions` server module and the Account sheet is rendered by the
 * foundation-owned topbar, which cannot pass them down. Loading happens ON OPEN, not on mount: the
 * sheet exists on every authenticated page and a read per page load for a panel nobody opened would
 * be a query per navigation for nothing.
 *
 * Out of office lives here rather than on an admin page because it is a statement about yourself:
 * the person who knows they are away is the person who sets it, and B4's job reads the same two
 * columns to hand their open tickets to the named backup.
 */
export function NotificationPrefsSheet({ open, onOpenChange }: NotificationPrefsSheetProps): React.JSX.Element {
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [backupOptions, setBackupOptions] = useState<UserRef[]>([]);
  const [backupUserId, setBackupUserId] = useState<string | null>(null);
  const [outOfOfficeLocal, setOutOfOfficeLocal] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const result = await loadNotificationSettings();
      if (cancelled) return;
      if (!result.ok) {
        setLoadFailed(true);
        return;
      }
      setLoadFailed(false);
      setPrefs(result.data.prefs);
      setBackupOptions(result.data.backupOptions);
      setBackupUserId(result.data.backupUserId);
      setOutOfOfficeLocal(isoToFirmDateTimeLocal(result.data.outOfOfficeUntil));
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  function setChannel(kind: NotificationKind, channel: NotificationChannel, value: boolean): void {
    setPrefs((current) => {
      const base = current ?? NOTIFICATION_PREFS_DEFAULT;
      return {
        ...base,
        channels: { ...base.channels, [kind]: { ...(base.channels[kind] ?? {}), [channel]: value } },
      };
    });
  }

  function allows(kind: NotificationKind, channel: NotificationChannel): boolean {
    const base = prefs ?? NOTIFICATION_PREFS_DEFAULT;
    return base.channels[kind]?.[channel] ?? NOTIFICATION_PREFS_DEFAULT.channels[kind]?.[channel] ?? false;
  }

  function save(): void {
    const current = prefs ?? NOTIFICATION_PREFS_DEFAULT;
    const trimmed = outOfOfficeLocal.trim();
    const outOfOfficeUntil = trimmed === "" ? null : firmDateTimeLocalToIso(trimmed);
    if (trimmed !== "" && outOfOfficeUntil === null) {
      toast.error("That out-of-office date could not be read.");
      return;
    }
    startTransition(async () => {
      const result = await setNotificationPrefs({ prefs: current, outOfOfficeUntil, backupUserId });
      if (result.ok) {
        toast.success("Notification settings saved");
        onOpenChange(false);
        return;
      }
      switch (result.code) {
        case "VALIDATION":
          toast.error(result.message);
          return;
        case "UNAUTHORIZED":
          toast.error("Your session has ended. Sign in again.");
          return;
        default:
          toast.error("The settings were not saved.");
      }
    });
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Notifications"
      description="The inbox always fills. These two channels are the ones that interrupt you."
      height="full"
    >
      <ResponsiveSheetBody className="flex flex-col gap-4">
        {loadFailed ? (
          <p className="text-sm text-muted-foreground">
            Your settings could not be loaded. Close this and try again.
          </p>
        ) : prefs === null ? (
          <div aria-busy="true" className="flex flex-col gap-2">
            <span role="status" className="sr-only">
              Loading…
            </span>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Channels</p>
              <div className="hidden grid-cols-[1fr_5rem_5rem] items-center gap-2 pb-1 text-xs text-muted-foreground md:grid">
                <span />
                <span className="text-center">Slack DM</span>
                <span className="text-center">Push</span>
              </div>
              <ul className="flex flex-col gap-2">
                {LIVE_NOTIFICATION_KINDS.map((kind) => (
                  <li
                    key={kind}
                    className="grid grid-cols-[1fr_auto_auto] items-center gap-3 rounded-md border p-2 md:grid-cols-[1fr_5rem_5rem] md:gap-2"
                  >
                    <span className="min-w-0 text-sm leading-snug">{NOTIFICATION_KIND_LABELS[kind]}</span>
                    <span className="flex flex-col items-center gap-1">
                      <span className="text-[10px] text-muted-foreground md:hidden">Slack</span>
                      <Switch
                        checked={allows(kind, "SLACK_DM")}
                        onCheckedChange={(v) => setChannel(kind, "SLACK_DM", v)}
                        aria-label={`Slack DM for ${NOTIFICATION_KIND_LABELS[kind]}`}
                      />
                    </span>
                    <span className="flex flex-col items-center gap-1">
                      <span className="text-[10px] text-muted-foreground md:hidden">Push</span>
                      <Switch
                        checked={allows(kind, "WEB_PUSH")}
                        onCheckedChange={(v) => setChannel(kind, "WEB_PUSH", v)}
                        aria-label={`Web push for ${NOTIFICATION_KIND_LABELS[kind]}`}
                      />
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                The inbox is not a switch: every one of these always writes a row you can read and mark
                off. A channel that is not configured for the firm simply never fires.
              </p>
            </div>

            <Separator />

            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="digest-switch" className="text-sm leading-snug">
                Daily digest
                <span className="block text-xs font-normal text-muted-foreground">
                  One summary of what is still unread, each morning.
                </span>
              </Label>
              <Switch
                id="digest-switch"
                checked={prefs.digest}
                onCheckedChange={(v) => setPrefs({ ...prefs, digest: v })}
              />
            </div>

            <Separator />

            <div className="flex flex-col gap-3">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Out of office</p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ooo-until">Away until ({DISPLAY_TIME_ZONE_LABEL})</Label>
                <Input
                  id="ooo-until"
                  type="datetime-local"
                  value={outOfOfficeLocal}
                  onChange={(e) => setOutOfOfficeLocal(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  While this is in the future you are skipped by auto-assignment and your open tickets
                  are handed to your backup.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ooo-backup">Backup</Label>
                <Select
                  value={backupUserId ?? "NONE"}
                  onValueChange={(v) => setBackupUserId(v === "NONE" ? null : v)}
                >
                  <SelectTrigger id="ooo-backup" className="w-full">
                    <SelectValue placeholder="Nobody" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NONE">Nobody — leave them unassigned</SelectItem>
                    {backupOptions.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.name?.trim() || u.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="mute-ooo" className="text-sm leading-snug">
                  Silence Slack and push while away
                  <span className="block text-xs font-normal text-muted-foreground">
                    The inbox still fills — coming back to it is the point of coming back.
                  </span>
                </Label>
                <Switch
                  id="mute-ooo"
                  checked={prefs.muteWhileOutOfOffice}
                  onCheckedChange={(v) => setPrefs({ ...prefs, muteWhileOutOfOffice: v })}
                />
              </div>
            </div>
          </>
        )}
      </ResponsiveSheetBody>

      <ResponsiveSheetFooter className="flex-col items-stretch gap-2">
        <Button type="button" disabled={pending || prefs === null} onClick={save}>
          {pending ? "Saving…" : "Save settings"}
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
      </ResponsiveSheetFooter>
    </ResponsiveSheet>
  );
}
