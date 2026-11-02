import { Prisma } from "@prisma/client";

/**
 * Display-only naming. The client feed currently splits a full name at its last
 * space, so a multiword first_name is not evidence of a complete surname. Only
 * simplify an explicit household label when every contributing name and every
 * word in the source label supports the result. Unknown composition, entities,
 * and ambiguous name boundaries retain their source label.
 *
 * Arguments are SQL expressions; members is a JSON array of first_name and
 * last_name objects, already deduplicated by visible contact identity. Keeping
 * the rule in SQL means directory filtering/sorting/paging uses the same label
 * as detail pages and search. It also lets tests exercise the actual expression.
 */
export function householdDisplayNameSql(
  sourceName: Prisma.Sql,
  members: Prisma.Sql,
): Prisma.Sql {
  const matches = (candidate: Prisma.Sql, withAnd = false) => Prisma.sql`(
    lower(state.source_stem) = lower(${candidate})
    ${withAnd ? Prisma.sql`OR lower(state.source_stem) = lower(replace(${candidate}, ' & ', ' and '))` : Prisma.empty}
  )`;
  const fullFirst = Prisma.sql`state.first_name || ' ' || state.last_name`;
  const fullSecond = Prisma.sql`state.second_first_name || ' ' || state.second_last_name`;
  const bothFirst = Prisma.sql`${fullFirst} || ' & ' || ${fullSecond}`;
  const bothSecond = Prisma.sql`${fullSecond} || ' & ' || ${fullFirst}`;
  const pairedFirst = Prisma.sql`state.first_name || ' & ' || state.second_first_name || ' ' || state.last_name`;
  const pairedSecond = Prisma.sql`state.second_first_name || ' & ' || state.first_name || ' ' || state.second_last_name`;
  const surnamesFirst = Prisma.sql`state.last_name || ' & ' || state.second_last_name`;
  const surnamesSecond = Prisma.sql`state.second_last_name || ' & ' || state.last_name`;
  return Prisma.sql`(
    WITH naming_input AS (
      SELECT ${sourceName}::text AS source_name,
             ${members}::jsonb AS members
    ), naming_pair AS (
      -- The rule accepts only one or two members. Read those two directly
      -- instead of expanding, aggregating and self-joining a recordset for
      -- every household in a directory. Larger groups still retain the source.
      SELECT source_name,
             regexp_replace(
               regexp_replace(btrim(source_name), '[[:space:]]+household$', '', 'i'),
               '^the[[:space:]]+', '', 'i'
             ) AS source_stem,
             jsonb_array_length(members) AS member_count,
             btrim(members -> 0 ->> 'first_name') AS first_name,
             btrim(members -> 0 ->> 'last_name') AS last_name,
             btrim(members -> 1 ->> 'first_name') AS second_first_name,
             btrim(members -> 1 ->> 'last_name') AS second_last_name
        FROM naming_input
    ), naming_state AS (
      SELECT pair.*,
             member_count = 1 OR lower(last_name) = lower(second_last_name) AS shared_surname
        FROM naming_pair pair
    )
    SELECT CASE
      WHEN state.source_name ~* '[[:space:]]household[[:space:]]*$'
       -- Legal/entity markers still win even if an imported member's name
       -- fields happen to reproduce the entity label (for example Smith/LLC).
       AND state.source_name !~* '\\m(trust|trustee|estate|llc|llp|lp|ltd|inc|corp|corporation|company|foundation|association|partnership|partners|holdings|university|retirement)\\M'
       AND state.member_count BETWEEN 1 AND 2
       AND COALESCE(state.first_name ~ '^[[:alpha:]][[:alpha:]''’‐-]*$', false)
       AND COALESCE(state.last_name ~ '^[[:alpha:]][[:alpha:]''’‐ -]*$', false)
       AND (state.member_count = 1 OR (
         COALESCE(state.second_first_name ~ '^[[:alpha:]][[:alpha:]''’‐-]*$', false)
         AND COALESCE(state.second_last_name ~ '^[[:alpha:]][[:alpha:]''’‐ -]*$', false)
       ))
       AND (
         (state.shared_surname AND ${matches(fullFirst)})
         OR (state.shared_surname AND ${matches(fullSecond)})
         OR ${matches(bothFirst, true)}
         OR ${matches(bothSecond, true)}
         OR (state.shared_surname AND ${matches(pairedFirst, true)})
         OR (state.shared_surname AND ${matches(pairedSecond, true)})
         -- Church and Merlin can be personal names. A surname-only shape
         -- cannot establish that the source label denotes a person.
         OR (state.source_name !~* '\\m(charity|church)\\M' AND (
           (state.shared_surname AND ${matches(Prisma.sql`state.last_name`)})
           OR ${matches(surnamesFirst, true)}
           OR ${matches(surnamesSecond, true)}
         ))
       )
      THEN (CASE
        WHEN state.shared_surname THEN least(state.last_name, state.second_last_name)
        WHEN lower(state.last_name) < lower(state.second_last_name)
          THEN state.last_name || ' & ' || state.second_last_name
        ELSE state.second_last_name || ' & ' || state.last_name
      END) || ' Household'
      ELSE state.source_name
    END
    FROM naming_state state
  )`;
}

