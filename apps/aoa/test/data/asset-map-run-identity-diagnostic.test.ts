import { beforeEach, describe, expect, it, vi } from "vitest";

// ticket aggregate diagnostics. The read path runs for real (contract,
// persistence planning and the checked resolver) against a READ ONLY fake that
// rejects every write. Persisted rows are seeded directly. All data is invented.

vi.mock("server-only", () => ({}));

const { scopeRef } = vi.hoisted(() => ({
  scopeRef: { current: null as null | ((fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>) },
}));
vi.mock("@/lib/ingest/scope", () => ({
  withIngestScope: (fn: (tx: unknown) => Promise<unknown>) => scopeRef.current!(fn),
}));

import { identityPayloadDigest, parseRunIdentity, type AvailableRunIdentity } from "@/lib/data/asset-map-run-identity/contract";
import {
  diagnoseRunIdentities,
  diagnosticEquationsHold,
  type RunIdentityDiagnostics,
} from "@/lib/data/asset-map-run-identity/diagnostic";
import { deriveMemberResolutions, resolutionDigest } from "@/lib/data/asset-map-run-identity/persistence";
import type { RunPersonResolution } from "@/lib/data/asset-map-run-identity/resolver";
import { buildIdentityCensus, type IdentityCensus } from "@/lib/data/asset-map-run-identity/sync";
import { clientLink } from "../asset-map-run-identity/fixtures";

type Target = { outcome: string; id: string | null; key: string | null };
type MemberSeed = { run_id: string; cedar_ridge_user_id: string; membership_state: "active" | "retired"; resolution_outcome: string | null; canonical_contact_identity_id: string | null; canonical_contact_source_key: string | null };

/** The invented CRM source key the fake resolver returns for target n. */
const invKey = (n: number) => `003INV${String(n).padStart(12, "0")}`;

class ReadOnlyFake {
  households = new Set<string>();
  snapshots: Array<Record<string, unknown>> = [];
  members: MemberSeed[] = [];
  crm = new Map<string, Target>();
  statements: string[] = [];
  failReads = false;
  scopeCalls = 0;

  scope = async (fn: (tx: unknown) => Promise<unknown>) => {
    this.scopeCalls++;
    let readOnly = false;
    const sqlOf = (s: TemplateStringsArray) => s.join("?").replace(/\s+/g, " ").trim();
    const tx = {
      $executeRaw: async (strings: TemplateStringsArray) => {
        const sql = sqlOf(strings);
        this.statements.push(sql);
        if (sql === "SET TRANSACTION READ ONLY" && this.statements.length === 1) {
          readOnly = true;
          return 0;
        }
        throw new Error(`write attempted in diagnostics: ${sql}`);
      },
      $queryRaw: async (strings: TemplateStringsArray, ...v: unknown[]) => {
        const sql = sqlOf(strings);
        this.statements.push(sql);
        if (!readOnly) throw new Error("read before READ ONLY");
        if (this.failReads) throw new Error("permission denied");
        if (/FOR UPDATE/i.test(sql)) throw new Error("row lock in a read-only transaction");
        const ids = new Set(v[0] as string[]);
        if (sql.includes("resolve_asset_map_run_people")) {
          return (v[0] as string[]).map((id) => {
            const t = this.crm.get(id) ?? { outcome: "missing", id: null, key: null };
            return { cedar_ridge_user_id: id, outcome: t.outcome, canonical_contact_identity_id: t.id, canonical_contact_source_key: t.key };
          });
        }
        if (sql.includes("FROM mirror.acat_asset_map_household")) return [...this.households].filter((id) => ids.has(id)).map((id) => ({ id }));
        if (sql.includes("FROM mirror.acat_asset_map_run_identity")) return this.snapshots.filter((r) => ids.has(r.run_id as string));
        if (sql.includes("FROM mirror.acat_asset_map_run_person")) return this.members.filter((r) => ids.has(r.run_id));
        throw new Error(`unexpected query: ${sql}`);
      },
      auditLog: { create: async () => { throw new Error("audit attempted in diagnostics"); } },
    };
    return fn(tx);
  };

  target(eg: string, outcome: "resolved" | "ambiguous" | "conflict", n = 0) {
    this.crm.set(eg, outcome === "resolved" ? { outcome, id: `con_inv${n}`, key: invKey(n) } : { outcome, id: null, key: null });
  }

  /** Seed a persisted snapshot + active members exactly as the writer would have stored them. */
  persist(runId: string, link: Record<string, unknown>, stored: Map<string, RunPersonResolution>) {
    const parsed = parseRunIdentity(runId, link);
    if (!parsed.ok || parsed.value.availability !== "available") throw new Error("seed invalid");
    const identity = parsed.value as AvailableRunIdentity;
    const members = deriveMemberResolutions(identity, stored);
    this.snapshots.push({
      run_id: runId, identity_version: String(identity.identityVersion), payload_digest: identityPayloadDigest(identity),
      decision_id: identity.decisionId, decision_state: identity.decisionState, coverage: identity.coverage,
      people_ids: identity.peopleIds, primary_user_id: identity.primaryUserId, cedar_ridge_user_id: identity.cedarRidgeUserId,
      review_state: identity.reviewState, conflict_flags: identity.conflictFlags, resolution_digest: resolutionDigest(members),
    });
    for (const m of members) {
      this.members.push({
        run_id: runId, cedar_ridge_user_id: m.cedarRidgeUserId, membership_state: "active", resolution_outcome: m.outcome,
        canonical_contact_identity_id: m.canonicalContactIdentityId, canonical_contact_source_key: m.canonicalContactSourceKey,
      });
    }
  }
}

const run = (n: number) => `02710000-0000-4000-8000-${(0xd00 + n).toString(16).padStart(12, "0")}`;
const linked = (people: string[], version: number, extra: Record<string, unknown> = {}) =>
  clientLink("shared_no_primary", {
    people_ids: people, identity_version: version, coverage: "complete",
    cedar_ridge_user_id: people.length === 1 ? people[0] : null, ...extra,
  });
const household = (id: string, link?: unknown) => (link === undefined ? { id } : { id, client_link: link });
const census = (households: unknown[]): IdentityCensus => buildIdentityCensus(
  [{ requestedPage: 1, requestedPerPage: 200, envelope: { page: 1, per_page: 200, total: households.length, households_is_array: true }, households }],
  { maxPages: 50 },
);
const missingTarget = (eg: string): RunPersonResolution => ({ cedarRidgeUserId: eg, outcome: "missing", canonicalContactIdentityId: null, canonicalContactSourceKey: null });

let fake: ReadOnlyFake;
beforeEach(() => {
  fake = new ReadOnlyFake();
  scopeRef.current = fake.scope;
});

const preview = (c: IdentityCensus, pulled: string[] = [], dryRun = true) =>
  diagnoseRunIdentities(c, { mode: "preview", dryRun, pulledRunIds: new Set(pulled) });

function assertNoIdentifiers(d: RunIdentityDiagnostics) {
  expect(JSON.stringify(d)).not.toMatch(/cr-|con_inv|003INV|02710000|folder|Synthetic/);
}

describe("T3.5 diagnoseRunIdentities — counts reconcile the whole observed population", () => {
  it("reports every category, satisfies the equations and contains no identifiers", async () => {
    for (let n = 1; n <= 10; n++) fake.households.add(run(n));
    fake.target("cr-res", "resolved", 1);
    fake.target("cr-amb", "ambiguous");
    fake.target("cr-crm", "conflict");
    const c = census([
      household(run(1), linked(["cr-amb", "cr-crm", "cr-miss", "cr-res"], 1)),
      household(run(2), clientLink("conflict")),
      household(run(3), clientLink("explicit_unlinked")),
      household(run(4), clientLink("unreviewed")),
      household(run(5), { schema_version: 1, availability: "unavailable", reason: "client_linking_disabled" }),
      household(run(6)),
      household(run(7), { ...linked(["cr-res"], 1), schema_version: 2 }),
      household(run(8), { ...linked(["cr-res"], 1), review_state: "partial" }),
    ]);
    const d = await preview(c);
    expect(d).toMatchObject({
      mode: "preview",
      dryRun: true,
      schemaStatus: "mixed",
      census: { complete: true, reasons: [], pages: 1, total: 8 },
      runs: {
        observed: 8, available: 4, unavailable: 3, quarantined: 1,
        unavailableBreakdown: { disabled: 1, missing: 1, unsupported: 1 },
        linked: 2, unlinked: 1, unreviewed: 1,
      },
      people: { status: "available", accepted: 5, resolved: 1, missing: 1, ambiguous: 1, sourceConflict: 1, crmConflict: 1 },
      plan: {
        status: "available", wouldAdd: 5, wouldRetire: 0, wouldRemap: 0, unchanged: 0, persistedDrift: 0,
        transitions: { inserted: 4, unavailable_preserved: 1 },
      },
    });
    expect(diagnosticEquationsHold(d)).toBe(true);
    expect(typeof d.timingMs).toBe("number");
    assertNoIdentifiers(d);
  });

  it("separates no-ID prospects (empty accepted sets) from resolver outcomes", async () => {
    fake.households.add(run(1)).add(run(2));
    const d = await preview(census([household(run(1), clientLink("unreviewed")), household(run(2), clientLink("first_confirmation_reversal"))]));
    expect(d.runs).toMatchObject({ unreviewed: 1, unlinked: 1, linked: 0 });
    expect(d.people).toMatchObject({ accepted: 0, missing: 0, ambiguous: 0, crmConflict: 0 });
  });

  it("shows planned vs persisted changes: add, retire, remap, unchanged and persisted drift", async () => {
    for (let n = 1; n <= 4; n++) fake.households.add(run(n));
    // run1: persisted {a,b}; source v2 drops b and adds c → add c, retire b, a unchanged.
    fake.target("cr-a", "resolved", 1);
    fake.target("cr-b", "resolved", 2);
    fake.target("cr-c", "resolved", 3);
    fake.persist(run(1), linked(["cr-a", "cr-b"], 1), new Map([
      ["cr-a", { cedarRidgeUserId: "cr-a", outcome: "resolved", canonicalContactIdentityId: "con_inv1", canonicalContactSourceKey: invKey(1) }],
      ["cr-b", { cedarRidgeUserId: "cr-b", outcome: "resolved", canonicalContactIdentityId: "con_inv2", canonicalContactSourceKey: invKey(2) }],
    ]));
    // run2: same version, stored as missing; CRM now resolves it → remap + drift.
    fake.target("cr-d", "resolved", 4);
    fake.persist(run(2), linked(["cr-d"], 5), new Map([["cr-d", missingTarget("cr-d")]]));
    // run3: same version but different payload → quarantined, prior kept unchanged.
    fake.target("cr-e", "resolved", 5);
    fake.persist(run(3), linked(["cr-e"], 2), new Map([["cr-e", { cedarRidgeUserId: "cr-e", outcome: "resolved", canonicalContactIdentityId: "con_inv5", canonicalContactSourceKey: invKey(5) }]]));
    // run4: older version arrives → stale, prior kept.
    fake.persist(run(4), linked(["cr-a"], 7), new Map([["cr-a", { cedarRidgeUserId: "cr-a", outcome: "resolved", canonicalContactIdentityId: "con_inv1", canonicalContactSourceKey: invKey(1) }]]));

    const d = await preview(census([
      household(run(1), linked(["cr-a", "cr-c"], 2)),
      household(run(2), linked(["cr-d"], 5)),
      household(run(3), linked(["cr-e", "cr-f"], 2)),
      household(run(4), linked(["cr-a"], 6)),
    ]), [], false);
    expect(d.plan).toMatchObject({
      status: "available", wouldAdd: 1, wouldRetire: 1, wouldRemap: 1, unchanged: 3, persistedDrift: 1,
      transitions: { source_applied: 1, unchanged: 1, quarantined_equal_version: 1, stale_rejected: 1 },
    });
    expect(d.dryRun).toBe(false);
    expect(diagnosticEquationsHold(d)).toBe(true);
    assertNoIdentifiers(d);
  });

  it("dry-run treats runs pulled in this request as parents; others are missing_parent", async () => {
    const c = census([household(run(1), linked(["cr-a"], 1)), household(run(2), linked(["cr-a"], 1))]);
    const d = await preview(c, [run(1)]);
    expect(d.plan).toMatchObject({ transitions: { inserted: 1, missing_parent: 1 }, wouldAdd: 1 });
  });
});

describe("T3.1/T3.5 diagnostics never write and never guess", () => {
  it("opens a READ ONLY transaction first and issues no write, lock or audit", async () => {
    fake.households.add(run(1));
    await preview(census([household(run(1), linked(["cr-a"], 1))]));
    expect(fake.statements[0]).toBe("SET TRANSACTION READ ONLY");
    expect(fake.statements.slice(1).every((s) => s.startsWith("SELECT"))).toBe(true);
    expect(fake.statements.some((s) => /advisory|INSERT|UPDATE|DELETE/i.test(s))).toBe(false);
  });

  it("an incomplete census reports people/plan unavailable without reading the database", async () => {
    const c = buildIdentityCensus(
      [{ requestedPage: 1, requestedPerPage: 2, envelope: { page: 1, per_page: 2, total: 5, households_is_array: true }, households: [household(run(1), linked(["cr-a"], 1))] }],
      { maxPages: 50 },
    );
    const d = await preview(c);
    expect(d.census).toEqual({ complete: false, reasons: ["short_page"], pages: 1, total: 5 });
    expect(d.people).toEqual({ status: "unavailable", reason: "census_incomplete" });
    expect(d.plan).toEqual({ status: "unavailable", reason: "census_incomplete" });
    expect(fake.scopeCalls).toBe(0);
    expect(diagnosticEquationsHold(d)).toBe(true);
  });

  it("a read/permission failure is reported unavailable, not as missing clients", async () => {
    fake.failReads = true;
    const d = await preview(census([household(run(1), linked(["cr-a"], 1))]));
    expect(d.people).toEqual({ status: "unavailable", reason: "read_failed" });
    expect(d.plan).toEqual({ status: "unavailable", reason: "read_failed" });
    expect(d.runs.linked).toBe(1);
  });

  it("an empty census is complete with zero counts", async () => {
    const d = await preview(census([]));
    expect(d.schemaStatus).toBe("no_runs");
    expect(d.people).toMatchObject({ status: "available", accepted: 0 });
    expect(d.plan).toMatchObject({ status: "available", wouldAdd: 0, wouldRetire: 0 });
  });
});

describe("diagnosticEquationsHold", () => {
  it("rejects a report whose counts do not reconcile", async () => {
    fake.households.add(run(1));
    const d = await preview(census([household(run(1), linked(["cr-a"], 1))]));
    expect(diagnosticEquationsHold(d)).toBe(true);
    expect(diagnosticEquationsHold({ ...d, runs: { ...d.runs, observed: d.runs.observed + 1 } })).toBe(false);
    expect(diagnosticEquationsHold({ ...d, runs: { ...d.runs, linked: d.runs.linked + 1 } })).toBe(false);
    if (d.people.status !== "available") throw new Error("expected people");
    expect(diagnosticEquationsHold({ ...d, people: { ...d.people, accepted: d.people.accepted + 1 } })).toBe(false);
  });
});
