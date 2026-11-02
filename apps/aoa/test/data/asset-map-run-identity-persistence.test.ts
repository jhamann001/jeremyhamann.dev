import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  identityPayloadDigest,
  parseRunIdentity,
  type AvailableRunIdentity,
  type RunIdentityObservation,
} from "@/lib/data/asset-map-run-identity/contract";
import {
  RunIdentityPersistenceError,
  deriveMemberResolutions,
  persistRunIdentities,
  planSourceTransition,
  resolutionDigest,
} from "@/lib/data/asset-map-run-identity/persistence";
import type { RunPersonResolution } from "@/lib/data/asset-map-run-identity/resolver";
import {
  CrmSeed,
  cleanupRuns,
  connectSyntheticDatabase,
  contactIdentityId,
  contactKey,
  disconnectSyntheticDatabase,
  fixtureVector,
  integrationDescribe,
  loadMachineExportFixture,
  seedHouseholdRuns,
  syntheticRunId,
  waitForAdvisoryWaiter,
  type SyntheticDatabase,
} from "../asset-map-run-identity/fixtures";

function observe(name: string, overrides: Record<string, unknown> = {}, runId?: string): RunIdentityObservation {
  const vector = fixtureVector(name);
  const parsed = parseRunIdentity(runId ?? vector.run_id, { ...vector.client_link, ...overrides });
  if (!parsed.ok) throw new Error(`fixture ${name} invalid: ${parsed.reason}`);
  return parsed.value;
}
const identity = (name: string, overrides: Record<string, unknown> = {}) => observe(name, overrides) as AvailableRunIdentity;
const unavailable = (runId: string): RunIdentityObservation =>
  ({ runId, schemaVersion: 1, availability: "unavailable", reason: "client_linking_disabled" });

const stored = (name: string, overrides: Record<string, unknown> = {}) => {
  const id = identity(name, overrides);
  return { identityVersion: id.identityVersion, payloadDigest: identityPayloadDigest(id), decisionState: id.decisionState };
};

describe("planSourceTransition", () => {
  it("inserts a first observation, including an unreviewed one", () => {
    expect(planSourceTransition(null, identity("singleton"))).toBe("inserted");
    expect(planSourceTransition(null, identity("unreviewed"))).toBe("inserted");
  });

  it("rejects older versions and quarantines equal-version mutations", () => {
    const current = stored("singleton", { identity_version: 5 });
    expect(planSourceTransition(current, identity("singleton", { identity_version: 4 }))).toBe("stale_rejected");
    expect(planSourceTransition(current, identity("singleton", { identity_version: 5 }))).toBe("unchanged");
    expect(planSourceTransition(current, identity("singleton", {
      identity_version: 5, decision_id: "abababab-abab-4bab-8bab-abababababab",
    }))).toBe("quarantined_equal_version");
  });

  it("applies newer linked and unlinked versions", () => {
    const current = stored("singleton");
    expect(planSourceTransition(current, identity("singleton", { identity_version: 2 }))).toBe("source_applied");
    expect(planSourceTransition(current, identity("first_confirmation_reversal"))).toBe("source_applied");
  });

  it("never lets a later unreviewed observation clear accepted state", () => {
    const unreviewedLater = identity("unreviewed", { identity_version: 9 });
    expect(planSourceTransition(stored("singleton"), unreviewedLater)).toBe("quarantined_unreviewed");
    expect(planSourceTransition(stored("explicit_unlinked"), unreviewedLater)).toBe("quarantined_unreviewed");
    expect(planSourceTransition(stored("unreviewed"), unreviewedLater)).toBe("source_applied");
  });

  it("preserves state when the source is unavailable", () => {
    expect(planSourceTransition(null, unavailable("11111111-1111-4111-8111-111111111111"))).toBe("unavailable_preserved");
    expect(planSourceTransition(stored("singleton"), unavailable("11111111-1111-4111-8111-111111111111")))
      .toBe("unavailable_preserved");
  });
});

