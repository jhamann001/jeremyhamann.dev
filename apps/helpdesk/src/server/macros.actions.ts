"use server";

/**
 * Macro administration — `"use server"`, node, layer L4 (the build record, Decision #68
 * `macro:admin`; I3, I4, I5).
 *
 * Before this, changing a sentence a client reads meant a pull request, CI, an approval and a migrate
 * job — and the seeder re-applied the macro bodies on every deploy, so a database edit made to get
 * around that was silently reverted the next time anything shipped. The three actions here replace
 * that loop, and `prisma/seed.ts` becomes create-if-missing so a body edited at runtime is never
 * overwritten by a deployment.
 *
 * `macro:admin` is held by `ops_team` and `compliance_officers` — the one mutating capability
 * compliance holds, deliberately, because macro bodies are client-facing WORDING and the CCO owns
 * that. It touches no ticket and no client record, so "compliance is read-plus-annotate" is unchanged
 * for tickets.
 *
 * Every action is one transaction whose LAST statement is a single `writeAuditMany` (audit rule 2).
 * `MACRO_UPDATED` writes one row per changed field and the `body` row carries the OLD text as well as
 * the new, so the ledger alone can reconstruct what a client would have been sent on any past date —
 * which is the whole reason runtime editing is allowed at all.
 *
 * That promise needs a channel wider than `oldValue`/`newValue`. Those columns go through
 * `prepareAuditValue`, which truncates at `AUDIT_VALUE_MAX_CHARS` (4,000), while `macroBodySchema`
 * accepts `MACRO_BODY_MAX` (20,000) — so a long disclosure template would have been recorded as its
 * first ~3,987 characters and then made unrecoverable by the very update that logged it (`Macro` has
 * no version history, the seeder is create-if-missing, and `AuditLog` is append-only). Every row that
 * carries a body therefore also carries `metadata.bodyFull`, which is JSONB and is NOT truncated:
 * `oldValue`/`newValue` stay the human-readable summary, and `metadata.bodyFull.previous` /
 * `.current` are the byte-for-byte record. `bodyTruncatedInValue` says outright which of the two a
 * reader must use. (`prepareAuditMetadata` still PII-sanitizes the JSON, as it must — but a body
 * that trips the sanitizer never reaches here: `sanitizedField` refuses it at the keyboard.)
 *
 * NOT implemented, deliberately: a delete. A macro that has been applied is referenced by
 * `Comment.macroId`, and `MACRO_APPLIED` rows point at it; retiring (`isActive = false`) removes it
 * from the composer's picker and leaves the history intact.
 */
import { Prisma } from "@prisma/client";
import type {
  ActionResult,
  AuditEntry,
  CommentVisibility,
  DisclaimerKey,
  MacroAdminInput,
  QueueKey,
  SetMacroActiveInput,
  UpdateMacroInput,
} from "@/types/domain";
import type { SetMacroActionsInput } from "@/server/macros-apply";
import {
  canonicalMacroActions,
  macroActionsAuditValue,
  parseMacroActions,
  setMacroActionsSchema,
} from "@/server/macros-apply";
import { AUDIT_VALUE_MAX_CHARS, actorFromViewer, writeAuditMany } from "@/lib/audit";
import type { DbTx } from "@/lib/db";
import { withTx } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { sanitizePII } from "@/lib/pii";
import { assertCan, canAdminMacros } from "@/lib/rbac";
import { runAction } from "@/server/action-utils";
import {
  macroAdminSchema,
  macroChannelDisclaimerError,
  setMacroActiveSchema,
  unknownPlaceholders,
  updateMacroSchema,
} from "@/server/macros";

// ---------------------------------------------------------------------------
// Module-private helpers (a "use server" module exports async functions only — guardrail G4)
// ---------------------------------------------------------------------------

const MACRO_SELECT = {
  id: true,
  key: true,
  title: true,
  body: true,
  channel: true,
  disclaimerKey: true,
  isActive: true,
  sortOrder: true,
  queueId: true,
  queue: { select: { key: true } },
} as const;

