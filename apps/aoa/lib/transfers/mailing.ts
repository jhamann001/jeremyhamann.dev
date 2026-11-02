import type { Prisma } from "@prisma/client";
import { withUserScope, type Identity } from "@/lib/rls";
import { writeAudit, TRANSFER_MAILING_RECORD } from "@/lib/audit";
import { easternToday, parseIsoDay } from "@/lib/transfers/eastern-day";
import {
  MAILING_CARRIERS, MAILING_CONTENTS, MAILING_JOURNEYS, MAILING_REASONS, mailingContentsText,
  type MailingCarrier, type MailingContent, type MailingJourney, type MailingReason,
} from "@/lib/transfers/mailing-journeys";

// ATW-05 paperwork mailings (AC-41..AC-45). A mailing stores one of six
// reasons, the checked envelope contents, one of four journeys, and any postage. It never writes a
// signature, submission, or receipt (AC-42).

export {
  MAILING_CARRIERS, MAILING_CONTENTS, MAILING_JOURNEYS, MAILING_REASONS,
  type MailingCarrier, type MailingContent, type MailingJourney, type MailingReason,
};

/** One leg as typed into the dialog; blank strings mean "not recorded". */
export type MailingLegInput = { carrier: string; trackingNumber: string; mailedOn: string; receivedOn: string };

export type MailingInput = {
  reason: string;
  contents: string[];
  contentsNote: string;
  journey: string;
  postage: string;
  legs?: MailingLegInput[];
};

export type MailingError = {
  field: "reason" | "contents" | "contentsNote" | "journey" | "postage" | "form" | `leg${number}`;
  message: string;
};

export type ValidMailingLeg = {
  leg_number: number;
  from_stop: string;
  to_stop: string;
  carrier: MailingCarrier | null;
  tracking_number: string | null;
  mailed_on: Date | null;
  received_on: Date | null;
};

export type ValidMailing = {
  reason: MailingReason;
  contentItems: MailingContent[];
  contentsNote: string | null;
  journey: MailingJourney;
  postage: number | null;
  legs: ValidMailingLeg[];
};

export type MailingLegView = {
  number: number;
  label: string;
  from: string;
  to: string;
  carrier: string | null;
  trackingNumber: string | null;
  mailedOn: string | null;
  receivedOn: string | null;
};

export type SaveMailingResult =
  | { ok: true; id: string }
  | { ok: false; errors: MailingError[] };

export type MailingReportRow = {
  id: string;
  transferId: string;
  href: string;
  recordedAt: string;
  client: string;
  sourceAccount: string;
  receivingAccount: string;
  reason: string;
  contents: string;
  journey: string;
  legs: MailingLegView[];
  status: string;
  postage: string;
};

export function isMailingJourney(value: string): value is MailingJourney {
  return (MAILING_JOURNEYS as readonly string[]).includes(value);
}

function isCarrier(value: string): value is MailingCarrier {
  return (MAILING_CARRIERS as readonly string[]).includes(value);
}

function isReason(value: string): value is MailingReason {
  return (MAILING_REASONS as readonly string[]).includes(value);
}

function isContent(value: string): value is MailingContent {
  return (MAILING_CONTENTS as readonly string[]).includes(value);
}

const CONTENTS_NOTE_MAX = 1000;


/** The stops of a journey: ["Cedar Ridge", "the client", "the final destination"]. */
export function journeyStops(journey: string): string[] {
  return journey.split(" to ");
}

/**
 * Carrier, tracking and dates for each leg of the journey. A received date
 * needs a mailed date on or before it, no date may be in the future, and a leg
 * cannot be mailed before the previous leg was received.
 */
