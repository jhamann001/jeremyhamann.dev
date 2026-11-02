import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { householdDisplayCtes, householdDisplayNameSql, householdSourceKeySql } from "@/lib/data/household-display";

type Member = { first_name: string | null; last_name: string | null };
const person = (first_name: string | null, last_name: string | null): Member => ({
  first_name, last_name,
});
const cases: Array<{ label: string; source: string; members: Member[]; expected: string }> = [
  {
    label: "one verified surname",
    source: "Alex Smith Household", members: [person("Alex", "Smith")], expected: "Smith Household",
  },
  {
    label: "shared surname appears once",
    source: "Alex & Jordan Smith Household",
    members: [person("Alex", "Smith"), person("Jordan", "Smith")], expected: "Smith Household",
  },
  {
    label: "one member source label can confirm a shared surname",
    source: "Alex Smith Household",
    members: [person("Alex", "Smith"), person("Jordan", "Smith")], expected: "Smith Household",
  },
  {
    label: "distinct surnames have stable ordering",
    source: "Alex Smith & Jordan Jones Household",
    members: [person("Alex", "Smith"), person("Jordan", "Jones")], expected: "Jones & Smith Household",
  },
  {
    label: "explicit surname-only source",
    source: "The Smith Household", members: [person("Alex", "Smith")], expected: "Smith Household",
  },
  {
    label: "hyphens and apostrophes remain intact",
    source: "Alex O’Brien-Smith Household",
    members: [person("Alex", "O’Brien-Smith")], expected: "O’Brien-Smith Household",
  },
  {
    label: "complete multiword surname remains intact",
    source: "Alex van der Bosco Household",
    members: [person("Alex", "van der Bosco")], expected: "van der Bosco Household",
  },
  {
    label: "lossy ingest surname cannot truncate compound surname",
    source: "Alex van der Bosco Household",
    members: [person("Alex van der", "Bosco")], expected: "Alex van der Bosco Household",
  },
  {
    label: "middle or multiple given names have ambiguous boundaries",
    source: "Ken Nakamura Smith Household",
    members: [person("Ken Nakamura", "Smith")], expected: "Ken Nakamura Smith Household",
  },
  {
    label: "trust names are retained",
    source: "Alex Smith Trust Household", members: [person("Alex", "Smith")], expected: "Alex Smith Trust Household",
  },
  {
    label: "business names are retained",
    source: "Smith LLC Household", members: [person("Smith", "LLC")], expected: "Smith LLC Household",
  },
  {
    label: "a verified Church surname is not an entity designation",
    source: "Alex Church Household", members: [person("Alex", "Church")], expected: "Church Household",
  },
  {
    label: "a verified Merlin given name is not an entity designation",
    source: "Merlin Smith Household", members: [person("Merlin", "Smith")], expected: "Smith Household",
  },
  {
    label: "shared collision surname is included once",
    source: "Alex & Jordan Church Household",
    members: [person("Alex", "Church"), person("Jordan", "Church")], expected: "Church Household",
  },
  {
    label: "joint personal names support both collision words and written and",
    source: "Merlin Smith and Alex Church Household",
    members: [person("Merlin", "Smith"), person("Alex", "Church")], expected: "Church & Smith Household",
  },
  {
    label: "collision matching ignores source case while preserving surname case",
    source: "THE ALEX CHURCH HOUSEHOLD", members: [person("Alex", "Church")], expected: "Church Household",
  },
  {
    label: "straight apostrophe and hyphen collision surname stays intact",
    source: "Alex O'Church-Smith Household",
    members: [person("Alex", "O'Church-Smith")], expected: "O'Church-Smith Household",
  },
  {
    label: "curly apostrophe and Unicode hyphen collision surname stays intact",
    source: "Alex O’Church‐Smith Household",
    members: [person("Alex", "O’Church‐Smith")], expected: "O’Church‐Smith Household",
  },
  {
    label: "complete multiword collision surname stays intact",
    source: "Alex van der Church Household",
    members: [person("Alex", "van der Church")], expected: "van der Church Household",
  },
  {
    label: "surname-only collision source does not establish a personal shape",
    source: "The Church Household", members: [person("Alex", "Church")], expected: "The Church Household",
  },
  {
    label: "joint surname-only collision source retains its label",
    source: "The Merlin & Church Household",
    members: [person("Alex", "Merlin"), person("Jordan", "Church")], expected: "The Merlin & Church Household",
  },
  {
    label: "collision exception cannot bypass a malformed business member",
    source: "Merlin LLC Household", members: [person("Merlin", "LLC")], expected: "Merlin LLC Household",
  },
  {
    label: "collision exception cannot consume a trust word inside the surname field",
    source: "Alex Church Trust Household",
    members: [person("Alex", "Church Trust")], expected: "Alex Church Trust Household",
  },
  {
    label: "collision exception cannot bypass a malformed foundation member",
    source: "Merlin Foundation Household",
    members: [person("Merlin", "Foundation")], expected: "Merlin Foundation Household",
  },
  {
    label: "collision source still requires a matching member",
    source: "Merlin Smith Household", members: [person("Merlin", "Jones")], expected: "Merlin Smith Household",
  },
  {
    label: "collision source still requires complete member fields",
    source: "Alex Church Household", members: [person(null, "Church")], expected: "Alex Church Household",
  },
  {
    label: "collision source cannot resolve ambiguous multiword given names",
    source: "Ken Nakamura Church Household",
    members: [person("Ken Nakamura", "Church")], expected: "Ken Nakamura Church Household",
  },
  {
    label: "collision source cannot bypass the member count limit",
    source: "Alex Church Household",
    members: [person("Alex", "Church"), person("Jordan", "Church"), person("Adah", "Church")], expected: "Alex Church Household",
  },
  {
    label: "collision source with no members remains unchanged",
    source: "Alex Church Household", members: [], expected: "Alex Church Household",
  },
  {
    label: "collision source still requires the household suffix",
    source: "Alex Church", members: [person("Alex", "Church")], expected: "Alex Church",
  },
  {
    label: "collision source with unexplained words remains unchanged",
    source: "Alex Church Family Household",
    members: [person("Alex", "Church")], expected: "Alex Church Family Household",
  },
  {
    label: "source must explicitly identify a household",
    source: "Alex Smith", members: [person("Alex", "Smith")], expected: "Alex Smith",
  },
  {
    label: "unexplained source text is preserved",
    source: "Smith Family Household", members: [person("Alex", "Smith")], expected: "Smith Family Household",
  },
  {
    label: "unseen member in source label is not dropped",
    source: "Smith & Jones Household", members: [person("Alex", "Smith")], expected: "Smith & Jones Household",
  },
  {
    label: "source connector cannot turn an unseen surname into a given name",
    source: "Smith & Jones Household", members: [person("Smith", "Jones")], expected: "Smith & Jones Household",
  },
  {
    label: "joint source includes both contributing given names when naming people",
    source: "Smith & Jones Household",
    members: [person("Smith", "Jones"), person("Jordan", "Jones")], expected: "Smith & Jones Household",
  },
  {
    label: "written and connector supports a verified joint source",
    source: "Alex and Jordan Smith Household",
    members: [person("Alex", "Smith"), person("Jordan", "Smith")], expected: "Smith Household",
  },
  {
    label: "additional surname absent from source cannot imply joint composition",
    source: "Alex Smith Household", members: [person("Alex", "Smith"), person("Jordan", "Jones")], expected: "Alex Smith Household",
  },
  {
    label: "missing surname keeps original label",
    source: "Alex Smith Household", members: [person("Alex", null)], expected: "Alex Smith Household",
  },
  {
    label: "missing first name keeps original label",
    source: "Smith Household", members: [person(null, "Smith")], expected: "Smith Household",
  },
  {
    label: "zero members keeps original label",
    source: "Alex Smith Household", members: [], expected: "Alex Smith Household",
  },
  {
    label: "more than two members requires verified composition",
    source: "Alex Smith Household",
    members: [person("Alex", "Smith"), person("Jordan", "Smith"), person("Adah", "Smith")], expected: "Alex Smith Household",
  },
  {
    label: "uppercase source suffix is understood without recasing surname",
    source: "Alex McDonald HOUSEHOLD", members: [person("Alex", "McDonald")], expected: "McDonald Household",
  },
];

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;

