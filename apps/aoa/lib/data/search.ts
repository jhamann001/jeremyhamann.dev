import { withUserScope } from "@/lib/rls";
import { Prisma } from "@prisma/client";
import { crmIdentityReadsEnabled } from "@/lib/flags";
import { householdDisplayCtes, householdSourceKeySql } from "./household-display";
import type { Identity } from "./types";
import {
  hrefFor,
  MIN_QUERY_LENGTH,
  type SearchResult,
  type SearchResultType,
} from "./search-types";

// Global Topbar search seam. One withUserScope tx → each table's OWN RLS policy
// decides visibility (no role branching in code, fails closed). The scoping is
// asymmetric BY DESIGN and matches the rest of the app (owner decision
// 2026-07-21, "match the app"):
//   • mirror.household / mirror.client — book-scoped: ADVISOR sees only rows
//     where lead_advisor_email = the caller (household_own_book / client_own_book
//     policies); CLIENT_SERVICE sees the whole firm (household_client_service_all
//     / client_client_service_all); VIEWER sees none.
//   • app.deal / app.transfer — firm-wide to EVERY app role, no book predicate
//     (deal_read_all_roles / transfer_read_all_roles, the locked ADR-4 posture).
//     This is the SAME visibility the /deals and /asset-transfer pages already
//     give every role — search exposes no record those pages don't. So an
//     advisor searching an out-of-book name gets no household/client hit but may
//     get deal/transfer hits carrying that name; that is intended, not a leak.
// Substring ILIKE only (owner decision); no pg_trgm/FTS, no migration. Names
// only — never matches opaque ids. Mirrors the layout badge query's multi-schema
// Promise.all pattern (app/(authenticated)/layout.tsx) and the loadReviewClients
// server-action idiom (asset-mapping-review/actions.ts).
//
// The client-safe constants/types (MIN_QUERY_LENGTH, hrefFor, SearchResult…)
// live in ./search-types (no server imports) so the GlobalSearch client
// component can use them without dragging Prisma into the browser bundle. They
// are re-exported here so `@/lib/data/search` stays the server/test surface.
export {
  hrefFor,
  MIN_QUERY_LENGTH,
  type SearchResult,
  type SearchResultType,
};

const PER_TYPE_LIMIT = 5;
// Upper bound on the query length — a pasted multi-KB string should not become a
// %…% ILIKE across four tables. Names are short; 100 chars is generous.
const MAX_QUERY_LENGTH = 100;

// LIKE-metacharacter escape (the single source of truth, reused by both pattern
// builders so they can never drift): a user typing "50%" or "a_b" must match
// those literals, not wildcards. Escapes \ % _ with a backslash; paired with
// `ESCAPE '\'` in the SQL.
function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Full substring pattern (`%escaped%`) — the value bound into every WHERE.
export function likePattern(raw: string): string {
  return `%${escapeLike(raw)}%`;
}

// The prefix-boost pattern (`escaped%`) — used ONLY in ORDER BY to float prefix
// matches above mid-string matches.
function prefixPattern(raw: string): string {
  return `${escapeLike(raw)}%`;
}

type Raw = { id: string; label: string | null; sublabel: string | null };

const shape =
  (type: SearchResultType) =>
  (r: Raw): SearchResult => ({
    type,
    id: r.id,
    label: (r.label ?? "").trim(),
    sublabel: r.sublabel,
    href: hrefFor(type, r.id),
  });

/**
 * Cross-entity substring search under the caller's RLS scope (see the module
 * header for the per-table, by-design-asymmetric visibility). Returns [] for a
 * blank/too-short query (guards against dumping results on one keystroke) BEFORE
 * opening a transaction, and caps the query at MAX_QUERY_LENGTH. Result order:
 * households, clients, deals, transfers — each capped at PER_TYPE_LIMIT,
 * name-ordered with a prefix-match boost. Rows whose label resolves empty are
 * dropped (an empty-label row is un-clickable/confusing).
 */
