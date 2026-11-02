import type { Prisma } from "@prisma/client";
import { INGEST_SCHWAB_ACCOUNT_BALANCES, writeAudit } from "@/lib/audit";
import { requireIngestToken } from "@/lib/ingest/auth";
import { withIngestScope } from "@/lib/ingest/scope";
import {
  resolveSchwabAccounts,
  validateSchwabSnapshot,
  type SchwabDirectoryClient,
  type SchwabDirectoryHousehold,
  type SchwabMatchSummary,
  type SchwabSnapshotRejection,
} from "@/lib/ingest/schwab-account-balance";
import { logIngestSuccess } from "@/lib/observability/structured-log";
import type { SchwabReviewedMapping } from "@/lib/schwab/review";

export const runtime = "nodejs";

const MAX_ITEMS = 5000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

type ErrorBody = {
  error: string;
  rejected?: SchwabSnapshotRejection[];
  run_id?: string;
};

const err = (
  error: string,
  status: number,
  extra: Omit<ErrorBody, "error"> = {},
) => Response.json({ error, ...extra } satisfies ErrorBody, { status });

function methodNotAllowed(): Response {
  return err("method_not_allowed", 405);
}
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

class SnapshotOutOfOrder extends Error {
  constructor(readonly committedAsOf: string) {
    super("snapshot_out_of_order");
  }
}

class IdentityResolutionFailure extends Error {
  constructor(readonly rejected: SchwabSnapshotRejection[]) {
    super("identity_resolution_failed");
  }
}

const utcDate = (value: string) => new Date(`${value}T00:00:00.000Z`);

