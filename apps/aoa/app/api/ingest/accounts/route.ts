import type { Prisma } from "@prisma/client";
import { INGEST_ACCOUNTS, writeAudit } from "@/lib/audit";
import { requireIngestToken } from "@/lib/ingest/auth";
import { withIngestScope } from "@/lib/ingest/scope";
import { logIngestSuccess } from "@/lib/observability/structured-log";
import type {
  AccountsItem,
  IngestDryRunResponse,
  IngestErrorBody,
  IngestLiveResponse,
  RejectedItem,
} from "@/lib/ingest/types";
import { validateAccountsItem, validateEnvelope } from "@/lib/ingest/validate";

// Node runtime: crypto (auth) + Prisma. Plain POST handler, no intercepting/
// parallel routes (TDD §14). Same skeleton as the clients route.
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
  const okItems: AccountsItem[] = [];
  items.forEach((it, i) => {
    const r = validateAccountsItem(it, i);
    if (r) rejected.push(r);
    else okItems.push(it as AccountsItem);
  });

  // 6. Derive the account set: distinct custodian_account_id, last ok-item wins
  //    on field conflict. Holders are per (custodian_account_id,
  //    cedar_ridge_user_id) ok-PAIR — a joint account (two items, same account id,
  //    different holder id) yields two holder rows (ADR-4). Duplicate pairs
  //    collapse (idempotent composite-PK upsert).
  const accounts = new Map<
    string,
    {
      custodian: string;
      account_type: string | null;
      status: string;
      opened_at: string | null;
      closed_at: string | null;
    }
  >();
  const holders = new Map<string, { account_id: string; user_id: string }>();
  for (const it of okItems) {
    accounts.set(it.custodian_account_id, {
      custodian: it.custodian,
      // Coalesce optional fields to null: an OMITTED key is JS `undefined`,
      // which the pg driver rejects in a raw tagged template (this is NOT
      // Prisma's "skip" semantics). `?? null` makes an omitted key bind SQL
      // NULL, matching the null-sent path. (QC MEDIUM.)
      account_type: it.account_type ?? null,
      status: it.status,
      opened_at: it.opened_at ?? null,
      closed_at: it.closed_at ?? null,
    });
    // Dedup key for the holder pair. "|" cannot appear in a custodian_account_id
    // (D8 rule: [A-Za-z0-9*-]) or an cedar_ridge_user_id (user-[0-9a-f-]), so it is
    // a collision-free separator.
    holders.set(`${it.custodian_account_id}|${it.cedar_ridge_user_id}`, {
      account_id: it.custodian_account_id,
      user_id: it.cedar_ridge_user_id,
    });
  }

  // 7. dryRun.
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";

  // 8. Persist in ONE transaction. Live: accounts, then holders, then the audit
  //    row. dryRun: audit row ONLY.
  try {
    await withIngestScope(async (tx) => {
      if (!dryRun) {
        for (const [id, a] of accounts) {
          // opened_at/closed_at cast to date (or null). NOT DELETE.
          await tx.$executeRaw`
            INSERT INTO mirror.account
              (custodian_account_id, custodian, account_type, status, opened_at, closed_at)
            VALUES
              (${id}, ${a.custodian}, ${a.account_type}, ${a.status},
               ${a.opened_at}::date, ${a.closed_at}::date)
            ON CONFLICT (custodian_account_id) DO UPDATE SET
              custodian = EXCLUDED.custodian,
              account_type = EXCLUDED.account_type,
              status = EXCLUDED.status,
              opened_at = EXCLUDED.opened_at,
              closed_at = EXCLUDED.closed_at,
              synced_at = now()
          `;
        }
        for (const [, h] of holders) {
          // Holder cedar_ridge_user_ids matching no mirror.client are TOLERATED
          // (no FK — the clients run may not have landed yet; TDD §5).
          await tx.$executeRaw`
            INSERT INTO mirror.account_holder (custodian_account_id, cedar_ridge_user_id)
            VALUES (${h.account_id}, ${h.user_id})
            ON CONFLICT (custodian_account_id, cedar_ridge_user_id) DO UPDATE SET
              synced_at = now()
          `;
        }
      }

      // Same-tx audit row (ADR-8), counts only. upserted = okItems.length (ITEM
      // count, not distinct-account count — two joint holders = two processed
      // items; the frozen invariant is items.length − rejected.length).
      await writeAudit(
        tx as Prisma.TransactionClient,
        { role: "INGEST", email: null },
        {
          action: INGEST_ACCOUNTS,
          entityType: "ingest_run",
          entityId: run_id,
          detail: {
            source,
            endpoint: "accounts",
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
    console.error(`[ingest] accounts run_id=${safeRunId} tx_failed`);
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
  if (rejected.length === 0) logIngestSuccess("accounts");
  return Response.json({
    upserted: okItems.length,
    rejected,
    run_id,
  } satisfies IngestLiveResponse);
}
