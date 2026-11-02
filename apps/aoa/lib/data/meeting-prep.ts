import "server-only";
import type { Prisma } from "@prisma/client";
import { withUserScope, type Identity } from "@/lib/rls";
import { formatWhen } from "./appointments";
import { getClientWithHousehold } from "./clients";
import { apexAccountsForClient, clientApexAumTotal } from "./account-aum";
import { dealsForClient } from "./deals";
import { listTransfers, getSlackCloseout } from "./transfers";
import { tasksForHousehold } from "./tasks";
import { activityForHousehold } from "./activity";
import { emailsForHousehold } from "./emails";
import type { MeetingPrepSources } from "@/lib/ai/meeting-prep-context";
import type { MeetingPrepBrief, SavedMeetingPrepBrief } from "./types";

// AI meeting prep — the SERVER-ONLY half (fetch, persist, read back). The pure
// assembler lives in lib/ai/meeting-prep-context.ts and never imports this file.
//
// Every read here runs inside the CALLER'S OWN withUserScope. Appointment
// metadata remains a firm-wide Command Center feed, but getAppointmentByKey
// requires ADVISOR/CLIENT_SERVICE callers to resolve the linked client through
// mirror.client's own-book RLS before the generation action can spend an AI call.
// app.meeting_prep separately enforces the same book boundary for stored-brief
// SELECT/INSERT/UPDATE; ADMIN/OPERATIONS retain firm-wide access.
//
// DELIBERATELY NOT READ HERE: clientPortraitDetail (lib/data/portrait.ts) and
// clientReminders (lib/data/client-reminders.ts). Both are HYBRID MOCK — their
// risk/instructions/portrait/taxBudget/prep and decisions/nudges fields come
// from lib/mock/*, and their real parts are already covered by the readers
// below. Mock fixtures must never become model context.
//
// NO-LOG: not one statement in this file logs a client name, an account number,
// an email subject/body, a task note, the context blob or the brief.

/** The appointment fields the prep path needs. */
export type PrepAppointment = {
  externalKey: string;
  clientName: string | null;
  clientSfId: string | null;
  advisorName: string | null;
  meetingType: string | null;
  startsAt: Date;
};

type AppointmentRow = {
  external_key: string;
  client_name: string | null;
  client_sf_id: string | null;
  advisor_name: string | null;
  meeting_type: string | null;
  starts_at: Date;
};

/** One appointment by its external_key, authorized for meeting-prep use.
 *
 * mirror.appointment itself is intentionally firm-wide. This read is narrower:
 * ADMIN/OPERATIONS retain firm-wide prep access, while ADVISOR/CLIENT_SERVICE
 * must resolve the appointment's linked client through mirror.client's existing
 * own-book RLS. Unlinked and out-of-book appointments therefore return null
 * before context assembly or an AI call. */
export async function getAppointmentByKey(
  id: Identity,
  key: string,
): Promise<PrepAppointment | null> {
  if (!key) return null;
  const rows = await withUserScope(id, (tx) =>
    tx.$queryRaw<AppointmentRow[]>`
      SELECT appointment.external_key,
             appointment.client_name,
             appointment.client_sf_id,
             appointment.advisor_name,
             appointment.meeting_type,
             appointment.starts_at
        FROM mirror.appointment appointment
       WHERE appointment.external_key = ${key}
         AND (
           current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
           OR (
             current_setting('app.user_role', true) IN ('ADVISOR', 'CLIENT_SERVICE')
             AND appointment.client_sf_id IS NOT NULL
             AND EXISTS (
               SELECT 1
                 FROM mirror.client visible_client
                WHERE visible_client.sf_id = appointment.client_sf_id
             )
           )
         )
       LIMIT 1`,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    externalKey: r.external_key,
    clientName: r.client_name,
    clientSfId: r.client_sf_id,
    advisorName: r.advisor_name,
    meetingType: r.meeting_type,
    startsAt: new Date(r.starts_at),
  };
}

/** Per-block degradation: ONE slow or failing reader must not sink the brief —
 *  the block simply renders `(none on file)`. Catches without logging (the
 *  error object can echo a query containing client ids). */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

const isOpenDealStage = (stage: string | null): boolean =>
  stage !== "WON" && stage !== "LOST";

