import { Prisma, PrismaClient } from "@prisma/client";
import { seedFeeRequests, cleanupFeeRequests } from "./operations-fee-fixture";
import { reconcileAccountAware, type MeridianTradeSourceRow, type ApexTradeSourceRow } from "../../lib/operations/trade-reconciliation";

const DATABASE_NAME = "aoa_operations_browser_synthetic";
const ids = Array.from({ length: 315 }, (_, index) => `browserrecon${String(index + 1).padStart(8, "0")}`);

export function validateOperationsBrowserDatabase() {
  const parse = (raw: string | undefined, user: string) => {
    if (!raw) throw new Error("Operations browser fixture requires explicit local database URLs");
    const url = new URL(raw);
    if (!["postgresql:", "postgres:"].includes(url.protocol) || !["127.0.0.1", "[::1]"].includes(url.hostname) || !url.port ||
      url.pathname !== `/${DATABASE_NAME}` || url.username !== user ||
      ["host", "hostaddr", "service", "servicefile"].some((key) => url.searchParams.has(key)) ||
      process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE || process.env.APP_ENV === "prod") throw new Error("Operations browser tests require the isolated synthetic loopback database");
    return url;
  };
  const ownerUrl = parse(process.env.DIRECT_DATABASE_URL, "aoa");
  const runtimeUrl = parse(process.env.DATABASE_URL, "app_rw");
  if (ownerUrl.host !== runtimeUrl.host) throw new Error("Operations browser database targets differ");
  return ownerUrl;
}

export default async function operationsFixture() {
  const owner = new PrismaClient({ datasourceUrl: validateOperationsBrowserDatabase().toString(), log: [] });
  const cleanup = async () => {
    await owner.$executeRaw(Prisma.sql`DELETE FROM app.trade_reconciliation_note_event WHERE run_id IN (${Prisma.join(ids)})`);
    await owner.$executeRaw(Prisma.sql`DELETE FROM app.trade_reconciliation_review_event WHERE run_id IN (${Prisma.join(ids)})`);
    await owner.$executeRaw(Prisma.sql`DELETE FROM app.trade_reconciliation_run WHERE id IN (${Prisma.join(ids)})`);
    await cleanupFeeRequests(owner);
  };
  try {
    const [{ database }] = await owner.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`;
    if (database !== DATABASE_NAME) throw new Error("Operations browser actual database mismatch");
    const [{ conflicts }] = await owner.$queryRaw<Array<{ conflicts: bigint }>>(Prisma.sql`
      SELECT COUNT(*) AS conflicts FROM app.trade_reconciliation_run WHERE id IN (${Prisma.join(ids)}) AND source_scope_version <> 'synthetic-browser'`);
    if (Number(conflicts)) throw new Error("Operations browser fixture IDs collide with existing records");
    await cleanup();
    await owner.$executeRaw`
      INSERT INTO app.trade_reconciliation_run (id, run_date, business_date, algorithm_version, source_scope_version, source_digest, source_commit_sha,
        apex_record_count, meridian_record_count, raw_match_count, exception_count, raw_match_rate, payload, completed_by, completed_at)
      SELECT 'browserrecon' || LPAD(i::text, 8, '0'), DATE '2035-01-01' + i, DATE '2035-01-01' + i,
        'account-aware-v2', 'synthetic-browser', LPAD(i::text, 64, '0'), 'synthetic', 10, 10, 8, 2, 80, '[]'::jsonb,
        'ops@example.com', TIMESTAMPTZ '2036-01-01 00:00:00Z' FROM generate_series(1, 315) i`;
    await owner.$executeRaw`INSERT INTO app.trade_reconciliation_note_event (id, run_id, note, author_email)
      VALUES ('browserreconnote', 'browserrecon00000001', 'Synthetic oldest run note', 'ops@example.com')`;
    const alpha: MeridianTradeSourceRow[] = Array.from({ length: 10 }, (_, i) => ({
      rebalancerOrderId: `synthetic-${i}`, accountId: `synthetic-account-${i}`, assetType: "EQUITY", symbol: "VTI", side: "Buy",
      quantity: 10, notionalAmount: null, initiatedTimestamp: null, clientBasketId: null, apexBasketId: null,
    }));
    const apex: ApexTradeSourceRow[] = alpha.slice(0, 8).map((row, i) => ({
      activityId: `synthetic-activity-${i}`, processDate: "2035-01-02", accountId: row.accountId, assetType: "EQUITY", symbol: "VTI", side: "Buy",
      quantity: 10, netAmount: 1000, grossAmount: 1000, clientOrderId: row.rebalancerOrderId, activityTimestamp: null,
    }));
    const rows = reconcileAccountAware(apex, alpha).map((row, i) => ({ ...row, id: (1000 + i).toString(16).padStart(64, "0") }));
    await owner.$executeRaw`UPDATE app.trade_reconciliation_run SET payload = ${JSON.stringify(rows)}::jsonb, apex_record_count = 8, raw_match_rate = 100 WHERE id = 'browserrecon00000001'`;
    await owner.$executeRaw`INSERT INTO app.trade_reconciliation_review_event (id, run_id, row_fingerprint, classification, explanation, reviewer_email)
      VALUES ('browserreconreview', 'browserrecon00000001', ${rows.find((row) => row.result === "MERIDIAN_ONLY")!.id}, 'Other', 'Synthetic order cancelled before Apex submission', 'ops@example.com')`;
    await seedFeeRequests(owner);
  } catch (error) { await owner.$disconnect(); throw error; }
  return async () => { try { await cleanup(); } finally { await owner.$disconnect(); } };
}
