"use server";

/**
 * Inbox and follower mutations — `"use server"`, node, layer L4.
 *
 * Three actions, and the audit rule for each is the contract's, not a judgement call made here
 * (§3 rule 3):
 *
 *  - `markNotificationsRead` writes NO audit row. A notification is derived from an event that is
 *    already on the ledger; recording that someone looked at the derivation would double the
 *    ledger's volume to record nothing new, and it is not a read of client material — the row
 *    carries a kind, a sanitized preview and a number, and opening the ticket is the audited view.
 *  - `setNotificationPrefs` writes ONE `NOTIFICATION_PREFS_CHANGED` row carrying a SUMMARY, never
 *    the JSON. "This person changed how they are reached, and roughly to what" is the fact worth
 *    keeping; a settings object an examiner would have to diff by hand is not.
 *  - `followTicket` writes `TICKET_FOLLOWED` / `TICKET_UNFOLLOWED`. Who was on the distribution for
 *    a client matter is a question a reviewer can reasonably ask, and "nobody told me" is a claim
 *    the ledger has to be able to answer.
 *
 * Everything runs through `runAction` fail-closed and each mutation is ONE transaction whose LAST
 * statement is `writeAuditMany` (shared convention 4, audit rule 2).
 */
import type {
  ActionResult,
  AuditEntry,
  FollowTicketInput,
  MarkNotificationsInput,
  QueueKey,
  SetNotificationPrefsInput,
  UserRef,
} from "@/types/domain";
import { actorFromViewer, writeAuditMany } from "@/lib/audit";
import { prisma, withTx } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { assertCan, canReadQueue, canUseInbox } from "@/lib/rbac";
import { runAction } from "@/server/action-utils";
import type { NotificationSettings } from "@/server/notifications";
import {
  followTicketSchema,
  getNotificationSettings,
  listMentionableUsers,
  markNotificationsSchema,
  prefsSummary,
  setNotificationPrefsSchema,
} from "@/server/notifications";
import { MACHINE_ACTOR_EMAILS } from "@/server/users";

/**
 * The caller's own preferences, plus the colleagues they may name as cover.
 *
 * A read wrapped in `runAction` rather than a plain read module, because the only consumer is the
 * Account sheet — a CLIENT component, which may not import a non-`.actions` `@/server/*` module
 *. It returns the signed-in person's own row and nobody else's, and the staff list it returns
 * is directory data (name, address, avatar) with no ticket, counter or record content in it.
 */
export async function loadNotificationSettings(): Promise<
  ActionResult<NotificationSettings & { backupOptions: UserRef[] }>
> {
  return runAction("loadNotificationSettings", async (viewer) => {
    assertCan(canUseInbox(viewer.groups), "inbox preferences");
    const [settings, backupOptions] = await Promise.all([
      getNotificationSettings(viewer),
      listMentionableUsers(viewer.id),
    ]);
    return { ...settings, backupOptions };
  });
}

/**
 * Marks the caller's OWN notifications read.
 *
 * Scoped by `userId` in the `where` clause rather than by checking ownership afterwards: an id
 * belonging to someone else matches zero rows and the action reports `read: 0`, which is both the
 * truthful answer and the one that leaks nothing about whether that id exists.
 *
 * `updateMany` is idempotent by construction — `readAt: null` in the filter means a second call
 * changes nothing and returns 0 rather than re-stamping a time someone already read something.
 */
export async function markNotificationsRead(
  input: MarkNotificationsInput,
): Promise<ActionResult<{ read: number }>> {
  return runAction("markNotificationsRead", async (viewer) => {
    const data = markNotificationsSchema.parse(input);
    assertCan(canUseInbox(viewer.groups), "inbox mark-read");

    const result = await prisma.notification.updateMany({
      where: {
        userId: viewer.id,
        readAt: null,
        ...(data.all === true ? {} : { id: { in: data.ids ?? [] } }),
      },
      data: { readAt: new Date() },
    });
    return { read: result.count };
  });
}

/**
 * Saves the caller's own notification preferences and availability.
 *
 * CONTRACT EXTENSION (recorded in the build record): §10 types the
 * input as `{ prefs }`, but the brief puts the out-of-office fields on the same form and B4's job
 * consumes them. Both are OPTIONAL additions, so every caller written against the contract's shape
 * still typechecks and still means exactly what it meant; omitting a field leaves the column alone,
 * which is what makes "just change my digest switch" not silently clear someone's cover.
 *
 * `outOfOfficeUntil` and `backupUserId` ride in the SAME audit row as flags rather than getting an
 * action of their own: there is no `USER_OUT_OF_OFFICE` in the catalog, the catalog is
 * foundation-owned, and inventing an unlisted action is worse than recording the change as part of
 * the preference write it arrived with.
 */
