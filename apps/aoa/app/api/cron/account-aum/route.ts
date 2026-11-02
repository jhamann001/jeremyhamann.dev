import crypto from "crypto";
import type { Prisma } from "@prisma/client";
import { INGEST_ACCOUNT_AUM, writeAudit } from "@/lib/audit";
import { checkAumFreshness } from "@/lib/data/feed-health";
import { requireIngestToken } from "@/lib/ingest/auth";
import { withIngestScope } from "@/lib/ingest/scope";
import { queryWarehouseCard } from "@/lib/warehouse/client";
import { activeAccountCloseDateOverridesInTransaction } from "@/lib/data/account-close-date-overrides";
import {
  validateAccountAumSnapshot,
  type SnapshotValidationError,
  type ValidatedAccountAumSnapshot,
} from "@/lib/data/account-aum-snapshot";

// Node runtime: crypto (auth + run id) + Prisma. The FIRST scheduled/internal
// route in the app — Cloud Scheduler POSTs here daily and the app PULLS from a
// saved Warehouse question (card 6601), rather than n8n PUSHing an envelope. Auth
// REUSES the ingest bearer token (requireIngestToken → process.env.INGEST_TOKEN);
// no new secret. Same 405 posture as the app/api/ingest/* routes.
//
// ticket: repointed 6436 → 6601. Card 6601 keys on custodian_account_id (a
// ULID, ALWAYS present) and carries cash_equity, position_market_value, and
// total_equity from one account/date row. apex_account_number is NULL for the 4 firm corporate
// accounts, so it is no longer the key. Any account whose custodian ULID is in
// the firm seed (lib/data/firm-household) is attributed to the "Cedar Ridge Wealth"
// firm household — the card emits a NULL household_sf_id for them, and the app
// (not the warehouse) owns that attribution.
export const runtime = "nodejs";

const CARD_ID = 6601;
const SOURCE = "warehouse-card-6601";

type ErrorBody = { error: string };
const err = (error: string, status: number) =>
  Response.json({ error } satisfies ErrorBody, { status });

// Shared 405 (NOT exported — Next rejects non-Route exports); each verb below
// returns it, guaranteeing our body over Next's default.
function methodNotAllowed(): Response {
  return err("method_not_allowed", 405);
}
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

const utcDate = (value: string | null) =>
  value == null ? null : new Date(`${value}T00:00:00.000Z`);

class SnapshotValidationFailure extends Error {
  constructor(readonly errors: SnapshotValidationError[]) {
    super("snapshot_validation_failed");
  }
}
class SnapshotOutOfOrder extends Error {
  constructor(readonly committedAsOf: string) {
    super("snapshot_out_of_order");
  }
}