describe("deriveMemberResolutions", () => {
  const resolved = (id: string): RunPersonResolution => ({
    cedarRidgeUserId: id, outcome: "resolved", canonicalContactIdentityId: "con_x", canonicalContactSourceKey: "003X",
  });

  it("keeps people but blocks targets while the source conflicts", () => {
    const members = deriveMemberResolutions(identity("conflict"), new Map([["cr-conflict", resolved("cr-conflict")]]));
    expect(members).toEqual([{
      cedarRidgeUserId: "cr-conflict", outcome: "conflict", canonicalContactIdentityId: null, canonicalContactSourceKey: null,
    }]);
  });

  it("passes checked outcomes through and requires one per member", () => {
    const shared = identity("shared_no_primary");
    expect(deriveMemberResolutions(shared, new Map([["cr-a", resolved("cr-a")], ["cr-b", resolved("cr-b")]])))
      .toHaveLength(2);
    expect(() => deriveMemberResolutions(shared, new Map([["cr-a", resolved("cr-a")]])))
      .toThrow(RunIdentityPersistenceError);
  });

  it("fingerprints resolution independent of map order", () => {
    const a = resolutionDigest([resolved("cr-a"), resolved("cr-b")]);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(resolutionDigest([resolved("cr-b"), resolved("cr-a")])).toBe(a);
    expect(resolutionDigest([resolved("cr-a")])).not.toBe(a);
  });
});

// ---------------------------------------------------------------------------
// Real PostgreSQL as ingest_rw, using the shared invented fixture vectors.
// ---------------------------------------------------------------------------

type SnapshotRow = {
  identity_version: string;
  decision_state: string;
  decision_id: string | null;
  people_ids: string[];
  consumer_revision: number;
  review_state: string;
  quarantine_reason: string | null;
  quarantined_identity_version: string | null;
  last_observed_availability: string;
};
type MemberRow = {
  cedar_ridge_user_id: string;
  membership_state: string;
  first_identity_version: string;
  active_since_identity_version: string;
  last_confirmed_identity_version: string;
  retired_identity_version: string | null;
  resolution_outcome: string | null;
  canonical_contact_identity_id: string | null;
  canonical_contact_source_key: string | null;
};
type HistoryRow = {
  consumer_revision: number;
  identity_version: string;
  people_ids: string[];
  source_changed: boolean;
  resolution_changed: boolean;
  resolutions: Array<{ cedar_ridge_user_id: string; outcome: string; canonical_contact_identity_id: string | null }>;
};

