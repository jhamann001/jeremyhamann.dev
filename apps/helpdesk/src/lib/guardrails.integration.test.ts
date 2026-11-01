/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10): runs only with TEST_DATABASE_URL, against a
 * separate database. Read-only — it inspects the catalog and writes nothing.
 *
 * G15 in src/lib/guardrails.test.ts reads the SQL *text* of the migration and of the operator-run
 * prisma/sql/runtime-roles.sql. That text is the intent; this file is the state. A privilege granted out
 * of band — by hand in psql, by a role membership, by a blanket `GRANT … ON ALL TABLES IN SCHEMA`, or by
 * an `ALTER DEFAULT PRIVILEGES` that fired when a later migration created a table — never appears in
 * either file, so no text scan can see it. `has_table_privilege` can: it resolves inherited grants and
 * grants made to PUBLIC as well as direct ones.
 *
 * Proves live: I1 at the privilege layer — the client-API role can read ten "Ticket" COLUMNS, the two
 * client-visible views, and nothing else, and holds no write privilege anywhere.
 *
 * MOSTLY read-only. The last test is the exception and says so: it creates three
 * tickets, because the property it proves is about ROWS — that the opening-message view admits the one
 * the client wrote and not the two the desk composed — and a catalog query cannot show that. Every
 * assertion it makes is scoped to the ids it created; nothing is updated or deleted (the triggers
 * would refuse anyway).
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, afterAll } from "vitest";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  // The Prisma datasource reads DATABASE_URL: repoint it BEFORE the first import of @/lib/db.
  process.env.DATABASE_URL = TEST_URL;
}
const dbModule = TEST_URL ? await import("@/lib/db") : null;

/**
 * The only relations the client-API role may hold any privilege on (#65, #117).
 *
 * The third is Decision #117's, and it is granted BECAUSE three `"Ticket"` columns are revoked: a view
 * whose WHERE is the disclosure rule is narrower than three columns readable for every ticket.
 */
const PUBLIC_READABLE = ["Ticket", "ClientVisibleComment", "ClientVisibleOpeningMessage"];
/** Wave A's six tables, named explicitly so the failure message says which one leaked. */
const WAVE_A_TABLES = ["IngestReceipt", "SuspendedIntake", "MessageDelivery", "Attachment", "SlaAlert", "JobCursor"];
/** Wave B's thirteen, for the same reason. The generic sweep below would catch them
 *  anyway; naming them is what makes the failure read as the I1 regression it is. */
const WAVE_B_TABLES = [
  "Notification",
  "TicketFollower",
  "ComposerDraft",
  "CommentRetraction",
  "TicketLink",
  "WebhookEndpoint",
  "WebhookDelivery",
  "PushSubscription",
  "ClientApiToken",
  "IdentityVerification",
  "ReviewStamp",
  "RequesterSuppression",
  "FollowUpNudge",
];

/** The deployed `ClientVisibleComment` projection. Seven columns, in this order. */
const CLIENT_VISIBLE_COLUMNS = ["id", "ticketId", "body", "disclaimerKey", "authorKind", "createdAt", "retracted"];
/**
 * The `"Ticket"` columns the client-API role may read — `getClientTicketView`'s projection, and the
 * column list `prisma/sql/runtime-roles.sql` grants. `has_table_privilege` says nothing about a column
 * grant, so the test above (which judges relations) cannot tell a column-scoped `"Ticket"` from a
 * table-wide one; the test below does, and it is the live half of G15's column rule.
 *
 * Decision #117 added `description`, `source` and `externalId` and then took all three back: the
 * opening message is read through the "ClientVisibleOpeningMessage" view, which carries the gate in its
 * own WHERE, so the client role is back to Wave A's ten. Sorted, like the rest of this list.
 */
const CLIENT_TICKET_COLUMNS = [
  "category",
  "createdAt",
  "id",
  "number",
  "priority",
  "requesterEmail",
  "resolvedAt",
  "status",
  "subject",
  "updatedAt",
];