gated("Household display naming executes its actual PostgreSQL expression", () => {
  let db: PrismaClient;
  let actual: Map<string, string>;

  beforeAll(async () => {
    const raw = process.env.DATABASE_URL;
    if (!raw) throw new Error("explicit_synthetic_database_required");
    const url = new URL(raw);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      || !["5432", "55426", "55444"].includes(url.port)
      || !(["/aoa_tkt_216", "/aoa_pagination_synthetic", "/aoa_loading_full_synthetic"].includes(url.pathname)
        || (process.env.CI === "true" && url.pathname === "/aoa"))
      || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE
      || ["dev", "development", "prod", "production"].includes(process.env.APP_ENV?.toLowerCase() ?? "")) {
      throw new Error("isolated_synthetic_database_required");
    }
    db = new PrismaClient({ datasourceUrl: raw });
    const rows = await db.$queryRaw<Array<{ label: string; display_name: string }>>(
      Prisma.join(cases.map(test => Prisma.sql`
        SELECT ${test.label}::text AS label,
               ${householdDisplayNameSql(
                 Prisma.sql`${test.source}`,
                 Prisma.sql`${JSON.stringify(test.members)}`,
               )} AS display_name
      `), " UNION ALL "),
    );
    actual = new Map(rows.map(row => [row.label, row.display_name]));
  });

  afterAll(async () => { await db?.$disconnect(); });

  it.each(cases)("$label", ({ label, expected }) => {
    expect(actual.get(label)).toBe(expected);
  });

  it("normalizes Salesforce aliases while preserving opaque keys sharing a prefix", async () => {
    const ids = ["001288867315530", "001288867315530AAA", "ZZTEST-SEARCH-HH", "ZZTEST-SEARCH-HH-PCT"];
    const rows = await db.$queryRaw<Array<{ source: string; normalized: string }>>(
      Prisma.join(ids.map(id => Prisma.sql`SELECT ${id}::text AS source,
        ${householdSourceKeySql(Prisma.sql`${id}::text`)} AS normalized`), " UNION ALL "),
    );
    expect(rows.map(row => row.normalized)).toEqual([
      "001288867315530", "001288867315530", "ZZTEST-SEARCH-HH", "ZZTEST-SEARCH-HH-PCT",
    ]);
  });

  it.runIf(Boolean(process.env.AUDIT_TEST_CLEANUP_URL))(
    "point reads isolate opaque IDs, retain source/member names, and fail closed for empty or invisible keys",
    async () => {
      const raw = process.env.AUDIT_TEST_CLEANUP_URL!;
      const target = new URL(process.env.DATABASE_URL!);
      const cleanup = new URL(raw);
      if (cleanup.host !== target.host || cleanup.pathname !== target.pathname || cleanup.username !== "aoa") {
        throw new Error("matching_synthetic_owner_required");
      }
      const owner = new PrismaClient({ datasourceUrl: raw });
      const householdIds = ["TKT16-DISPLAY-OPAQUE-A", "TKT16-DISPLAY-OPAQUE-B", "TKT16-DISPLAY-OPAQUE-HIDDEN"];
      const memberIds = ["TKT16-DISPLAY-PERSON-A", "TKT16-DISPLAY-PERSON-B", "TKT16-DISPLAY-PERSON-HIDDEN"];
      const advisor = "tkt16-display-point@example.invalid";
      const cleanupFixture = async () => {
        await owner.$executeRaw(Prisma.sql`DELETE FROM mirror.client WHERE sf_id IN (${Prisma.join(memberIds)})`);
        await owner.$executeRaw(Prisma.sql`DELETE FROM mirror.household WHERE sf_id IN (${Prisma.join(householdIds)})`);
      };
      try {
        await cleanupFixture();
        await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, lead_advisor_email)
          VALUES (${householdIds[0]}, 'Alex Smith Household', ${advisor}),
            (${householdIds[1]}, 'Jordan Jones Household', ${advisor}),
            (${householdIds[2]}, 'Hidden Smith Household', 'other-tkt16-display@example.invalid')`;
        await owner.$executeRaw`INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
          VALUES (${memberIds[0]}, ${householdIds[0]}, 'Alex', 'Smith', ${advisor}),
            (${memberIds[1]}, ${householdIds[1]}, 'Jordan', 'Jones', ${advisor}),
            (${memberIds[2]}, ${householdIds[2]}, 'Hidden', 'Smith', 'other-tkt16-display@example.invalid')`;
        const read = (keys: string[]) => db.$transaction(async tx => {
          await tx.$executeRaw`SELECT set_config('app.user_role', 'ADVISOR', true)`;
          await tx.$executeRaw`SELECT set_config('app.user_email', ${advisor}, true)`;
          return tx.$queryRaw<Array<{ sf_id: string; display_name: string; member_names: string[]; source_names: string[] }>>(Prisma.sql`
            WITH ${householdDisplayCtes(true, Prisma.sql`${keys}::text[]`)}
            SELECT sf_id, display_name, member_names, source_names FROM household_display ORDER BY sf_id`);
        });
        expect(await read([householdIds[0]])).toEqual([{
          sf_id: householdIds[0], display_name: "Smith Household",
          member_names: ["Alex Smith"], source_names: ["Alex Smith Household"],
        }]);
        expect((await read([householdIds[1]])).map(row => row.display_name)).toEqual(["Jones Household"]);
        expect(await read([])).toEqual([]);
        expect(await read([householdIds[2]])).toEqual([]);
      } finally {
        await cleanupFixture();
        await owner.$disconnect();
      }
    },
  );
});
