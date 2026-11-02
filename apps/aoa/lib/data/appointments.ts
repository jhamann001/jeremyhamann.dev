import "server-only";
import { withUserScope, type Identity } from "@/lib/rls";
import type { Meeting } from "./types";

// Appointments-Feed feed → the Command Center Meetings card.
//
// The #appointments-feed Slack channel receives a rolling "Upcoming
// Appointments" digest from a Pipedream bot. An n8n workflow forwards the LATEST
// digest's Slack block text to /api/ingest/appointments; this module parses that
// text into appointment records and the ingest route FULL-REPLACES the set for
// the source (the digest is a snapshot of the current upcoming list, not a delta).
//
// This file holds the PURE parsing/formatting helpers (unit-tested without a DB
// or a clock) plus the read seam the Command Center calls. NO-LOG: appointment
// text carries client + advisor names; nothing here logs it.

export type ParsedAppointment = {
  meetingType: string;
  clientName: string;
  advisorName: string | null;
  dateText: string; // MM/DD/YYYY (as written in the digest)
  timeText: string; // 'HH:MM AM/PM'
};

/** Strip Slack decoration: :emoji: tokens, *bold* markers, collapse whitespace. */
function clean(s: string): string {
  return s
    .replace(/:[a-z0-9_+-]+:/gi, " ") // :bust_in_silhouette: etc.
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The meeting-type label with the org prefix trimmed ("Cedar Ridge Wealth - X" → "X"). */
function tidyType(s: string): string {
  return clean(s).replace(/^Cedar Ridge Wealth\s*[-–]\s*/i, "").trim();
}

function pick(segment: string, re: RegExp): string | null {
  const m = segment.match(re);
  return m ? clean(m[1]) : null;
}

/**
 * Parse a Slack "Upcoming Appointments" digest (the block mrkdwn text, with
 * newlines) into appointment records. Returns [] when the text is not a valid
 * digest (missing the header) — so a stray non-digest message never wipes the set.
 * Malformed individual entries (missing client/date/time) are skipped.
 */
export function parseAppointmentDigest(text: string | null | undefined): ParsedAppointment[] {
  if (!text || !/upcoming appointments/i.test(text)) return [];
  // Each appointment starts at a "*N.*" marker; drop the leading header segment.
  const segments = text.split(/\*\s*\d+\.\s*\*/).slice(1);
  const out: ParsedAppointment[] = [];
  for (const seg of segments) {
    const clientName = pick(seg, /client:\s*\*?\s*([^\n]+)/i);
    const advisorName = pick(seg, /advisor:\s*\*?\s*([^\n]+)/i);
    const dateText = pick(seg, /date:\s*\*?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    const timeText = pick(seg, /time[^:]*:\s*\*?\s*(\d{1,2}:\d{2}\s*[AP]M)/i);
    // Meeting type = the first non-empty line of the segment (before the labels).
    const firstLine = seg.split("\n").map((l) => l.trim()).find((l) => clean(l).length > 0) ?? "";
    if (!clientName || !dateText || !timeText) continue;
    out.push({
      meetingType: tidyType(firstLine) || "Appointment",
      clientName,
      advisorName: advisorName ?? null,
      dateText,
      timeText,
    });
  }
  return out;
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/**
 * Parse a Calendly "New Appointment Scheduled" single-event message (double-*
 * bold, "Meeting Date: <Month> D, YYYY at H:MM AM/PM <TZ>"). Returns null when
 * the text isn't that format or the date won't parse — so it composes with
 * parseAppointmentDigest (the ingest unions both). Normalizes to the same
 * ParsedAppointment shape (MM/DD/YYYY + HH:MM AM/PM) so etWallClockToUtc handles
 * the ET→UTC conversion identically (the "EDT/EST" label is ignored, like the digest).
 */
export function parseCalendlyAppointment(
  text: string | null | undefined,
): ParsedAppointment | null {
  if (!text || !/new appointment scheduled/i.test(text)) return null;
  const clientName = pick(text, /client:\**\s*([^\n*]+)/i);
  const advisorName = pick(text, /advisor:\**\s*([^\n*]+)/i);
  const dm = text.match(
    /meeting date:\**\s*([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*([AP]M)/i,
  );
  if (!clientName || !dm) return null;
  const mo = MONTHS[dm[1].toLowerCase()];
  if (!mo) return null;
  const dateText = `${mo}/${parseInt(dm[2], 10)}/${dm[3]}`;
  const timeText = `${parseInt(dm[4], 10)}:${dm[5]} ${dm[6].toUpperCase()}`;
  return {
    meetingType: "Appointment",
    clientName,
    advisorName: advisorName ?? null,
    dateText,
    timeText,
  };
}

/** NY (America/New_York) offset in minutes at a given instant (handles EST/EDT). */
function nyOffsetMinutes(instant: Date): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  })
    .formatToParts(instant)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = (name ?? "GMT-5").match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
  const h = m ? parseInt(m[1], 10) : -5;
  const mm = m && m[2] ? parseInt(m[2], 10) : 0;
  return h * 60 + (h < 0 ? -mm : mm);
}

/**
 * Interpret a digest date (MM/DD/YYYY) + time (HH:MM AM/PM) as an America/New_York
 * wall-clock and return the UTC instant. (The digest labels the time "EST" but the
 * real offset follows NY DST — July is EDT/-04:00 — so we resolve it against the
 * NY zone rather than trusting the label.) Returns null on unparseable input.
 */
export function etWallClockToUtc(dateText: string, timeText: string): Date | null {
  const d = dateText.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const t = timeText.match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!d || !t) return null;
  const [, moS, dayS, yS] = d;
  let hour = parseInt(t[1], 10);
  const min = parseInt(t[2], 10);
  const ampm = t[3].toUpperCase();
  if (ampm === "PM" && hour !== 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;
  const y = parseInt(yS, 10), mo = parseInt(moS, 10), day = parseInt(dayS, 10);
  // Guess the instant as if UTC, then correct by NY's offset at that instant.
  const guess = new Date(Date.UTC(y, mo - 1, day, hour, min));
  const offMin = nyOffsetMinutes(guess);
  return new Date(guess.getTime() - offMin * 60_000);
}

/** Deterministic idempotency key for one appointment within a source. */
export function appointmentKey(source: string, clientName: string, startsAtIso: string): string {
  return `${source}|${clientName.toLowerCase().trim()}|${startsAtIso}`;
}

// ---- display / bucketing (pure; `now` injected for deterministic tests) -------

const DAY = 86_400_000;

function nyParts(instant: Date): { y: number; m: number; d: number; wd: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(instant);
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: +get("year"), m: +get("month"), d: +get("day"), wd: wdMap[get("weekday")] ?? 0 };
}

/** Human "when" like the mock card: Today / Tomorrow / Weekday + time, ET. */
export function formatWhen(startsAt: Date, now: Date): string {
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", minute: "2-digit",
  }).format(startsAt);
  const a = nyParts(startsAt), n = nyParts(now);
  const dayDiff = Math.round(
    (Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(n.y, n.m - 1, n.d)) / DAY,
  );
  let label: string;
  if (dayDiff === 0) label = "Today";
  else if (dayDiff === 1) label = "Tomorrow";
  else label = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }).format(startsAt);
  return `${label} · ${time} ET`;
}

