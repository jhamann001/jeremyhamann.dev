import "server-only";
import type { Prisma } from "@prisma/client";
import { withUserScope, type Identity } from "@/lib/rls";
import { crmIdentityReadsEnabled, hideDemoTransferCardsEnabled } from "@/lib/flags";

// Left-nav badge counts. All five run in ONE statement and RLS-scoped transaction (the caller's
// role/email), so book-scoped tables (mirror.household, mirror.client) reflect the
// caller's book and firm-wide tables (app.deal, app.transfer are all-roles-read)
// show the same number for everyone. withUserScope fails closed to VIEWER/'' → 0
// rows for an unknown role / missing email.
//
// CLIENT vs PROSPECT (owner ask 2026-07-21): the Households + Client Portrait
// badges count ACTUAL CLIENTS only — `stage = 'Client'` — not prospects or lost.
// `stage` carries the Salesforce Entity_Client_Stage__c verbatim (Client /
// Prospect / Lost Client / Lost Prospect — see app/api/ingest/clients/route.ts) on
// BOTH mirror.client and mirror.household. The predicate matches the Households
// table's "Client" classification (components/households/HouseholdsTable.tsx
// `stageKey`: norm = trim + lower + collapse-spaces, then === "client") — here
// `lower(btrim(stage)) = 'client'` ('Client' is single-word, so trim+lower is the
// full normalization). The synthetic firm household has a NULL stage, so it is
// excluded here exactly as it is from the Households "Clients" KPI.
//
// ASSET TRANSFER (owner ask 2026-07-21): the count of VISIBLE transfer cards
// actively in flight — stage DECISION or IN_TRANSFER, not archived. FUNDED
// (done) and the inert DISCOVERY/ACCOUNTS_OPEN enum values are excluded. When
// canonical dev hides stable DEMO-T-* rows AND normal-keyed transfers derived
// from synthetic DEMO-* deals. The badge applies that same filter so it cannot
// advertise cards the board deliberately omits.

export type NavCounts = {
  /** Client households (stage = 'Client'), RLS-scoped to the caller's book. */
  households: number;
  /** Actual clients (stage = 'Client'), excluding the retired feed's placeholder
   *  rows (sf_id = household_id), RLS-scoped to the caller's book. */
  clients: number;
  /** Firm-wide OPEN deals (stage not WON/LOST, not archived). */
  openDeals: number;
  /** Transfer cards in flight — stage DECISION or IN_TRANSFER, not archived. */
  activeTransfers: number;
  /** CRM identity exceptions and duplicate candidates requiring Operations review. */
  crmOpenExceptions: number;
};

export async function applyNavCountDatabaseBounds(tx: Prisma.TransactionClient): Promise<void> {
  // CRM exception policies can produce a high estimated plan cost for a tiny
  // badge result. Avoid LLVM compilation just for these optional reads, as the
  // CRM directory does; all SQL, RLS checks and existing deadlines stay intact.
  await tx.$executeRaw`SELECT
    set_config('jit', 'off', true),
    set_config('statement_timeout', '10000', true),
    set_config('lock_timeout', '2000', true)`;
}

export async function navCounts(identity: Identity): Promise<NavCounts> {
  const hideDemoTransfers = hideDemoTransferCardsEnabled();
  const canonicalReads = crmIdentityReadsEnabled();
  const [counts] = await withUserScope(
    identity,
    async (tx) => {
      // Badges are optional, but their SQL still uses the shared application
      // pool. A Prisma deadline alone does not cancel an executing statement.
      await applyNavCountDatabaseBounds(tx);
      // A transaction uses one connection: Promise.all would queue five
      // statements, each with its own 10-second budget. Scalar subqueries keep
      // the identical counts/RLS in one snapshot and one cancellation budget.
      return tx.$queryRaw<NavCounts[]>`SELECT (
        WITH visible_household AS MATERIALIZED (
          SELECT sf_id, stage FROM mirror.household
        ), canonical_overlay AS MATERIALIZED (
          SELECT overlay.source_key
            FROM app.resolve_crm_canonical_household_overlays(
              CASE WHEN ${canonicalReads}
                THEN ARRAY(SELECT h.sf_id FROM visible_household h)
                ELSE ARRAY[]::text[]
              END
            ) overlay
        )
        SELECT count(*)::int AS n
          FROM visible_household household
          LEFT JOIN canonical_overlay overlay
            ON overlay.source_key = household.sf_id
         WHERE lower(btrim(household.stage)) = 'client'
           AND overlay.source_key IS NULL
      ) AS households, (
        WITH visible_client AS MATERIALIZED (
          SELECT sf_id, household_id, stage FROM mirror.client
           WHERE household_id IS NULL OR sf_id <> household_id
        ), canonical_overlay AS MATERIALIZED (
          SELECT overlay.source_key
            FROM app.resolve_crm_canonical_contact_overlays(
              CASE WHEN ${canonicalReads}
                THEN ARRAY(SELECT client.sf_id FROM visible_client client)
                ELSE ARRAY[]::text[]
              END
            ) overlay
        )
        SELECT count(*)::int AS n
          FROM visible_client client
          LEFT JOIN canonical_overlay overlay
            ON left(overlay.source_key, 15) = left(client.sf_id, 15)
         WHERE lower(btrim(client.stage)) = 'client'
           AND overlay.source_key IS NULL
      ) AS clients, (
        SELECT count(*)::int AS n FROM app.deal
        WHERE stage NOT IN ('WON','LOST') AND archived_at IS NULL
      ) AS "openDeals", (
        SELECT count(*)::int AS n
        FROM app.transfer t
        LEFT JOIN app.deal d ON d.id = t.deal_id
        WHERE t.stage IN ('DECISION','IN_TRANSFER')
          AND t.archived_at IS NULL
          AND (${hideDemoTransfers} = false OR (
            t.id NOT LIKE 'DEMO-T-%'
            AND COALESCE(t.deal_sf_id, d.sf_deal_id, '') NOT LIKE 'DEMO-%'
          ))
      ) AS "activeTransfers", (
        SELECT (
          (SELECT count(*) FROM app.crm_identity_exception
            WHERE exception_state = 'OPEN')
          +
          (SELECT count(*) FROM app.crm_duplicate_candidate candidate
            WHERE candidate.source_active
              AND (
                candidate.status = 'NEW'
                OR (candidate.status = 'SNOOZED' AND candidate.snoozed_until <= now())
              ))
        )::int AS n
      ) AS "crmOpenExceptions"`;
    },
    // Confirmed CRM overlays can make the two directory counts exceed
    // Prisma's five-second interactive-transaction default during a cold read.
    // The caller loads these non-critical badges after first paint and degrades
    // on failure, so this longer window improves eventual count
    // availability without ever blocking or taking down an app page.
    { timeout: 15_000, maxWait: 5_000 },
  );
  return {
    households: counts?.households ?? 0,
    clients: counts?.clients ?? 0,
    openDeals: counts?.openDeals ?? 0,
    activeTransfers: counts?.activeTransfers ?? 0,
    crmOpenExceptions: counts?.crmOpenExceptions ?? 0,
  };
}
