/**
 * Notification core — node, layer L4.
 *
 * Owned by slice **B1**. This file replaces the foundation's no-op stub; the five call sites in
 * `src/server/{ingest,comments.actions,tickets.actions}.ts` are unchanged and stay unchanged.
 *
 * THE TWO RULES THE STUB'S DOCSTRING STATED, KEPT VERBATIM IN BEHAVIOUR:
 *
 *  1. **`notifyFromEvent` runs INSIDE the caller's transaction and RETURNS its `AuditEntry[]`**
 *     rather than writing them, exactly as `enqueueDelivery` does (CONTRACT §3 rule 2). Two
 *     `writeAuditMany` calls in one transaction re-acquire the chain trigger's advisory lock for
 *     nothing, and the caller's trailing `writeAuditMany` must stay the last statement.
 *  2. **Fan-out to Slack and web push happens AFTER commit**, in `notifications-dispatch.ts`. A
 *     Slack DM sent for a transaction that rolled back cannot be recalled. What happens in the
 *     transaction is the durable in-app row; everything else is derived from it later.
 *
 * WHAT IS AND IS NOT AUDITED (CONTRACT §3 rule 3). A `Notification` row is DERIVED from an event
 * that is already on the ledger — the assignment, the comment, the status change — so creating one
 * writes no audit row, and reading the inbox or marking a row read writes none either. What IS
 * audited is the preference change, the follow and the unfollow: who was on the distribution for a
 * client matter is a question a reviewer can reasonably ask, and "I was never told" is a claim the
 * ledger has to be able to answer. That is why auto-follow returns `TICKET_FOLLOWED` entries from
 * inside the same transaction rather than quietly inserting rows.
 *
 * NOT A VIEW. The inbox renders notification rows — a kind and a
 * timestamp always; the WM number, the subject the dashboard already shows them AND the stored
 * preview only for tickets in the viewer's readable queues. No description, no comment body, no
 * requester. Opening the ticket is the audited view, exactly as it is from a queue list. The
 * preview is inside the gate rather than outside it because a `MENTION` preview is NOT a subject
 * line: it is a window on the INTERNAL note (`mentionSnippet`), so showing it to someone the queue
 * grant excludes would hand them more of the record than the subject they are being refused.
 */
import { z } from "zod";
import type {
  AuditEntry,
  FollowerSource,
  InboxPage,
  NotificationChannel,
  NotificationDTO,
  NotificationKind,
  NotificationPrefs,
  QueueKey,
  TicketFollowerDTO,
  UserRef,
  Viewer,
} from "@/types/domain";
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KIND_LABELS,
  NOTIFICATION_KINDS,
  NOTIFICATION_PREFS_DEFAULT,
  QUEUE_KEYS,
  WAVE_B_LIMITS,
} from "@/types/domain";
import type { DbTx } from "@/lib/db";
import { prisma } from "@/lib/db";
import { ForbiddenError } from "@/lib/errors";
import { logError } from "@/lib/logger";
import { sanitizePII } from "@/lib/pii";
import { canReadQueue, canUseInbox } from "@/lib/rbac";
import { parseMentions, resolveMentionOwners } from "@/lib/mentions";
import { MACHINE_ACTOR_EMAILS } from "@/server/users";

// ---------------------------------------------------------------------------
// Contract types — unchanged from the foundation stub
// ---------------------------------------------------------------------------

/** One notifiable event. `recipientIds` is resolved by the caller when it already knows (assignee). */
export type NotificationEvent = {
  kind: NotificationKind;
  ticketId: string;
  commentId?: string | null;
  /** Sanitized, <= WAVE_B_LIMITS.notificationPreviewChars. The DB CHECK is the backstop. */
  preview: string;
  /** Who caused it. Null for a job. */
  actorId: string | null;
  /** Explicit recipients. When omitted, B1 resolves followers / mentions / the assignee itself. */
  recipientIds?: string[];
  /** Collapses repeats: one row per (userId, dedupeKey). */
  dedupeKey?: string | null;
};

