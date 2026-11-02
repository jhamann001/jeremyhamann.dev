import { Prisma } from "@prisma/client";
import type { EmailEnvelope } from "@/lib/email-search/envelope";

// Code-owned column reference; all observation content is bound, never SQL text.
// Legacy payload omission preserves metadata. Later observations win, except a
// regressed EmailMessage version. Replays retain the original observation time.
export function emailEnvelopeAssignment(incoming: EmailEnvelope | null | undefined): Prisma.Sql {
  const json = incoming ? JSON.stringify(incoming) : null;
  return Prisma.sql`CASE
    WHEN ${json}::jsonb IS NULL THEN mirror.email.email_envelope
    WHEN mirror.email.email_envelope IS NULL THEN ${json}::jsonb
    WHEN (${json}::jsonb->>'observed_at')::timestamptz <= (mirror.email.email_envelope->>'observed_at')::timestamptz THEN mirror.email.email_envelope
    WHEN mirror.email.email_envelope->>'state' = 'MATCHED' AND ${json}::jsonb->>'state' = 'MATCHED'
      AND left(mirror.email.email_envelope->>'message_sf_id',15) = left(${json}::jsonb->>'message_sf_id',15)
      AND mirror.email.email_envelope->>'source_modified_at' IS NOT NULL
      AND (${json}::jsonb->>'source_modified_at' IS NULL OR
        (${json}::jsonb->>'source_modified_at')::timestamptz < (mirror.email.email_envelope->>'source_modified_at')::timestamptz) THEN mirror.email.email_envelope
    WHEN (mirror.email.email_envelope - 'observed_at') = (${json}::jsonb - 'observed_at') THEN mirror.email.email_envelope
    ELSE ${json}::jsonb END`;
}