export function validateMailingLegs(
  journey: string,
  inputs: readonly MailingLegInput[] | undefined,
  today: string = easternToday(),
): { ok: true; legs: ValidMailingLeg[] } | { ok: false; errors: MailingError[] } {
  const stops = journeyStops(journey);
  const errors: MailingError[] = [];
  const legs: ValidMailingLeg[] = [];
  if (inputs && inputs.length > stops.length - 1) {
    return { ok: false, errors: [{ field: "form", message: "This journey has fewer legs than were entered." }] };
  }
  let previousReceived: string | null = null;
  for (let i = 0; i + 1 < stops.length; i += 1) {
    const field = `leg${i + 1}` as const;
    const input = inputs?.[i] ?? { carrier: "", trackingNumber: "", mailedOn: "", receivedOn: "" };
    const carrier = input.carrier.trim();
    const tracking = input.trackingNumber.trim();
    const mailedText = input.mailedOn.trim();
    const receivedText = input.receivedOn.trim();
    const mailedOn = mailedText ? parseIsoDay(mailedText) : null;
    const receivedOn = receivedText ? parseIsoDay(receivedText) : null;
    const label = `Leg ${i + 1}`;
    if (carrier && !isCarrier(carrier)) errors.push({ field, message: `${label}: choose FedEx, USPS, UPS, DHL or Other.` });
    if (tracking.length > 250) errors.push({ field, message: `${label}: keep the tracking number within 250 characters.` });
    if (mailedText && !mailedOn) errors.push({ field, message: `${label}: enter a valid mailed date.` });
    if (receivedText && !receivedOn) errors.push({ field, message: `${label}: enter a valid received date.` });
    if (receivedText && !mailedText) errors.push({ field, message: `${label}: enter the mailed date before the received date.` });
    if ((mailedOn && mailedText > today) || (receivedOn && receivedText > today)) {
      errors.push({ field, message: `${label}: dates cannot be in the future.` });
    }
    if (mailedOn && receivedOn && receivedText < mailedText) {
      errors.push({ field, message: `${label}: the received date cannot precede the mailed date.` });
    }
    if (mailedOn && previousReceived && mailedText < previousReceived) {
      errors.push({ field, message: `${label}: this leg cannot be mailed before the previous leg was received.` });
    }
    previousReceived = receivedOn ? receivedText : previousReceived;
    legs.push({
      leg_number: i + 1,
      from_stop: stops[i],
      to_stop: stops[i + 1],
      carrier: carrier && isCarrier(carrier) ? carrier : null,
      tracking_number: tracking || null,
      mailed_on: mailedOn,
      received_on: receivedOn,
    });
  }
  return errors.length ? { ok: false, errors } : { ok: true, legs };
}

export function validateMailing(input: MailingInput): { ok: true; value: ValidMailing } | { ok: false; errors: MailingError[] } {
  const errors: MailingError[] = [];
  const reason = input.reason.trim();
  const selected = [...new Set(input.contents.map((item) => item.trim()))];
  const contentsNote = input.contentsNote.trim();
  const journey = input.journey.trim();
  const postageText = input.postage.trim();
  if (!isReason(reason)) errors.push({ field: "reason", message: "Choose a mailing reason." });
  if (!selected.length || !selected.every(isContent)) {
    errors.push({ field: "contents", message: "Choose the documents or items included in this envelope." });
  }
  if (selected.includes("Other") && !contentsNote) {
    errors.push({ field: "contentsNote", message: "Describe the other items included in the envelope." });
  }
  if (contentsNote.length > CONTENTS_NOTE_MAX) {
    errors.push({ field: "contentsNote", message: "Keep the envelope details within 1,000 characters." });
  }
  if (!isMailingJourney(journey)) errors.push({ field: "journey", message: "Choose one of the four mailing journeys." });
  let postage: number | null = null;
  if (postageText !== "") {
    const parsed = Number(postageText.replace(/^\$/, ""));
    if (!Number.isFinite(parsed) || parsed < 0) {
      errors.push({ field: "postage", message: "Postage must be a non-negative amount." });
    } else {
      postage = Math.round(parsed * 100) / 100;
    }
  }
  if (errors.length > 0 || !isMailingJourney(journey) || !isReason(reason)) return { ok: false, errors };
  const legs = validateMailingLegs(journey, input.legs);
  if (!legs.ok) return legs;
  const contentItems = MAILING_CONTENTS.filter((item) => selected.includes(item));
  return {
    ok: true,
    value: { reason, contentItems, contentsNote: contentsNote || null, journey, postage, legs: legs.legs },
  };
}

/** The stops of a journey, joined pairwise: "Cedar Ridge → the client", … */
export function journeyLegs(journey: string): string[] {
  const stops = journeyStops(journey);
  const legs: string[] = [];
  for (let i = 0; i + 1 < stops.length; i += 1) legs.push(`${stops[i]} → ${stops[i + 1]}`);
  return legs;
}

