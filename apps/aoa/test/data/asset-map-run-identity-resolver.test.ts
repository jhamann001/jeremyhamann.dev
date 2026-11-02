import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  RESOLVER_BATCH_LIMIT,
  RunIdentityResolverError,
  resolveRunPeople,
} from "@/lib/data/asset-map-run-identity/resolver";
import {
  CrmSeed,
  connectSyntheticDatabase,
  contactIdentityId,
  contactKey,
  disconnectSyntheticDatabase,
  integrationDescribe,
  type SyntheticDatabase,
} from "../asset-map-run-identity/fixtures";

type Row = {
  cedar_ridge_user_id: string;
  outcome: string;
  canonical_contact_identity_id: string | null;
  canonical_contact_source_key: string | null;
};

function mockTx(handler: (ids: string[]) => Row[]) {
  const calls: string[][] = [];
  const tx = {
    $queryRaw: vi.fn(async (_strings: TemplateStringsArray, ids: string[]) => {
      calls.push(ids);
      return handler(ids);
    }),
  } as unknown as Prisma.TransactionClient;
  return { tx, calls };
}

const missingRows = (ids: string[]): Row[] => ids.map((id) => ({
  cedar_ridge_user_id: id, outcome: "missing", canonical_contact_identity_id: null, canonical_contact_source_key: null,
}));