export type NotifyResult = { created: number; auditEntries: AuditEntry[] };

// ---------------------------------------------------------------------------
// Preview handling
// ---------------------------------------------------------------------------

/**
 * Sanitized and bounded to the DB CHECK. Free text reaches this column from a comment body (the
 * mention snippet) and from call-site literals, so it goes through `sanitizePII` like every other
 * persisted string before the 200-character cap rather than after — truncating first could cut
 * a card number in half and store the half that still looks like one.
 */
export function toPreview(raw: string): string {
  const sanitized = sanitizePII(raw.replace(/\s+/g, " ").trim()).text;
  if (sanitized.length <= WAVE_B_LIMITS.notificationPreviewChars) return sanitized;
  return `${sanitized.slice(0, WAVE_B_LIMITS.notificationPreviewChars - 1)}…`;
}

/** Characters of the note either side of a mention that make the snippet readable. */
const MENTION_SNIPPET_RADIUS = 80;

/** "…asked @mia.ops to confirm the wire before…" — a window on the note, never the whole note. */
export function mentionSnippet(body: string, at: number): string {
  const from = Math.max(0, at - MENTION_SNIPPET_RADIUS);
  const to = Math.min(body.length, at + MENTION_SNIPPET_RADIUS);
  const core = body.slice(from, to).trim();
  return toPreview(`${from > 0 ? "…" : ""}${core}${to < body.length ? "…" : ""}`);
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

/**
 * `partialRecord`, not `record`: in zod 4 a record keyed by an enum is EXHAUSTIVE, so
 * `z.record(z.enum(...), z.boolean())` would reject every stored object that omits a key — which is
 * every stored object, because `NotificationPrefs` types both levels as `Partial`. Getting this
 * wrong is silent: the parse fails, `readNotificationPrefs` falls back to the defaults, and a
 * person's saved preferences quietly stop applying.
 */
const prefsChannelSchema = z.partialRecord(
  z.enum(NOTIFICATION_CHANNELS as unknown as [NotificationChannel, ...NotificationChannel[]]),
  z.boolean(),
);

/**
 * The stored shape. `catch`-free on purpose: a malformed column is not repaired silently, it is
 * REPLACED by the defaults at read time (`readNotificationPrefs`), because a half-parsed preference
 * object is how someone ends up silently un-notified.
 */
export const notificationPrefsSchema: z.ZodType<NotificationPrefs, unknown> = z.object({
  channels: z.partialRecord(
    z.enum(NOTIFICATION_KINDS as unknown as [NotificationKind, ...NotificationKind[]]),
    prefsChannelSchema,
  ),
  digest: z.boolean(),
  muteWhileOutOfOffice: z.boolean(),
});

/**
 * `User.notificationPrefs` as a value. A null column means THE DEFAULTS, never "notify nothing"
 * (the constant's own docstring says so, and this is the one function that honours it); an
 * unparseable column means the same, because the alternative is a person who stops being told
 * things because of a bad write months ago.
 */
export function readNotificationPrefs(raw: unknown): NotificationPrefs {
  if (raw === null || raw === undefined) return NOTIFICATION_PREFS_DEFAULT;
  const parsed = notificationPrefsSchema.safeParse(raw);
  return parsed.success ? parsed.data : NOTIFICATION_PREFS_DEFAULT;
}

/**
 * Whether `kind` may reach `channel` for these preferences.
 *
 * `IN_APP` is unconditional and is not configurable — a notification that could be switched off
 * entirely would make "you were told" unprovable, which is the whole reason the inbox row exists
 * (`NOTIFICATION_PREFS_DEFAULT`'s docstring). A missing key falls back to the default, never to
 * `false`: adding a ninth `NotificationKind` must not silently mute it for everyone who has ever
 * saved their preferences.
 */
export function prefAllows(prefs: NotificationPrefs, kind: NotificationKind, channel: NotificationChannel): boolean {
  if (channel === "IN_APP") return true;
  const configured = prefs.channels[kind]?.[channel];
  if (configured !== undefined) return configured;
  return NOTIFICATION_PREFS_DEFAULT.channels[kind]?.[channel] ?? false;
}

/**
 * The `newValue` of `NOTIFICATION_PREFS_CHANGED` — a SUMMARY, never the JSON.
 *
 * The ledger's job here is to record THAT someone changed how they are reached and roughly what
 * that means, not to carry a copy of a settings object an examiner would have to diff by hand.
 */
export function prefsSummary(prefs: NotificationPrefs): string {
  const slack = NOTIFICATION_KINDS.filter((k) => prefAllows(prefs, k, "SLACK_DM")).length;
  const push = NOTIFICATION_KINDS.filter((k) => prefAllows(prefs, k, "WEB_PUSH")).length;
  return [
    `digest ${prefs.digest ? "on" : "off"}`,
    `Slack DM ${slack}/${NOTIFICATION_KINDS.length}`,
    `push ${push}/${NOTIFICATION_KINDS.length}`,
    `mute while out of office ${prefs.muteWhileOutOfOffice ? "on" : "off"}`,
  ].join("; ");
}

/** Preferences plus the availability fields that live beside them on `User`. */
export type NotificationSettings = {
  prefs: NotificationPrefs;
  outOfOfficeUntil: string | null;
  backupUserId: string | null;
};

/** The signed-in person's own settings, for the account sheet. Their own row only — never anyone else's. */
export async function getNotificationSettings(viewer: Viewer): Promise<NotificationSettings> {
  const row = await prisma.user.findUnique({
    where: { id: viewer.id },
    select: { notificationPrefs: true, outOfOfficeUntil: true, backupUserId: true },
  });
  return {
    prefs: readNotificationPrefs(row?.notificationPrefs ?? null),
    outOfOfficeUntil: row?.outOfOfficeUntil?.toISOString() ?? null,
    backupUserId: row?.backupUserId ?? null,
  };
}

/**
 * Who may be chosen as a backup while someone is away, and who may be `@mentioned`: ACTIVE, non-machine
 * staff accounts. A departed colleague's handle therefore notifies nobody and cannot be named as
 * cover — which is the point of `deactivateUser` writing `isActive = false` rather than a note.
 *
 * `db` is the client to read on, and it is NOT decoration. The standalone read (the account sheet's
 * backup picker) leaves it out and gets the `prisma` singleton; `notifyFromEvent` passes its caller's
 * `tx`, because the same query issued on the global client from inside an interactive transaction
 * takes a SECOND pooled connection while the first is still held — the classic Prisma nested-connection
 * stall on a small pool — and reads a snapshot that cannot see the transaction's own uncommitted
 * writes, so someone deactivated earlier in the very same request would still be offered as a mention
 * target. The parameter is trailing rather than leading so the existing one-argument call sites are
 * unchanged.
 */
export async function listMentionableUsers(
  excludeUserId?: string,
  db: DbTx = prisma,
): Promise<UserRef[]> {
  const rows = await db.user.findMany({
    where: {
      isActive: true,
      email: { notIn: [...MACHINE_ACTOR_EMAILS] },
      ...(excludeUserId === undefined ? {} : { id: { not: excludeUserId } }),
    },
    select: { id: true, name: true, email: true, image: true },
    orderBy: [{ name: "asc" }, { email: "asc" }],
  });
  return rows;
}

// ---------------------------------------------------------------------------
// notifyFromEvent
// ---------------------------------------------------------------------------

const FOLLOWER_SELECT = { id: true, userId: true, removedAt: true } as const;

type FollowTouch = { userId: string; source: FollowerSource };

/**
 * Makes each named person a live follower of the ticket and returns the audit entries for the ones
 * that actually changed.
 *
 * Re-following someone who is already following writes nothing: the ledger records CHANGES, not
 * intentions (the same rule `flipActive` applies in `users.actions.ts`). A soft-removed row is
 * revived rather than re-created, because the unique key is `(ticketId, userId)` and the removal is
 * a state the row passed through, not a row that was deleted.
 */
async function ensureFollowers(
  tx: DbTx,
  ticketId: string,
  touches: readonly FollowTouch[],
): Promise<AuditEntry[]> {
  if (touches.length === 0) return [];

  // One row per user: MENTION beats AUTHOR beats ASSIGNEE only in the sense of "first writer wins",
  // which keeps the audited `source` equal to the reason the person first appeared here.
  const wanted = new Map<string, FollowerSource>();
  for (const t of touches) if (!wanted.has(t.userId)) wanted.set(t.userId, t.source);

  const ids = [...wanted.keys()];
  const [existing, users] = await Promise.all([
    tx.ticketFollower.findMany({ where: { ticketId, userId: { in: ids } }, select: FOLLOWER_SELECT }),
    tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } }),
  ]);
  const emailById = new Map(users.map((u) => [u.id, u.email] as const));
  const existingByUser = new Map(existing.map((f) => [f.userId, f] as const));

  const entries: AuditEntry[] = [];
  for (const [userId, source] of wanted) {
    const email = emailById.get(userId);
    if (email === undefined) continue; // the user row vanished between reads; nothing to follow with
    const already = existingByUser.get(userId);

    let followerId: string;
    if (already === undefined) {
      const created = await tx.ticketFollower.create({
        data: { ticketId, userId, source },
        select: { id: true },
      });
      followerId = created.id;
    } else if (already.removedAt !== null) {
      await tx.ticketFollower.update({
        where: { id: already.id },
        data: { removedAt: null, source },
      });
      followerId = already.id;
    } else {
      continue; // already following: no change, no row
    }

    entries.push({
      action: "TICKET_FOLLOWED",
      entityType: "TICKET",
      entityId: ticketId,
      ticketId,
      fieldChanged: "follower",
      oldValue: null,
      newValue: email,
      metadata: { followerId, source },
    });
  }
  return entries;
}

