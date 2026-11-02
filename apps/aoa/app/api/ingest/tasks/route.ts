import type { Prisma } from "@prisma/client";
import { INGEST_TASKS, writeAudit } from "@/lib/audit";
import { requireIngestToken } from "@/lib/ingest/auth";
import { withIngestScope } from "@/lib/ingest/scope";
import { logIngestSuccess } from "@/lib/observability/structured-log";
import type {
  TasksItem,
  TaskAssignment,
  IngestDryRunResponse,
  IngestErrorBody,
  IngestLiveResponse,
  RejectedItem,
} from "@/lib/ingest/types";
import { validateTasksItem, validateEnvelope } from "@/lib/ingest/validate";

// Node runtime: crypto (auth) + Prisma. Plain POST handler, no intercepting/
// parallel routes (TDD §14). Same skeleton as the accounts route.
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
  const okItems: TasksItem[] = [];
  items.forEach((it, i) => {
    const r = validateTasksItem(it, i);
    if (r) rejected.push(r);
    else okItems.push(it as TasksItem);
  });

  // 6. Derive the task set: distinct sf_id, last ok-item wins on field conflict
  //    (same-run conflicts are source inconsistency; mirror reflects source).
  const tasks = new Map<
    string,
    {
      household_sf_id: string;
      subject: string | null;
      status: string | null;
      priority: string | null;
      description: string | null;
      last_modified_at: string | null;
      assignment: TaskAssignment | null;
    }
  >();
  for (const it of okItems) {
    // Assignment is an atomic observation, independent of legacy task fields.
    // A later legacy duplicate cannot discard enrichment. On an equal clock,
    // retain the first observation, matching the database's replay semantics.
    const previous = tasks.get(it.sf_id)?.assignment ?? null;
    const assignment = it.assignment && (!previous
      || Date.parse(it.assignment.observed_at) > Date.parse(previous.observed_at))
      ? it.assignment : previous;
    tasks.set(it.sf_id, {
      household_sf_id: it.household_sf_id,
      // Coalesce optional fields to null: an OMITTED key is JS `undefined`,
      // which the pg driver rejects in a raw tagged template (this is NOT
      // Prisma's "skip" semantics). `?? null` makes an omitted key bind SQL
      // NULL, matching the null-sent path. (QC MEDIUM.)
      subject: it.subject ?? null,
      status: it.status ?? null,
      priority: it.priority ?? null,
      description: it.description ?? null,
      last_modified_at: it.last_modified_at ?? null,
      assignment,
    });
  }

  // 7. dryRun.
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";

  // 8. Persist in ONE transaction. Live: tasks, then the audit row. dryRun:
  //    audit row ONLY.
  try {
    await withIngestScope(async (tx) => {
      if (!dryRun) {
        for (const [sf_id, t] of tasks) {
          const assignment = t.assignment;
          // NOT DELETE. last_modified_at may be null — a ::timestamptz cast of
          // null is fine (binds SQL NULL).
          await tx.$executeRaw`
            INSERT INTO mirror.task
              (sf_id, household_sf_id, subject, status, priority, description, source_modified_at,
               assignment_state, assignee_sf_id, assignee_type, assignee_name, assignment_observed_at)
            VALUES
              (${sf_id}, ${t.household_sf_id}, ${t.subject}, ${t.status}, ${t.priority},
               ${t.description}, ${t.last_modified_at}::timestamptz,
               ${assignment?.state ?? "UNAVAILABLE"}, ${assignment?.assignee_id ?? null},
               ${assignment?.assignee_type ?? null}, ${assignment?.assignee_name ?? null},
               ${assignment?.observed_at ?? null}::timestamptz)
            ON CONFLICT (sf_id) DO UPDATE SET
              household_sf_id = EXCLUDED.household_sf_id,
              subject = EXCLUDED.subject,
              status = EXCLUDED.status,
              priority = EXCLUDED.priority,
              description = EXCLUDED.description,
              source_modified_at = EXCLUDED.source_modified_at,
              assignment_state = CASE WHEN EXCLUDED.assignment_observed_at IS NOT NULL
                AND (task.assignment_observed_at IS NULL OR EXCLUDED.assignment_observed_at > task.assignment_observed_at)
                THEN EXCLUDED.assignment_state ELSE task.assignment_state END,
              assignee_sf_id = CASE WHEN EXCLUDED.assignment_observed_at IS NOT NULL
                AND (task.assignment_observed_at IS NULL OR EXCLUDED.assignment_observed_at > task.assignment_observed_at)
                THEN EXCLUDED.assignee_sf_id ELSE task.assignee_sf_id END,
              assignee_type = CASE WHEN EXCLUDED.assignment_observed_at IS NOT NULL
                AND (task.assignment_observed_at IS NULL OR EXCLUDED.assignment_observed_at > task.assignment_observed_at)
                THEN EXCLUDED.assignee_type ELSE task.assignee_type END,
              assignee_name = CASE WHEN EXCLUDED.assignment_observed_at IS NOT NULL
                AND (task.assignment_observed_at IS NULL OR EXCLUDED.assignment_observed_at > task.assignment_observed_at)
                THEN EXCLUDED.assignee_name ELSE task.assignee_name END,
              assignment_observed_at = CASE WHEN EXCLUDED.assignment_observed_at IS NOT NULL
                AND (task.assignment_observed_at IS NULL OR EXCLUDED.assignment_observed_at > task.assignment_observed_at)
                THEN EXCLUDED.assignment_observed_at ELSE task.assignment_observed_at END,
              synced_at = now()
          `;
        }
      }

      // Same-tx audit row (ADR-8), counts only. upserted = okItems.length (ITEM
      // count, not distinct-task count — the frozen invariant is items.length −
      // rejected.length).
      await writeAudit(
        tx as Prisma.TransactionClient,
        { role: "INGEST", email: null },
        {
          action: INGEST_TASKS,
          entityType: "ingest_run",
          entityId: run_id,
          detail: {
            source,
            endpoint: "tasks",
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
    console.error(`[ingest] tasks run_id=${safeRunId} tx_failed`);
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
  if (rejected.length === 0) logIngestSuccess("tasks");
  return Response.json({
    upserted: okItems.length,
    rejected,
    run_id,
  } satisfies IngestLiveResponse);
}