type MacroRow = {
  id: string;
  key: string;
  title: string;
  body: string;
  channel: CommentVisibility;
  disclaimerKey: DisclaimerKey;
  isActive: boolean;
  sortOrder: number;
  queueId: string | null;
  queue: { key: QueueKey } | null;
};

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === "P2002";
}

/**
 * Sanitizes a free-text field before it is persisted and refuses anything the sanitizer touched.
 *
 * Refusing rather than silently storing the redacted text is the right call HERE specifically: a
 * macro is a template that has not met a client yet, so a digit run that scans as an account or card
 * number is somebody pasting a real value into a reusable template — a mistake worth stopping at the
 * keyboard, not a client's own words that must be kept as written.
 *
 * DECISION #116 NARROWED WHAT THIS CATCHES, and the narrowing was not aimed here. The decision is
 * about client wire instructions on a ticket; this gate is template hygiene. It rides on `sanitizePII`,
 * so it stopped refusing routing numbers, dates of birth, passport and licence numbers on the same
 * day — a real macro body reading "wire to our operating bank, routing 021000021" is now stored and
 * rendered into every client email that macro sends. Whether that should be refused is a separate
 * question from whether a client's routing number should be redacted; if the desk wants it back, this
 * needs its OWN predicate rather than the sanitizer's. The message below names only what it still
 * catches, because an operator who reads "routing" in a refusal that no longer fires on routing
 * numbers draws the wrong conclusion about what the desk checks.
 */
function sanitizedField(raw: string, field: string, label: string): string {
  const result = sanitizePII(raw);
  if (result.redacted) {
    throw new ValidationError(`${label} looks like it contains client data`, {
      [field]: [
        `That ${label.toLowerCase()} contains ${result.count} value${result.count === 1 ? "" : "s"} that look like ` +
          "an account, card or Social Security number. A macro is a reusable template — take the real " +
          "value out and use a placeholder or plain words instead.",
      ],
    });
  }
  return result.text;
}

/** Every `{{…}}` the renderer would ship verbatim is a bug a client would read. */
function assertTemplateResolves(body: string): void {
  const unknown = unknownPlaceholders(body);
  if (unknown.length > 0) {
    throw new ValidationError("the body contains placeholders the desk cannot fill", {
      body: [
        `${unknown.join(", ")} would be sent to the client exactly as written. Use {{ticket.number}}, ` +
          "{{requester.name}}, {{requester.firstName}}, {{agent.name}} or {{today}}.",
      ],
    });
  }
}

function assertChannelDisclaimer(channel: CommentVisibility, disclaimerKey: DisclaimerKey): void {
  const message = macroChannelDisclaimerError(channel, disclaimerKey);
  if (message !== null) throw new ValidationError(message, { disclaimerKey: [message] });
}

/** `queueKey` → `Queue.id`, or null for a macro offered in every queue. An unknown key is a 404. */
async function resolveQueueId(tx: DbTx, queueKey: QueueKey | null): Promise<string | null> {
  if (queueKey === null) return null;
  const queue = await tx.queue.findUnique({ where: { key: queueKey }, select: { id: true } });
  if (!queue) throw new NotFoundError(`queue not found: ${queueKey}`);
  return queue.id;
}

async function loadMacro(tx: DbTx, macroId: string): Promise<MacroRow> {
  const macro = await tx.macro.findUnique({ where: { id: macroId }, select: MACRO_SELECT });
  if (!macro) throw new NotFoundError("macro not found");
  return macro;
}

/** One `MACRO_UPDATED` row per changed field, old and new — the shape `TICKET_FIELD_CHANGED` uses. */
function fieldEntry(macroId: string, fieldChanged: string, oldValue: string | null, newValue: string | null): AuditEntry {
  return {
    action: "MACRO_UPDATED",
    entityType: "MACRO",
    entityId: macroId,
    fieldChanged,
    oldValue,
    newValue,
  };
}

/**
 * The shape of the `metadata` on every audit row that carries macro wording. Not exported: a
 * `"use server"` module's exports must all be async functions (guardrail G4), and no caller needs it —
 * readers of the ledger see plain JSONB.
 */
