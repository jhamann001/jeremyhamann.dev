import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { householdDisplayNameSql } from "@/lib/data/household-display";

// Frozen reference from approved revision 017f03f8. Keep this deliberately
// independent of production optimizations: the comparison guards the complete
// SQL naming behavior, including case, punctuation, ambiguity and fallbacks.
function approvedHouseholdDisplayNameSql(
  sourceName: Prisma.Sql,
  members: Prisma.Sql,
): Prisma.Sql {
  return Prisma.sql`(
    WITH naming_source AS (
      SELECT ${sourceName}::text AS source_name,
             regexp_replace(
               regexp_replace(btrim(${sourceName}::text), '[[:space:]]+household$', '', 'i'),
               '^the[[:space:]]+', '', 'i'
             ) AS source_stem
    ), naming_member AS (
      SELECT row_number() OVER () AS member_number,
             btrim(member.first_name) AS first_name,
             btrim(member.last_name) AS last_name
        FROM jsonb_to_recordset(${members}::jsonb)
          AS member(first_name text, last_name text)
    ), naming_surname AS (
      SELECT min(last_name) AS surname
        FROM naming_member
       GROUP BY lower(last_name)
    ), naming_state AS (
      SELECT count(*) AS member_count,
             bool_and(
               COALESCE(first_name ~ '^[[:alpha:]][[:alpha:]''’‐-]*$', false)
               AND COALESCE(last_name ~ '^[[:alpha:]][[:alpha:]''’‐ -]*$', false)
             ) AS complete
        FROM naming_member
    ), naming_candidate AS (
      -- Enumerate supported source shapes rather than interpreting arbitrary
      -- word order or an unseen person's name as another member's given name.
      SELECT min(last_name) AS stem, false AS personal_shape
        FROM naming_member
      HAVING count(DISTINCT lower(last_name)) = 1
      UNION ALL
      SELECT first_name || ' ' || last_name, true
        FROM naming_member
       WHERE (SELECT count(*) FROM naming_surname) = 1
      UNION ALL
      SELECT first.first_name || ' ' || first.last_name || ' & '
             || second.first_name || ' ' || second.last_name, true
        FROM naming_member first JOIN naming_member second
          ON first.member_number <> second.member_number
      UNION ALL
      SELECT first.last_name || ' & ' || second.last_name, false
        FROM naming_member first JOIN naming_member second
          ON first.member_number <> second.member_number
      UNION ALL
      SELECT first.first_name || ' & ' || second.first_name || ' ' || first.last_name, true
        FROM naming_member first JOIN naming_member second
          ON first.member_number <> second.member_number
         AND lower(first.last_name) = lower(second.last_name)
    )
    SELECT CASE
      WHEN source.source_name ~* '[[:space:]]household[[:space:]]*$'
       -- Legal/entity markers still win even if an imported member's name
       -- fields happen to reproduce the entity label (for example Smith/LLC).
       AND source.source_name !~* '\\m(trust|trustee|estate|llc|llp|lp|ltd|inc|corp|corporation|company|foundation|association|partnership|partners|holdings|university|retirement)\\M'
       AND state.member_count BETWEEN 1 AND 2
       AND state.complete
       AND EXISTS (
         SELECT 1 FROM naming_candidate candidate
          WHERE (lower(source.source_stem) = lower(candidate.stem)
             OR lower(source.source_stem) = lower(replace(candidate.stem, ' & ', ' and ')))
            -- Church and Merlin can be personal names. Require a supported
            -- given-name form to resolve that ambiguity, not a surname alone.
            AND (candidate.personal_shape
              OR source.source_name !~* '\\m(charity|church)\\M')
       )
      THEN (SELECT string_agg(surname, ' & ' ORDER BY lower(surname), surname)
              FROM naming_surname) || ' Household'
      ELSE source.source_name
    END
    FROM naming_source source CROSS JOIN naming_state state
  )`;
}