export async function POST(req: Request): Promise<Response> {
  if (!requireIngestToken(req).ok) return err("unauthorized", 401);

  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const bytes = Number(contentLength);
    if (Number.isFinite(bytes) && bytes > MAX_BODY_BYTES) return err("too_large", 413);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err("bad_request", 400);
  }
  if (Buffer.byteLength(JSON.stringify(body ?? null)) > MAX_BODY_BYTES) {
    return err("too_large", 413);
  }

  const validation = validateSchwabSnapshot(body, MAX_ITEMS);
  if (!validation.ok) {
    const status = validation.error === "too_large"
      ? 413
      : validation.error === "snapshot_invalid" || validation.error === "snapshot_incomplete"
        ? 422
        : 400;
    return err(validation.error, status, { rejected: validation.rejected });
  }

  const snapshot = validation.envelope;
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";

  let summary: SchwabMatchSummary;
  let retired = 0;
  try {
    const result = await withIngestScope(async (tx) => {
      // Serialize the complete-snapshot decision and commit. This lock is
      // source-specific and cannot block or retire the independent Apex feed.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(1938724016)::text AS locked`;

      const committed = await tx.$queryRaw<{ max_as_of: string | null }[]>`
        SELECT to_char(max(balance_as_of), 'YYYY-MM-DD') AS max_as_of
        FROM mirror.schwab_account_balance
        WHERE source_present`;
      const committedAsOf = committed[0]?.max_as_of ?? null;
      if (committedAsOf && snapshot.as_of_date < committedAsOf) {
        throw new SnapshotOutOfOrder(committedAsOf);
      }

      const reviewedMappings = await tx.$queryRaw<SchwabReviewedMapping[]>`
        SELECT account_id AS "accountId", account_number_last4 AS "accountNumberLast4",
               client_sf_id AS "clientSfId", household_sf_id AS "householdSfId",
               account_scope AS "accountScope", version
        FROM app.schwab_account_mapping`;
      const clients = await tx.$queryRaw<Array<{
        sf_id: string;
        household_sf_id: string | null;
        name: string;
        name_eligible: boolean;
      }>>`
        SELECT c.sf_id,
               c.household_id AS household_sf_id,
               trim(concat_ws(' ', c.first_name, c.last_name)) AS name,
               c.stage = 'Client' AS name_eligible
        FROM mirror.client c
        WHERE c.stage = 'Client' OR EXISTS (
          SELECT 1 FROM app.schwab_account_mapping m WHERE m.client_sf_id = c.sf_id
        )`;
      const households = await tx.$queryRaw<Array<{ sf_id: string; name: string; name_eligible: boolean }>>`
        SELECT h.sf_id, coalesce(h.name, '') AS name, h.stage = 'Client' AS name_eligible
        FROM mirror.household h
        WHERE h.stage = 'Client' OR EXISTS (
          SELECT 1 FROM app.schwab_account_mapping m WHERE m.household_sf_id = h.sf_id
        )`;

      const directory = {
        clients: clients.map((row): SchwabDirectoryClient => ({
          sfId: row.sf_id,
          householdSfId: row.household_sf_id,
          name: row.name,
          nameEligible: row.name_eligible === true,
        })),
        households: households.map((row): SchwabDirectoryHousehold => ({
          sfId: row.sf_id,
          name: row.name,
          nameEligible: row.name_eligible === true,
        })),
      };
      const resolution = resolveSchwabAccounts(snapshot.items, directory, reviewedMappings);
      if (!resolution.ok) throw new IdentityResolutionFailure(resolution.rejected);

      let retiredCount = 0;
      if (!dryRun) {
        for (const account of resolution.accounts) {
          await tx.$executeRaw`
            INSERT INTO mirror.schwab_account_balance AS current
              (account_id, account_number, account_number_last4, account_name,
               client_sf_id, household_sf_id,
               candidate_client_sf_id, candidate_household_sf_id,
               account_type, registration_type, account_status,
               account_cash, account_securities, account_aum,
               balance_as_of, balance_current, source_present,
               resolution_method, resolution_state,
               source_key, source_etag, source_sha256,
               snapshot_run_id, expected_snapshot_rows, account_scope, reviewed_mapping_version)
            VALUES
              (${account.accountId}, ${account.account_number}, ${account.accountNumberLast4},
               ${account.account_name},
               ${account.clientSfId}, ${account.householdSfId},
               ${account.candidateClientSfId}, ${account.candidateHouseholdSfId},
               ${account.account_type}, ${account.registration_type}, 'OPEN',
               ${account.account_cash}, ${account.account_securities}, ${account.account_aum},
               ${utcDate(account.balance_as_of)}, true, true,
               ${account.resolutionMethod}, ${account.resolutionState},
               ${snapshot.source_key}, ${snapshot.source_etag}, ${snapshot.source_sha256},
               ${snapshot.run_id}, ${snapshot.expected_account_count},
               ${account.accountScope}, ${account.reviewedMappingVersion})
            ON CONFLICT (account_id) DO UPDATE SET
              account_number = EXCLUDED.account_number,
              account_number_last4 = EXCLUDED.account_number_last4,
              account_name = EXCLUDED.account_name,
              client_sf_id = CASE
                WHEN current.resolution_method = 'CRM_ACCOUNT_NUMBER'
                 AND EXCLUDED.resolution_state <> 'CONFIRMED'
                THEN current.client_sf_id ELSE EXCLUDED.client_sf_id END,
              household_sf_id = CASE
                WHEN current.resolution_method = 'CRM_ACCOUNT_NUMBER'
                 AND EXCLUDED.resolution_state <> 'CONFIRMED'
                THEN current.household_sf_id ELSE EXCLUDED.household_sf_id END,
              candidate_client_sf_id = CASE
                WHEN current.resolution_method = 'CRM_ACCOUNT_NUMBER'
                 AND EXCLUDED.resolution_state <> 'CONFIRMED'
                THEN NULL ELSE EXCLUDED.candidate_client_sf_id END,
              candidate_household_sf_id = CASE
                WHEN current.resolution_method = 'CRM_ACCOUNT_NUMBER'
                 AND EXCLUDED.resolution_state <> 'CONFIRMED'
                THEN NULL ELSE EXCLUDED.candidate_household_sf_id END,
              account_type = EXCLUDED.account_type,
              registration_type = EXCLUDED.registration_type,
              account_status = EXCLUDED.account_status,
              account_cash = EXCLUDED.account_cash,
              account_securities = EXCLUDED.account_securities,
              account_aum = EXCLUDED.account_aum,
              balance_as_of = EXCLUDED.balance_as_of,
              balance_current = true,
              source_present = true,
              resolution_method = CASE
                WHEN current.resolution_method = 'CRM_ACCOUNT_NUMBER'
                 AND EXCLUDED.resolution_state <> 'CONFIRMED'
                THEN current.resolution_method ELSE EXCLUDED.resolution_method END,
              resolution_state = CASE
                WHEN current.resolution_method = 'CRM_ACCOUNT_NUMBER'
                 AND EXCLUDED.resolution_state <> 'CONFIRMED'
                THEN current.resolution_state ELSE EXCLUDED.resolution_state END,
              source_key = EXCLUDED.source_key,
              source_etag = EXCLUDED.source_etag,
              source_sha256 = EXCLUDED.source_sha256,
              snapshot_run_id = EXCLUDED.snapshot_run_id,
              expected_snapshot_rows = EXCLUDED.expected_snapshot_rows,
              account_scope = CASE
                WHEN current.resolution_method = 'CRM_ACCOUNT_NUMBER'
                 AND EXCLUDED.resolution_state <> 'CONFIRMED'
                THEN current.account_scope ELSE EXCLUDED.account_scope END,
              reviewed_mapping_version = EXCLUDED.reviewed_mapping_version,
              synced_at = now()
          `;
        }
        retiredCount = Number(await tx.$executeRaw`
          UPDATE mirror.schwab_account_balance
          SET source_present = false,
              balance_current = false,
              synced_at = now()
          WHERE source_present
            AND NOT (account_id = ANY(${resolution.accounts.map((account) => account.accountId)}::text[]))
        `);
      }

      await writeAudit(
        tx as Prisma.TransactionClient,
        { role: "INGEST", email: null },
        {
          action: INGEST_SCHWAB_ACCOUNT_BALANCES,
          entityType: "ingest_run",
          entityId: snapshot.run_id,
          detail: {
            source: snapshot.source,
            endpoint: "schwab-account-balances",
            received: snapshot.items.length,
            upserted: dryRun ? 0 : resolution.accounts.length,
            would_upsert: dryRun ? resolution.accounts.length : 0,
            rejected: 0,
            retired: retiredCount,
            dry_run: dryRun,
            as_of_max: snapshot.as_of_date,
            authoritative: resolution.summary.authoritative,
            operations_reviewed: resolution.summary.operations_reviewed,
            firm_operating: resolution.summary.firm_operating,
            exact_client_name: resolution.summary.exact_client_name,
            exact_household_name: resolution.summary.exact_household_name,
            ambiguous: resolution.summary.ambiguous,
            unmatched: resolution.summary.unmatched,
          },
        },
      );

      return { summary: resolution.summary, retired: retiredCount };
    });
    summary = result.summary;
    retired = result.retired;
  } catch (failure) {
    if (failure instanceof SnapshotOutOfOrder) {
      return err("snapshot_out_of_order", 409, { run_id: snapshot.run_id });
    }
    if (failure instanceof IdentityResolutionFailure) {
      return err("snapshot_invalid", 422, {
        rejected: failure.rejected,
        run_id: snapshot.run_id,
      });
    }
    console.error("[ingest] schwab-account-balances tx_failed");
    return err("internal", 500);
  }

  if (!dryRun) logIngestSuccess("schwab-account-balances");
  return Response.json({
    ...(dryRun
      ? { would_upsert: snapshot.items.length }
      : { upserted: snapshot.items.length, retired }),
    rejected: [],
    run_id: snapshot.run_id,
    as_of_date: snapshot.as_of_date,
    match_summary: summary,
  });
}