/** The deployed `ClientVisibleOpeningMessage` projection. Four columns, in this order. */
const OPENING_VIEW_COLUMNS = ["ticketId", "source", "body", "createdAt"];

type GrantRow = { relation: string; privileges: string };

describe.skipIf(!TEST_URL)("privilege guardrails (TEST_DATABASE_URL)", () => {
  afterAll(async () => {
    if (!dbModule) return;
    await dbModule.prisma.$disconnect();
  });

  it("the client-API role holds SELECT on exactly the two client-readable relations and nothing else (I1)", async (ctx) => {
    if (!dbModule) throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
    const { prisma } = dbModule;

    const roles = await prisma.$queryRaw<Array<{ rolname: string }>>`
      SELECT rolname FROM pg_roles WHERE rolname = 'wm_helpdesk_public'
    `;
    if (roles.length === 0) {
      // The runtime roles are operator-provisioned environment state, not schema: a database that has
      // only had `prisma migrate deploy` run against it has nothing to assert about. Skipping is
      // honest; passing would be a lie about a role that does not exist.
      ctx.skip();
      return;
    }

    const grants = await prisma.$queryRaw<GrantRow[]>`
      SELECT g.relation, g.privileges
      FROM (
        SELECT c.relname AS relation,
               array_to_string(ARRAY(
                 SELECT p
                 FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
                 WHERE has_table_privilege('wm_helpdesk_public', c.oid, p)
               ), ',') AS privileges
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      ) g
      WHERE g.privileges <> ''
      ORDER BY g.relation
    `;

    const violations: string[] = [];
    for (const { relation, privileges } of grants) {
      if (!PUBLIC_READABLE.includes(relation)) {
        violations.push(`${relation}: wm_helpdesk_public holds ${privileges} (allowed: none)`);
        continue;
      }
      if (privileges !== "SELECT") {
        violations.push(`${relation}: wm_helpdesk_public holds ${privileges} (allowed: SELECT)`);
      }
    }
    // Named separately so a leak reads as the I1 regression it is, not as a generic extra grant.
    for (const [wave, tables] of [
      ["Wave A", WAVE_A_TABLES],
      ["Wave B", WAVE_B_TABLES],
    ] as const) {
      for (const table of tables) {
        const row = grants.find((g) => g.relation === table);
        if (row) violations.push(`I1: ${wave} table ${table} is readable by wm_helpdesk_public (${row.privileges})`);
      }
    }
    expect(violations).toEqual([]);

    // The grant set must also not be empty in the direction that matters: if the operator file has run,
    // the view is readable. (Ticket's grant lives only in runtime-roles.sql, which a bare
    // `migrate deploy` database has not seen, so it is not asserted here.)
    expect(grants.map((g) => g.relation)).toContain("ClientVisibleComment");
  });

  it("the client-API role reads \"Ticket\" column by column, never table-wide (I1)", async (ctx) => {
    if (!dbModule) throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
    const { prisma } = dbModule;

    const roles = await prisma.$queryRaw<Array<{ rolname: string }>>`
      SELECT rolname FROM pg_roles WHERE rolname = 'wm_helpdesk_public'
    `;
    if (roles.length === 0) {
      ctx.skip();
      return;
    }

    const tableWide = await prisma.$queryRaw<Array<{ granted: boolean }>>`
      SELECT has_table_privilege('wm_helpdesk_public', '"Ticket"'::regclass, 'SELECT') AS granted
    `;
    // has_column_privilege resolves the table grant, the column grant and anything inherited, so this
    // is the whole truth about what the client role can read out of "Ticket".
    const readable = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT a.attname AS column_name
      FROM pg_attribute a
      WHERE a.attrelid = '"Ticket"'::regclass
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND has_column_privilege('wm_helpdesk_public', a.attrelid, a.attnum, 'SELECT')
      ORDER BY a.attname
    `;
    const granted = tableWide[0]?.granted === true;
    if (!granted && readable.length === 0) {
      // A database that has only seen `prisma migrate deploy` has no "Ticket" grant to judge.
      ctx.skip();
      return;
    }
    expect(granted, 'wm_helpdesk_public holds table-wide SELECT on "Ticket" — it must be column-scoped').toBe(false);
    expect(readable.map((r) => r.column_name)).toEqual(CLIENT_TICKET_COLUMNS);
  });

  it("the DEPLOYED ClientVisibleComment blanks a retracted body, and joins only CommentRetraction (Decision #101)", async () => {
    if (!dbModule) throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
    const { prisma } = dbModule;

    // G16 reads the migration TEXT — the intent. This reads the catalog — the state. A view rebuilt by
    // hand, or a migration applied out of order, never shows up in a text scan.
    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT a.attname AS column_name
      FROM pg_attribute a
      WHERE a.attrelid = '"ClientVisibleComment"'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum
    `;
    expect(columns.map((c) => c.column_name)).toEqual(CLIENT_VISIBLE_COLUMNS);

    const [{ definition }] = await prisma.$queryRaw<Array<{ definition: string }>>`
      SELECT pg_get_viewdef('"ClientVisibleComment"'::regclass, true) AS definition
    `;
    // Exactly one join, to a table that holds no message text of its own.
    expect([...definition.matchAll(/\bJOIN\s+"?([A-Za-z0-9_]+)"?/gi)].map((m) => m[1])).toEqual([
      "CommentRetraction",
    ]);
    expect(definition).toMatch(/LEFT JOIN/i);
    expect(definition).toMatch(/visibility = 'PUBLIC'/);
    // No identity, ever.
    for (const forbidden of ["authorId", "macroId", "piiRedacted"]) {
      expect(definition, `the view must not select ${forbidden}`).not.toContain(forbidden);
    }

    // And the behaviour, not only the shape: every retracted row comes back with an empty body.
    const rows = await prisma.$queryRaw<Array<{ retracted: boolean; body_length: number }>>`
      SELECT retracted, length(body) AS body_length FROM "ClientVisibleComment" WHERE retracted
    `;
    for (const row of rows) expect(row.body_length, "a retracted comment's body must be blank").toBe(0);
  });

  /**
   * DECISION #117, and the test the amendment exists for.
   *
   * The first shape of the opening entry granted `wm_helpdesk_public` SELECT on `"Ticket".description`,
   * `.source` and `.externalId` and enforced the requester-authored gate in `src/server/client-view.ts`.
   * That is the shape `ClientVisibleComment` exists to avoid: an INTERNAL comment cannot leak through a
   * coding mistake because the DATABASE will not return one, whereas a mistake in an application-side
   * allowlist COULD have returned a staff-composed description to the client it was written about.
   *
   * This test is the property, at the privilege layer, as the client role itself:
   *   1. the database REFUSES `SELECT description FROM "Ticket"` to that role — and grants `subject` in
   *      the same breath, so the refusal is about the column and not about the table;
   *   2. the view returns a row for an EMAIL ticket — the client's own words, reachable;
   *   3. and none for a STAFF_FORM one, nor for a released held-mail ticket whose source IS `EMAIL`.
   *
   * It would have FAILED on the code this amendment replaced: (1) succeeded, and (2) and (3) had no
   * view to query at all. `SET LOCAL ROLE` inside a transaction is how the role is assumed — privilege
   * checks resolve against `current_user`, so this is the same answer a connection as that role gives,
   * without a second datasource URL or a password this suite does not hold.
   */
  it("the client role is REFUSED \"Ticket\".description, and reads the gated view instead (I1, Decision #117)", async (ctx) => {
    if (!dbModule) throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
    const { prisma } = dbModule;

    const roles = await prisma.$queryRaw<Array<{ rolname: string }>>`
      SELECT rolname FROM pg_roles WHERE rolname = 'wm_helpdesk_public'
    `;
    if (roles.length === 0) {
      ctx.skip();
      return;
    }
    const granted = await prisma.$queryRaw<Array<{ ok: boolean }>>`
      SELECT has_column_privilege('wm_helpdesk_public', '"Ticket"'::regclass, 'subject', 'SELECT') AS ok
    `;
    if (granted[0]?.ok !== true) {
      // prisma/sql/runtime-roles.sql has not been applied here, so there is no grant to judge.
      ctx.skip();
      return;
    }

    // --- fixtures: three tickets, one per branch of the gate, all created as the OWNER ------------
    const run = randomUUID().slice(0, 8);
    const ids = {
      email: `it_gi_open_email_${run}`,
      staff: `it_gi_open_staff_${run}`,
      released: `it_gi_open_released_${run}`,
    };
    const CLIENT_WORDS = `CLIENT_WORDS_${run} — I sent the wire form on Tuesday and have heard nothing.`;
    const DESK_WORDS = `DESK_WORDS_${run} — caller sounded confused; chase the wire desk before replying.`;
    const RELEASE_WORDS = `RELEASE_WORDS_${run} — Released from held inbound mail. Reviewer note: called back.`;

    await prisma.queue.upsert({
      where: { key: "CLIENT_SERVICE" },
      update: {},
      create: { key: "CLIENT_SERVICE", name: "Client Service", description: "integration fixture", sortOrder: 2 },
    });
    const queue = await prisma.queue.findUniqueOrThrow({ where: { key: "CLIENT_SERVICE" } });
    const user = await prisma.user.upsert({
      where: { id: "it_gi_user_cs" },
      update: { isActive: true },
      create: {
        id: "it_gi_user_cs",
        email: "gi.staff@wm-helpdesk.local",
        name: "Casey Service (privilege it)",
        groups: ["client_services"],
        emailVerified: new Date(),
        isActive: true,
      },
    });
    const base = {
      requesterName: "Privilege Probe",
      requesterEmail: `privilege.probe.${run}@example.com`,
      category: "WIRE_TRANSFER" as const,
      priority: "HIGH" as const,
      status: "OPEN" as const,
      queueId: queue.id,
      createdById: user.id,
      slaFirstResponseMinutes: 60,
      slaResolutionMinutes: 480,
      firstResponseDueAt: new Date(Date.now() + 60 * 60_000),
      resolutionDueAt: new Date(Date.now() + 480 * 60_000),
    };
    await prisma.ticket.create({
      data: { ...base, id: ids.email, subject: `Wire form ${run}`, description: CLIENT_WORDS, source: "EMAIL" },
    });
    await prisma.ticket.create({
      data: { ...base, id: ids.staff, subject: `Call note ${run}`, description: DESK_WORDS, source: "STAFF_FORM" },
    });
    await prisma.ticket.create({
      data: {
        ...base,
        id: ids.released,
        subject: `Released hold ${run}`,
        description: RELEASE_WORDS,
        // The dangerous case: an ALLOWLISTED source carrying a body the desk composed. Only the
        // `externalId` marker separates it from the first ticket, which is why the gate keys on it.
        source: "EMAIL",
        externalId: `intake-release.si_${run}`,
      },
    });

    // --- 1. as the client role: the column is refused, the table is not --------------------------
    const asClientRole = <T>(sql: string, ...params: unknown[]): Promise<T> =>
      prisma
        .$transaction([
          prisma.$executeRawUnsafe("SET LOCAL ROLE wm_helpdesk_public"),
          prisma.$queryRawUnsafe<T>(sql, ...params),
        ])
        .then(([, rows]) => rows as T);

    for (const column of ["description", "source", "externalId"]) {
      await expect(
        asClientRole(`SELECT "${column}" FROM "Ticket" WHERE id = $1`, ids.email),
        `wm_helpdesk_public must not be able to read "Ticket".${column}`,
      ).rejects.toThrow(/permission denied/i);
    }
    // The control: a granted column of the SAME table, read by the SAME role in the same way. Without
    // this the refusals above would also pass if the role had simply lost its "Ticket" grant.
    const subjects = await asClientRole<Array<{ subject: string }>>(
      `SELECT subject FROM "Ticket" WHERE id = $1`,
      ids.email,
    );
    expect(subjects.map((r) => r.subject)).toEqual([`Wire form ${run}`]);

    // --- 2 & 3. the view: the client's own words, and neither desk-composed body -----------------
    const rows = await asClientRole<Array<{ ticketId: string; source: string; body: string; createdAt: Date }>>(
      `SELECT "ticketId", source, body, "createdAt" FROM "ClientVisibleOpeningMessage"
        WHERE "ticketId" = ANY($1::text[]) ORDER BY "ticketId"`,
      [ids.email, ids.staff, ids.released],
    );
    expect(rows.map((r) => r.ticketId), "only the emailed ticket may have an opening message").toEqual([ids.email]);
    expect(rows[0].source).toBe("EMAIL");
    expect(rows[0].body).toBe(CLIENT_WORDS);
    // Said the other way round, because this is the claim that matters: the desk's words are not
    // reachable through the view by the role that serves the client API.
    const text = JSON.stringify(rows);
    expect(text).not.toContain(DESK_WORDS);
    expect(text).not.toContain(RELEASE_WORDS);

    // --- the deployed view's shape, not only its rows (G16 reads the migration TEXT) -------------
    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT a.attname AS column_name
      FROM pg_attribute a
      WHERE a.attrelid = '"ClientVisibleOpeningMessage"'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum
    `;
    expect(columns.map((c) => c.column_name)).toEqual(OPENING_VIEW_COLUMNS);
    const [{ definition }] = await prisma.$queryRaw<Array<{ definition: string }>>`
      SELECT pg_get_viewdef('"ClientVisibleOpeningMessage"'::regclass, true) AS definition
    `;
    // One table, no join, and both gates present in the DEPLOYED definition.
    expect([...definition.matchAll(/\bJOIN\s+"?([A-Za-z0-9_]+)"?/gi)].map((m) => m[1])).toEqual([]);
    expect(definition).toMatch(/FROM "Ticket" t/);
    expect(definition).toMatch(/'EMAIL'/);
    expect(definition).toMatch(/'CLIENT_APP'/);
    expect(definition).toMatch(/intake-release\./);
    for (const forbidden of ["requesterPhone", "householdId", "isComplaint", "piiRedacted"]) {
      expect(definition, `the view must not select ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("no default privilege hands a future table to the client-API role (I1)", async (ctx) => {
    if (!dbModule) throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
    const { prisma } = dbModule;

    const roles = await prisma.$queryRaw<Array<{ rolname: string }>>`
      SELECT rolname FROM pg_roles WHERE rolname = 'wm_helpdesk_public'
    `;
    if (roles.length === 0) {
      ctx.skip();
      return;
    }

    // A default ACL is invisible until the next CREATE TABLE, at which point the new table is already
    // readable by whoever the ACL names. This is the one privilege regression that is silent by design.
    const defaults = await prisma.$queryRaw<Array<{ objtype: string; acl: string }>>`
      SELECT d.defaclobjtype::text AS objtype, COALESCE(array_to_string(d.defaclacl, ' '), '') AS acl
      FROM pg_default_acl d
    `;
    const offenders = defaults
      .filter((d) => d.acl.includes("wm_helpdesk_public="))
      .map((d) => `default ACL on objtype ${d.objtype} names wm_helpdesk_public: ${d.acl}`);
    expect(offenders).toEqual([]);

    // Role membership is the other way the client role inherits privileges it was never granted.
    const memberships = await prisma.$queryRaw<Array<{ grantee: string; member_of: string }>>`
      SELECT member.rolname AS grantee, parent.rolname AS member_of
      FROM pg_auth_members m
      JOIN pg_roles member ON member.oid = m.member
      JOIN pg_roles parent ON parent.oid = m.roleid
      WHERE member.rolname = 'wm_helpdesk_public'
    `;
    expect(memberships).toEqual([]);
  });
});