/** Inserts one mailing. Writes `app.transfer_mailing` and the audit row only. */
export async function saveMailing(
  tx: Prisma.TransactionClient,
  identity: Identity,
  transferId: string,
  input: MailingInput,
  enabled: boolean,
): Promise<SaveMailingResult> {
  if (!enabled) return { ok: false, errors: [{ field: "form", message: "Mailings are not available." }] };
  const valid = validateMailing(input);
  if (!valid.ok) return valid;
  const row = await tx.transferMailing.create({
    data: {
      transfer_id: transferId,
      reason: valid.value.reason,
      contents: mailingContentsText(valid.value.contentItems, valid.value.contentsNote),
      content_items: valid.value.contentItems,
      contents_note: valid.value.contentsNote,
      journey: valid.value.journey,
      postage: valid.value.postage,
      legs: { create: valid.value.legs },
    },
    select: { id: true },
  });
  await writeAudit(tx, identity, {
    action: TRANSFER_MAILING_RECORD,
    entityType: "transfer",
    entityId: transferId,
    detail: {
      mailingId: row.id,
      reason: valid.value.reason,
      contentItems: valid.value.contentItems,
      journey: valid.value.journey,
      hasPostage: valid.value.postage != null,
      trackedLegs: valid.value.legs.filter((leg) => leg.tracking_number != null).length,
    },
  });
  return { ok: true, id: row.id };
}

/**
 * Updates the carrier, tracking and dates of a saved mailing's legs. The
 * reason, contents and journey stay as recorded.
 */
export async function updateMailingLegs(
  tx: Prisma.TransactionClient,
  identity: Identity,
  transferId: string,
  mailingId: string,
  inputs: MailingLegInput[],
  enabled: boolean,
  today: string = easternToday(),
): Promise<SaveMailingResult> {
  if (!enabled) return { ok: false, errors: [{ field: "form", message: "Mailings are not available." }] };
  const mailing = await tx.transferMailing.findFirst({
    where: { id: mailingId, transfer_id: transferId },
    select: { id: true, journey: true },
  });
  if (!mailing) return { ok: false, errors: [{ field: "form", message: "That mailing is no longer available." }] };
  const valid = validateMailingLegs(mailing.journey, inputs, today);
  if (!valid.ok) return valid;
  for (const leg of valid.legs) {
    const { leg_number, ...values } = leg;
    await tx.transferMailingLeg.upsert({
      where: { mailing_id_leg_number: { mailing_id: mailing.id, leg_number } },
      create: { mailing_id: mailing.id, leg_number, ...values },
      update: values,
    });
  }
  await writeAudit(tx, identity, {
    action: TRANSFER_MAILING_RECORD,
    entityType: "transfer",
    entityId: transferId,
    detail: {
      mailingId: mailing.id,
      kind: "legs_update",
      trackedLegs: valid.legs.filter((leg) => leg.tracking_number != null).length,
    },
  });
  return { ok: true, id: mailing.id };
}

type ReportSource = {
  id: string;
  transfer_id: string;
  reason: string;
  contents: string;
  journey: string;
  postage: { toString(): string } | number | null;
  created_at: Date;
  legs?: {
    leg_number: number;
    from_stop: string;
    to_stop: string;
    carrier: string | null;
    tracking_number: string | null;
    mailed_on: Date | null;
    received_on: Date | null;
  }[];
  transfer: {
    client_first_name: string;
    client_last_name: string;
    asset_map_custodian: string | null;
    asset_map_account_type: string | null;
    asset_map_account_number: string | null;
    transferring_firm?: string | null;
    source_account_type?: string | null;
    source_account_last4?: string | null;
    accounts: { label: string }[];
  };
};

function maskedNumber(number: string | null): string | null {
  if (!number) return null;
  const digits = number.replace(/\s/g, "");
  return digits.length <= 4 ? `••${digits}` : `••${digits.slice(-4)}`;
}

function money(value: ReportSource["postage"]): string {
  if (value == null) return "";
  const amount = Number(value.toString());
  return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : "";
}

