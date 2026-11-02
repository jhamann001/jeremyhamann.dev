import "server-only";
import { withUserScope, type Identity } from "@/lib/rls";
import { canSeeUnlinkedAcats } from "./acat-lane";
import { acatLegacyDiagnosticSchema, type AcatLegacyDiagnostic } from "./acat-legacy-diagnostic-contract";

/** Count the literal legacy detail branch. A candidate is only a stored link;
 * its upstream existence and successful response still require an in-app read.
 * Never materialize transfer rows or upstream identifiers outside PostgreSQL. */
export async function readAcatLegacyDiagnostic(identity: Identity): Promise<AcatLegacyDiagnostic> {
  if (!canSeeUnlinkedAcats(identity.role) || typeof identity.email !== "string" || !identity.email.trim()) {
    throw new Error("ACAT legacy diagnostic forbidden");
  }
  const rows = await withUserScope(identity, async (tx) => {
    await tx.$executeRaw`SELECT
      set_config('statement_timeout', '5000', true),
      set_config('lock_timeout', '1000', true),
      set_config('jit', 'off', true)`;
    // One aggregate = one consistent snapshot. Do not apply board/demo/date/
    // stage/archive filters or replace record-ID precedence with UUID heuristics.
    return tx.$queryRaw<AcatLegacyDiagnostic[]>`SELECT
      count(*)::int AS "legacyOnlyCount",
      count(*) FILTER (WHERE archived_at IS NOT NULL)::int AS "archivedLegacyOnlyCount",
      coalesce(min(id) FILTER (WHERE archived_at IS NULL), min(id)) AS "candidateTransferId"
      FROM app.transfer
      WHERE acat_record_id IS NULL AND acat_transfer_id IS NOT NULL`;
  }, { maxWait: 2_000, timeout: 8_000 });
  if (rows.length !== 1) throw new Error("ACAT legacy diagnostic unavailable");
  return acatLegacyDiagnosticSchema.parse(rows[0]);
}
