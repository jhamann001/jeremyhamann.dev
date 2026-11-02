import crypto from "crypto";
import type { Prisma } from "@prisma/client";
import { INGEST_LINKED_EXTERNAL_ACCOUNT_SUMMARY, writeAudit } from "@/lib/audit";
import { requireIngestToken } from "@/lib/ingest/auth";
import { withIngestScope } from "@/lib/ingest/scope";
import { queryWarehouseCard } from "@/lib/warehouse/client";
import { validateLinkedExternalSummarySnapshot } from "@/lib/data/linked-external-account-summary-snapshot";

// Scheduled pull of active Plaid-linked account summaries from saved Warehouse
// card 6898 (no parameters) into mirror.linked_external_account_summary. Same
// auth and 405 posture as app/api/cron/account-aum. Logs carry status markers
// and counts only — never row payloads, holdings, or monetary values.
export const runtime = "nodejs";

const CARD_ID = 6898;
const SOURCE = `warehouse-card-${CARD_ID}`;

type ErrorBody = { error: string };
const err = (error: string, status: number) =>
  Response.json({ error } satisfies ErrorBody, { status });

function methodNotAllowed(): Response {
  return err("method_not_allowed", 405);
}
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

export async function POST(req: Request): Promise<Response> {
  if (!requireIngestToken(req).ok) return err("unauthorized", 401);
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const runId = crypto.randomUUID();
  const safeRunId = encodeURIComponent(runId).slice(0, 256);

  let payload: unknown;
  try {
    payload = await queryWarehouseCard(
      CARD_ID,
      [],
      "cron:linked-external-account-summary",
      (reason, message) => Object.assign(new Error(message), { reason }),
    );
  } catch {
    console.error(
      `[cron:linked-external-account-summary] warehouse_fetch_failed run_id=${safeRunId}`,
    );
    return err(
      process.env.WAREHOUSE_URL && process.env.WAREHOUSE_API_KEY
        ? "warehouse_error"
        : "config_error",
      process.env.WAREHOUSE_URL && process.env.WAREHOUSE_API_KEY ? 502 : 500,
    );
  }
  if (!Array.isArray(payload)) {
    console.error(
      `[cron:linked-external-account-summary] warehouse_bad_shape run_id=${safeRunId}`,
    );
    return err("warehouse_error", 502);
  }

  const validated = validateLinkedExternalSummarySnapshot(payload);
  if (!validated.ok) {
    console.error(
      `[cron:linked-external-account-summary] snapshot_validation_failed run_id=${safeRunId} n=${validated.errors.length}`,
    );
    return err("snapshot_validation_failed", 422);
  }

  const skipped = validated.skipped;
  if (dryRun) {
    return Response.json({
      dry_run: true,
      received: validated.rows.length,
      skipped,
      source: SOURCE,
    });
  }

  const received = validated.rows.length;
  let upserted = 0;
  try {
    await withIngestScope(async (tx) => {
      for (const row of validated.rows) {
        await tx.$executeRaw`
          INSERT INTO mirror.linked_external_account_summary (
            external_account_id, client_sf_id, household_sf_id, institution_name,
            account_subtype, mask, cash_amount, securities_amount, holdings_total,
            institution_balance, as_of, link_status, lineage_key,
            prior_external_account_id, synced_at
          ) VALUES (
            ${row.externalAccountId}, ${row.clientSfId}, ${row.householdSfId},
            ${row.institutionName}, ${row.accountSubtype}, ${row.mask},
            ${row.cashAmount}, ${row.securitiesAmount}, ${row.holdingsTotal},
            ${row.institutionBalance}, ${row.asOf}, ${row.linkStatus},
            ${row.lineageKey}, ${row.priorExternalAccountId}, now()
          )
          ON CONFLICT (external_account_id) DO UPDATE SET
            client_sf_id = EXCLUDED.client_sf_id,
            household_sf_id = EXCLUDED.household_sf_id,
            institution_name = EXCLUDED.institution_name,
            account_subtype = EXCLUDED.account_subtype,
            mask = EXCLUDED.mask,
            cash_amount = EXCLUDED.cash_amount,
            securities_amount = EXCLUDED.securities_amount,
            holdings_total = EXCLUDED.holdings_total,
            institution_balance = EXCLUDED.institution_balance,
            as_of = EXCLUDED.as_of,
            link_status = EXCLUDED.link_status,
            lineage_key = EXCLUDED.lineage_key,
            prior_external_account_id = EXCLUDED.prior_external_account_id,
            synced_at = now()`;
        upserted += 1;
      }
      // Staleness, not deletes (ADR-7): mark active rows absent from this snapshot.
      const ids = validated.rows.map((r) => r.externalAccountId);
      if (ids.length > 0) {
        await tx.$executeRaw`
          UPDATE mirror.linked_external_account_summary
          SET link_status = 'inactive', synced_at = now()
          WHERE link_status = 'ACTIVE'
            AND NOT (external_account_id = ANY(${ids}))`;
      }
      await writeAudit(
        tx as Prisma.TransactionClient,
        { role: "INGEST", email: null },
        {
          action: INGEST_LINKED_EXTERNAL_ACCOUNT_SUMMARY,
          entityType: "ingest_run",
          entityId: runId,
          detail: { source: SOURCE, received, upserted, skipped, dry_run: false },
        },
      );
    });
  } catch {
    console.error(
      `[cron:linked-external-account-summary] tx_failed run_id=${safeRunId}`,
    );
    return err("internal", 500);
  }

  return Response.json({ received, upserted, skipped, source: SOURCE });
}