describe("resolveRunPeople wrapper", () => {
  it("does not query for an empty request", async () => {
    const { tx, calls } = mockTx(missingRows);
    expect((await resolveRunPeople(tx, [])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("batches at the explicit limit and returns exactly the requested ids", async () => {
    const ids = Array.from({ length: RESOLVER_BATCH_LIMIT * 2 + 5 }, (_, i) => `cr-${i}`);
    const { tx, calls } = mockTx(missingRows);
    const result = await resolveRunPeople(tx, ids);
    expect(calls.map((c) => c.length)).toEqual([RESOLVER_BATCH_LIMIT, RESOLVER_BATCH_LIMIT, 5]);
    expect([...result.keys()].sort()).toEqual([...ids].sort());
  });

  it.each([
    ["empty id", [""]],
    ["whitespace id", ["  "]],
    ["duplicate ids", ["cr-a", "cr-a"]],
    ["non-string id", [7 as unknown as string]],
  ])("rejects %s before querying", async (_label, ids) => {
    const { tx, calls } = mockTx(missingRows);
    await expect(resolveRunPeople(tx, ids)).rejects.toBeInstanceOf(RunIdentityResolverError);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["an unrequested id", (ids: string[]) => [...missingRows(ids), ...missingRows(["cr-extra"])]],
    ["a missing id", (ids: string[]) => missingRows(ids.slice(1))],
    ["a duplicate row", (ids: string[]) => [...missingRows(ids), ...missingRows(ids.slice(0, 1))]],
    ["an unknown outcome", (ids: string[]) => missingRows(ids).map((r) => ({ ...r, outcome: "first_match" }))],
    ["resolved without a target", (ids: string[]) => missingRows(ids).map((r) => ({ ...r, outcome: "resolved" }))],
    ["a target on an unresolved row", (ids: string[]) => missingRows(ids).map((r) => ({
      ...r, outcome: "ambiguous", canonical_contact_identity_id: "con_x", canonical_contact_source_key: "003X",
    }))],
  ])("fails closed on %s", async (_label, handler) => {
    const { tx } = mockTx(handler);
    await expect(resolveRunPeople(tx, ["cr-a", "cr-b"])).rejects.toBeInstanceOf(RunIdentityResolverError);
  });
});

// ---------------------------------------------------------------------------
// Real PostgreSQL, executed as ingest_rw against the checked SECURITY DEFINER
// resolver. Every CRM row is invented and namespaced "rs".
// ---------------------------------------------------------------------------
integrationDescribe("app.resolve_asset_map_run_people under real roles", () => {
  let db: SyntheticDatabase | undefined;
  let seed: CrmSeed;
  const ns = "rs";
  const key = (n: number) => contactKey(ns, n);
  const con = (n: number) => contactIdentityId(ns, n);

  async function resolve(ids: string[]) {
    return db!.ingest.$transaction((tx) => resolveRunPeople(tx, ids));
  }

  beforeAll(async () => {
    db = await connectSyntheticDatabase();
    seed = new CrmSeed(db, ns, 0x270100000);
    await seed.cleanup();
    // 1: unique exact match.
    await seed.contact({ n: 1, cedarRidgeUserId: "rs-exact" });
    // 2,3: two unrelated clients share one id → ambiguous.
    await seed.contact({ n: 2, cedarRidgeUserId: "rs-two" });
    await seed.contact({ n: 3, cedarRidgeUserId: "rs-two" });
    // 4→5: confirmed duplicate converging to one compatible survivor → collapse.
    await seed.contact({ n: 4, cedarRidgeUserId: "rs-merged" });
    await seed.contact({ n: 5, cedarRidgeUserId: "rs-merged" });
    await seed.edge({ from: 4, to: 5 });
    // 6: 15/18-character aliases of the same identity collapse.
    await seed.contact({ n: 6, cedarRidgeUserId: "rs-alias", registry: "two_aliases" });
    // 7→8→9 chain.
    await seed.contact({ n: 7, cedarRidgeUserId: "rs-chain" });
    await seed.contact({ n: 8, cedarRidgeUserId: null });
    await seed.contact({ n: 9, cedarRidgeUserId: "rs-chain" });
    await seed.edge({ from: 7, to: 8 });
    await seed.edge({ from: 8, to: 9 });
    // 10→11 and 10→12: branch.
    await seed.contact({ n: 10, cedarRidgeUserId: "rs-branch" });
    await seed.contact({ n: 11, cedarRidgeUserId: null });
    await seed.contact({ n: 12, cedarRidgeUserId: null });
    await seed.edge({ from: 10, to: 11 });
    await seed.edge({ from: 10, to: 12 });
    // 13↔14: cycle.
    await seed.contact({ n: 13, cedarRidgeUserId: "rs-cycle" });
    await seed.contact({ n: 14, cedarRidgeUserId: null });
    await seed.edge({ from: 13, to: 14 });
    await seed.edge({ from: 14, to: 13 });
    // 20..28: eight hops exceed the bound; 30..37: seven hops resolve.
    for (let n = 20; n <= 28; n++) await seed.contact({ n, cedarRidgeUserId: n === 20 ? "rs-deep" : null });
    for (let n = 20; n < 28; n++) await seed.edge({ from: n, to: n + 1 });
    for (let n = 30; n <= 37; n++) await seed.contact({ n, cedarRidgeUserId: n === 30 ? "rs-bound" : null });
    for (let n = 30; n < 37; n++) await seed.edge({ from: n, to: n + 1 });
    // 40: alias maps to a HOUSEHOLD identity → wrong type.
    await seed.contact({ n: 40, cedarRidgeUserId: "rs-wrong-type", registry: "wrong_type" });
    // 41: archived identity; 42: only a superseded mapping; 43: no registry row.
    await seed.contact({ n: 41, cedarRidgeUserId: "rs-archived", registry: "archived" });
    await seed.contact({ n: 42, cedarRidgeUserId: "rs-superseded", registry: "superseded" });
    await seed.contact({ n: 43, cedarRidgeUserId: "rs-unregistered", registry: "none" });
    // 44→45: survivor carries a different Cedar Ridge id → conflicting survivor.
    await seed.contact({ n: 44, cedarRidgeUserId: "rs-conflicting" });
    await seed.contact({ n: 45, cedarRidgeUserId: "rs-someone-else" });
    await seed.edge({ from: 44, to: 45 });
    // 46,47: unconfirmed (NEW) duplicate is ignored → still ambiguous.
    await seed.contact({ n: 46, cedarRidgeUserId: "rs-unconfirmed" });
    await seed.contact({ n: 47, cedarRidgeUserId: "rs-unconfirmed" });
    await seed.edge({ from: 46, to: 47, status: "NEW" });
    // 48: case-sensitive exact id.
    await seed.contact({ n: 48, cedarRidgeUserId: "RS-Case" });
    // 49→50: one healthy alias plus one archived survivor for the same id → conflict, not first match.
    await seed.contact({ n: 49, cedarRidgeUserId: "rs-mixed" });
    await seed.contact({ n: 50, cedarRidgeUserId: "rs-mixed", registry: "archived" });
  });

  afterAll(async () => {
    try { if (db) await seed.cleanup(); } finally { await disconnectSyntheticDatabase(db); }
  });

  it("resolves a unique exact id to its canonical CONTACT", async () => {
    const result = await resolve(["rs-exact"]);
    expect(result.get("rs-exact")).toEqual({
      cedarRidgeUserId: "rs-exact", outcome: "resolved",
      canonicalContactIdentityId: con(1), canonicalContactSourceKey: key(1),
    });
  });

  it("collapses aliases that converge on one compatible survivor", async () => {
    const result = await resolve(["rs-merged", "rs-alias", "rs-chain", "rs-bound"]);
    expect(result.get("rs-merged")).toMatchObject({ outcome: "resolved", canonicalContactIdentityId: con(5), canonicalContactSourceKey: key(5) });
    expect(result.get("rs-alias")).toMatchObject({ outcome: "resolved", canonicalContactIdentityId: con(6) });
    expect(result.get("rs-chain")).toMatchObject({ outcome: "resolved", canonicalContactIdentityId: con(9) });
    expect(result.get("rs-bound")).toMatchObject({ outcome: "resolved", canonicalContactIdentityId: con(37) });
  });

  it("reports different survivors and unconfirmed duplicates as ambiguous", async () => {
    const result = await resolve(["rs-two", "rs-unconfirmed"]);
    for (const id of ["rs-two", "rs-unconfirmed"]) {
      expect(result.get(id)).toEqual({
        cedarRidgeUserId: id, outcome: "ambiguous", canonicalContactIdentityId: null, canonicalContactSourceKey: null,
      });
    }
  });

  it("reports missing and case-mismatched ids as missing", async () => {
    const result = await resolve(["rs-nobody", "rs-case", "RS-Case"]);
    expect(result.get("rs-nobody")?.outcome).toBe("missing");
    expect(result.get("rs-case")?.outcome).toBe("missing");
    expect(result.get("RS-Case")).toMatchObject({ outcome: "resolved", canonicalContactIdentityId: con(48) });
  });

  it.each([
    ["branch", "rs-branch"],
    ["cycle", "rs-cycle"],
    ["depth beyond the bound", "rs-deep"],
    ["wrong identity type", "rs-wrong-type"],
    ["archived identity", "rs-archived"],
    ["superseded mapping", "rs-superseded"],
    ["unregistered client", "rs-unregistered"],
    ["conflicting survivor", "rs-conflicting"],
    ["one invalid alias among valid ones", "rs-mixed"],
  ])("returns conflict for %s, never a first match", async (_label, id) => {
    expect((await resolve([id])).get(id)).toEqual({
      cedarRidgeUserId: id, outcome: "conflict", canonicalContactIdentityId: null, canonicalContactSourceKey: null,
    });
  });

  it("does not trust the existing helper's fallback-to-input on a bad chain", async () => {
    const [fallback] = await db!.ingest.$queryRaw<Array<{ key: string }>>`
      SELECT app.resolve_crm_canonical_contact_source_key(${key(13)}) AS key`;
    expect(fallback.key).toBe(key(13));
    expect((await resolve(["rs-cycle"])).get("rs-cycle")?.outcome).toBe("conflict");
  });

  it("returns only requested ids and creates no CRM or client identities", async () => {
    // Sibling files ("ps", "it") seed their own namespaced CRM rows in parallel.
    const counts = () => db!.fixture.$queryRaw<Array<{ identities: bigint; mappings: bigint; clients: bigint }>>`
      SELECT (SELECT count(*) FROM app.crm_identity WHERE id !~ '^(con|hld)_r270(ps|it)') AS identities,
             (SELECT count(*) FROM app.crm_source_mapping WHERE id !~ '^r270-(ps|it)-') AS mappings,
             (SELECT count(*) FROM mirror.client WHERE sf_id !~ '^003R(ps|it)') AS clients`;
    const before = await counts();
    const rows = await db!.ingest.$queryRaw<Row[]>`
      SELECT * FROM app.resolve_asset_map_run_people(ARRAY['rs-exact', 'rs-nobody']::text[])`;
    expect(rows.map((r) => r.cedar_ridge_user_id).sort()).toEqual(["rs-exact", "rs-nobody"]);
    expect(await counts()).toEqual(before);
  });

  it("rejects unbounded, null and duplicate batches in SQL", async () => {
    const tooMany = Array.from({ length: RESOLVER_BATCH_LIMIT + 1 }, (_, i) => `rs-${i}`);
    await expect(db!.ingest.$queryRaw`SELECT * FROM app.resolve_asset_map_run_people(${tooMany}::text[])`).rejects.toThrow();
    await expect(db!.ingest.$queryRaw`SELECT * FROM app.resolve_asset_map_run_people(NULL::text[])`).rejects.toThrow();
    await expect(db!.ingest.$queryRaw`SELECT * FROM app.resolve_asset_map_run_people(ARRAY['rs-a','rs-a']::text[])`).rejects.toThrow();
    await expect(db!.ingest.$queryRaw`SELECT * FROM app.resolve_asset_map_run_people(ARRAY[' ']::text[])`).rejects.toThrow();
  });
});
