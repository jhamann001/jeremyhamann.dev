import { Prisma } from "@prisma/client";
import { INGEST_CLIENTS, writeAudit } from "@/lib/audit";
import { requireIngestToken } from "@/lib/ingest/auth";
import { withIngestScope } from "@/lib/ingest/scope";
import { logIngestSuccess } from "@/lib/observability/structured-log";
import type {
  ClientsItem,
  IngestDryRunResponse,
  IngestErrorBody,
  IngestLiveResponse,
  RejectedItem,
} from "@/lib/ingest/types";
import { validateClientsItem, validateEnvelope } from "@/lib/ingest/validate";

// Node runtime: `crypto` (auth) + Prisma (ingest client) cannot run on the edge
// (the app/api/health precedent). Plain POST route handler — NO intercepting or
// parallel routes (house rule, TDD §14).
export const runtime = "nodejs";

// Slice-1 caps (TDD §8). The 5 MB body cap is enforced via a
// JSON.stringify(body) byte-length proxy (+ Content-Length when present), not a
// streaming byte-accurate limiter: at ~430 rows / well under 1 MB the proxy is
// safe; a streaming limit is a D-3+ hardening.
const MAX_ITEMS = 5000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
// Keep each raw statement comfortably below Postgres' parameter ceiling while
// avoiding one database round trip per source row. A full 5,000-item request
// is at most ten household statements plus ten client statements inside the
// existing single transaction.
const UPSERT_BATCH_SIZE = 500;

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

/** Split a display name at the LAST space: everything before → first_name, last
 * token → last_name. No space → last_name only, first_name null (TDD §3;
 * lossy-tolerable — the mirror reflects source, and re-splits are idempotent). */
function splitName(name: string): { first: string | null; last: string } {
  const trimmed = name.trim();
  const idx = trimmed.lastIndexOf(" ");
  if (idx === -1) return { first: null, last: trimmed };
  return { first: trimmed.slice(0, idx), last: trimmed.slice(idx + 1) };
}

function batches<T>(items: T[]): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += UPSERT_BATCH_SIZE) {
    result.push(items.slice(i, i + UPSERT_BATCH_SIZE));
  }
  return result;
}