type MacroBodyAuditMetadata = {
  /** The complete wording, untruncated. `previous` is null on a create. */
  bodyFull: { previous: string | null; current: string };
  /** Character counts, so a reader can see at a glance that nothing was lost. */
  bodyChars: { previous: number | null; current: number };
  /**
   * True when `oldValue`/`newValue` on this row were cut by `AUDIT_VALUE_MAX_CHARS`. When it is true,
   * `bodyFull` is the only complete copy; when it is false, the two agree.
   */
  bodyTruncatedInValue: boolean;
};

/**
 * `metadata` for a row whose `fieldChanged` is `"body"`.
 *
 * Written on EVERY body row, not only the long ones: a uniform rule ("the full wording is always at
 * `metadata.bodyFull`") is what an examiner can be handed, whereas "look in the column, unless it was
 * long, in which case look in the JSON" is a footgun in a ledger nobody can repair after the fact.
 * Macro edits are an admin action measured in tens per year, so the duplication costs nothing.
 */
function bodyAuditMetadata(previous: string | null, current: string): MacroBodyAuditMetadata {
  const longest = Math.max(previous?.length ?? 0, current.length);
  return {
    bodyFull: { previous, current },
    bodyChars: { previous: previous === null ? null : previous.length, current: current.length },
    bodyTruncatedInValue: longest > AUDIT_VALUE_MAX_CHARS,
  };
}