type PlannedRow = {
  userId: string;
  kind: NotificationKind;
  preview: string;
  dedupeKey: string | null;
};

/**
 * Creates the in-app rows for one event and returns what it wrote plus the audit entries the CALLER
 * must append to its own trailing `writeAuditMany`.
 *
 * NEVER THROWS, and the boundary of that promise is worth stating precisely rather than implying
 * more than it can deliver: a logic failure here (a missing user, an over-long preview, a comment
 * that vanished) is caught, logged without content, and returns "nothing notified", so a
 * notification can never roll back the ticket change it describes. A Postgres ERROR inside the
 * caller's interactive transaction aborts that transaction at the database, and no `catch` in
 * application code can undo it — the caller's next statement fails either way. That is the correct
 * outcome and not a gap: the ticket change and the record of who was told about it are one act.
 */
export async function notifyFromEvent(tx: DbTx, event: NotificationEvent): Promise<NotifyResult> {
  try {
    return await notifyFromEventUnsafe(tx, event);
  } catch (e) {
    logError("notifications", e, { op: "notifyFromEvent", kind: event.kind });
    return { created: 0, auditEntries: [] };
  }
}

async function notifyFromEventUnsafe(tx: DbTx, event: NotificationEvent): Promise<NotifyResult> {
  const actorId = event.actorId;
  const basePreview = toPreview(event.preview);

  // --- 1. @mentions, INTERNAL notes only ------------------------------------------------------
  //
  // Parsed HERE rather than at the call site so the five foundation-owned hooks never have to know
  // that mentions exist: the event carries a commentId, and everything about who was named is
  // derived from the stored body. PUBLIC replies are deliberately excluded — a client-facing
  // message is correspondence, and an `@` in it is a typo or an address the client wrote, never a
  // desk instruction.
  const mentioned: UserRef[] = [];
  const mentionPreviews = new Map<string, string>();
  if (event.commentId) {
    const comment = await tx.comment.findUnique({
      where: { id: event.commentId },
      select: { visibility: true, body: true, authorId: true },
    });
    if (comment && comment.visibility === "INTERNAL") {
      const tokens = parseMentions(comment.body);
      if (tokens.length > 0) {
        const candidates = await listMentionableUsers(actorId ?? undefined, tx);
        for (const hit of resolveMentionOwners(tokens, candidates)) {
          mentioned.push(hit.user);
          mentionPreviews.set(hit.user.id, mentionSnippet(comment.body, hit.mention.start));
        }
      }
    }
  }
  const mentionedIds = new Set(mentioned.map((u) => u.id));

  // --- 2. Recipients of the event itself -------------------------------------------------------
  let baseIds: string[];
  if (event.recipientIds !== undefined) {
    baseIds = [...new Set(event.recipientIds)];
  } else {
    const [followers, ticket] = await Promise.all([
      tx.ticketFollower.findMany({
        where: { ticketId: event.ticketId, removedAt: null },
        select: { userId: true },
      }),
      tx.ticket.findUnique({ where: { id: event.ticketId }, select: { assigneeId: true } }),
    ]);
    baseIds = [...new Set([...followers.map((f) => f.userId), ...(ticket?.assigneeId ? [ticket.assigneeId] : [])])];
  }

  // The actor never notifies themselves — including through an explicit `recipientIds`, so
  // "assign to me" stays silent — and a mention outranks the follow, so nobody gets two rows for
  // one comment.
  baseIds = baseIds.filter((id) => id !== actorId && !mentionedIds.has(id));

  // --- 3. Only ACTIVE people are notified ------------------------------------------------------
  const candidateIds = [...new Set([...baseIds, ...mentionedIds])];
  if (candidateIds.length === 0) return { created: 0, auditEntries: [] };
  const active = await tx.user.findMany({
    where: { id: { in: candidateIds }, isActive: true },
    select: { id: true },
  });
  const activeIds = new Set(active.map((u) => u.id));

  const planned: PlannedRow[] = [];
  for (const user of mentioned) {
    if (!activeIds.has(user.id)) continue;
    planned.push({
      userId: user.id,
      kind: "MENTION",
      preview: mentionPreviews.get(user.id) ?? basePreview,
      // A mention is one-per-comment by construction; keying it stops a retry of the same submit
      // from producing a second row.
      dedupeKey: event.commentId ? `mention:${event.commentId}` : null,
    });
  }
  for (const userId of baseIds) {
    if (!activeIds.has(userId)) continue;
    planned.push({ userId, kind: event.kind, preview: basePreview, dedupeKey: event.dedupeKey ?? null });
  }

  // --- 4. Auto-follow --------------------------------------------------------------------------
  //
  // Three sources, all of them a fact rather than a preference: you authored a
  // comment on it, you were assigned it, or you were named in it. MANUAL is the only source a
  // person creates, and the only one `followTicket` removes.
  const touches: FollowTouch[] = [];
  for (const user of mentioned) if (activeIds.has(user.id)) touches.push({ userId: user.id, source: "MENTION" });
  if (event.kind === "ASSIGNED") {
    for (const userId of baseIds) if (activeIds.has(userId)) touches.push({ userId, source: "ASSIGNEE" });
  }
  if (event.commentId && actorId !== null) touches.push({ userId: actorId, source: "AUTHOR" });
  const auditEntries = await ensureFollowers(tx, event.ticketId, touches);

  // --- 5. The rows ------------------------------------------------------------------------------
  if (planned.length === 0) return { created: 0, auditEntries };
  const result = await tx.notification.createMany({
    data: planned.map((p) => ({
      userId: p.userId,
      kind: p.kind,
      actorId,
      ticketId: event.ticketId,
      commentId: event.commentId ?? null,
      preview: p.preview,
      dedupeKey: p.dedupeKey,
      // What has ACTUALLY happened at commit time is the in-app row. Slack and push are appended by
      // the dispatcher once they have been delivered, which is also how it knows what is still
      // pending (see notifications-dispatch.ts).
      channels: ["IN_APP" as NotificationChannel],
    })),
    // ON CONFLICT DO NOTHING. A duplicate `(userId, dedupeKey)` is a repeat, not an error — and a
    // P2002 inside the caller's transaction would abort a ticket change over a notification.
    skipDuplicates: true,
  });

  return { created: result.count, auditEntries };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Unread rows for the inbox badge. Not a view — it returns a count and no record content. */
export async function unreadNotificationCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null, dismissedAt: null } });
}