type Member = { first_name: string | null; last_name: string | null };
const member = (first_name: string | null, last_name: string | null): Member => ({ first_name, last_name });
const inputs: Array<{ case_id: number; source_name: string | null; members: Member[] | null }> = [];
function add(source_name: string | null, members: Member[] | null) {
  inputs.push({ case_id: inputs.length, source_name, members });
}
const firstNames = ["Alex", "Jordan", "Merlin", "ALEX", " Alex ", null, "", "Ken Nakamura", "A.", "Jean-Luc", "D’Alex", "李"];
const lastNames = ["Smith", "SMITH", "Church", "Merlin", "O’Church‐Smith", "van der Bosco", "Church Trust", "LLC", null, "", " Smith ", "Álvarez", "张", "Smith."];
for (const first of firstNames) for (const last of lastNames) {
  const full = [first, last].filter(value => value !== null).join(" ");
  const members = [member(first, last)];
  for (const source of [
    `${full} Household`, `The ${full.toUpperCase()} HOUSEHOLD`, `${last ?? ""} Household`,
    full, `${full} Household\t`, `${full} Family Household`, "Unrelated Source Household",
  ]) add(source, members);
}
const people = [member("Alex", "Smith"), member("Jordan", "SMITH"), member("Merlin", "Jones"),
  member("Alex", "Church"), member("Jean-Luc", "O’Church‐Smith"), member("Alex", "van der Bosco"),
  member("Ken Nakamura", "Smith"), member(null, "Smith"), member("Alex", null)];
for (const first of people) for (const second of people) {
  const a = `${first.first_name} ${first.last_name}`, b = `${second.first_name} ${second.last_name}`;
  for (const source of [
    `${a} & ${b} Household`, `${b} and ${a} Household`, `${a} Household`,
    `${first.first_name} & ${second.first_name} ${first.last_name} Household`,
    `The ${first.last_name} & ${second.last_name} Household`,
  ]) {
    add(source, [first, second]);
    add(source, [second, first]);
  }
  add(`${a} Household`, [first, second, first]);
}
for (const source of [null, "", "The Church Household", "Merlin LLC Household", "Tom Delgado Household"]) {
  add(source, []); add(source, null);
}

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
gated("Household naming optimization matches the approved SQL rule", () => {
  let db: PrismaClient;
  beforeAll(() => {
    const raw = process.env.DATABASE_URL;
    if (!raw) throw new Error("explicit_synthetic_database_required");
    const url = new URL(raw);
    if (!["postgres:", "postgresql:"].includes(url.protocol)
      || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      || !(url.port === "55444" && url.pathname === "/aoa_pagination_synthetic"
        || process.env.CI === "true" && url.port === "5432" && url.pathname === "/aoa")
      || [...url.searchParams.keys()].some(key => !["schema", "connection_limit", "pool_timeout"].includes(key))
      || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE
      || ["dev", "development", "prod", "production"].includes(process.env.APP_ENV?.toLowerCase() ?? "")) {
      throw new Error("isolated_synthetic_database_required");
    }
    db = new PrismaClient({ datasourceUrl: raw });
  });
  afterAll(async () => { await db?.$disconnect(); });

  it("preserves labels across generated individual, joint and ambiguous inputs", async () => {
    expect(inputs.length).toBeGreaterThan(2_000);
    const differences = await db.$queryRaw(Prisma.sql`
      WITH input AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(inputs)}::jsonb)
          AS row(case_id integer, source_name text, members jsonb)
      ), compared AS MATERIALIZED (
        SELECT case_id,
          ${approvedHouseholdDisplayNameSql(Prisma.sql`input.source_name`, Prisma.sql`input.members`)} AS expected,
          ${householdDisplayNameSql(Prisma.sql`input.source_name`, Prisma.sql`input.members`)} AS actual
          FROM input
      )
      SELECT * FROM compared WHERE expected IS DISTINCT FROM actual ORDER BY case_id LIMIT 10`);
    expect(differences).toEqual([]);
  });
});
