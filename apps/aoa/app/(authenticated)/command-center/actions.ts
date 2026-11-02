"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { withUserScope, type Identity } from "@/lib/rls";
import {
  writeAudit,
  MEETING_PREP_GENERATE,
  MEETING_PREP_SAVE,
  MEETING_PREP_UNSAVE,
} from "@/lib/audit";
import { aiMeetingPrepEnabled } from "@/lib/flags";
import { canWriteTransfers } from "@/lib/data/transfer-write";
import { AiError } from "@/lib/ai/gemini";
import { draftCommunication } from "@/lib/ai/draft";
import {
  assembleMeetingPrepContext,
  MEETING_PREP_INSTRUCTION,
} from "@/lib/ai/meeting-prep-context";
import {
  findMeetingPrepForSave,
  gatherMeetingPrepSources,
  getAppointmentByKey,
  readMeetingPrep,
  setMeetingPrepSaved,
  upsertMeetingPrep,
} from "@/lib/data/meeting-prep";
import {
  meetingPrepThrottled,
  MEETING_PREP_GENERATION_CAP,
  type MeetingPrepFailure,
} from "@/lib/data/meeting-prep-view";
import type { MeetingPrepBrief } from "@/lib/data/types";

// AI meeting prep — the ONE write path (blueprint ADR-6: a Server Action, not an
// API route; middleware.ts excludes only /api/auth|health|ingest/|cron/, so a
// route handler would 302 to Okta and then need its own auth).
//
// Order of operations, all fail-closed:
//   auth() → flag gate → role gate → appointment lookup → past-meeting reject →
//   THROTTLE pre-check (refuse BEFORE spending a Vertex call) → gather (RLS) →
//   assemble (pure, capped) → draftCommunication → ONE withUserScope tx
//   { throttle re-check, upsert, writeAudit } → revalidate.
//
// NO-LOG: this file adds no log statement that touches the context blob, the
// prompt, the brief, a client or advisor name, an email subject/body or an
// account number. Failures return a STATIC reason enum — never a message from
// the model, the Gemini config or Postgres.

export type GenerateMeetingPrepResult =
  | { ok: true; brief: MeetingPrepBrief }
  | { ok: false; reason: MeetingPrepFailure };

const LOG_TAG = "meeting-prep";

// The ONE diagnostic log in this feature. It prints a STATIC enum member and
// nothing else — no key, no name, no context, no brief, no error message — so a
// refusal is debuggable in Cloud Logging without any PII leaving the process
// (the lib/ai/gemini.ts status-only convention).
const fail = (reason: MeetingPrepFailure): { ok: false; reason: MeetingPrepFailure } => {
  console.error(`[${LOG_TAG}] refused reason=${reason}`);
  return { ok: false, reason };
};

/** Sentinel that rolls the write tx back when the cap is hit inside it. */
class ThrottledError extends Error {}

const MAX_OUTPUT_TOKENS = 3072; // > the 2048 default: the 3.x thinking-budget trap.

async function sessionIdentity(): Promise<Identity> {
  const session = await auth();
  if (!session?.user) redirect("/");
  return {
    role: (session.user as { role?: string }).role ?? "VIEWER",
    email: session.user.email ?? null,
  };
}

/**
 * Generate (or REgenerate) the AI prep brief for one appointment.
 *
 * `appointmentKey` is mirror.appointment.external_key. It is NEVER used as the
 * audit entityId — the key embeds the client name (source|client|starts_at).
 */
