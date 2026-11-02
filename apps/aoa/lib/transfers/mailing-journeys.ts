// The four AC-41 mailing journeys. Client-safe: no server imports.
export const MAILING_JOURNEYS = [
  "Cedar Ridge to the final destination",
  "Cedar Ridge to the client to the final destination",
  "Cedar Ridge to the client to Cedar Ridge to the final destination",
  "Cedar Ridge to the client",
] as const;

export type MailingJourney = (typeof MAILING_JOURNEYS)[number];

export const MAILING_CARRIERS = ["FedEx", "USPS", "UPS", "DHL", "Other"] as const;
export type MailingCarrier = (typeof MAILING_CARRIERS)[number];

export const MAILING_REASONS = [
  "Statement", "Wet Signature", "Physical Check / Deposit Slip", "Physical Mail", "Deceased Client", "Other",
] as const;
export type MailingReason = (typeof MAILING_REASONS)[number];

// Must match the transfer_mailing_content_items_check constraint.
export const MAILING_CONTENTS = [
  "Empty Envelope", "IRA Deposit Slip", "Manual Transfer Paperwork", "Signed transfer paperwork",
  "Return shipping label", "General Mail", "Estate Letter", "Statement", "Physical Check", "Other",
] as const;
export type MailingContent = (typeof MAILING_CONTENTS)[number];

/** The envelope as one line: the checked items, then the details note. */
export function mailingContentsText(items: readonly string[], note: string | null): string {
  const listed = items.join(", ");
  const detail = note?.trim() ?? "";
  if (!detail) return listed;
  return listed ? `${listed} — ${detail}` : detail;
}