/** Salesforce keys have 15/18-character aliases. Opaque imported identifiers
 * must remain complete, even when two happen to share the first 15 characters. */
export function householdSourceKeySql(value: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`CASE WHEN ${value} ~ '^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$'
    THEN left(${value}, 15) ELSE ${value} END`;
}

/**
 * Shared RLS-invoker read CTEs. Call inside withUserScope, immediately after
 * WITH. Source names/IDs are never modified. Household/contact aliases only
 * contribute when both the household and member are visible to the caller.
 *
 * Defines base_household, canonical_overlay, visible_household (raw h.* plus
 * canonical_sf_id), and household_display. The last contains one row per
 * canonical visible household: sf_id, source_name, display_name, source_names
 * text[], member_names text[]. With CRM reads disabled each source stands alone.
 * Optional requestedSourceKeys is a text[] expression for point reads: expand
 * those visible source IDs to their full canonical groups before aggregating
 * names. An empty array produces no display rows; base/visible household CTEs
 * retain their full scoped metadata contract for existing joins.
 * previewOnly is for the first-row query, which selects only display_name.
 * It returns empty source/member arrays that preview callers must not display.
 */
export function householdDisplayCtes(
  canonical: boolean,
  requestedSourceKeys?: Prisma.Sql,
  previewOnly = false,
): Prisma.Sql {
  return buildHouseholdDisplayCtes(canonical, requestedSourceKeys, previewOnly, false);
}

/** The exact directory needs the same scoped household metadata as its display
 * name. Carry only those fields through the existing one-row-per-household CTE
 * so it does not have to rejoin visible_household after computing the name.
 * Other display consumers retain their existing projection. */
export function householdDirectoryDisplayCtes(canonical: boolean): Prisma.Sql {
  return buildHouseholdDisplayCtes(canonical, undefined, false, true);
}

