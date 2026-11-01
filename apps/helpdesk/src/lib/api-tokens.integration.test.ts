/**
 * `verifyApiToken` against the REAL schema.
 *
 * DB-gated: runs only with `TEST_DATABASE_URL`, against `wm_helpdesk_test`. That database is
 * PERMANENT by design — `ClientApiToken` carries a no-hard-delete trigger, so nothing this file
 * writes can ever be cleaned up — and several test files run against it concurrently. Every row
 * created here therefore carries a per-run marker (`RUN`), every assertion is scoped to rows this run
 * created, and nothing counts or asserts over the table as a whole.
 *
 * What is proved here and cannot be proved with a mock:
 *  - the CHECK constraints accept what `mintApiToken` produces (prefix shape, sha256 hex) and refuse
 *    what it never produces — and where one of them does NOT refuse what it looks like it should,
 *    that is written down as a finding rather than left for somebody to assume;
 *  - verification is by PREFIX with a constant-time digest compare, so a right prefix with a wrong
 *    secret is refused;
 *  - expiry, revocation and a missing scope are all the SAME answer, `null`;
 *  - `lastUsedAt` is written once and then not again inside the refresh window.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  // The Prisma datasource reads DATABASE_URL and env.ts parses at import: set it BEFORE the first import.
  process.env.DATABASE_URL = TEST_URL;
  delete process.env.PUBLIC_DATABASE_URL;
}

const dbModule = TEST_URL ? await import("@/lib/db") : null;
const tokensModule = TEST_URL ? await import("@/lib/api-tokens") : null;

function mods() {
  if (!dbModule || !tokensModule) throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  return { ...dbModule, ...tokensModule };
}

/** Per-run marker. Every row this file writes carries it; every query filters on it. */
const RUN = randomUUID().slice(0, 8);
const USER_ID = `it_tok_user_${RUN}`;
const USER_EMAIL = `tokens.${RUN}@wm-helpdesk.local`;

const bearer = (value: string): Headers => new Headers({ authorization: `Bearer ${value}` });

type Created = { id: string; plaintext: string; prefix: string };

async function createToken(over: {
  scopes?: string[];
  expiresAt?: Date | null;
  revokedAt?: Date | null;
  requesterEmail?: string | null;
  lastUsedAt?: Date | null;
}): Promise<Created> {
  const { prisma, mintApiToken } = mods();
  const minted = mintApiToken();
  const row = await prisma.clientApiToken.create({
    data: {
      name: `it-${RUN}`,
      prefix: minted.prefix,
      tokenHash: minted.tokenHash,
      scopes: (over.scopes ?? ["INTEGRATION_INGEST"]) as never,
      requesterEmail: over.requesterEmail ?? null,
      expiresAt: over.expiresAt ?? null,
      revokedAt: over.revokedAt ?? null,
      lastUsedAt: over.lastUsedAt ?? null,
      createdById: USER_ID,
      note: `run:${RUN}`,
    },
    select: { id: true },
  });
  return { id: row.id, plaintext: minted.plaintext, prefix: minted.prefix };
}

beforeAll(async () => {
  if (!TEST_URL) return;
  const { prisma } = mods();
  await prisma.user.upsert({
    where: { id: USER_ID },
    update: {},
    create: { id: USER_ID, email: USER_EMAIL, name: `Token IT ${RUN}`, groups: ["ops_team"], isActive: true },
  });
});

afterAll(async () => {
  if (!TEST_URL) return;
  // Nothing is deleted: the token rows carry a no-hard-delete trigger and the User row is referenced
  // by them. The per-run marker is what keeps this file's rows from ever being confused with another's.
  await mods().prisma.$disconnect();
});