export async function generateMeetingPrep(
  appointmentKey: string,
): Promise<GenerateMeetingPrepResult> {
  const identity = await sessionIdentity();

  // Defense in depth #1: the flag gates the ACTION as well as the UI, so a
  // leaked/stale client bundle cannot generate when the feature is dark.
  if (!aiMeetingPrepEnabled()) return fail("flag_off");

  // Defense in depth #2: the same predicate the UI uses (everyone except
  // VIEWER), matching the table's RLS policy roles exactly. The DB is still the
  // real enforcement — a VIEWER that got past this hits the INSERT policy.
  if (!canWriteTransfers(identity.role)) return fail("not_authorized");

  const appointment = await getAppointmentByKey(identity, appointmentKey);
  // Gone from the feed (the digest FULL-REPLACES, so a cancelled meeting simply
  // disappears) — or never visible to this caller.
  if (!appointment) return fail("not_found");
  if (appointment.startsAt.getTime() < Date.now()) return fail("past_meeting");

  // Throttle pre-check (owner decision 2026-07-27): refuse at the lifetime cap
  // BEFORE the model call, so a refusal costs nothing and writes nothing.
  const existing = await readMeetingPrep(identity, appointmentKey);
  if (existing && meetingPrepThrottled(existing.brief.generations)) {
    return fail("throttled");
  }

  const startedAt = Date.now();
  const sources = await gatherMeetingPrepSources(identity, appointment);
  const context = assembleMeetingPrepContext(sources);

  let draft;
  try {
    draft = await draftCommunication({
      kind: "meeting_prep",
      context: context.text,
      instruction: MEETING_PREP_INSTRUCTION,
      tone: "concise",
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
  } catch (e) {
    // AiError.reason maps one-for-one onto the failure enum; anything else is
    // reported as a generic upstream failure. Nothing from the error message
    // reaches the caller.
    return fail(e instanceof AiError ? e.reason : "upstream_error");
  }
  const latencyMs = Date.now() - startedAt;

  try {
    // ONE transaction: the row write and its audit row share it, so a failed
    // audit rolls the brief back and vice versa (lib/audit.ts's guarantee).
    const written = await withUserScope(identity, async (tx) => {
      const current = await tx.meetingPrep.findUnique({
        where: { appointment_key: appointmentKey },
        select: { generations: true },
      });
      // Re-check inside the tx: two concurrent Generates cannot push the row
      // past the cap.
      if (current && meetingPrepThrottled(current.generations)) {
        throw new ThrottledError();
      }
      const row = await upsertMeetingPrep(tx, {
        appointmentKey,
        clientSfId: appointment.clientSfId,
        startsAt: appointment.startsAt,
        brief: draft.draft,
        model: draft.model,
        finishReason: draft.finishReason,
        contextChars: context.chars,
        contextTruncated: context.truncated,
        generatedBy: identity.email ?? null,
      });
      // IDS + ENUMS + COUNTS ONLY. entityId is the row cuid, NEVER the
      // appointment key (it embeds the client name).
      await writeAudit(tx, identity, {
        action: MEETING_PREP_GENERATE,
        entityType: "meeting_prep",
        entityId: row.id,
        detail: {
          clientSfId: appointment.clientSfId,
          model: draft.model,
          finishReason: draft.finishReason,
          regenerated: current != null,
          generations: row.generations,
          cap: MEETING_PREP_GENERATION_CAP,
          contextChars: context.chars,
          truncated: context.truncated,
          latencyMs,
          sources: context.sources,
        },
      });
      return row;
    });

    revalidatePath("/command-center");
    return {
      ok: true,
      brief: {
        text: draft.draft,
        generatedAt: written.generatedAt,
        model: draft.model,
        finishReason: draft.finishReason,
        truncated: context.truncated,
        generations: written.generations,
        generatedBy: identity.email ?? null,
        // Preserved by the upsert: regenerating an ALREADY-SAVED brief refreshes
        // what the portrait shows rather than silently detaching it.
        savedAt: written.savedAt,
      },
    };
  } catch (e) {
    if (e instanceof ThrottledError) return fail("throttled");
    // An RLS rejection and a vanished row look identical here, deliberately.
    return fail("write_failed");
  }
}

// --- Save the brief to the Client Portrait -----------------------------------
//
// The brief is ALREADY stored (generateMeetingPrep wrote it). Save does not
// create anything: it PROMOTES the row from a Command-Center working artifact to
// part of the client record by stamping saved_at / saved_by, which is what makes
// it render on /client-portrait/<client_sf_id>. Unsave nulls the stamp.
//
// Both are UPDATEs on app.meeting_prep, permitted by the current four-role
// UPDATE policy — no new grant, no new policy. DELETE remains REVOKEd, so unsave
// detaches without destroying: Save is not a one-way trapdoor for a PII artifact.
//
// Same fail-closed order and the same NO-LOG / no-PII-in-audit rules as generate.

/** Sentinel: the stored row has no client_sf_id, so there is no portrait. */
class NoClientLinkError extends Error {}
/** Sentinel: nothing stored for that appointment key. */
class NoPrepError extends Error {}

export type SaveMeetingPrepResult =
  | { ok: true; savedAt: Date | null }
  | { ok: false; reason: MeetingPrepFailure };

async function setSaved(
  appointmentKey: string,
  saved: boolean,
): Promise<SaveMeetingPrepResult> {
  const identity = await sessionIdentity();
  if (!aiMeetingPrepEnabled()) return fail("flag_off");
  if (!canWriteTransfers(identity.role)) return fail("not_authorized");

  try {
    const result = await withUserScope(identity, async (tx) => {
      // Read INSIDE the tx: the no-client-link check and the write cannot race,
      // and an RLS-invisible row is indistinguishable from a missing one.
      const row = await findMeetingPrepForSave(tx, appointmentKey);
      if (!row) throw new NoPrepError();
      // An appointment whose name never matched a mirror.client row has no
      // portrait to attach to. Refuse rather than writing a saved row nothing
      // can render. (Unsave is allowed regardless — detaching is always safe.)
      if (saved && !row.clientSfId) throw new NoClientLinkError();

      const wasSaved = row.savedAt != null;
      const updated = await setMeetingPrepSaved(tx, {
        appointmentKey,
        saved,
        savedBy: saved ? (identity.email ?? null) : null,
      });
      // IDS + ENUMS ONLY. entityId is the row cuid, NEVER the appointment key.
      await writeAudit(tx, identity, {
        action: saved ? MEETING_PREP_SAVE : MEETING_PREP_UNSAVE,
        entityType: "meeting_prep",
        entityId: row.id,
        detail: saved
          ? { clientSfId: row.clientSfId, resaved: wasSaved }
          : { clientSfId: row.clientSfId },
      });
      return { savedAt: updated.savedAt, clientSfId: row.clientSfId };
    });

    revalidatePath("/command-center");
    if (result.clientSfId) revalidatePath(`/client-portrait/${result.clientSfId}`);
    return { ok: true, savedAt: result.savedAt };
  } catch (e) {
    if (e instanceof NoClientLinkError) return fail("no_client_link");
    if (e instanceof NoPrepError) return fail("not_found");
    return fail("write_failed");
  }
}

/**
 * Attach the stored brief for this appointment to its client's portrait.
 * IDEMPOTENT: `appointment_key` is unique, so a second save UPDATEs the same row
 * and only moves `saved_at` — it can never create a duplicate.
 */
export async function saveMeetingPrepToPortrait(
  appointmentKey: string,
): Promise<SaveMeetingPrepResult> {
  return setSaved(appointmentKey, true);
}

/**
 * Detach it again (saved_at / saved_by → NULL). The brief row itself survives —
 * DELETE is REVOKEd on this table — so the Command Center still re-opens it
 * without a second Vertex call.
 */
export async function unsaveMeetingPrepFromPortrait(
  appointmentKey: string,
): Promise<SaveMeetingPrepResult> {
  return setSaved(appointmentKey, false);
}