/** CRM task statuses are free text; "Completed" is the closed one. */
const isOpenTask = (status: string | null): boolean =>
  (status ?? "").trim().toLowerCase() !== "completed";

/**
 * Gather everything the assembler is allowed to see, RLS-scoped to the caller.
 * Blocks 3-9 all require a resolved client_sf_id; without one the sources come
 * back with `client: null` and empty lists, which the assembler turns into the
 * "no linked client record" note plus six `(none on file)` blocks.
 */
export async function gatherMeetingPrepSources(
  id: Identity,
  appointment: PrepAppointment,
  now: Date = new Date(),
): Promise<MeetingPrepSources> {
  const meeting = {
    clientName: appointment.clientName,
    advisorName: appointment.advisorName,
    meetingType: appointment.meetingType,
    when: formatWhen(appointment.startsAt, now),
  };

  const empty: MeetingPrepSources = {
    meeting,
    client: null,
    aumTotal: null,
    accounts: [],
    deals: [],
    transfers: [],
    tasks: [],
    activity: [],
    emails: [],
  };

  const clientSfId = appointment.clientSfId;
  if (!clientSfId) return empty;

  const detail = await safe(() => getClientWithHousehold(id, clientSfId), null);
  if (!detail) return empty;

  const householdSfId = detail.household?.sf_id ?? null;

  // Blocks 4-6 are client-keyed; blocks 7-9 are HOUSEHOLD-keyed (Task.AccountId
  // links to the household — the per-person WhoId is FLS-blocked upstream).
  const [aumTotal, accounts, deals, allTransfers, tasks, activity, emails] =
    await Promise.all([
      safe(() => clientApexAumTotal(id, clientSfId), null),
      safe(() => apexAccountsForClient(id, clientSfId), []),
      safe(() => dealsForClient(id, clientSfId), []),
      safe(() => listTransfers(id), []),
      householdSfId ? safe(() => tasksForHousehold(id, householdSfId), []) : [],
      householdSfId ? safe(() => activityForHousehold(id, householdSfId), []) : [],
      householdSfId ? safe(() => emailsForHousehold(id, householdSfId), []) : [],
    ]);

  // listTransfers has no per-client seam, so filter in memory on the same
  // client_sf_id join key; FUNDED is done money, not money in flight.
  const inFlight = allTransfers
    .filter((t) => t.client_sf_id === clientSfId && t.stage !== "FUNDED")
    .slice(0, 5);
  const closeouts = await Promise.all(
    inFlight.map((t) => safe(() => getSlackCloseout(id, t.id), null)),
  );

  return {
    meeting,
    client: {
      name: detail.name,
      householdName: detail.household?.name ?? null,
      householdStatus: detail.household?.status ?? null,
      householdStage: detail.household?.stage ?? null,
      leadAdvisorEmail: detail.household?.lead_advisor_email ?? null,
    },
    aumTotal,
    accounts: accounts.map((a) => ({
      accountType: a.accountType,
      apexAccountNumber: a.apexAccountNumber,
      accountStatus: a.accountStatus,
      isManaged: a.isManaged,
      accountAum: a.accountAum,
      asOf: a.asOf,
    })),
    deals: deals
      .filter((d) => isOpenDealStage(d.stage))
      .map((d) => ({
        name: d.name,
        stage: d.stage,
        amount: d.amount,
        closeDate: d.close_date,
        fundingType: d.account_type,
        transferringFirm: d.transferring_firm,
        ownerName: d.owner_name,
      })),
    transfers: inFlight.map((t, i) => ({
      stage: t.stage,
      daysInStage: t.daysInStage,
      value: t.value,
      fundingType: t.funding_type,
      nextStep: t.next_step,
      accountsOpenedAtApex: t.accounts_opened_at_apex,
      fundingPlanComplete: t.funding_plan_complete,
      fundingInitiated: t.funding_initiated,
      cashInFlight: t.cash_in_flight,
      acatLinked: t.acat_transfer_id != null && t.acat_transfer_id !== "",
      closeoutDone: closeouts[i]?.done ?? null,
      closeoutTotal: closeouts[i]?.total ?? null,
    })),
    tasks: tasks
      .filter((t) => isOpenTask(t.status))
      .map((t) => ({
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        description: t.description,
      })),
    activity: activity.map((a) => ({
      at: a.activity_at,
      subject: a.subject,
      ownerName: a.owner_name,
      note: a.note,
    })),
    emails: emails.map((e) => ({
      at: e.sent_at,
      subject: e.subject,
      body: e.body,
    })),
  };
}