describe.runIf(TEST_URL)("verifyApiToken against the real schema", () => {
  it("accepts what mintApiToken produced, and only with the right scope", async () => {
    const { verifyApiToken } = mods();
    const token = await createToken({ scopes: ["INTEGRATION_INGEST", "EXPORT_READ"] });

    const ok = await verifyApiToken(bearer(token.plaintext), "INTEGRATION_INGEST");
    expect(ok).not.toBeNull();
    expect(ok?.id).toBe(token.id);
    expect(ok?.scopes).toContain("EXPORT_READ");
    expect(ok?.requesterEmail).toBeNull();

    // A scope the row does not hold is the same answer as a bad token: null.
    await expect(verifyApiToken(bearer(token.plaintext), "MCP")).resolves.toBeNull();
  });

  it("refuses the right prefix with a wrong secret", async () => {
    const { verifyApiToken } = mods();
    const token = await createToken({});
    const [prefix] = token.plaintext.split(".");
    const forged = `${prefix}.${"A".repeat(43)}`;
    expect(forged).not.toBe(token.plaintext);
    await expect(verifyApiToken(bearer(forged), "INTEGRATION_INGEST")).resolves.toBeNull();
  });

  it("refuses an unknown prefix, a malformed bearer and a missing header, identically", async () => {
    const { verifyApiToken } = mods();
    for (const header of [
      bearer("wmhd_zzzzzzzz.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
      bearer("not-a-token"),
      bearer("wmhd_BADCASE.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
      new Headers({ authorization: "Basic abc" }),
      new Headers(),
    ]) {
      await expect(verifyApiToken(header, "INTEGRATION_INGEST")).resolves.toBeNull();
    }
  });

  it("refuses an expired token and accepts one whose expiry is still ahead", async () => {
    const { verifyApiToken } = mods();
    const now = new Date();
    const expired = await createToken({ expiresAt: new Date(now.getTime() - 1_000) });
    const live = await createToken({ expiresAt: new Date(now.getTime() + 3_600_000) });

    await expect(verifyApiToken(bearer(expired.plaintext), "INTEGRATION_INGEST", now)).resolves.toBeNull();
    await expect(verifyApiToken(bearer(live.plaintext), "INTEGRATION_INGEST", now)).resolves.not.toBeNull();
  });

  it("refuses a revoked token — and the row is still there, because nothing is deleted", async () => {
    const { prisma, verifyApiToken } = mods();
    const token = await createToken({});
    await expect(verifyApiToken(bearer(token.plaintext), "INTEGRATION_INGEST")).resolves.not.toBeNull();

    await prisma.clientApiToken.update({ where: { id: token.id }, data: { revokedAt: new Date() } });
    await expect(verifyApiToken(bearer(token.plaintext), "INTEGRATION_INGEST")).resolves.toBeNull();

    const still = await prisma.clientApiToken.findUnique({ where: { id: token.id }, select: { id: true } });
    expect(still?.id).toBe(token.id);
  });

  it("carries a requester binding through to the caller", async () => {
    const { verifyApiToken } = mods();
    const token = await createToken({ scopes: ["CLIENT_READ"], requesterEmail: `client.${RUN}@example.com` });
    const ok = await verifyApiToken(bearer(token.plaintext), "CLIENT_READ");
    expect(ok?.requesterEmail).toBe(`client.${RUN}@example.com`);
  });

  it("writes lastUsedAt once, then leaves it alone inside the refresh window", async () => {
    const { prisma, verifyApiToken, LAST_USED_REFRESH_MS } = mods();
    const token = await createToken({});

    const before = await prisma.clientApiToken.findUnique({
      where: { id: token.id },
      select: { lastUsedAt: true },
    });
    expect(before?.lastUsedAt).toBeNull();

    const t1 = new Date();
    await verifyApiToken(bearer(token.plaintext), "INTEGRATION_INGEST", t1);
    const first = await prisma.clientApiToken.findUnique({
      where: { id: token.id },
      select: { lastUsedAt: true },
    });
    expect(first?.lastUsedAt?.getTime()).toBe(t1.getTime());

    // A second call a second later must NOT rewrite the column: it is metadata, not evidence.
    await verifyApiToken(bearer(token.plaintext), "INTEGRATION_INGEST", new Date(t1.getTime() + 1_000));
    const second = await prisma.clientApiToken.findUnique({
      where: { id: token.id },
      select: { lastUsedAt: true },
    });
    expect(second?.lastUsedAt?.getTime()).toBe(t1.getTime());

    // Past the window, it moves again.
    const t2 = new Date(t1.getTime() + LAST_USED_REFRESH_MS + 1_000);
    await verifyApiToken(bearer(token.plaintext), "INTEGRATION_INGEST", t2);
    const third = await prisma.clientApiToken.findUnique({
      where: { id: token.id },
      select: { lastUsedAt: true },
    });
    expect(third?.lastUsedAt?.getTime()).toBe(t2.getTime());
  });
});

describe.runIf(TEST_URL)("the database's own constraints", () => {
  /**
   * REGRESSION for the finding recorded in the build record
   * and fixed by `prisma/migrations/20260920000300_wave_b_integration_r1`.
   *
   * `api_token_has_a_scope` was `CHECK (array_length(scopes, 1) >= 1)`. For an EMPTY array
   * `array_length` returns NULL, the expression is NULL, and a CHECK treats NULL as SATISFIED — so the
   * constraint that exists to refuse a scope-less credential did not refuse one.
   *
   * Two assertions, because the semantics and the deployed definition are different facts and only the
   * second one would have caught a migration that was written but never applied:
   *
   *  1. The SQL semantics, so the REASON stays in the file. Asserted rather than demonstrated with a
   *     junk row, because the test database is permanent and `ClientApiToken` has a no-hard-delete
   *     trigger: proving the gap must not leave a scope-less credential behind.
   *  2. The constraint THIS database actually carries contains the `coalesce`.
   *
   * `convalidated` is deliberately NOT asserted. The constraint is added `NOT VALID` and validated in
   * the same migration only when the table is clean; `wm_helpdesk_test` still holds the two
   * scope-less rows an earlier run of this suite left behind, and on a permanent books-and-records
   * fixture database the right answer is to leave them and enforce forward, not to delete the
   * evidence. `NOT VALID` still refuses every new row, which is what the assertion below proves.
   */
  it("the scope CHECK refuses an empty array (coalesce, not bare array_length)", async () => {
    const { prisma } = mods();
    const [row] = await prisma.$queryRaw<Array<{ asWritten: boolean; withCoalesce: boolean }>>`
      SELECT (array_length(ARRAY[]::text[], 1) >= 1) IS NOT FALSE AS "asWritten",
             (coalesce(array_length(ARRAY[]::text[], 1), 0) >= 1) IS NOT FALSE AS "withCoalesce"`;
    // As it was written the CHECK admitted a scope-less row...
    expect(row.asWritten).toBe(true);
    // ...and with the one-word fix it does not.
    expect(row.withCoalesce).toBe(false);

    const [live] = await prisma.$queryRaw<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(oid) AS def
        FROM pg_constraint WHERE conname = 'api_token_has_a_scope'`;
    expect(live?.def, "this database still carries the pre-fix constraint").toMatch(/COALESCE/i);
  });

  it("refuses an INSERT with no scopes at all", async () => {
    const { prisma, mintApiToken } = mods();
    const minted = mintApiToken();
    await expect(
      prisma.clientApiToken.create({
        data: {
          name: `it-no-scope-${RUN}`,
          prefix: minted.prefix,
          tokenHash: minted.tokenHash,
          scopes: [],
          createdById: USER_ID,
        },
        select: { id: true },
      }),
    ).rejects.toThrow();
  });

  it("refuses a prefix that is not the minted shape", async () => {
    const { prisma, mintApiToken } = mods();
    const minted = mintApiToken();
    await expect(
      prisma.clientApiToken.create({
        data: {
          name: `it-bad-prefix-${RUN}`,
          prefix: `WMHD_${RUN}`,
          tokenHash: minted.tokenHash,
          scopes: ["MCP"] as never,
          createdById: USER_ID,
        },
        select: { id: true },
      }),
    ).rejects.toThrow();
  });

  it("refuses anything but lower-case sha256 hex in tokenHash — a plaintext cannot be stored by accident", async () => {
    const { prisma, mintApiToken } = mods();
    const minted = mintApiToken();
    await expect(
      prisma.clientApiToken.create({
        data: {
          name: `it-bad-hash-${RUN}`,
          prefix: minted.prefix,
          tokenHash: minted.plaintext,
          scopes: ["MCP"] as never,
          createdById: USER_ID,
        },
        select: { id: true },
      }),
    ).rejects.toThrow();
  });

  it("refuses a hard delete, whatever the caller intends", async () => {
    const { prisma } = mods();
    const token = await createToken({});
    // The Prisma extension refuses it in-process; the trigger refuses it at the database. Both layers
    // are live here, and the in-process one fires first.
    await expect(prisma.clientApiToken.delete({ where: { id: token.id } })).rejects.toThrow();
  });

  /**
   * REGRESSION for the round-2 finding on `insertToken` (`src/server/api-tokens.actions.ts`).
   *
   * That function used to swallow the first P2002 and `create` again on the SAME `tx`, on the strength
   * of a comment promising a silent retry of a prefix collision. It could not work: `withTx` is one
   * interactive BEGIN/COMMIT with no per-statement SAVEPOINT, so the unique violation aborts the
   * transaction and every later statement in it fails with 25P02 — which is not a unique violation, so
   * it is rethrown and the operator gets an opaque 500 instead of the promised retry. The retry now
   * re-runs the whole transaction with a fresh mint (`withMintedToken`); this proves WHY it had to move
   * out, so that nobody puts it back inside.
   *
   * Nothing is left behind on this permanent database: the aborted transaction rolls back in full, and
   * the row whose prefix is collided with is one this run created and marked.
   */
  it("a unique violation aborts the enclosing withTx — an in-transaction retry cannot work", async () => {
    const { prisma, withTx, mintApiToken } = mods();
    const taken = await createToken({});
    const retryName = `it-inline-retry-${RUN}`;
    let swallowed = false;

    await expect(
      withTx(async (tx) => {
        const collision = mintApiToken();
        try {
          await tx.clientApiToken.create({
            data: {
              name: `it-collide-${RUN}`,
              // The one prefix on this database that is guaranteed taken, because this run took it.
              prefix: taken.prefix,
              tokenHash: collision.tokenHash,
              scopes: ["MCP"] as never,
              createdById: USER_ID,
              note: `run:${RUN}`,
            },
            select: { id: true },
          });
        } catch {
          // Exactly what the old `if (attempt === 0 && isUniqueViolation(e)) continue;` did.
          swallowed = true;
        }
        const fresh = mintApiToken();
        return tx.clientApiToken.create({
          data: {
            name: retryName,
            prefix: fresh.prefix,
            tokenHash: fresh.tokenHash,
            scopes: ["MCP"] as never,
            createdById: USER_ID,
            note: `run:${RUN}`,
          },
          select: { id: true },
        });
      }),
    ).rejects.toThrow(/aborted/i);

    expect(swallowed, "the colliding insert should have raised a unique violation").toBe(true);
    // And the "retry" landed nothing: the transaction it ran in was already doomed.
    const rows = await prisma.clientApiToken.findMany({ where: { name: retryName }, select: { id: true } });
    expect(rows).toHaveLength(0);
  });

  it("every row this run created is still readable, and carries this run's marker", async () => {
    const { prisma } = mods();
    const rows = await prisma.clientApiToken.findMany({
      where: { note: `run:${RUN}` },
      select: { id: true, prefix: true, tokenHash: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.prefix).toMatch(/^wmhd_[0-9a-z]{8}$/);
      expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