function buildHouseholdDisplayCtes(
  canonical: boolean,
  requestedSourceKeys: Prisma.Sql | undefined,
  previewOnly: boolean,
  directoryMetadata: boolean,
): Prisma.Sql {
  const requestedGroups = requestedSourceKeys
    ? Prisma.sql`WHERE ${householdSourceKeySql(Prisma.sql`source.canonical_sf_id`)} IN (
        SELECT ${householdSourceKeySql(Prisma.sql`requested.canonical_sf_id`)}
          FROM visible_household requested
         WHERE ${householdSourceKeySql(Prisma.sql`requested.sf_id`)} IN (
           SELECT ${householdSourceKeySql(Prisma.sql`input.source_key`)}
             FROM unnest(${requestedSourceKeys}::text[]) AS input(source_key)
         )
      )`
    : Prisma.empty;
  return Prisma.sql`
    base_household AS MATERIALIZED (
      SELECT ${previewOnly ? Prisma.sql`h.sf_id, h.name, h.stage, h.lead_advisor_email` : Prisma.sql`h.*`}
        FROM mirror.household h
    ), canonical_overlay AS MATERIALIZED (
      SELECT overlay.source_key, overlay.canonical_source_key
        FROM app.resolve_crm_canonical_household_overlays(
          CASE WHEN ${canonical}
            THEN ARRAY(SELECT base.sf_id FROM base_household base)
            ELSE ARRAY[]::text[]
          END
        ) overlay
    ), visible_household AS MATERIALIZED (
      SELECT ${previewOnly ? Prisma.sql`h.sf_id, h.name, h.stage, h.lead_advisor_email` : Prisma.sql`h.*`},
             COALESCE(overlay.canonical_source_key, h.sf_id) AS canonical_sf_id
        FROM base_household h
        LEFT JOIN canonical_overlay overlay ON overlay.source_key = h.sf_id
    ), ${previewOnly ? Prisma.sql`preview_name_roots AS MATERIALIZED (
      SELECT ${householdSourceKeySql(Prisma.sql`root.sf_id`)} AS canonical15
        FROM visible_household root
       WHERE root.name ~* '[[:space:]]household[[:space:]]*$'
         AND (NOT ${canonical}
           OR ${householdSourceKeySql(Prisma.sql`root.canonical_sf_id`)} = ${householdSourceKeySql(Prisma.sql`root.sf_id`)})
    ),` : Prisma.empty} display_household_source AS MATERIALIZED (
      SELECT ${previewOnly ? Prisma.sql`source.sf_id, source.name, source.canonical_sf_id` : Prisma.sql`source.*`}
        FROM visible_household source ${requestedGroups}
    ), display_source_names AS (
      SELECT ${householdSourceKeySql(Prisma.sql`canonical_sf_id`)} AS canonical15,
             array_agg(DISTINCT name ORDER BY name) AS source_names
        FROM display_household_source
       GROUP BY 1
    ), display_member AS MATERIALIZED (
      SELECT DISTINCT ON (${householdSourceKeySql(Prisma.sql`source.canonical_sf_id`)}, ${householdSourceKeySql(Prisma.sql`client.sf_id`)})
             ${householdSourceKeySql(Prisma.sql`source.canonical_sf_id`)} AS canonical15,
             client.first_name, client.last_name
        FROM display_household_source source
        ${previewOnly ? Prisma.sql`JOIN preview_name_roots naming_root
          ON naming_root.canonical15 = ${householdSourceKeySql(Prisma.sql`source.canonical_sf_id`)}` : Prisma.empty}
        JOIN mirror.client client
          ON ${householdSourceKeySql(Prisma.sql`client.household_id`)} = ${householdSourceKeySql(Prisma.sql`source.sf_id`)}
       WHERE ${householdSourceKeySql(Prisma.sql`client.sf_id`)} <> ${householdSourceKeySql(Prisma.sql`client.household_id`)}
       ORDER BY ${householdSourceKeySql(Prisma.sql`source.canonical_sf_id`)}, ${householdSourceKeySql(Prisma.sql`client.sf_id`)}, client.sf_id
    ), display_member_names AS (
      SELECT canonical15,
             ${previewOnly ? Prisma.sql`ARRAY[]::text[]` : Prisma.sql`array_agg(DISTINCT btrim(concat_ws(' ', first_name, last_name)))`} AS member_names,
             jsonb_agg(jsonb_build_object(
               'first_name', first_name, 'last_name', last_name
             )) AS naming_members
        FROM display_member
       GROUP BY canonical15
    ), household_display AS MATERIALIZED (
      SELECT h.sf_id,${directoryMetadata ? Prisma.sql`
             h.status, h.stage, h.aum,
             h.lead_advisor_email, h.household_kind, h.canonical_sf_id,` : Prisma.empty}
             h.name AS source_name,
             ${previewOnly ? Prisma.sql`CASE
               WHEN h.name ~* '[[:space:]]household[[:space:]]*$' THEN ${householdDisplayNameSql(
                 Prisma.sql`h.name`,
                 Prisma.sql`COALESCE(member.naming_members, '[]'::jsonb)`,
               )}
               ELSE h.name
             END` : householdDisplayNameSql(
               Prisma.sql`h.name`,
               Prisma.sql`COALESCE(member.naming_members, '[]'::jsonb)`,
             )} AS display_name,
             ${previewOnly ? Prisma.sql`ARRAY[]::text[]` : Prisma.sql`sources.source_names`} AS source_names,
             ${previewOnly ? Prisma.sql`ARRAY[]::text[]` : Prisma.sql`COALESCE(member.member_names, ARRAY[]::text[])`} AS member_names
        FROM visible_household h
        ${previewOnly ? Prisma.empty : Prisma.sql`JOIN display_source_names sources
          ON sources.canonical15 = ${householdSourceKeySql(Prisma.sql`h.sf_id`)}`}
        LEFT JOIN display_member_names member
          ON member.canonical15 = ${householdSourceKeySql(Prisma.sql`h.sf_id`)}
       WHERE NOT ${canonical}
          OR ${householdSourceKeySql(Prisma.sql`h.canonical_sf_id`)} = ${householdSourceKeySql(Prisma.sql`h.sf_id`)}
    )`;
}