export async function POST(req: Request): Promise<Response> {
  // 1. Auth (fail-closed; constant-time; env at call time).
  if (!requireIngestToken(req).ok) return err("unauthorized", 401);

  // 2. Parse JSON + body-size cap.
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

  // 3. Envelope shape.
  const parsed = validateEnvelope(body);
  if (!parsed.ok) return err("bad_request", 400);
  const { source, run_id, items } = parsed.envelope;

  // 4. Item-count cap BEFORE per-item work.
  if (items.length > MAX_ITEMS) return err("too_large", 413);

  // 5. Per-item validation; ok-items are the complements (typed ClientsItem[]).
  const rejected: RejectedItem[] = [];
  const okItems: ClientsItem[] = [];
  items.forEach((it, i) => {
    const r = validateClientsItem(it, i);
    if (r) rejected.push(r);
    else okItems.push(it as ClientsItem);
  });

  // 6. Derive the household set: distinct non-null household_sf_id, last ok-item
  //    wins on name/advisor conflict (same-run conflicts are source
  //    inconsistency; mirror reflects source — TDD §5).
  const households = new Map<
    string,
    {
      household_name: string | null;
      lead_advisor_email: string | null;
      stage: string | null;
    }
  >();
  for (const it of okItems) {
    // != null excludes BOTH null and an omitted (undefined) key — an omitted
    // household_sf_id must not create a household with a NULL PK.
    if (it.household_sf_id != null) {
      households.set(it.household_sf_id, {
        // Coalesce optional fields to null: an OMITTED key is JS `undefined`,
        // which the pg driver rejects in a raw tagged template (NOT Prisma's
        // "skip"). `?? null` binds SQL NULL, matching the null-sent path.
        // (QC MEDIUM.)
        household_name: it.household_name ?? null,
        lead_advisor_email: it.lead_advisor_email ?? null,
        // stage carries the Salesforce Entity_Client_Stage__c verbatim (Client /
        // Prospect / Lost Client / Lost Prospect). `stage` is a required non-empty
        // string per the contract (validated above); `?? null` is belt-and-braces
        // to bind SQL NULL rather than let `undefined` reach the pg driver.
        stage: it.stage ?? null,
      });
    }
  }

  // 7. dryRun flag.
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";

  // 8. Persist in ONE withIngestScope transaction. Live: households (FK order),
  //    then clients, then the audit row. dryRun: the audit row ONLY — no upsert
  //    SQL is emitted at all (the compute-only honest mechanism, TDD §10).
  try {
    await withIngestScope(async (tx) => {
      if (!dryRun) {
        for (const batch of batches([...households.entries()])) {
          // NOT DELETE, NOT aum (ingest does not own aum). status='Active' on
          // INSERT only (seed default; not a contract field) so ingest never
          // overwrites a value another process set — and it stays OUT of the SET
          // list for the same reason. `stage` IS owned by the source (the
          // Salesforce lifecycle), so it is written on INSERT and re-stamped on
          // conflict — that is how a Prospect→Client or Client→Lost transition
          // propagates into the mirror on the next sync.
          const values = batch.map(
            ([sf_id, h]) =>
              Prisma.sql`(${sf_id}, ${h.household_name}, ${h.lead_advisor_email}, 'Active', ${h.stage})`,
          );
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO mirror.household (sf_id, name, lead_advisor_email, status, stage)
            VALUES ${Prisma.join(values)}
            ON CONFLICT (sf_id) DO UPDATE SET
              name = EXCLUDED.name,
              lead_advisor_email = EXCLUDED.lead_advisor_email,
              stage = EXCLUDED.stage,
              synced_at = now()
          `);
        }
        for (const batch of batches(okItems)) {
          // email is NEVER in the SET list (not in the contract — TDD §5).
          // household_id = household_sf_id (nullable now — ADR-5).
          // cedar_ridge_user_id is written as-is; two clients may share it (D-1 QC
          // LOW-3, non-unique key) — the sf_id upsert key keeps them distinct.
          //
          // COALESCE guardrail on cedar_ridge_user_id: a client-pull run that omits
          // or nulls the id (e.g. a payload-builder regression) must NOT wipe an
          // already-populated bridge key. On INSERT there is no existing row so a
          // null lands as NULL (the null-sent contract holds for new clients); on
          // CONFLICT a null keeps the stored value — a NON-null incoming id still
          // overwrites (source stays authoritative when it actually sends one).
          // This deliberately deviates from "mirror reflects source" for THIS one
          // append-mostly join key, after a null run wiped it firm-wide (2026-07-20)
          // and broke every downstream join (trade-request panels, the id gate).
          const values = batch.map((it) => {
            const { first, last } = splitName(it.name);
            return Prisma.sql`(
              ${it.sf_contact_id}, ${it.household_sf_id ?? null}, ${first}, ${last},
              ${it.cedar_ridge_user_id ?? null}, ${it.stage}, ${it.lead_advisor_email ?? null}
            )`;
          });
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO mirror.client AS c
              (sf_id, household_id, first_name, last_name, cedar_ridge_user_id, stage, lead_advisor_email)
            VALUES ${Prisma.join(values)}
            ON CONFLICT (sf_id) DO UPDATE SET
              household_id = EXCLUDED.household_id,
              first_name = EXCLUDED.first_name,
              last_name = EXCLUDED.last_name,
              cedar_ridge_user_id = COALESCE(EXCLUDED.cedar_ridge_user_id, c.cedar_ridge_user_id),
              stage = EXCLUDED.stage,
              lead_advisor_email = EXCLUDED.lead_advisor_email,
              synced_at = now()
          `);
        }
      }

      // Same-tx audit row (ADR-8), counts only — no PII.
      await writeAudit(
        tx as Prisma.TransactionClient,
        { role: "INGEST", email: null },
        {
          action: INGEST_CLIENTS,
          entityType: "ingest_run",
          entityId: run_id,
          detail: {
            source,
            endpoint: "clients",
            received: items.length,
            upserted: okItems.length,
            rejected: rejected.length,
            dry_run: dryRun,
          },
        },
      );
    });
  } catch {
    // Generic body, no internals; nothing committed (single tx, no audit row).
    // One PII-free error line: endpoint + run_id + marker, no payload.
    // run_id is user-controlled envelope input — sanitize to prevent log
    // injection (CWE-117).
    const safeRunId = encodeURIComponent(run_id).slice(0, 256);
    console.error(`[ingest] clients run_id=${safeRunId} tx_failed`);
    return err("internal", 500);
  }

  // 9. Response. upserted/would_upsert = okItems.length = items.length −
  //    rejected.length (the frozen arithmetic invariant).
  if (dryRun) {
    return Response.json({
      would_upsert: okItems.length,
      rejected,
      run_id,
    } satisfies IngestDryRunResponse);
  }
  if (rejected.length === 0) logIngestSuccess("clients");
  return Response.json({
    upserted: okItems.length,
    rejected,
    run_id,
  } satisfies IngestLiveResponse);
}
