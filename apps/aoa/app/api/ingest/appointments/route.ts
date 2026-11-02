import crypto from "crypto";
import type { Prisma } from "@prisma/client";
import { INGEST_APPOINTMENTS, writeAudit } from "@/lib/audit";
import { requireIngestToken } from "@/lib/ingest/auth";
import { withIngestScope } from "@/lib/ingest/scope";
import { logIngestSuccess } from "@/lib/observability/structured-log";
import {
  appointmentKey,
  etWallClockToUtc,
  parseAppointmentDigest,
  parseCalendlyAppointment,
  type ParsedAppointment,
} from "@/lib/data/appointments";

// Node runtime: crypto (run id) + Prisma. Appointments-Feed ingest.
//
// CONTRACT: n8n forwards the LATEST "Upcoming Appointments" digest from the
// #appointments-feed Slack channel. Body:
//   { "source"?: string, "messages": [ { "ts": "<slack ts>", "text": "<block mrkdwn>" } ] }
// (a single { "digest": {...} } is also accepted). `text` MUST be the Slack block
// text WITH newlines (blocks[0].text.text), not the flattened `text` field.
//
// Two Slack formats are parsed and UNIONED: the Pipedream "Upcoming Appointments"
// digest (a snapshot of the current list — latest one wins) AND Calendly "New
// Appointment Scheduled" single-event messages. Together they FULL-REPLACE the set
// for `source`: delete all rows for that source, then insert the unioned+deduped
// appointments — a dropped appointment thus disappears with the next snapshot.
// A body with NEITHER a valid digest nor any Calendly event is a 422 no-op so a
// stray message can never wipe the card. Auth reuses the ingest bearer token.
// NO-LOG: never logs client/advisor names or the digest text.
export const runtime = "nodejs";

const SOURCE_DEFAULT = "slack-appointments-feed";
const MAX_BODY_BYTES = 1 * 1024 * 1024;
const MAX_ITEMS = 500;

const err = (error: string, status: number) => Response.json({ error }, { status });
function methodNotAllowed(): Response {
  return err("method_not_allowed", 405);
}
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

type Msg = { ts?: string; text?: string };

function pickLatestDigest(messages: Msg[]): { ts: string; parsed: ParsedAppointment[] } | null {
  let best: { ts: string; parsed: ParsedAppointment[] } | null = null;
  for (const m of messages) {
    const parsed = parseAppointmentDigest(m.text);
    if (parsed.length === 0) continue; // not a valid digest
    const ts = String(m.ts ?? "0");
    if (!best || Number(ts) > Number(best.ts)) best = { ts, parsed };
  }
  return best;
}