type PrepRow = {
  id: string;
  appointment_key: string;
  brief: string;
  model: string;
  finish_reason: string | null;
  context_truncated: boolean;
  generations: number;
  generated_at: Date;
  generated_by: string | null;
  saved_at: Date | null;
};

/** The one column list every brief read shares — keep the two callers honest. */
const BRIEF_SELECT = {
  id: true,
  appointment_key: true,
  brief: true,
  model: true,
  finish_reason: true,
  context_truncated: true,
  generations: true,
  generated_at: true,
  generated_by: true,
  saved_at: true,
} as const;

const toBrief = (r: PrepRow): MeetingPrepBrief => ({
  text: r.brief,
  generatedAt: new Date(r.generated_at),
  model: r.model,
  finishReason: r.finish_reason,
  truncated: r.context_truncated,
  generations: r.generations,
  generatedBy: r.generated_by,
  savedAt: r.saved_at == null ? null : new Date(r.saved_at),
});

/** Stored briefs for a set of appointment keys, keyed by appointment_key.
 * RLS returns only rows in the caller's permitted firm/book scope and returns
 * {} for VIEWERs or callers with no visible requested rows. */
export async function readMeetingPreps(
  id: Identity,
  keys: string[],
): Promise<Record<string, MeetingPrepBrief | null>> {
  const wanted = keys.filter((k) => k !== "");
  if (wanted.length === 0) return {};
  const rows = await withUserScope(id, (tx) =>
    tx.meetingPrep.findMany({
      where: { appointment_key: { in: wanted } },
      select: BRIEF_SELECT,
    }),
  );
  const out: Record<string, MeetingPrepBrief | null> = {};
  for (const r of rows) out[r.appointment_key] = toBrief(r);
  return out;
}

/** One stored brief (plus its row id, which the audit uses as entityId). */
export async function readMeetingPrep(
  id: Identity,
  key: string,
): Promise<{ id: string; brief: MeetingPrepBrief } | null> {
  const rows = await readMeetingPrepRows(id, key);
  return rows ? { id: rows.id, brief: toBrief(rows) } : null;
}

async function readMeetingPrepRows(id: Identity, key: string): Promise<PrepRow | null> {
  if (!key) return null;
  const row = await withUserScope(id, (tx) =>
    tx.meetingPrep.findUnique({
      where: { appointment_key: key },
      select: BRIEF_SELECT,
    }),
  );
  return row ?? null;
}

export type UpsertMeetingPrepInput = {
  appointmentKey: string;
  clientSfId: string | null;
  startsAt: Date;
  brief: string;
  model: string;
  finishReason: string | null;
  contextChars: number;
  contextTruncated: boolean;
  generatedBy: string | null;
};

/**
 * Insert-or-update the single row for this appointment. Takes the CALLER'S tx so
 * the writeAudit shares it (lib/audit.ts's same-transaction guarantee: a failed
 * audit rolls the brief back and vice versa). Regenerate UPSERTs in place —
 * `generations` increments, `generated_at` moves, no version history (history
 * would multiply stored PII for no owner-asked benefit).
 *
 * saved_at / saved_by are DELIBERATELY absent from both the create and the
 * update: attaching to the portrait is a separate decision with its own action
 * and its own audit row. A regenerate of an ALREADY-SAVED brief therefore keeps
 * it attached and refreshes what the portrait shows — which is what an advisor
 * means by "regenerate", not "silently detach this from the client record".
 */
