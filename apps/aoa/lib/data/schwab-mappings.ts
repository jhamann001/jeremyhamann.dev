import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { withUserScope, type Identity } from "@/lib/rls";
import { writeAudit } from "@/lib/audit";
import { canReviewSchwabMappings, validMappingBatch, type SchwabReviewedMapping } from "@/lib/schwab/review";

export type SchwabMappingPreview = SchwabReviewedMapping & {
  clientName: string | null;
  householdName: string | null;
  stage: string | null;
  previous: SchwabReviewedMapping | null;
};
export type SchwabMappingResult =
  | { status: "preview"; rows: SchwabMappingPreview[] }
  | { status: "saved" }
  | { status: "invalid" | "forbidden" | "target_mismatch" | "conflict" };

type MappingRow = SchwabReviewedMapping & {
  reviewedBy: string; reviewedAt: Date; appliedVersion: number | null;
  clientName: string | null; householdName: string | null;
};

export async function listSchwabMappings(identity: Identity): Promise<MappingRow[]> {
  if (!canReviewSchwabMappings(identity.role) || !identity.email) return [];
  return withUserScope(identity, (tx) => tx.$queryRaw<MappingRow[]>`
    SELECT m.account_id AS "accountId", m.account_number_last4 AS "accountNumberLast4",
           m.client_sf_id AS "clientSfId", m.household_sf_id AS "householdSfId",
           m.account_scope AS "accountScope", m.version,
           m.reviewed_by AS "reviewedBy", m.reviewed_at AS "reviewedAt",
           b.reviewed_mapping_version AS "appliedVersion",
           nullif(trim(concat_ws(' ', c.first_name, c.last_name)), '') AS "clientName",
           h.name AS "householdName"
    FROM app.schwab_account_mapping m
    LEFT JOIN mirror.schwab_account_balance b ON b.account_id = m.account_id AND b.source_present
    LEFT JOIN mirror.client c ON c.sf_id = m.client_sf_id
    LEFT JOIN mirror.household h ON h.sf_id = m.household_sf_id
    ORDER BY m.reviewed_at DESC LIMIT 5000`);
}

async function prepare(tx: Prisma.TransactionClient, rows: SchwabReviewedMapping[], saving: boolean): Promise<SchwabMappingResult> {
  const preview: SchwabMappingPreview[] = [];
  for (const row of rows) {
    const [previous] = await tx.$queryRaw<SchwabReviewedMapping[]>`
      SELECT account_id AS "accountId", account_number_last4 AS "accountNumberLast4",
             client_sf_id AS "clientSfId", household_sf_id AS "householdSfId",
             account_scope AS "accountScope", version
      FROM app.schwab_account_mapping WHERE account_id = ${row.accountId}`;
    if ((saving && row.version !== (previous?.version ?? 0))
        || (previous && previous.accountNumberLast4 !== row.accountNumberLast4)) return { status: "conflict" };
    let clientName: string | null = null;
    let householdName: string | null = null;
    let stage: string | null = null;
    let clientSfId: string | null = null;
    let householdSfId: string | null = null;
    if (row.accountScope === "CLIENT") {
      const households = await tx.$queryRaw<Array<{ sf_id: string; name: string; stage: string }>>`
        SELECT sf_id, name, stage FROM mirror.household
        WHERE left(sf_id, 15) = left(${row.householdSfId}, 15)`;
      if (households.length !== 1) return { status: "target_mismatch" };
      householdSfId = households[0]!.sf_id;
      householdName = households[0]!.name;
      stage = households[0]!.stage;
      if (row.clientSfId) {
        const clients = await tx.$queryRaw<Array<{ sf_id: string; name: string; household_id: string | null }>>`
          SELECT sf_id, trim(concat_ws(' ', first_name, last_name)) AS name, household_id
          FROM mirror.client WHERE left(sf_id, 15) = left(${row.clientSfId}, 15)`;
        if (clients.length !== 1 || clients[0]!.household_id?.slice(0, 15) !== householdSfId.slice(0, 15)) {
          return { status: "target_mismatch" };
        }
        clientSfId = clients[0]!.sf_id;
        clientName = clients[0]!.name;
      }
    }
    preview.push({ ...row, clientSfId, householdSfId, clientName, householdName, stage,
      version: previous?.version ?? 0, previous: previous ?? null });
  }
  return { status: "preview", rows: preview };
}

/** Preview and save share validation. Saving rechecks all targets and versions
 * under the same lock as snapshot ingestion; no partial batch can commit. */
export async function reviewSchwabMappings(identity: Identity, rows: unknown, save = false): Promise<SchwabMappingResult> {
  if (!canReviewSchwabMappings(identity.role) || !identity.email) return { status: "forbidden" };
  if (!validMappingBatch(rows)) return { status: "invalid" };
  return withUserScope(identity, async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(1938724016)::text AS locked`;
    const result = await prepare(tx, rows, save);
    if (result.status !== "preview" || !save) return result;
    for (const row of result.rows) {
      // Explicit INSERT/UPDATE instead of UPSERT: PostgreSQL runs BEFORE INSERT
      // even on a conflict, which would unnecessarily stamp a second version.
      if (row.version === 0) {
        await tx.$executeRaw`
          INSERT INTO app.schwab_account_mapping
            (account_id, account_number_last4, client_sf_id, household_sf_id,
             account_scope, version, reviewed_by)
          VALUES (${row.accountId}, ${row.accountNumberLast4}, ${row.clientSfId},
                  ${row.householdSfId}, ${row.accountScope}, 1, ${identity.email})`;
      } else {
        const updated = await tx.$executeRaw`
          UPDATE app.schwab_account_mapping
          SET client_sf_id = ${row.clientSfId}, household_sf_id = ${row.householdSfId},
              account_scope = ${row.accountScope}
          WHERE account_id = ${row.accountId} AND version = ${row.version}`;
        if (Number(updated) !== 1) throw new Error("schwab_mapping_concurrent_change");
      }
    }
    await writeAudit(tx, identity, {
      action: "schwab.mapping_review", entityType: "schwab_mapping_batch", entityId: randomUUID(),
      detail: { reviewed: result.rows.length,
        client: result.rows.filter((row) => row.accountScope === "CLIENT").length,
        firm_operating: result.rows.filter((row) => row.accountScope === "FIRM_OPERATING").length },
    });
    return { status: "saved" };
  }, { timeout: 30_000, maxWait: 5_000 });
}