/** Normalize "First Middle Last" to a comparison key matching mirror.client. */
function nameKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export async function POST(req: Request): Promise<Response> {
  if (!requireIngestToken(req).ok) return err("unauthorized", 401);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return err("too_large", 413);
  let body: { source?: string; messages?: Msg[]; digest?: Msg };
  try {
    body = JSON.parse(raw);
  } catch {
    return err("invalid_json", 400);
  }

  const source = (body.source && String(body.source)) || SOURCE_DEFAULT;
  const messages: Msg[] = Array.isArray(body.messages)
    ? body.messages
    : body.digest
      ? [body.digest]
      : [];
  if (messages.length === 0) return err("no_messages", 400);

  // Collect appointments from BOTH formats in the batch: the LATEST "Upcoming
  // Appointments" digest (a snapshot of the current list) PLUS every Calendly
  // "New Appointment Scheduled" single-event message. Union them, then dedupe by
  // external_key below. A body with NEITHER is a 422 no-op so a stray message
  // never wipes the set.
  const latest = pickLatestDigest(messages);
  const collected: { appt: ParsedAppointment; ts: string }[] = [];
  if (latest) for (const a of latest.parsed) collected.push({ appt: a, ts: latest.ts });
  for (const m of messages) {
    const c = parseCalendlyAppointment(m.text);
    if (c) collected.push({ appt: c, ts: String(m.ts ?? "0") });
  }
  if (collected.length === 0) return err("no_valid_digest", 422);

  // Newest contributing ts (for the audit/response marker).
  const maxTs = collected.reduce((mx, x) => (Number(x.ts) > Number(mx) ? x.ts : mx), "0");

  // Build appointment rows (skip entries whose date/time won't parse), then
  // dedupe identical keys across the unioned digest + Calendly set (first wins).
  const rows = collected
    .map(({ appt: a, ts }) => {
      const startsAt = etWallClockToUtc(a.dateText, a.timeText);
      if (!startsAt) return null;
      return {
        external_key: appointmentKey(source, a.clientName, startsAt.toISOString()),
        client_name: a.clientName,
        advisor_name: a.advisorName,
        meeting_type: a.meetingType,
        starts_at: startsAt,
        date_text: a.dateText,
        time_text: a.timeText,
        slack_ts: ts,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .filter((r, i, arr) => arr.findIndex((x) => x.external_key === r.external_key) === i)
    .slice(0, MAX_ITEMS);

  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const runId = crypto.randomUUID();
  const safeRunId = encodeURIComponent(runId).slice(0, 256);

  if (dryRun) {
    return Response.json({ would_replace: rows.length, source, slack_ts: maxTs });
  }

  try {
    await withIngestScope(async (tx) => {
      // Best-effort client_sf_id match: load the (small) client name→sf_id map once.
      const clients = await tx.$queryRaw<{ sf_id: string; full: string }[]>`
        SELECT sf_id, lower(btrim(coalesce(first_name,'') || ' ' || coalesce(last_name,''))) AS full
        FROM mirror.client`;
      const byName = new Map<string, string | null>();
      for (const c of clients) {
        // null when a name is ambiguous (maps to >1 client) → leave unlinked
        byName.set(c.full, byName.has(c.full) ? null : c.sf_id);
      }

      // FULL-REPLACE the set for this source.
      await tx.$executeRaw`DELETE FROM mirror.appointment WHERE source = ${source}`;
      for (const r of rows) {
        const clientSfId = byName.get(nameKey(r.client_name)) ?? null;
        await tx.$executeRaw`
          INSERT INTO mirror.appointment
            (external_key, source, client_name, client_sf_id, advisor_name, meeting_type,
             starts_at, date_text, time_text, slack_ts, synced_at)
          VALUES
            (${r.external_key}, ${source}, ${r.client_name}, ${clientSfId}, ${r.advisor_name},
             ${r.meeting_type}, ${r.starts_at}, ${r.date_text}, ${r.time_text}, ${r.slack_ts}, now())
          ON CONFLICT (external_key) DO UPDATE SET
            client_name  = EXCLUDED.client_name,
            client_sf_id = EXCLUDED.client_sf_id,
            advisor_name = EXCLUDED.advisor_name,
            meeting_type = EXCLUDED.meeting_type,
            starts_at    = EXCLUDED.starts_at,
            date_text    = EXCLUDED.date_text,
            time_text    = EXCLUDED.time_text,
            slack_ts     = EXCLUDED.slack_ts,
            synced_at    = now()`;
      }
      await writeAudit(
        tx as Prisma.TransactionClient,
        { role: "INGEST", email: null },
        {
          action: INGEST_APPOINTMENTS,
          entityType: "ingest_run",
          entityId: runId,
          detail: { source, replaced: rows.length, slack_ts: maxTs, dry_run: false },
        },
      );
    });
  } catch {
    console.error(`[ingest:appointments] run_id=${safeRunId} tx_failed`);
    return err("internal", 500);
  }

  if (rows.length > 0) logIngestSuccess("appointments");
  return Response.json({ replaced: rows.length, source, slack_ts: maxTs });
}