export async function globalSearch(
  identity: Identity,
  rawQuery: string,
): Promise<SearchResult[]> {
  const q = rawQuery.trim().slice(0, MAX_QUERY_LENGTH);
  if (q.length < MIN_QUERY_LENGTH) return [];
  const pat = likePattern(q);
  const prefix = prefixPattern(q);
  const canonicalHouseholds = crmIdentityReadsEnabled();

  const [people, deals, transfers] = await withUserScope(
    identity,
    async (tx) => {
      // Avoid JIT compilation overhead for small interactive result sets, as
      // in the directory seams. Settings remain local to this RLS transaction.
      await tx.$executeRaw`SELECT set_config('jit', 'off', true)`;
      return Promise.all([
        tx.$queryRaw<Array<Raw & { type: "household" | "client" }>>`
          WITH ${householdDisplayCtes(canonicalHouseholds)}, matching_households AS (
          SELECT 'household'::text AS type, 0 AS type_rank,
                 (display.display_name ILIKE ${prefix} ESCAPE '\\') AS prefix_rank,
                 display.sf_id AS id,
                 display.display_name AS label,
                 initcap(coalesce(h.stage, '')) AS sublabel
          FROM household_display display
          JOIN base_household h ON h.sf_id = display.sf_id
          WHERE display.display_name ILIKE ${pat} ESCAPE '\\'
             OR EXISTS (
               SELECT 1 FROM unnest(display.source_names || display.member_names) AS alias(name)
                WHERE alias.name ILIKE ${pat} ESCAPE '\\'
             )
          ORDER BY prefix_rank DESC, label, id
          LIMIT ${PER_TYPE_LIMIT}
          ), client_candidates AS MATERIALIZED (
          SELECT c.sf_id, c.household_id,
                 (c.last_name ILIKE ${prefix} ESCAPE '\\') AS prefix_rank,
                 trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) AS label
          FROM mirror.client c
          -- Exclude the retired-feed placeholder rows (sf_id = household_id),
          -- matching the client picker's "All" count. household_id is NOT NULL.
          WHERE ${householdSourceKeySql(Prisma.sql`c.sf_id`)} <> ${householdSourceKeySql(Prisma.sql`c.household_id`)}
            AND (
              c.first_name ILIKE ${pat} ESCAPE '\\'
              OR c.last_name ILIKE ${pat} ESCAPE '\\'
              OR trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) ILIKE ${pat} ESCAPE '\\'
            )
          ORDER BY prefix_rank DESC, label, c.sf_id
          LIMIT ${PER_TYPE_LIMIT}
          ), matching_clients AS (
          SELECT 'client'::text AS type, 1 AS type_rank,
                 c.prefix_rank, c.sf_id AS id, c.label,
                 display.display_name AS sublabel
          FROM client_candidates c
          LEFT JOIN visible_household h
            ON ${householdSourceKeySql(Prisma.sql`h.sf_id`)} = ${householdSourceKeySql(Prisma.sql`c.household_id`)}
          LEFT JOIN household_display display
            ON ${householdSourceKeySql(Prisma.sql`display.sf_id`)} = ${householdSourceKeySql(Prisma.sql`h.canonical_sf_id`)}
          ORDER BY c.prefix_rank DESC, c.label, c.sf_id
          LIMIT ${PER_TYPE_LIMIT}
          )
          SELECT * FROM matching_households
          UNION ALL
          SELECT * FROM matching_clients
          ORDER BY type_rank, prefix_rank DESC, label, id`,
        tx.$queryRaw<Raw[]>`
          SELECT id,
                 name AS label,
                 nullif(trim(coalesce(client_first_name,'') || ' ' || coalesce(client_last_name,'')), '') AS sublabel
          FROM app.deal
          WHERE archived_at IS NULL
            AND (
              name ILIKE ${pat} ESCAPE '\\'
              OR client_first_name ILIKE ${pat} ESCAPE '\\'
              OR client_last_name ILIKE ${pat} ESCAPE '\\'
              OR household_name ILIKE ${pat} ESCAPE '\\'
            )
          ORDER BY (name ILIKE ${prefix} ESCAPE '\\') DESC, created_date DESC
          LIMIT ${PER_TYPE_LIMIT}`,
        tx.$queryRaw<Raw[]>`
          SELECT id,
                 -- Fall back to the household name so a transfer matched only on
                 -- household_name (null client names) still shows a usable label
                 -- instead of being dropped by the empty-label filter.
                 coalesce(
                   nullif(trim(coalesce(client_first_name,'') || ' ' || coalesce(client_last_name,'')), ''),
                   household_name
                 ) AS label,
                 initcap(replace(coalesce(stage::text,''), '_', ' ')) AS sublabel
          FROM app.transfer
          WHERE archived_at IS NULL
            AND (
              client_first_name ILIKE ${pat} ESCAPE '\\'
              OR client_last_name ILIKE ${pat} ESCAPE '\\'
              OR household_name ILIKE ${pat} ESCAPE '\\'
            )
          ORDER BY (client_last_name ILIKE ${prefix} ESCAPE '\\') DESC, stage_entered_at DESC
          LIMIT ${PER_TYPE_LIMIT}`,
      ]);
    },
  );

  return [
    ...people.map((row) => shape(row.type)(row)),
    ...deals.map(shape("deal")),
    ...transfers.map(shape("transfer")),
  ].filter((r) => r.label.length > 0);
}