/** A short "Mon Jul 20 – Sun Jul 26" style range label, ET. */
function rangeLabel(from: Date, to: Date): string {
  const f = (dt: Date) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(dt);
  return `${f(from)} – ${f(to)}`;
}

export type BucketedMeetings = {
  meetings: Meeting[];
  meetingsNextWeek: Meeting[];
  meetingWeekRanges: { thisWeek: string; nextWeek: string };
};

/**
 * The two-week window boundaries (ms), all in the NY calendar week (Sun–Sat):
 * start of the current week (the Sunday just past), the boundary into next week
 * (the coming Sunday), and the end of next week. The read query bounds to
 * [startThisWeek, nextWeekEnd) and bucketMeetings splits at endThisWeek — so
 * every returned row lands in exactly one of the two tabs.
 */
function weekWindow(now: Date): {
  startThisWeekMs: number;
  endThisWeekMs: number;
  nextWeekEndMs: number;
} {
  const n = nyParts(now);
  const daysToSunday = (7 - n.wd) % 7 || 7; // 1..7 → the coming Sunday boundary
  const startOfTodayMs = etWallClockToUtc(`${n.m}/${n.d}/${n.y}`, "12:00 AM")!.getTime();
  const endThisWeekMs = startOfTodayMs + daysToSunday * DAY; // coming Sunday 00:00 ET
  return {
    startThisWeekMs: endThisWeekMs - 7 * DAY, // the Sunday that began this week
    endThisWeekMs,
    nextWeekEndMs: endThisWeekMs + 7 * DAY,
  };
}