/** The `MACRO_UPDATED` row for a body change: the summary in the columns, the full wording in metadata. */
function bodyEntry(macroId: string, previous: string, current: string): AuditEntry {
  return { ...fieldEntry(macroId, "body", previous, current), metadata: bodyAuditMetadata(previous, current) };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * A new macro. The key is unique and immutable; a collision is a CONFLICT rather than an overwrite,
 * because the colliding row may be a RETIRED macro whose wording an examiner still needs.
 */
export async function createMacro(input: MacroAdminInput): Promise<ActionResult<{ id: string }>> {
  return runAction("createMacro", async (viewer, ctx) => {
    const data = macroAdminSchema.parse(input);
    assertCan(canAdminMacros(viewer.groups), "macro:admin create");

    const title = sanitizedField(data.title, "title", "Title");
    const body = sanitizedField(data.body, "body", "Body");
    assertTemplateResolves(body);
    assertChannelDisclaimer(data.channel, data.disclaimerKey);

    const actor = actorFromViewer(viewer);

    return withTx(async (tx) => {
      const queueId = await resolveQueueId(tx, data.queueKey);

      const existing = await tx.macro.findUnique({ where: { key: data.key }, select: { id: true, isActive: true } });
      if (existing) {
        throw new ConflictError(
          existing.isActive
            ? `a macro with the key "${data.key}" already exists`
            : `a retired macro with the key "${data.key}" already exists — restore it instead of recreating it`,
        );
      }

      let macro: { id: string };
      try {
        macro = await tx.macro.create({
          data: {
            key: data.key,
            title,
            queueId,
            body,
            channel: data.channel,
            disclaimerKey: data.disclaimerKey,
            isActive: true,
            sortOrder: data.sortOrder,
            updatedById: viewer.id,
          },
          select: { id: true },
        });
      } catch (e) {
        // Lost a race with another admin between the lookup above and this insert.
        if (isUniqueViolation(e)) throw new ConflictError(`a macro with the key "${data.key}" already exists`);
        throw e;
      }

      await writeAuditMany(tx, actor, ctx, [
        {
          action: "MACRO_CREATED",
          entityType: "MACRO",
          entityId: macro.id,
          fieldChanged: "body",
          oldValue: null,
          newValue: body,
          metadata: {
            key: data.key,
            title,
            queueKey: data.queueKey,
            channel: data.channel,
            disclaimerKey: data.disclaimerKey,
            sortOrder: data.sortOrder,
            // `newValue` above is truncated at AUDIT_VALUE_MAX_CHARS; this is the untruncated copy.
            ...bodyAuditMetadata(null, body),
          },
        },
      ]);

      return { id: macro.id };
    });
  });
}

/**
 * Edits an existing macro. Fields left `undefined` are untouched; a field submitted with the value it
 * already holds writes no row, so the ledger records changes rather than saves.
 *
 * There is no version token: `UpdateMacroInput` has none and the contract asks for
 * optimistic concurrency only where it says so. Two admins editing the same macro therefore resolve
 * last-write-wins — acceptable here because the `body` audit row carries the OLD text in full (in
 * `metadata.bodyFull.previous`, which nothing truncates), so a clobbered version is recoverable from
 * the ledger, which is not true of a ticket field. Recorded in the integration notes.
 */
export async function updateMacro(input: UpdateMacroInput): Promise<ActionResult<{ id: string }>> {
  return runAction("updateMacro", async (viewer, ctx) => {
    const data = updateMacroSchema.parse(input);
    assertCan(canAdminMacros(viewer.groups), "macro:admin update");

    const title = data.title === undefined ? undefined : sanitizedField(data.title, "title", "Title");
    const body = data.body === undefined ? undefined : sanitizedField(data.body, "body", "Body");
    if (body !== undefined) assertTemplateResolves(body);

    const actor = actorFromViewer(viewer);

    return withTx(async (tx) => {
      const macro = await loadMacro(tx, data.macroId);

      // The coherence rule binds the EFFECTIVE values: flipping only the channel of a macro whose
      // disclaimer stays put must be refused just as loudly as submitting both at once.
      const channel = data.channel ?? macro.channel;
      const disclaimerKey = data.disclaimerKey ?? macro.disclaimerKey;
      assertChannelDisclaimer(channel, disclaimerKey);

      const oldQueueKey = macro.queue?.key ?? null;
      const queueChanged = data.queueKey !== undefined && data.queueKey !== oldQueueKey;
      const queueId = queueChanged ? await resolveQueueId(tx, data.queueKey ?? null) : macro.queueId;

      const entries: AuditEntry[] = [];
      const patch: {
        title?: string;
        body?: string;
        channel?: CommentVisibility;
        disclaimerKey?: DisclaimerKey;
        sortOrder?: number;
        queueId?: string | null;
      } = {};

      if (title !== undefined && title !== macro.title) {
        patch.title = title;
        entries.push(fieldEntry(macro.id, "title", macro.title, title));
      }
      if (body !== undefined && body !== macro.body) {
        patch.body = body;
        // The one row that carries both sides in full: this is the record of what the desk used to
        // say to clients, and it is the only copy once the column is overwritten. `metadata.bodyFull`
        // is that copy — `oldValue`/`newValue` are cut at AUDIT_VALUE_MAX_CHARS and a macro body is
        // allowed to be five times that long.
        entries.push(bodyEntry(macro.id, macro.body, body));
      }
      if (data.channel !== undefined && data.channel !== macro.channel) {
        patch.channel = data.channel;
        entries.push(fieldEntry(macro.id, "channel", macro.channel, data.channel));
      }
      if (data.disclaimerKey !== undefined && data.disclaimerKey !== macro.disclaimerKey) {
        patch.disclaimerKey = data.disclaimerKey;
        entries.push(fieldEntry(macro.id, "disclaimerKey", macro.disclaimerKey, data.disclaimerKey));
      }
      if (data.sortOrder !== undefined && data.sortOrder !== macro.sortOrder) {
        patch.sortOrder = data.sortOrder;
        entries.push(fieldEntry(macro.id, "sortOrder", String(macro.sortOrder), String(data.sortOrder)));
      }
      if (queueChanged) {
        patch.queueId = queueId;
        entries.push(fieldEntry(macro.id, "queueKey", oldQueueKey, data.queueKey ?? null));
      }

      // Nothing actually differs: no write, no row. A save that changed nothing is not an event.
      if (entries.length === 0) return { id: macro.id };

      await tx.macro.update({
        where: { id: macro.id },
        data: { ...patch, updatedById: viewer.id },
        select: { id: true },
      });
      await writeAuditMany(tx, actor, ctx, entries);

      return { id: macro.id };
    });
  });
}

/**
 * Retires or restores a macro. Retiring is the only removal there is: `listMacros` reads active rows
 * only, so the composer's picker loses it immediately while `Comment.macroId` and every
 * `MACRO_APPLIED` row keep pointing at wording that still exists.
 *
 * The flip is a conditional `updateMany`; a count of 0 means somebody else already made the change,
 * which is not an error — the caller asked for a state and the state holds — so the action succeeds
 * and writes NO row rather than logging a second deactivation that changed nothing.
 */
export async function setMacroActive(
  input: SetMacroActiveInput,
): Promise<ActionResult<{ id: string; isActive: boolean }>> {
  return runAction("setMacroActive", async (viewer, ctx) => {
    const data = setMacroActiveSchema.parse(input);
    assertCan(canAdminMacros(viewer.groups), `macro:admin ${data.isActive ? "reactivate" : "deactivate"}`);
    const actor = actorFromViewer(viewer);

    return withTx(async (tx) => {
      const macro = await loadMacro(tx, data.macroId);

      const flipped = await tx.macro.updateMany({
        where: { id: macro.id, isActive: !data.isActive },
        data: { isActive: data.isActive, updatedById: viewer.id },
      });
      if (flipped.count !== 1) return { id: macro.id, isActive: macro.isActive };

      await writeAuditMany(tx, actor, ctx, [
        {
          action: data.isActive ? "MACRO_REACTIVATED" : "MACRO_DEACTIVATED",
          entityType: "MACRO",
          entityId: macro.id,
          fieldChanged: "isActive",
          oldValue: String(!data.isActive),
          newValue: String(data.isActive),
          metadata: { key: macro.key, title: macro.title, channel: macro.channel },
        },
      ]);

      return { id: macro.id, isActive: data.isActive };
    });
  });
}

/**
 * Sets (or clears) a macro's structured actions — Wave B, Decision #100.
 *
 * Separate from `updateMacro` on purpose. Editing what a macro SAYS and editing what it DOES are
 * different acts with different blast radii: a wording change reaches a client's inbox, an actions
 * change silently starts moving tickets between queues and statuses for everyone who picks that
 * macro. Giving it its own action gives it its own audit row, its own confirmation and its own
 * screen, and leaves the Wave A create/update paths byte-for-byte as they were.
 *
 * Validation is `macroActionsSchema` — the SAME schema `applyMacroActions` parses the stored column
 * with, so a macro that saves here cannot fail to parse there. What this action deliberately does NOT
 * check is whether the actions are reachable for any particular ticket: `OPEN → CLOSED` is a legal
 * thing to configure and an illegal transition from `NEW`, and refusing it here would mean guessing
 * at every ticket the macro might ever meet. The apply path checks against the real ticket, refuses
 * with the macro's key in the message, and rolls the comment back with it.
 *
 * `{}` and `null` are the same thing — "insert the body only" — and both store SQL NULL, so there is
 * one representation of "no actions" rather than two that read differently in a diff.
 */
export async function setMacroActions(input: SetMacroActionsInput): Promise<ActionResult<{ id: string }>> {
  return runAction("setMacroActions", async (viewer, ctx) => {
    const data = setMacroActionsSchema.parse(input);
    assertCan(canAdminMacros(viewer.groups), "macro:admin actions");
    const next = canonicalMacroActions(data.actions);
    const actor = actorFromViewer(viewer);

    return withTx(async (tx) => {
      const macro = await tx.macro.findUnique({
        where: { id: data.macroId },
        select: { id: true, key: true, title: true, channel: true, actions: true },
      });
      if (!macro) throw new NotFoundError("macro not found");

      const previous = canonicalMacroActions(parseMacroActions(macro.actions, macro.key));
      const oldValue = macroActionsAuditValue(previous);
      const newValue = macroActionsAuditValue(next);
      // A save that changed nothing is not an event — the same rule `updateMacro` applies per field.
      if (oldValue === newValue) return { id: macro.id };

      await tx.macro.update({
        where: { id: macro.id },
        // Prisma writes SQL NULL for `Prisma.DbNull`; a plain `null` on a Json column means JSON null,
        // which is a DIFFERENT value and would make `actions IS NULL` false for a macro that has none.
        data: { actions: next === null ? Prisma.DbNull : next, updatedById: viewer.id },
        select: { id: true },
      });

      await writeAuditMany(tx, actor, ctx, [
        {
          ...fieldEntry(macro.id, "actions", oldValue, newValue),
          metadata: { key: macro.key, title: macro.title, channel: macro.channel },
        },
      ]);

      return { id: macro.id };
    });
  });
}