export type InboxQuery = {
  /** Empty or omitted means every kind. */
  kinds?: NotificationKind[];
  unreadOnly?: boolean;
  /** `<createdAt ISO>|<id>` from the previous page's `nextCursor`. */
  cursor?: string | null;
  limit?: number;
};

export const INBOX_PAGE_SIZE = 25;
const INBOX_MAX_PAGE_SIZE = 100;

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.toISOString()}|${row.id}`;
}

/** Tolerant by design: a hand-edited cursor pages from the top rather than failing the render. */
export function decodeCursor(raw: string | null | undefined): { createdAt: Date; id: string } | null {
  if (!raw) return null;
  const at = raw.indexOf("|");
  if (at <= 0) return null;
  const createdAt = new Date(raw.slice(0, at));
  const id = raw.slice(at + 1);
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) return null;
  return { createdAt, id };
}

const INBOX_INCLUDE = {
  actor: { select: { id: true, name: true, email: true, image: true } },
  ticket: { select: { id: true, number: true, subject: true, queue: { select: { key: true } } } },
} as const;

/**
 * One page of the signed-in person's inbox, newest first.
 *
 * QUEUE SCOPING, and why the row is shown either way: a notification is addressed to a person, so
 * hiding one because they have since lost access to the queue would make the unread badge disagree
 * with the list and leave "you have 3 unread" pointing at nothing. The row is rendered; the SUBJECT,
 * the deep link and the stored PREVIEW are withheld unless the viewer can read the ticket's queue,
 * which is the same boundary every other list in the app draws.
 */
export async function listInbox(viewer: Viewer, query: InboxQuery = {}): Promise<InboxPage> {
  if (!canUseInbox(viewer.groups)) throw new ForbiddenError("Forbidden: inbox");

  const take = Math.min(Math.max(query.limit ?? INBOX_PAGE_SIZE, 1), INBOX_MAX_PAGE_SIZE);
  const cursor = decodeCursor(query.cursor);
  const kinds = query.kinds?.filter((k) => NOTIFICATION_KINDS.includes(k)) ?? [];

  const rows = await prisma.notification.findMany({
    where: {
      userId: viewer.id,
      dismissedAt: null,
      ...(query.unreadOnly === true ? { readAt: null } : {}),
      ...(kinds.length > 0 ? { kind: { in: kinds } } : {}),
      ...(cursor === null
        ? {}
        : {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }),
    },
    include: INBOX_INCLUDE,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
  });

  const page = rows.slice(0, take);
  const unread = await unreadNotificationCount(viewer.id);

  return {
    rows: page.map((r) => toNotificationDTO(r, viewer)),
    unread,
    nextCursor: rows.length > take && page.length > 0 ? encodeCursor(page[page.length - 1]) : null,
  };
}

type InboxRow = {
  id: string;
  kind: NotificationKind;
  preview: string;
  createdAt: Date;
  readAt: Date | null;
  dismissedAt: Date | null;
  commentId: string | null;
  channels: NotificationChannel[];
  actor: UserRef | null;
  ticket: { id: string; number: number; subject: string; queue: { key: string } } | null;
};

/** The stored key is a Prisma enum; this is the narrowing `canReadQueue` needs, with no cast. */
function isQueueKey(value: string | undefined): value is QueueKey {
  return value !== undefined && (QUEUE_KEYS as readonly string[]).includes(value);
}

export function toNotificationDTO(row: InboxRow, viewer: Viewer): NotificationDTO {
  const queueKey = row.ticket?.queue.key;
  const readable = isQueueKey(queueKey) && canReadQueue(viewer.groups, queueKey);
  return {
    id: row.id,
    kind: row.kind,
    // Inside the gate, with the subject and the number. A preview is a SUBJECT LINE only for the
    // kinds that were raised from one; for `MENTION` it is `mentionSnippet` — a +/-80-character
    // window on the stored INTERNAL note — so rendering it to a viewer the queue grant excludes
    // would hand them up to 160 characters of the note while refusing them the subject, which is
    // strictly more record content than the field being withheld. A mention can legitimately name
    // someone outside the queue today (`listMentionableUsers` is the whole active staff directory
    // and `QUEUE_ACCESS.client_services.ADVICE` is null), so this is reachable without any group
    // change. Falling back to the kind label alone is the same shape `slackDmLine` sends, and it is
    // what the row's own badge already says: the person is told they were named, not what was said.
    preview: readable ? row.preview : NOTIFICATION_KIND_LABELS[row.kind],
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
    dismissedAt: row.dismissedAt?.toISOString() ?? null,
    actor: row.actor,
    ticketId: row.ticket?.id ?? null,
    // Withheld together: the number IS the deep link, so a row the viewer may not open shows
    // neither, and the inbox says so in words rather than rendering a link that 404s.
    ticketNumber: readable ? (row.ticket?.number ?? null) : null,
    ticketSubject: readable ? (row.ticket?.subject ?? null) : null,
    commentId: row.commentId,
    channels: row.channels,
  };
}

/** Live followers of one ticket, longest-standing first. Staff identities only — no record content. */
export async function listTicketFollowers(ticketId: string): Promise<TicketFollowerDTO[]> {
  const rows = await prisma.ticketFollower.findMany({
    where: { ticketId, removedAt: null },
    select: {
      source: true,
      createdAt: true,
      user: { select: { id: true, name: true, email: true, image: true } },
    },
    orderBy: [{ createdAt: "asc" }],
  });
  return rows.map((r) => ({ user: r.user, source: r.source, since: r.createdAt.toISOString() }));
}

/** Whether `userId` is following `ticketId` right now. Drives the Follow / Following control. */
export async function isFollowing(ticketId: string, userId: string): Promise<boolean> {
  const row = await prisma.ticketFollower.findUnique({
    where: { ticketId_userId: { ticketId, userId } },
    select: { removedAt: true },
  });
  return row !== null && row.removedAt === null;
}

// ---------------------------------------------------------------------------
// Input validation (the schemas the actions parse with; kept beside the reads, not in the
// foundation-owned src/server/validation.ts
// ---------------------------------------------------------------------------

export const markNotificationsSchema = z
  .object({
    ids: z.array(z.string().min(1).max(64)).min(1).max(200).optional(),
    all: z.literal(true).optional(),
  })
  .refine((v) => v.ids !== undefined || v.all === true, {
    message: "Pass ids or all: true",
    path: ["ids"],
  });

export const setNotificationPrefsSchema = z.object({
  prefs: notificationPrefsSchema,
  /** ISO instant, or null to clear. Absent means "leave it alone". */
  outOfOfficeUntil: z.string().datetime().nullable().optional(),
  backupUserId: z.string().min(1).max(64).nullable().optional(),
});

export const followTicketSchema = z.object({
  ticketId: z.string().min(1).max(64),
  follow: z.boolean(),
});