export async function upsertMeetingPrep(
  tx: Prisma.TransactionClient,
  input: UpsertMeetingPrepInput,
): Promise<{
  id: string;
  generations: number;
  generatedAt: Date;
  savedAt: Date | null;
}> {
  const row = await tx.meetingPrep.upsert({
    where: { appointment_key: input.appointmentKey },
    create: {
      appointment_key: input.appointmentKey,
      client_sf_id: input.clientSfId,
      starts_at: input.startsAt,
      brief: input.brief,
      model: input.model,
      finish_reason: input.finishReason,
      context_chars: input.contextChars,
      context_truncated: input.contextTruncated,
      generated_by: input.generatedBy,
    },
    update: {
      client_sf_id: input.clientSfId,
      starts_at: input.startsAt,
      brief: input.brief,
      model: input.model,
      finish_reason: input.finishReason,
      context_chars: input.contextChars,
      context_truncated: input.contextTruncated,
      generated_by: input.generatedBy,
      generated_at: new Date(),
      generations: { increment: 1 },
    },
    select: { id: true, generations: true, generated_at: true, saved_at: true },
  });
  return {
    id: row.id,
    generations: row.generations,
    generatedAt: row.generated_at,
    savedAt: row.saved_at ?? null,
  };
}

// --- Save to / remove from the Client Portrait -------------------------------
// The brief is already stored; these only flip the saved_at / saved_by stamp.
// Both are UPDATEs, which the existing meeting_prep_update_write_roles policy
// permits for the four current non-VIEWER roles — no new grant, no new policy, and
// DELETE stays REVOKEd (un-saving DETACHES a brief, it never destroys it, which
// also means Save is not a one-way trapdoor for a PII artifact).

/** The row fields the save/unsave path needs, read INSIDE the caller's tx so the
 *  check and the write cannot race. Null when there is no brief for that key. */
export async function findMeetingPrepForSave(
  tx: Prisma.TransactionClient,
  appointmentKey: string,
): Promise<{ id: string; clientSfId: string | null; savedAt: Date | null } | null> {
  if (!appointmentKey) return null;
  const row = await tx.meetingPrep.findUnique({
    where: { appointment_key: appointmentKey },
    select: { id: true, client_sf_id: true, saved_at: true },
  });
  return row
    ? { id: row.id, clientSfId: row.client_sf_id, savedAt: row.saved_at ?? null }
    : null;
}

/**
 * Attach (`savedBy` set) or detach (`savedBy` null) this brief from the client
 * portrait. Takes the CALLER'S tx so the writeAudit shares it. Saving twice
 * UPDATEs the one row — `appointment_key` is unique, so a duplicate is
 * structurally impossible; the second save just moves `saved_at`.
 */
export async function setMeetingPrepSaved(
  tx: Prisma.TransactionClient,
  input: { appointmentKey: string; saved: boolean; savedBy: string | null; now?: Date },
): Promise<{ id: string; savedAt: Date | null }> {
  const row = await tx.meetingPrep.update({
    where: { appointment_key: input.appointmentKey },
    data: input.saved
      ? { saved_at: input.now ?? new Date(), saved_by: input.savedBy }
      : { saved_at: null, saved_by: null },
    select: { id: true, saved_at: true },
  });
  return { id: row.id, savedAt: row.saved_at ?? null };
}

type SavedPrepRow = PrepRow & { starts_at: Date; saved_by: string | null };

/**
 * The SAVED briefs attached to one client's portrait, most recent meeting first.
 * RLS-scoped like every other read here: ADMIN/OPERATIONS may read firm-wide,
 * while ADVISOR/CLIENT_SERVICE must resolve client_sf_id through their
 * mirror.client own-book policy. Reaching the portrait page is not relied on as
 * the authorization boundary; the stored brief is protected at the database.
 *
 * Returns [] for an empty id — the portrait's card then renders exactly as it
 * does today.
 */
export async function savedMeetingPrepsForClient(
  id: Identity,
  clientSfId: string,
): Promise<SavedMeetingPrepBrief[]> {
  if (!clientSfId) return [];
  const rows = await withUserScope(id, (tx) =>
    tx.meetingPrep.findMany({
      where: { client_sf_id: clientSfId, saved_at: { not: null } },
      select: { ...BRIEF_SELECT, starts_at: true, saved_by: true },
      orderBy: { starts_at: "desc" },
    }),
  );
  return (rows as SavedPrepRow[]).map((r) => ({
    ...toBrief(r),
    appointmentKey: r.appointment_key,
    startsAt: new Date(r.starts_at),
    // Non-null by construction: the WHERE filters on saved_at IS NOT NULL.
    savedAt: new Date(r.saved_at!),
    savedBy: r.saved_by,
  }));
}