/**
 * Bucket already-sorted meetings into this-week vs next-week for the card's
 * two-tab toggle. "This week" = the whole current NY calendar week (Sun–Sat),
 * INCLUDING meetings earlier today/this week that already happened (they carry
 * `past` and render as Completed); "Next week" = the following Sun–Sat. Each
 * bucket stays in soonest-first order.
 */
export function bucketMeetings(
  rows: { meeting: Meeting; startsAt: Date }[],
  now: Date,
): BucketedMeetings {
  const { startThisWeekMs, endThisWeekMs, nextWeekEndMs } = weekWindow(now);

  const meetings: Meeting[] = [];
  const meetingsNextWeek: Meeting[] = [];
  for (const { meeting, startsAt } of rows) {
    if (startsAt.getTime() < endThisWeekMs) meetings.push(meeting);
    else meetingsNextWeek.push(meeting);
  }
  return {
    meetings,
    meetingsNextWeek,
    meetingWeekRanges: {
      thisWeek: rangeLabel(new Date(startThisWeekMs), new Date(endThisWeekMs - DAY)),
      nextWeek: rangeLabel(new Date(endThisWeekMs), new Date(nextWeekEndMs - DAY)),
    },
  };
}

type Row = {
  external_key: string;
  client_name: string | null;
  client_sf_id: string | null;
  advisor_name: string | null;
  meeting_type: string | null;
  starts_at: Date;
};

/**
 * Meetings for the Command Center card across the current + next NY calendar week,
 * bucketed this-week / next-week, each soonest-first. RLS-scoped read (all app
 * roles read firm-wide per the appointment_read_all_roles policy). Returns the
 * WHOLE window — meetings earlier in the week that already happened come back with
 * `past: true` and render as "Completed" (owner ask 2026-07-23) rather than being
 * filtered out; anything outside the two weeks is excluded by the window bounds.
 */
export async function weekMeetings(
  id: Identity,
  now: Date = new Date(),
): Promise<BucketedMeetings> {
  const { startThisWeekMs, nextWeekEndMs } = weekWindow(now);
  const from = new Date(startThisWeekMs);
  const to = new Date(nextWeekEndMs);
  const rows = await withUserScope(id, (tx) =>
    tx.$queryRaw<Row[]>`
      SELECT external_key, client_name, client_sf_id, advisor_name, meeting_type, starts_at
      FROM mirror.appointment
      WHERE starts_at >= ${from} AND starts_at < ${to}
      ORDER BY starts_at ASC`,
  );
  const mapped = rows.map((r) => {
    const startsAt = new Date(r.starts_at);
    return {
      startsAt,
      meeting: {
        client: r.client_name ?? "Unknown client",
        clientId: r.client_sf_id ?? "",
        // The appointment's PRIMARY KEY — the stable per-meeting identity the
        // card keys on and app.meeting_prep.appointment_key stores. client_sf_id
        // is often null, so it can never serve as the row key.
        key: r.external_key,
        when: formatWhen(startsAt, now),
        type: r.meeting_type ?? "Appointment",
        prepReady: false,
        past: startsAt.getTime() < now.getTime(),
      } satisfies Meeting,
    };
  });
  return bucketMeetings(mapped, now);
}