function day(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Saved legs, or the journey's legs with nothing recorded for older mailings. */
export function mailingLegViews(journey: string, saved: ReportSource["legs"]): MailingLegView[] {
  const stops = journeyStops(journey);
  const views: MailingLegView[] = [];
  for (let i = 0; i + 1 < stops.length; i += 1) {
    const row = saved?.find((leg) => leg.leg_number === i + 1);
    const from = row?.from_stop ?? stops[i];
    const to = row?.to_stop ?? stops[i + 1];
    views.push({
      number: i + 1,
      label: `${capitalized(from)} → ${to}`,
      from,
      to,
      carrier: row?.carrier ?? null,
      trackingNumber: row?.tracking_number ?? null,
      mailedOn: day(row?.mailed_on),
      receivedOn: day(row?.received_on),
    });
  }
  return views;
}

/** The journey status from the latest leg with a date, as in the mockup. */
export function mailingStatus(legs: readonly MailingLegView[]): string {
  for (let i = legs.length - 1; i >= 0; i -= 1) {
    const leg = legs[i];
    if (leg.mailedOn && !leg.receivedOn) return `In transit to ${leg.to}`;
    if (leg.receivedOn) {
      if (leg.to === "the client") return "Received by client";
      if (leg.to === "Cedar Ridge") return "Returned to Cedar Ridge";
      return `Received at ${leg.to}`;
    }
  }
  return "Not yet mailed";
}

/** The day the date filters use: the first mailed date, else the first received date, else the day recorded. */
export function mailingFilterDay(row: Pick<MailingReportRow, "legs" | "recordedAt">): string {
  return row.legs.find((leg) => leg.mailedOn)?.mailedOn ?? row.legs.find((leg) => leg.receivedOn)?.receivedOn ?? row.recordedAt;
}

/** AC-43: one report row from a mailing and its transfer's existing columns. */
export function mailingReportRow(source: ReportSource): MailingReportRow {
  const t = source.transfer;
  const legs = mailingLegViews(source.journey, source.legs);
  const sourceParts = [
    t.asset_map_custodian ?? t.transferring_firm ?? null,
    t.asset_map_account_type ?? t.source_account_type ?? null,
    maskedNumber(t.asset_map_account_number) ?? maskedNumber(t.source_account_last4 ?? null),
  ]
    .filter((part): part is string => Boolean(part));
  return {
    id: source.id,
    transferId: source.transfer_id,
    href: `/asset-transfer/${source.transfer_id}`,
    recordedAt: source.created_at.toISOString().slice(0, 10),
    client: `${t.client_first_name} ${t.client_last_name}`.trim(),
    sourceAccount: sourceParts.join(" · "),
    receivingAccount: t.accounts.map((account) => account.label).join("; "),
    reason: source.reason,
    contents: source.contents,
    journey: source.journey,
    legs,
    status: mailingStatus(legs),
    postage: money(source.postage),
  };
}

export const MAILING_REPORT_COLUMNS = [
  "Recorded",
  "Client",
  "Source account",
  "Receiving account",
  "Envelope contents",
  "Journey legs",
  "Journey status",
  "Carriers",
  "Tracking numbers",
  "Mailed dates",
  "Received dates",
  "Postage",
  "Reason",
] as const;

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** AC-44: the download carries the same fields as the list. */
export function mailingReportCsv(rows: readonly MailingReportRow[]): string {
  const lines = [MAILING_REPORT_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push([
      row.recordedAt,
      row.client,
      row.sourceAccount,
      row.receivingAccount,
      row.contents,
      row.legs.map((leg) => leg.label).join(" | "),
      row.status,
      row.legs.map((leg) => leg.carrier ?? "").join(" | "),
      row.legs.map((leg) => leg.trackingNumber ?? "").join(" | "),
      row.legs.map((leg) => leg.mailedOn ?? "").join(" | "),
      row.legs.map((leg) => leg.receivedOn ?? "").join(" | "),
      row.postage,
      row.reason,
    ].map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

const REPORT_SELECT = {
  id: true,
  transfer_id: true,
  reason: true,
  contents: true,
  journey: true,
  postage: true,
  created_at: true,
  legs: {
    select: {
      leg_number: true,
      from_stop: true,
      to_stop: true,
      carrier: true,
      tracking_number: true,
      mailed_on: true,
      received_on: true,
    },
    orderBy: { leg_number: "asc" as const },
  },
  transfer: {
    select: {
      transferring_firm: true,
      source_account_type: true,
      source_account_last4: true,
      client_first_name: true,
      client_last_name: true,
      asset_map_custodian: true,
      asset_map_account_type: true,
      asset_map_account_number: true,
      accounts: { select: { label: true }, orderBy: { id: "asc" as const } },
    },
  },
} satisfies Prisma.TransferMailingSelect;

export async function getMailingReport(identity: Identity, transferId?: string): Promise<MailingReportRow[]> {
  const rows = await withUserScope(identity, (tx) =>
    tx.transferMailing.findMany({
      where: transferId ? { transfer_id: transferId } : { transfer: { archived_at: null } },
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      take: 500,
      select: REPORT_SELECT,
    }),
  );
  return rows.map(mailingReportRow);
}