integrationDescribe("persistRunIdentities under real ingest_rw", () => {
  let db: SyntheticDatabase | undefined;
  let seed: CrmSeed;
  const ns = "ps";
  const con = (n: number) => contactIdentityId(ns, n);
  const fixtureRuns = loadMachineExportFixture().vectors.map((v) => v.run_id);
  const extraRuns = [syntheticRunId(2, 1), syntheticRunId(2, 2)];
  const allRuns = [...fixtureRuns, ...extraRuns];

  const persist = (observations: RunIdentityObservation[]) =>
    db!.ingest.$transaction((tx) => persistRunIdentities(tx, observations), { timeout: 20_000 });

  async function snapshot(runId: string): Promise<SnapshotRow | undefined> {
    const [row] = await db!.ingest.$queryRaw<SnapshotRow[]>`
      SELECT identity_version::text, decision_state, decision_id, people_ids, consumer_revision, review_state,
             quarantine_reason, quarantined_identity_version::text, last_observed_availability
        FROM mirror.acat_asset_map_run_identity WHERE run_id = ${runId}`;
    return row;
  }
  const members = (runId: string) => db!.ingest.$queryRaw<MemberRow[]>`
    SELECT cedar_ridge_user_id, membership_state, first_identity_version::text, active_since_identity_version::text,
           last_confirmed_identity_version::text, retired_identity_version::text, resolution_outcome,
           canonical_contact_identity_id, canonical_contact_source_key
      FROM mirror.acat_asset_map_run_person WHERE run_id = ${runId} ORDER BY cedar_ridge_user_id COLLATE "C"`;
  const history = (runId: string) => db!.ingest.$queryRaw<HistoryRow[]>`
    SELECT consumer_revision, identity_version::text, people_ids, source_changed, resolution_changed, resolutions
      FROM mirror.acat_asset_map_run_identity_history WHERE run_id = ${runId} ORDER BY consumer_revision`;

  beforeAll(async () => {
    db = await connectSyntheticDatabase();
    seed = new CrmSeed(db, ns, 0x270200000);
    await cleanupRuns(db, allRuns);
    await seed.cleanup();
  });

  beforeEach(async () => {
    await cleanupRuns(db!, allRuns);
    await seed.cleanup();
    await seedHouseholdRuns(db!, fixtureRuns);
    await seed.contact({ n: 1, cedarRidgeUserId: "cr-solo" });
    await seed.contact({ n: 2, cedarRidgeUserId: "cr-a" });
    await seed.contact({ n: 3, cedarRidgeUserId: "cr-primary" });
    await seed.contact({ n: 4, cedarRidgeUserId: "cr-secondary" });
    await seed.contact({ n: 5, cedarRidgeUserId: "cr-partial" });
    await seed.contact({ n: 6, cedarRidgeUserId: "cr-conflict" });
  });

  afterAll(async () => {
    try {
      if (db) { await cleanupRuns(db, allRuns); await seed.cleanup(); }
    } finally { await disconnectSyntheticDatabase(db); }
  });

  it("stores every fixture vector with truthful membership and provenance (T2.1)", async () => {
    const observations = loadMachineExportFixture().vectors.map((v) => observe(v.name));
    const result = await persist(observations);
    expect(result.counts).toMatchObject({ observed: 8, inserted: 8, historyRows: 8 });

    const [solo, shared, primary, partial, conflict, unreviewed, unlinked, reversal] = fixtureRuns;
    expect(await members(solo)).toEqual([expect.objectContaining({
      cedar_ridge_user_id: "cr-solo", membership_state: "active", first_identity_version: "1",
      resolution_outcome: "resolved", canonical_contact_identity_id: con(1), canonical_contact_source_key: contactKey(ns, 1),
    })]);
    expect((await members(shared)).map((m) => [m.cedar_ridge_user_id, m.resolution_outcome]))
      .toEqual([["cr-a", "resolved"], ["cr-b", "missing"]]);
    expect(await snapshot(shared)).toMatchObject({ people_ids: ["cr-a", "cr-b"], decision_state: "linked" });
    expect((await members(primary)).map((m) => m.cedar_ridge_user_id)).toEqual(["cr-primary", "cr-secondary"]);
    expect(await snapshot(partial)).toMatchObject({ review_state: "partial", people_ids: ["cr-partial"] });
    expect(await members(conflict)).toEqual([expect.objectContaining({
      cedar_ridge_user_id: "cr-conflict", membership_state: "active", resolution_outcome: "conflict",
      canonical_contact_identity_id: null,
    })]);
    for (const run of [unreviewed, unlinked, reversal]) expect(await members(run)).toEqual([]);
    expect(await snapshot(reversal)).toMatchObject({ decision_id: null, decision_state: "unlinked", identity_version: "7" });
    expect((await history(solo)).map((h) => [h.consumer_revision, h.source_changed])).toEqual([[1, true]]);
  });

  it("is idempotent on identical replay: no duplicate members or history (T2.4)", async () => {
    const observations = loadMachineExportFixture().vectors.map((v) => observe(v.name));
    await persist(observations);
    const replay = await persist(observations);
    expect(replay.counts).toMatchObject({ unchanged: 8, historyRows: 0, membersActivated: 0, membersRetired: 0 });
    const [{ n: memberCount }] = await db!.ingest.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM mirror.acat_asset_map_run_person WHERE run_id IN (${Prisma.join(fixtureRuns)})`;
    expect(Number(memberCount)).toBe(7);
    for (const run of fixtureRuns) expect(await history(run)).toHaveLength(1);
  });

  it("rejects older versions and quarantines equal-version payload changes (T2.4)", async () => {
    await persist([observe("explicit_primary")]);
    const run = fixtureRuns[2];
    const stale = await persist([observe("explicit_primary", {
      identity_version: 2, people_ids: ["cr-primary"], cedar_ridge_user_id: "cr-primary",
    })]);
    expect(stale.runs[0].source).toBe("stale_rejected");
    const mutated = await persist([observe("explicit_primary", { decision_id: "abababab-abab-4bab-8bab-abababababab" })]);
    expect(mutated.runs[0].source).toBe("quarantined_equal_version");
    expect(await snapshot(run)).toMatchObject({
      identity_version: "3", people_ids: ["cr-primary", "cr-secondary"],
      quarantine_reason: "equal_version_mutation", quarantined_identity_version: "3",
    });
    expect((await members(run)).every((m) => m.membership_state === "active")).toBe(true);
    expect(await history(run)).toHaveLength(1);
  });

  it("retires removed members on a newer correction and keeps history (T2.4)", async () => {
    await persist([observe("explicit_primary")]);
    const run = fixtureRuns[2];
    const result = await persist([observe("explicit_primary", { identity_version: 4, people_ids: ["cr-primary"] })]);
    expect(result.runs[0]).toMatchObject({ source: "source_applied", consumerRevision: 2, historyWritten: true });
    expect(await members(run)).toEqual([
      expect.objectContaining({ cedar_ridge_user_id: "cr-primary", membership_state: "active", last_confirmed_identity_version: "4" }),
      expect.objectContaining({
        cedar_ridge_user_id: "cr-secondary", membership_state: "retired", retired_identity_version: "4",
        resolution_outcome: null, canonical_contact_identity_id: null,
      }),
    ]);
    expect((await history(run)).map((h) => [h.identity_version, h.people_ids]))
      .toEqual([["3", ["cr-primary", "cr-secondary"]], ["4", ["cr-primary"]]]);
    expect(await snapshot(run)).toMatchObject({ quarantine_reason: null });
  });

  it("clears membership on first-confirmation reversal and reactivates without duplicates (T2.4)", async () => {
    const run = fixtureRuns[0];
    await persist([observe("singleton")]);
    const reversal = await persist([observe("first_confirmation_reversal", {}, run)]);
    expect(reversal.runs[0].source).toBe("source_applied");
    expect(await snapshot(run)).toMatchObject({ decision_state: "unlinked", decision_id: null, people_ids: [] });
    expect(await members(run)).toEqual([expect.objectContaining({ membership_state: "retired", retired_identity_version: "7" })]);
    await persist([observe("singleton", { identity_version: 8 })]);
    expect(await members(run)).toEqual([expect.objectContaining({
      membership_state: "active", first_identity_version: "1", active_since_identity_version: "8", retired_identity_version: null,
    })]);
    expect((await history(run)).map((h) => h.identity_version)).toEqual(["1", "7", "8"]);
  });

  it("never lets unreviewed silently clear accepted data (T2.4)", async () => {
    const run = fixtureRuns[1];
    await persist([observe("shared_no_primary")]);
    const later = await persist([observe("unreviewed", { identity_version: 99 }, run)]);
    expect(later.runs[0].source).toBe("quarantined_unreviewed");
    expect(await snapshot(run)).toMatchObject({
      decision_state: "linked", people_ids: ["cr-a", "cr-b"], quarantine_reason: "unreviewed_after_accepted",
    });
    expect((await members(run)).filter((m) => m.membership_state === "active")).toHaveLength(2);
  });

  it("preserves accepted state when the source is unavailable", async () => {
    const run = fixtureRuns[0];
    await persist([observe("singleton")]);
    const result = await persist([unavailable(run), unavailable(syntheticRunId(2, 9))]);
    expect(result.counts).toMatchObject({ unavailablePreserved: 2, historyRows: 0 });
    expect(await snapshot(run)).toMatchObject({ people_ids: ["cr-solo"], last_observed_availability: "unavailable" });
    expect(await members(run)).toEqual([expect.objectContaining({ membership_state: "active", resolution_outcome: "resolved" })]);
  });

  it("creates a consumer revision when only CRM resolution changes (T2.5)", async () => {
    const run = fixtureRuns[1];
    await persist([observe("shared_no_primary")]);
    await seed.contact({ n: 7, cedarRidgeUserId: "cr-b" });
    const replay = await persist([observe("shared_no_primary")]);
    expect(replay.runs[0]).toMatchObject({ source: "unchanged", resolutionChanged: true, consumerRevision: 2 });
    expect(await snapshot(run)).toMatchObject({ identity_version: "2", consumer_revision: 2 });
    const rows = await history(run);
    expect(rows.map((h) => [h.consumer_revision, h.identity_version, h.source_changed, h.resolution_changed]))
      .toEqual([[1, "2", true, true], [2, "2", false, true]]);
    expect(rows[1].resolutions.find((r) => r.cedar_ridge_user_id === "cr-b"))
      .toMatchObject({ outcome: "resolved", canonical_contact_identity_id: con(7) });
  });

  it("refreshes or clears targets on merge, reopen and revocation without deleting membership (T2.5)", async () => {
    const run = fixtureRuns[0];
    await persist([observe("singleton")]);
    expect((await members(run))[0].canonical_contact_identity_id).toBe(con(1));

    await seed.contact({ n: 8, cedarRidgeUserId: "cr-solo" });
    const merge = await seed.edge({ from: 1, to: 8 });
    await persist([observe("singleton")]);
    expect((await members(run))[0]).toMatchObject({ resolution_outcome: "resolved", canonical_contact_identity_id: con(8) });

    await seed.reopen(merge);
    await persist([observe("singleton")]);
    expect((await members(run))[0]).toMatchObject({
      membership_state: "active", resolution_outcome: "ambiguous", canonical_contact_identity_id: null,
    });

    await seed.setCedarRidgeUserId(1, null);
    await seed.setCedarRidgeUserId(8, null);
    await persist([observe("singleton")]);
    expect((await members(run))[0]).toMatchObject({
      membership_state: "active", resolution_outcome: "missing", canonical_contact_identity_id: null,
    });
    expect((await history(run)).map((h) => h.consumer_revision)).toEqual([1, 2, 3, 4]);
  });

  it("blocks derived use for a source conflict and restores it when the conflict clears (T2.5)", async () => {
    const run = fixtureRuns[4];
    await persist([observe("conflict")]);
    expect((await members(run))[0]).toMatchObject({ resolution_outcome: "conflict", canonical_contact_identity_id: null });
    await persist([observe("conflict", { identity_version: 6, conflict_flags: [], review_state: "complete" })]);
    expect((await members(run))[0]).toMatchObject({ resolution_outcome: "resolved", canonical_contact_identity_id: con(6) });
  });

  it("skips runs whose parent household is absent and rejects duplicate batches", async () => {
    const orphan = syntheticRunId(2, 1);
    const result = await persist([observe("singleton", {}, orphan)]);
    expect(result.runs[0]).toMatchObject({ source: "missing_parent", consumerRevision: null });
    expect(await snapshot(orphan)).toBeUndefined();
    await expect(persist([observe("singleton"), observe("singleton")])).rejects.toBeInstanceOf(RunIdentityPersistenceError);
  });

  it("writes all affected runs atomically inside the caller transaction (T2.6)", async () => {
    await expect(db!.ingest.$transaction(async (tx) => {
      await persistRunIdentities(tx, [observe("singleton"), observe("shared_no_primary")]);
      throw new Error("caller audit failed");
    })).rejects.toThrow("caller audit failed");
    for (const run of fixtureRuns.slice(0, 2)) {
      expect(await snapshot(run)).toBeUndefined();
      expect(await members(run)).toEqual([]);
      expect(await history(run)).toEqual([]);
    }
  });

  it("locks before re-reading so a stale worker cannot overwrite a newer result (T2.6)", async () => {
    const run = fixtureRuns[2];
    const second = new PrismaClient({ datasourceUrl: db!.urls.ingest });
    try {
      await persist([observe("explicit_primary")]);
      let release!: () => void;
      let persisted!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const holding = new Promise<void>((resolve) => { persisted = resolve; });
      const newer = db!.ingest.$transaction(async (tx) => {
        const result = await persistRunIdentities(tx, [observe("explicit_primary", { identity_version: 5, people_ids: ["cr-primary"] })]);
        persisted();
        await gate;
        return result;
      }, { timeout: 20_000 });
      await holding;
      const stale = second.$transaction((tx) => persistRunIdentities(tx, [observe("explicit_primary", { identity_version: 4 })]),
        { timeout: 20_000 });
      await waitForAdvisoryWaiter(db!);
      // CRM changes while the stale worker waits; it must use the post-lock state.
      await seed.contact({ n: 9, cedarRidgeUserId: "cr-primary" });
      release();
      expect((await newer).runs[0].source).toBe("source_applied");
      const staleResult = await stale;
      expect(staleResult.runs[0]).toMatchObject({ source: "stale_rejected", resolutionChanged: true });
      expect(await snapshot(run)).toMatchObject({ identity_version: "5", people_ids: ["cr-primary"] });
      expect((await members(run)).find((m) => m.cedar_ridge_user_id === "cr-primary"))
        .toMatchObject({ resolution_outcome: "ambiguous" });
    } finally {
      await second.$disconnect();
    }
  });
});
