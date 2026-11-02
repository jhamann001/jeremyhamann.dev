import { emailEnvelopeAssignment } from "@/lib/ingest/email-envelope";
import { stripLoggedBcc, type EmailEnvelope } from "@/lib/email-search/envelope";
import type { Prisma } from "@prisma/client";
import { INGEST_EMAILS, writeAudit } from "@/lib/audit";
import { requireIngestToken } from "@/lib/ingest/auth";
import { withIngestScope } from "@/lib/ingest/scope";
import { logIngestSuccess } from "@/lib/observability/structured-log";
import type {
  EmailsItem,
  IngestDryRunResponse,
  IngestErrorBody,
  IngestLiveResponse,
  RejectedItem,
} from "@/lib/ingest/types";
import { validateEmailsItem, validateEnvelope } from "@/lib/ingest/validate";

// Node runtime: crypto (auth) + Prisma. Plain POST handler, no intercepting/
// parallel routes (TDD §14). Same skeleton as the tasks route.
export const runtime = "nodejs";

const MAX_ITEMS = 5000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const err = (error: IngestErrorBody["error"], status: number) =>
  Response.json({ error } satisfies IngestErrorBody, { status });

// Shared 405 helper — guarantees the TDD §8 body rather than Next's default.
// NOT exported (Next.js rejects non-Route exports from a route module); the
// HTTP-verb exports below are the public surface and each returns this body.
function methodNotAllowed(): Response {
  return err("method_not_allowed", 405);
}
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

export async function POST(req: Request): Promise<Response> {
  // 1. Auth.
  if (!requireIngestToken(req).ok) return err("unauthorized", 401);

  // 2. Parse + body-size cap.
  const contentLength = req.headers.get("content-length");
  // Number.isFinite guards a non-numeric header (NaN would silently skip the
  // early cap); the post-parse byte proxy still backstops oversize regardless.
  if (contentLength) {
    const n = Number(contentLength);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) return err("too_large", 413);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err("bad_request", 400);
  }
  if (Buffer.byteLength(JSON.stringify(body ?? null)) > MAX_BODY_BYTES)
    return err("too_large", 413);

  // 3. Envelope.
  const parsed = validateEnvelope(body);
  if (!parsed.ok) return err("bad_request", 400);
  const { source, run_id, items } = parsed.envelope;

  // 4. Item-count cap BEFORE per-item work.
  if (items.length > MAX_ITEMS) return err("too_large", 413);

  // 5. Per-item validation.
  const rejected: RejectedItem[] = [];
  const okItems: EmailsItem[] = [];
  items.forEach((it, i) => {
    const r = validateEmailsItem(it, i);
    if (r) rejected.push(r);
    else okItems.push(it as EmailsItem);
  });

  // 6. Derive the email set: distinct sf_id, last ok-item wins on field conflict
  //    (same-run conflicts are source inconsistency; mirror reflects source).
  const emails = new Map<
    string,
    {
      email_envelope: EmailEnvelope | undefined;
      household_sf_id: string;
      subject: string | null;
      body: string | null;
      sent_at: string | null;
      last_modified_at: string | null;
    }
  >();
  for (const it of okItems) {
    emails.set(it.sf_id, {
      email_envelope: it.email_envelope,
      household_sf_id: it.household_sf_id,
      // Coalesce optional fields to null: an OMITTED key is JS `undefined`,
      // which the pg driver rejects in a raw tagged template (this is NOT
      // Prisma's "skip" semantics). `?? null` makes an omitted key bind SQL
      // NULL, matching the null-sent path. (QC MEDIUM.)
      subject: it.subject ?? null,
      body: stripLoggedBcc(it.body),
      sent_at: it.sent_at ?? null,
      last_modified_at: it.last_modified_at ?? null,
    });
  }

  // 7. dryRun.
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";

  // 8. Persist in ONE transaction. Live: emails, then the audit row. dryRun:
  //    audit row ONLY.
  try {
    await withIngestScope(async (tx) => {
      if (!dryRun) {
        for (const [sf_id, e] of emails) {
          // NOT DELETE. sent_at/last_modified_at may be null — a ::timestamptz
          // cast of null is fine (binds SQL NULL).
          await tx.$executeRaw`
            INSERT INTO mirror.email
              (sf_id, household_sf_id, subject, body, sent_at, source_modified_at, email_envelope)
            VALUES
              (${sf_id}, ${e.household_sf_id}, ${e.subject}, ${e.body},
               ${e.sent_at}::timestamptz, ${e.last_modified_at}::timestamptz,
               ${e.email_envelope ? JSON.stringify(e.email_envelope) : null}::jsonb)
            ON CONFLICT (sf_id) DO UPDATE SET
              household_sf_id = EXCLUDED.household_sf_id,
              subject = EXCLUDED.subject,
              body = EXCLUDED.body,
              sent_at = EXCLUDED.sent_at,
              source_modified_at = EXCLUDED.source_modified_at,
              email_envelope = ${emailEnvelopeAssignment(e.email_envelope)},
              synced_at = now()
          `;
        }
      }

      // Same-tx audit row (ADR-8), counts only. upserted = okItems.length (ITEM
      // count, not distinct-email count — the frozen invariant is items.length −
      // rejected.length).
      await writeAudit(
        tx as Prisma.TransactionClient,
        { role: "INGEST", email: null },
        {
          action: INGEST_EMAILS,
          entityType: "ingest_run",
          entityId: run_id,
          detail: {
            source,
            endpoint: "emails",
            received: items.length,
            upserted: okItems.length,
            rejected: rejected.length,
            dry_run: dryRun,
          },
        },
      );
    });
  } catch {
    // Sanitize run_id before logging — it is user-controlled envelope input, so
    // URL-encode it (neutralizes newlines/control chars, the log-injection
    // vector) — the form SAST recognizes as a CWE-117 sanitizer.
    const safeRunId = encodeURIComponent(run_id).slice(0, 256);
    console.error(`[ingest] emails run_id=${safeRunId} tx_failed`);
    return err("internal", 500);
  }

  // 9. Response. upserted/would_upsert = okItems.length (item count).
  if (dryRun) {
    return Response.json({
      would_upsert: okItems.length,
      rejected,
      run_id,
    } satisfies IngestDryRunResponse);
  }
  if (rejected.length === 0) logIngestSuccess("emails");
  return Response.json({
    upserted: okItems.length,
    rejected,
    run_id,
  } satisfies IngestLiveResponse);
}