export async function setNotificationPrefs(
  input: SetNotificationPrefsInput & { outOfOfficeUntil?: string | null; backupUserId?: string | null },
): Promise<ActionResult<{ ok: true }>> {
  return runAction("setNotificationPrefs", async (viewer, ctx) => {
    const data = setNotificationPrefsSchema.parse(input);
    assertCan(canUseInbox(viewer.groups), "inbox preferences");
    const actor = actorFromViewer(viewer);

    if (data.backupUserId === viewer.id) {
      throw new ValidationError("you cannot be your own backup", {
        backupUserId: ["Choose a colleague who can pick your tickets up while you are away."],
      });
    }

    return withTx(async (tx) => {
      if (data.backupUserId !== undefined && data.backupUserId !== null) {
        const backup = await tx.user.findUnique({
          where: { id: data.backupUserId },
          select: { id: true, email: true, isActive: true },
        });
        // An inactive or machine account as cover means tickets handed to somebody who cannot work
        // them, discovered on the day the person is away. Refused here rather than at the job.
        if (backup === null || !backup.isActive || MACHINE_ACTOR_EMAILS.includes(backup.email)) {
          throw new ValidationError("that account cannot be a backup", {
            backupUserId: ["Pick an active staff account."],
          });
        }
      }

      await tx.user.update({
        where: { id: viewer.id },
        data: {
          notificationPrefs: data.prefs,
          ...(data.outOfOfficeUntil === undefined
            ? {}
            : { outOfOfficeUntil: data.outOfOfficeUntil === null ? null : new Date(data.outOfOfficeUntil) }),
          ...(data.backupUserId === undefined ? {} : { backupUserId: data.backupUserId }),
        },
      });

      const entries: AuditEntry[] = [
        {
          action: "NOTIFICATION_PREFS_CHANGED",
          entityType: "USER",
          entityId: viewer.id,
          fieldChanged: "notificationPrefs",
          oldValue: null,
          newValue: prefsSummary(data.prefs),
          metadata: {
            digest: data.prefs.digest,
            muteWhileOutOfOffice: data.prefs.muteWhileOutOfOffice,
            // Booleans, never the instant or the colleague's id: the row records THAT cover changed.
            ...(data.outOfOfficeUntil === undefined
              ? {}
              : { outOfOfficeSet: data.outOfOfficeUntil !== null }),
            ...(data.backupUserId === undefined ? {} : { backupSet: data.backupUserId !== null }),
          },
        },
      ];
      await writeAuditMany(tx, actor, ctx, entries);
      return { ok: true as const };
    });
  });
}

/**
 * Follows or unfollows a ticket, for the CALLER only.
 *
 * RECOMMENDED DEFAULT, pending confirmation (gap analysis §9, contract §13): a person may put
 * themselves on a ticket's distribution and take themselves off it, and may not put a colleague on
 * it. The legacy help desk's CC field does the latter, and the reason not to copy it is that adding someone to a
 * client matter's distribution is a supervisory act with no control around it here — `@mention`
 * already notifies a colleague once, on the record, without making them a standing recipient.
 *
 * QUEUE **READ**, not write: following is watching. Someone who can read the queue can already open
 * every ticket in it, so a follower row grants nothing they did not have — and requiring WRITE would
 * stop a compliance officer from watching the ticket they are reviewing.
 *
 * `removedAt` is a soft removal, never a delete (the table's own docstring): `TICKET_FOLLOWED` and
 * `TICKET_UNFOLLOWED` are a pair, and a row that vanished would leave the second half unreadable.
 */
export async function followTicket(input: FollowTicketInput): Promise<ActionResult<{ following: boolean }>> {
  return runAction("followTicket", async (viewer, ctx) => {
    const data = followTicketSchema.parse(input);
    const actor = actorFromViewer(viewer);

    return withTx(async (tx) => {
      const ticket = await tx.ticket.findUnique({
        where: { id: data.ticketId },
        select: { id: true, queue: { select: { key: true } } },
      });
      if (ticket === null) throw new NotFoundError("ticket not found");
      const queueKey = ticket.queue.key as QueueKey;
      assertCan(canReadQueue(viewer.groups, queueKey), `queue:read follow ${queueKey}`, ticket.id);

      const existing = await tx.ticketFollower.findUnique({
        where: { ticketId_userId: { ticketId: ticket.id, userId: viewer.id } },
        select: { id: true, removedAt: true, source: true },
      });
      const following = existing !== null && existing.removedAt === null;

      // The ledger records CHANGES, not intentions: asking for the state that already holds is a
      // success that writes nothing, the same rule `flipActive` applies in users.actions.ts.
      if (following === data.follow) return { following };

      let followerId: string;
      let source = existing?.source ?? "MANUAL";
      if (existing === null) {
        const created = await tx.ticketFollower.create({
          data: { ticketId: ticket.id, userId: viewer.id, source: "MANUAL" },
          select: { id: true },
        });
        followerId = created.id;
        source = "MANUAL";
      } else {
        await tx.ticketFollower.update({
          where: { id: existing.id },
          // Re-following by hand makes it MANUAL: the person chose it this time, whatever put them
          // on the ticket originally, and that is what the audited `source` should say.
          data: data.follow ? { removedAt: null, source: "MANUAL" } : { removedAt: new Date() },
        });
        followerId = existing.id;
        if (data.follow) source = "MANUAL";
      }

      await writeAuditMany(tx, actor, ctx, [
        {
          action: data.follow ? "TICKET_FOLLOWED" : "TICKET_UNFOLLOWED",
          entityType: "TICKET",
          entityId: ticket.id,
          ticketId: ticket.id,
          fieldChanged: "follower",
          oldValue: data.follow ? null : viewer.email,
          newValue: data.follow ? viewer.email : null,
          metadata: { followerId, source },
        },
      ]);

      return { following: data.follow };
    });
  });
}