export async function POST(req: Request): Promise<Response> {
  // 1. Auth — the same bearer gate the push ingest routes use.
  if (!requireIngestToken(req).ok) return err("unauthorized", 401);

  const searchParams = new URL(req.url).searchParams;
  const dryRun = searchParams.get("dryRun") === "1";
  const onlyIfStale = searchParams.get("onlyIfStale") === "1";

  // The 10:00 ET retry uses onlyIfStale=1. It reads the already-loaded feed
  // before contacting Warehouse so a successful 09:00 primary run is not
  // needlessly repeated. A failed precheck fails closed: without an
  // authoritative freshness verdict, the route must not guess whether to
  // overwrite the mirror.
  if (onlyIfStale) {
    try {
      const freshness = await checkAumFreshness();
      if (freshness.ok) {
        return Response.json({
          skipped: true,
          reason: "already_fresh",
          expected_min_as_of: freshness.expectedMinAsOf,
          as_of_max: freshness.maxAsOf,
          source: SOURCE,
        });
      }
    } catch {
      console.error("[cron:account-aum] freshness_precheck_failed");
      return err("internal", 500);
    }
  }

  const runId = crypto.randomUUID();
  // Log-injection-safe run id (security scanner CWE-117 convention — encodeURIComponent is
  // the recognized sanitizer). run id is app-generated here, but keep the idiom.
  const safeRunId = encodeURIComponent(runId).slice(0, 256);

  // 3. Pull the saved question as a JSON array of row objects keyed by the card
  //    column aliases. Log STATUS ONLY on failure — never the key/url/body.
  let payload: unknown;
  try {
    payload = await queryWarehouseCard(
      CARD_ID,
      [],
      "cron:account-aum",
      (reason, message) => Object.assign(new Error(message), { reason }),
    );
  } catch {
    console.error(`[cron:account-aum] warehouse_fetch_failed run_id=${safeRunId}`);
    return err(
      process.env.WAREHOUSE_URL && process.env.WAREHOUSE_API_KEY
        ? "warehouse_error"
        : "config_error",
      process.env.WAREHOUSE_URL && process.env.WAREHOUSE_API_KEY ? 502 : 500,
    );
  }
  if (!Array.isArray(payload)) {
    console.error(`[cron:account-aum] warehouse_bad_shape run_id=${safeRunId}`);
    return err("warehouse_error", 502);
  }
  // 4. Serialize the full decision + commit. The transaction advisory lock
  //    prevents overlapping scheduler/manual runs from interleaving. Active
  //    close-date fallbacks are read only after the lock, so one run cannot
  //    reintroduce a fallback that an earlier authoritative run just retired.
  let snapshot: ValidatedAccountAumSnapshot;
  try {
    snapshot = await withIngestScope(async (tx) => {
      // Prisma cannot deserialize PostgreSQL's native `void` result. Cast the
      // lock result to text; the value is irrelevant, acquisition is the effect.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(1095710769)::text AS locked`;
      const overrides = await activeAccountCloseDateOverridesInTransaction(tx);
      const validation = validateAccountAumSnapshot(payload, overrides);
      if (!validation.ok) throw new SnapshotValidationFailure(validation.errors);
      const candidate = validation.snapshot;

      const committed = await tx.$queryRaw<{ max_as_of: string | null }[]>`
        SELECT to_char(max(source_snapshot_as_of), 'YYYY-MM-DD') AS max_as_of
        FROM mirror.client_account_aum
        WHERE source_present`;
      const committedAsOf = committed[0]?.max_as_of ?? null;
      if (committedAsOf && candidate.sourceSnapshotAsOf < committedAsOf) {
        throw new SnapshotOutOfOrder(committedAsOf);
      }

      if (!dryRun) {
        // Seen rows receive this run id first; only then are prior-run rows
        // retired. Any failure rolls all of it back.
        for (const r of candidate.rows) {
          await tx.$executeRaw`
            INSERT INTO mirror.client_account_aum
              (custodian_account_id, apex_account_number, client_sf_id, household_sf_id,
               account_type, is_managed, account_status, account_aum, as_of,
               account_cash, account_securities, balance_as_of, source_snapshot_as_of,
               balance_current, source_present, close_date, close_date_source,
               snapshot_run_id, expected_snapshot_rows, expected_current_accounts,
               expected_closed_accounts, expected_corporate_accounts)
            VALUES
              (${r.custodianAccountId}, ${r.apexAccountNumber}, ${r.clientSfId}, ${r.householdSfId},
               ${r.accountType}, ${r.isManaged}, ${r.accountStatus}, ${r.accountAum},
               ${utcDate(r.sourceSnapshotAsOf)}, ${r.accountCash}, ${r.accountSecurities},
               ${utcDate(r.balanceAsOf)}, ${utcDate(r.sourceSnapshotAsOf)}, ${r.balanceCurrent},
               true, ${utcDate(r.closeDate)}, ${r.closeDateSource}, ${runId},
               ${candidate.expectedSnapshotRows}, ${candidate.expectedCurrentAccounts},
               ${candidate.expectedClosedAccounts}, ${candidate.expectedCorporateAccounts})
            ON CONFLICT (custodian_account_id) DO UPDATE SET
              apex_account_number = EXCLUDED.apex_account_number,
              client_sf_id        = EXCLUDED.client_sf_id,
              household_sf_id     = EXCLUDED.household_sf_id,
              account_type        = EXCLUDED.account_type,
              is_managed          = EXCLUDED.is_managed,
              account_status      = EXCLUDED.account_status,
              account_aum         = EXCLUDED.account_aum,
              as_of               = EXCLUDED.as_of,
              account_cash        = EXCLUDED.account_cash,
              account_securities  = EXCLUDED.account_securities,
              balance_as_of       = EXCLUDED.balance_as_of,
              source_snapshot_as_of = EXCLUDED.source_snapshot_as_of,
              balance_current     = EXCLUDED.balance_current,
              source_present      = true,
              close_date          = EXCLUDED.close_date,
              close_date_source   = EXCLUDED.close_date_source,
              snapshot_run_id     = EXCLUDED.snapshot_run_id,
              expected_snapshot_rows = EXCLUDED.expected_snapshot_rows,
              expected_current_accounts = EXCLUDED.expected_current_accounts,
              expected_closed_accounts = EXCLUDED.expected_closed_accounts,
              expected_corporate_accounts = EXCLUDED.expected_corporate_accounts,
              synced_at           = now()
          `;
        }
        const retired = await tx.$executeRaw`
          UPDATE mirror.client_account_aum
          SET source_present = false,
              balance_current = false
          WHERE source_present = true
            AND snapshot_run_id IS DISTINCT FROM ${runId}
        `;
        let retiredOverrides = 0;
        for (const row of candidate.rows) {
          if (row.closeDateSource !== "APEX") continue;
          retiredOverrides += Number(await tx.$executeRaw`
            UPDATE app.account_close_date_override
            SET retired_at = now(),
                retired_by_snapshot_run_id = ${runId}
            WHERE custodian_account_id = ${row.custodianAccountId}
              AND retired_at IS NULL
          `);
        }
        await writeAudit(
          tx as Prisma.TransactionClient,
          { role: "INGEST", email: null },
          {
            action: INGEST_ACCOUNT_AUM,
            entityType: "ingest_run",
            entityId: runId,
            detail: {
              source: "warehouse",
              card: CARD_ID,
              received: payload.length,
              upserted: candidate.rows.length,
              rejected: 0,
              retired: Number(retired),
              dry_run: dryRun,
              retired_close_date_overrides: retiredOverrides,
              as_of_max: candidate.sourceSnapshotAsOf,
              open_accounts: candidate.openAccounts,
              closed_accounts: candidate.closedAccounts,
              corporate_accounts: candidate.corporateAccounts,
              expected_snapshot_rows: candidate.expectedSnapshotRows,
              source_close_dates: candidate.sourceCloseDates,
              provisional_close_dates: candidate.provisionalCloseDates,
              trigger: onlyIfStale ? "stale_retry" : "scheduled_primary",
            },
          },
        );
      }
      return candidate;
    });
  } catch (failure) {
    if (failure instanceof SnapshotValidationFailure) {
      console.error(`[cron:account-aum] snapshot_validation_failed run_id=${safeRunId}`);
      return Response.json(
        { error: "snapshot_validation_failed", rejected: failure.errors, source: SOURCE },
        { status: 422 },
      );
    }
    if (failure instanceof SnapshotOutOfOrder) {
      console.error(`[cron:account-aum] snapshot_out_of_order run_id=${safeRunId}`);
      return Response.json(
        { error: "snapshot_out_of_order", committed_as_of: failure.committedAsOf, source: SOURCE },
        { status: 409 },
      );
    }
    console.error(`[cron:account-aum] run_id=${safeRunId} tx_failed`);
    return err("internal", 500);
  }
  const asOfMax = `${snapshot.sourceSnapshotAsOf}T00:00:00.000Z`;

  // 6. Response. would_upsert on dryRun, upserted on a live run.
  if (dryRun) {
    return Response.json({
      would_upsert: snapshot.rows.length,
      rejected: [],
      as_of_max: asOfMax,
      open_accounts: snapshot.openAccounts,
      closed_accounts: snapshot.closedAccounts,
      corporate_accounts: snapshot.corporateAccounts,
      provisional_close_dates: snapshot.provisionalCloseDates,
      source: SOURCE,
    });
  }
  return Response.json({
    upserted: snapshot.rows.length,
    rejected: [],
    as_of_max: asOfMax,
    open_accounts: snapshot.openAccounts,
    closed_accounts: snapshot.closedAccounts,
    corporate_accounts: snapshot.corporateAccounts,
    provisional_close_dates: snapshot.provisionalCloseDates,
    source: SOURCE,
  });
}
