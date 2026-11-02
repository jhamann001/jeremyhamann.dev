import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ticket sync tests. The landed ticket persistence + resolver modules run
// for real against an in-memory transactional fake of the three identity
// tables: the advisory lock is a mutex, writes are only legal after it, a
// transaction commits or rolls back as a unit, and history keeps its
// (run_id, consumer_revision) uniqueness. CRM targets are read at the moment
// the resolver statement executes, i.e. after the lock. All data is invented.

vi.mock("server-only", () => ({}));

const { scopeRef } = vi.hoisted(() => ({
  scopeRef: { current: null as null | ((fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>) },
}));
vi.mock("@/lib/ingest/scope", () => ({
  withIngestScope: (fn: (tx: unknown) => Promise<unknown>) => scopeRef.current!(fn),
}));

import { INGEST_ASSET_MAP_RUN_IDENTITY } from "@/lib/audit";
import type { HouseholdsEnvelope } from "@/lib/data/asset-map";
import {
  applyRunIdentities,
  buildIdentityCensus,
  identityStateChanged,
  runIdentityMode,
  type CensusPage,
  type IdentityCensus,
} from "@/lib/data/asset-map-run-identity/sync";
import { clientLink } from "../asset-map-run-identity/fixtures";

// ---------------------------------------------------------------------------
// In-memory transactional fake
// ---------------------------------------------------------------------------

type Snapshot = {
  run_id: string;
  identity_version: string;
  payload_digest: string;
  decision_id: string | null;
  decision_state: string;
  coverage: string;
  people_ids: string[];
  primary_user_id: string | null;
  cedar_ridge_user_id: string | null;
  review_state: string;
  conflict_flags: string[];
  consumer_revision: number;
  resolution_digest: string;
  quarantine_reason: string | null;
  last_observed_availability: string;
};
type Member = {
  run_id: string;
  cedar_ridge_user_id: string;
  membership_state: "active" | "retired";
  resolution_outcome: string | null;
  canonical_contact_identity_id: string | null;
  canonical_contact_source_key: string | null;
};
type State = {
  households: Set<string>;
  identities: Map<string, Snapshot>;
  members: Map<string, Member>;
  history: Array<{ run_id: string; consumer_revision: number; source_changed: boolean; resolution_changed: boolean }>;
  audits: Array<{ action: string; detail: Record<string, unknown> }>;
};
type CrmTarget = { outcome: string; id: string | null; key: string | null };

const clone = (s: State): State => ({
  households: new Set(s.households),
  identities: new Map([...s.identities].map(([k, v]) => [k, { ...v, people_ids: [...v.people_ids], conflict_flags: [...v.conflict_flags] }])),
  members: new Map([...s.members].map(([k, v]) => [k, { ...v }])),
  history: s.history.map((h) => ({ ...h })),
  audits: s.audits.map((a) => ({ ...a })),
});

class FakeDb {
  committed: State = { households: new Set(), identities: new Map(), members: new Map(), history: [], audits: [] };
  crm = new Map<string, CrmTarget>();
  events: string[] = [];
  failAt: null | "history" | "audit" | "member" = null;
  resolverMalformed = false;
  beforeResolve: null | (() => Promise<void>) = null;
  scopeCalls = 0;
  private lockTail: Promise<void> = Promise.resolve();

  resolved(eg: string, n: number) {
    this.crm.set(eg, { outcome: "resolved", id: `con_inv${n}`, key: `003INV${String(n).padStart(12, "0")}` });
  }

  scope = async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    this.scopeCalls++;
    const worker = this.scopeCalls;
    let local: State | null = null;
    let release: (() => void) | null = null;
    const sqlOf = (strings: TemplateStringsArray) => strings.join("?").replace(/\s+/g, " ");
    const requireLock = (what: string) => {
      if (!local) throw new Error(`${what} before the identity lock`);
      return local;
    };
    const maybeFail = (point: "history" | "audit" | "member") => {
      if (this.failAt === point) throw new Error(`injected ${point} failure`);
    };
    const tx = {
      $executeRaw: async (strings: TemplateStringsArray, ...v: unknown[]) => {
        const sql = sqlOf(strings);
        if (sql.includes("pg_advisory_xact_lock")) {
          const prior = this.lockTail;
          let mine!: () => void;
          this.lockTail = new Promise<void>((r) => (mine = r));
          await prior;
          release = mine;
          local = clone(this.committed);
          this.events.push(`w${worker}:lock`);
          return 1;
        }
        const s = requireLock("write");
        if (sql.includes("INSERT INTO mirror.acat_asset_map_run_identity_history")) {
          maybeFail("history");
          const [run_id, consumer_revision] = v as [string, number];
          if (s.history.some((h) => h.run_id === run_id && h.consumer_revision === consumer_revision)) {
            throw new Error("history primary key violation");
          }
          s.history.push({ run_id, consumer_revision, source_changed: v[14] as boolean, resolution_changed: v[15] as boolean });
          return 1;
        }
        if (sql.includes("INSERT INTO mirror.acat_asset_map_run_identity")) {
          const runId = v[0] as string;
          if (s.identities.has(runId)) throw new Error("run identity primary key violation");
          s.identities.set(runId, {
            run_id: runId, identity_version: String(v[1]), payload_digest: v[2] as string, decision_id: v[3] as string | null,
            decision_state: v[4] as string, coverage: v[5] as string, people_ids: [...(v[6] as string[])],
            primary_user_id: v[7] as string | null, cedar_ridge_user_id: v[8] as string | null, review_state: v[9] as string,
            conflict_flags: [...(v[10] as string[])], consumer_revision: v[11] as number, resolution_digest: v[12] as string,
            quarantine_reason: null, last_observed_availability: "available",
          });
          this.events.push(`w${worker}:write`);
          return 1;
        }
        if (sql.includes("UPDATE mirror.acat_asset_map_run_identity SET")) {
          const runId = v[v.length - 1] as string;
          const row = s.identities.get(runId)!;
          const sourceChanged = v[12] as boolean;
          const quarantine = v[17] as string | null;
          s.identities.set(runId, {
            ...row, identity_version: String(v[0]), payload_digest: v[1] as string, decision_id: v[2] as string | null,
            decision_state: v[3] as string, coverage: v[4] as string, people_ids: [...(v[5] as string[])],
            primary_user_id: v[6] as string | null, cedar_ridge_user_id: v[7] as string | null, review_state: v[8] as string,
            conflict_flags: [...(v[9] as string[])], consumer_revision: v[10] as number, resolution_digest: v[11] as string,
            last_observed_availability: (v[13] as boolean) ? (v[14] as string) : row.last_observed_availability,
            quarantine_reason: sourceChanged ? null : quarantine !== null ? quarantine : row.quarantine_reason,
          });
          this.events.push(`w${worker}:write`);
          return 1;
        }
        if (sql.includes("INSERT INTO mirror.acat_asset_map_run_person")) {
          maybeFail("member");
          const [run_id, eg] = v as [string, string];
          s.members.set(`${run_id}|${eg}`, {
            run_id, cedar_ridge_user_id: eg, membership_state: "active", resolution_outcome: v[5] as string,
            canonical_contact_identity_id: v[6] as string | null, canonical_contact_source_key: v[7] as string | null,
          });
          return 1;
        }
        if (sql.includes("UPDATE mirror.acat_asset_map_run_person SET")) {
          const key = `${v[v.length - 2]}|${v[v.length - 1]}`;
          const row = s.members.get(key)!;
          if (sql.includes("membership_state = 'retired'")) {
            s.members.set(key, { ...row, membership_state: "retired", resolution_outcome: null, canonical_contact_identity_id: null, canonical_contact_source_key: null });
          } else if (sql.includes("membership_state = 'active'")) {
            s.members.set(key, { ...row, membership_state: "active", resolution_outcome: v[2] as string, canonical_contact_identity_id: v[3] as string | null, canonical_contact_source_key: v[4] as string | null });
          } else {
            s.members.set(key, { ...row, resolution_outcome: v[2] as string, canonical_contact_identity_id: v[3] as string | null, canonical_contact_source_key: v[4] as string | null });
          }
          return 1;
        }
        throw new Error(`unexpected statement: ${sql}`);
      },
      $queryRaw: async (strings: TemplateStringsArray, ...v: unknown[]) => {
        const sql = sqlOf(strings);
        const s = requireLock("identity read");
        this.events.push(`w${worker}:read`);
        if (sql.includes("resolve_asset_map_run_people")) {
          const rows = (v[0] as string[]).map((id) => {
            if (this.resolverMalformed) return { cedar_ridge_user_id: id, outcome: "guess", canonical_contact_identity_id: null, canonical_contact_source_key: null };
            const target = this.crm.get(id) ?? { outcome: "missing", id: null, key: null };
            return { cedar_ridge_user_id: id, outcome: target.outcome, canonical_contact_identity_id: target.id, canonical_contact_source_key: target.key };
          });
          if (this.beforeResolve) await this.beforeResolve();
          return rows;
        }
        const ids = new Set(v[0] as string[]);
        if (sql.includes("FROM mirror.acat_asset_map_household")) return [...s.households].filter((id) => ids.has(id)).map((id) => ({ id }));
        if (sql.includes("FROM mirror.acat_asset_map_run_identity")) return [...s.identities.values()].filter((r) => ids.has(r.run_id)).map((r) => ({ ...r }));
        if (sql.includes("FROM mirror.acat_asset_map_run_person")) return [...s.members.values()].filter((r) => ids.has(r.run_id)).map((r) => ({ ...r }));
        throw new Error(`unexpected query: ${sql}`);
      },
      auditLog: {
        create: async ({ data }: { data: { action: string; detail: string } }) => {
          const s = requireLock("audit");
          maybeFail("audit");
          s.audits.push({ action: data.action, detail: JSON.parse(data.detail) });
        },
      },
    };
    try {
      const result = await fn(tx);
      if (local) this.committed = local;
      this.events.push(`w${worker}:commit`);
      return result;
    } catch (e) {
      this.events.push(`w${worker}:rollback`);
      throw e;
    } finally {
      (release as (() => void) | null)?.();
    }
  };

  activeMembers(runId: string) {
    return [...this.committed.members.values()].filter((m) => m.run_id === runId && m.membership_state === "active");
  }
}

// ---------------------------------------------------------------------------
// Invented census builders
// ---------------------------------------------------------------------------

const run = (n: number) => `02710000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const RUN_A = run(1);
const RUN_B = run(2);
const RUN_C = run(3);
const META = { runId: "invented-import-run", source: "statement-pipeline", endpoint: "/api/v1/households" };

const envelope = (page: number, perPage: number, total: number): HouseholdsEnvelope =>
  ({ page, per_page: perPage, total, households_is_array: true });
const household = (id: unknown, link?: unknown, extra: Record<string, unknown> = {}) =>
  (link === undefined ? { id, accounts: [], ...extra } : { id, accounts: [], client_link: link, ...extra });
const page = (n: number, perPage: number, total: number, households: unknown[], env?: Partial<HouseholdsEnvelope>): CensusPage =>
  ({ requestedPage: n, requestedPerPage: perPage, envelope: { ...envelope(n, perPage, total), ...env }, households });
const census = (households: unknown[]): IdentityCensus =>
  buildIdentityCensus([page(1, 200, households.length, households)], { maxPages: 50 });

const linked = (people: string[], version: number, decision = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") =>
  clientLink("shared_no_primary", {
    people_ids: people, identity_version: version, decision_id: decision,
    coverage: "complete", cedar_ridge_user_id: people.length === 1 ? people[0] : null,
  });
const unlinked = (version: number) => clientLink("explicit_unlinked", { identity_version: version });
const unreviewed = (version: number) => clientLink("unreviewed", { identity_version: version });
const disabled = () => ({ schema_version: 1, availability: "unavailable", reason: "client_linking_disabled" });

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb();
  db.committed.households = new Set([RUN_A, RUN_B, RUN_C]);
  scopeRef.current = db.scope;
});

// ---------------------------------------------------------------------------

describe("T3.1 runIdentityMode", () => {
  const keys = ["ASSET_MAP_RUN_IDENTITY_ENABLED", "ASSET_MAP_RUN_IDENTITY_WRITES_ENABLED"] as const;
  const saved = keys.map((k) => process.env[k]);
  afterEach(() => keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i]))));

  it("is off by default, preview with the parent only, write with both", () => {
    keys.forEach((k) => delete process.env[k]);
    expect(runIdentityMode()).toBe("off");
    process.env.ASSET_MAP_RUN_IDENTITY_ENABLED = "1";
    expect(runIdentityMode()).toBe("preview");
    process.env.ASSET_MAP_RUN_IDENTITY_WRITES_ENABLED = "1";
    expect(runIdentityMode()).toBe("write");
  });

  it("the writes gate alone, or any non-exact value, never enables identity", () => {
    process.env.ASSET_MAP_RUN_IDENTITY_WRITES_ENABLED = "1";
    for (const value of [undefined, "", "0", "true", "yes", " 1"]) {
      if (value === undefined) delete process.env.ASSET_MAP_RUN_IDENTITY_ENABLED;
      else process.env.ASSET_MAP_RUN_IDENTITY_ENABLED = value;
      expect(runIdentityMode()).toBe("off");
    }
    process.env.ASSET_MAP_RUN_IDENTITY_ENABLED = "1";
    process.env.ASSET_MAP_RUN_IDENTITY_WRITES_ENABLED = "true";
    expect(runIdentityMode()).toBe("preview");
  });
});

describe("T3.2 buildIdentityCensus — strict client_link parsing", () => {
  it("classifies every observed run and only persists available or explicitly disabled runs", () => {
    const c = census([
      household(RUN_A, linked(["cr-inv-1"], 1)),
      household(RUN_B, unlinked(2)),
      household(run(4), unreviewed(0)),
      household(run(5), disabled()),
      household(run(6)),
      household(run(7), { ...linked(["cr-inv-2"], 1), schema_version: 2 }),
      household(run(8), { ...linked(["cr-inv-3"], 1), people_ids: ["cr-inv-3", "cr-inv-3"] }),
    ]);
    expect(c.complete).toBe(true);
    expect(c.runs).toEqual({
      observed: 7, available: 3, unavailable: 3, unavailableDisabled: 1, unavailableMissing: 1,
      unavailableUnsupported: 1, quarantined: 1, linked: 1, unlinked: 1, unreviewed: 1,
    });
    expect(c.runs.observed).toBe(c.runs.available + c.runs.unavailable + c.runs.quarantined);
    expect(c.runs.available).toBe(c.runs.linked + c.runs.unlinked + c.runs.unreviewed);
    expect(c.observations.map((o) => [o.runId, o.availability])).toEqual([
      [RUN_A, "available"], [RUN_B, "available"], [run(4), "available"], [run(5), "unavailable"],
    ]);
    expect(c.schemaStatus).toBe("mixed");
  });

  it("an empty census differs from an unavailable one: neither produces empty membership", () => {
    const empty = buildIdentityCensus([page(1, 200, 0, [])], { maxPages: 50 });
    expect(empty).toMatchObject({ complete: true, schemaStatus: "no_runs", observations: [] });

    const exportOff = census([household(RUN_A), household(RUN_B)]);
    expect(exportOff.complete).toBe(true);
    expect(exportOff.schemaStatus).toBe("absent");
    expect(exportOff.observations).toEqual([]);
    expect(exportOff.runs.unavailableMissing).toBe(2);

    const unsupported = census([household(RUN_A, { ...linked(["cr-inv-1"], 1), schema_version: 2 })]);
    expect(unsupported.schemaStatus).toBe("unsupported");
    expect(unsupported.observations).toEqual([]);

    const linkingDisabled = census([household(RUN_A, disabled())]);
    expect(linkingDisabled.observations).toEqual([
      { runId: RUN_A, schemaVersion: 1, availability: "unavailable", reason: "client_linking_disabled" },
    ]);
  });

  it("includes superseded runs of the same folder as independent observations", () => {
    const c = census([
      household(RUN_A, linked(["cr-old"], 3), { source_folder_id: "folder-inv", superseded_by: RUN_B }),
      household(RUN_B, unreviewed(0), { source_folder_id: "folder-inv", superseded_by: null }),
    ]);
    expect(c.observations.map((o) => o.runId)).toEqual([RUN_A, RUN_B]);
    expect(c.runs).toMatchObject({ linked: 1, unreviewed: 1 });
  });
});

describe("T3.2 buildIdentityCensus — completeness gates", () => {
  const h = (n: number) => household(run(100 + n), linked([`cr-p${n}`], 1));
  const cases: Array<[string, CensusPage[], { truncated?: boolean }, string[]]> = [
    ["complete two-page census", [page(1, 2, 3, [h(1), h(2)]), page(2, 2, 3, [h(3)])], {}, []],
    ["early short page", [page(1, 2, 4, [h(1)]), page(2, 2, 4, [h(2), h(3)])], {}, ["short_page"]],
    ["empty page before total", [page(1, 2, 3, [h(1), h(2)]), page(2, 2, 3, [])], {}, ["short_page"]],
    ["changed total", [page(1, 2, 3, [h(1), h(2)]), page(2, 2, 4, [h(3)])], {}, ["total_changed"]],
    ["conflicting duplicate", [page(1, 2, 3, [h(1), h(2)]), page(2, 2, 3, [household(run(101), linked(["cr-other"], 1))])], {}, ["conflicting_duplicate"]],
    ["identical duplicate", [page(1, 2, 3, [h(1), h(2)]), page(2, 2, 3, [h(2)])], {}, ["duplicate_run"]],
    ["page out of sequence", [page(1, 2, 3, [h(1), h(2)]), page(2, 2, 3, [h(3)], { page: 1 })], {}, ["page_sequence"]],
    ["per_page mismatch", [page(1, 2, 2, [h(1), h(2)], { per_page: 100 })], {}, ["per_page_mismatch"]],
    ["missing total", [page(1, 2, 2, [h(1), h(2)], { total: null })], {}, ["envelope_invalid"]],
    ["households not an array", [page(1, 2, 0, [], { households_is_array: false })], {}, ["envelope_invalid"]],
    ["overfull page", [page(1, 2, 3, [h(1), h(2), h(3)])], {}, ["page_overfull"]],
    ["more rows than total", [page(1, 2, 1, [h(1), h(2)])], {}, ["over_total"]],
    ["invalid run id", [page(1, 2, 1, [household("h-not-a-uuid", linked(["cr-p9"], 1))])], {}, ["invalid_run_id"]],
    ["no pages", [], {}, ["envelope_invalid"]],
  ];
  it.each(cases)("%s", (_name, pages, opts, reasons) => {
    const c = buildIdentityCensus(pages, { maxPages: 50, ...opts });
    expect(c.reasons).toEqual(reasons);
    expect(c.complete).toBe(reasons.length === 0);
  });

  it("safety-cap truncation and an over-cap total are incomplete, never a smaller success", () => {
    const capped = buildIdentityCensus([page(1, 2, 6, [h(1), h(2)]), page(2, 2, 6, [h(3), h(4)])], { maxPages: 2, truncated: true });
    expect(capped.complete).toBe(false);
    expect(capped.reasons).toEqual(["safety_cap"]);
    const overCap = buildIdentityCensus([page(1, 2, 2, [h(1), h(2)])], { maxPages: 1 });
    expect(overCap.complete).toBe(true);
    const totalBeyondCap = buildIdentityCensus([page(1, 2, 2, [h(1), h(2)], { total: 5 })], { maxPages: 1 });
    expect(totalBeyondCap.reasons).toContain("safety_cap");
  });
});

describe("T3.3/T3.4 applyRunIdentities — real persistence on a transactional fake", () => {
  it("blocks the whole identity phase on an incomplete census (no transaction, no writes)", async () => {
    const c = buildIdentityCensus([page(1, 2, 4, [household(RUN_A, linked(["cr-inv-1"], 1))])], { maxPages: 50 });
    const outcome = await applyRunIdentities(c, META);
    expect(outcome).toMatchObject({ status: "blocked", reasons: ["short_page"] });
    expect(db.scopeCalls).toBe(0);
    expect(db.committed.identities.size).toBe(0);
  });

  it("first write commits snapshots, members, history and one counts-only audit together", async () => {
    db.resolved("cr-inv-1", 1);
    const outcome = await applyRunIdentities(census([
      household(RUN_A, linked(["cr-inv-1", "cr-inv-2"], 1)),
      household(RUN_B, unreviewed(0)),
    ]), META);
    expect(outcome).toMatchObject({ status: "applied", audited: true });
    if (outcome.status !== "applied") throw new Error("expected applied");
    expect(outcome.counts).toMatchObject({ inserted: 2, historyRows: 2, membersActivated: 2, resolved: 1, missing: 1 });
    expect(db.committed.identities.size).toBe(2);
    expect(db.activeMembers(RUN_A).map((m) => [m.cedar_ridge_user_id, m.resolution_outcome])).toEqual([
      ["cr-inv-1", "resolved"], ["cr-inv-2", "missing"],
    ]);
    expect(db.activeMembers(RUN_B)).toEqual([]);
    expect(db.committed.history).toHaveLength(2);
    expect(db.committed.audits).toHaveLength(1);
    expect(db.committed.audits[0].action).toBe(INGEST_ASSET_MAP_RUN_IDENTITY);
    const auditText = JSON.stringify(db.committed.audits[0]);
    expect(auditText).not.toMatch(/cr-inv|con_inv|003INV|02710000/);
    expect(db.committed.audits[0].detail).toMatchObject({ inserted: 2, history_rows: 2, dry_run: false });
  });

  it("an unchanged retry writes no new history or audit and still reports applied/unchanged", async () => {
    db.resolved("cr-inv-1", 1);
    const c = census([household(RUN_A, linked(["cr-inv-1"], 1))]);
    await applyRunIdentities(c, META);
    const second = await applyRunIdentities(c, META);
    expect(second).toMatchObject({ status: "applied", audited: false, counts: { unchanged: 1, historyRows: 0 } });
    expect(db.committed.history).toHaveLength(1);
    expect(db.committed.audits).toHaveLength(1);
  });

  it("newer versions converge: replace and retire, explicit unlink, relink, then revert", async () => {
    db.resolved("cr-inv-1", 1);
    db.resolved("cr-inv-2", 2);
    await applyRunIdentities(census([household(RUN_A, linked(["cr-inv-1", "cr-inv-2"], 1))]), META);

    await applyRunIdentities(census([household(RUN_A, linked(["cr-inv-2"], 2))]), META);
    expect(db.activeMembers(RUN_A).map((m) => m.cedar_ridge_user_id)).toEqual(["cr-inv-2"]);

    const unlink = await applyRunIdentities(census([household(RUN_A, unlinked(3))]), META);
    expect(unlink).toMatchObject({ status: "applied", counts: { sourceApplied: 1, membersRetired: 1 } });
    expect(db.activeMembers(RUN_A)).toEqual([]);
    expect(db.committed.identities.get(RUN_A)!.decision_state).toBe("unlinked");

    await applyRunIdentities(census([household(RUN_A, linked(["cr-inv-1"], 4))]), META);
    expect(db.activeMembers(RUN_A).map((m) => m.cedar_ridge_user_id)).toEqual(["cr-inv-1"]);

    // Reversal of a first confirmation: empty set, null decision, higher version.
    await applyRunIdentities(census([household(RUN_A, clientLink("first_confirmation_reversal", { identity_version: 5 }))]), META);
    expect(db.activeMembers(RUN_A)).toEqual([]);
    expect(db.committed.identities.get(RUN_A)).toMatchObject({ identity_version: "5", decision_state: "unlinked", decision_id: null });
    expect(new Set(db.committed.history.map((h) => h.consumer_revision)).size).toBe(db.committed.history.length);
  });

  it("an unchanged source version re-resolves when CRM changes", async () => {
    const c = census([household(RUN_A, linked(["cr-inv-1"], 1))]);
    await applyRunIdentities(c, META);
    expect(db.activeMembers(RUN_A)[0].resolution_outcome).toBe("missing");
    db.resolved("cr-inv-1", 7);
    const outcome = await applyRunIdentities(c, META);
    expect(outcome).toMatchObject({ status: "applied", counts: { unchanged: 1, resolutionRefreshed: 1, historyRows: 1 } });
    expect(db.activeMembers(RUN_A)[0]).toMatchObject({ resolution_outcome: "resolved", canonical_contact_identity_id: "con_inv7" });
  });

  it("a same-version conflicting payload stays quarantined with prior state while other runs advance", async () => {
    db.resolved("cr-inv-1", 1);
    await applyRunIdentities(census([household(RUN_A, linked(["cr-inv-1"], 4)), household(RUN_B, unreviewed(0))]), META);
    const before = { ...db.committed.identities.get(RUN_A)! };

    const outcome = await applyRunIdentities(census([
      household(RUN_A, linked(["cr-inv-1", "cr-inv-9"], 4)),
      household(RUN_B, linked(["cr-inv-1"], 1)),
    ]), META);
    expect(outcome).toMatchObject({ status: "applied", counts: { quarantinedEqualVersion: 1, sourceApplied: 1 } });
    const after = db.committed.identities.get(RUN_A)!;
    expect(after).toMatchObject({ payload_digest: before.payload_digest, people_ids: ["cr-inv-1"], quarantine_reason: "equal_version_mutation" });
    expect(db.activeMembers(RUN_A).map((m) => m.cedar_ridge_user_id)).toEqual(["cr-inv-1"]);
    expect(db.activeMembers(RUN_B).map((m) => m.cedar_ridge_user_id)).toEqual(["cr-inv-1"]);

    // Replaying the same conflicting payload stays quarantined.
    await applyRunIdentities(census([household(RUN_A, linked(["cr-inv-1", "cr-inv-9"], 4))]), META);
    expect(db.committed.identities.get(RUN_A)!.payload_digest).toBe(before.payload_digest);
  });

  it("an unreviewed observation never clears accepted data", async () => {
    db.resolved("cr-inv-1", 1);
    await applyRunIdentities(census([household(RUN_A, linked(["cr-inv-1"], 2))]), META);
    const outcome = await applyRunIdentities(census([household(RUN_A, unreviewed(9))]), META);
    expect(outcome).toMatchObject({ counts: { quarantinedUnreviewed: 1 } });
    expect(db.activeMembers(RUN_A).map((m) => m.cedar_ridge_user_id)).toEqual(["cr-inv-1"]);
    expect(db.committed.identities.get(RUN_A)!.decision_state).toBe("linked");
  });

  it("unavailable, missing-object and unsupported runs preserve existing links; absent runs are never pruned", async () => {
    db.resolved("cr-inv-1", 1);
    db.resolved("cr-inv-2", 2);
    db.resolved("cr-inv-3", 3);
    await applyRunIdentities(census([
      household(RUN_A, linked(["cr-inv-1"], 1)),
      household(RUN_B, linked(["cr-inv-2"], 1)),
      household(RUN_C, linked(["cr-inv-3"], 1)),
    ]), META);
    await applyRunIdentities(census([
      household(RUN_A, disabled()),
      household(RUN_B),
      household(RUN_C, { ...linked([], 9), schema_version: 3 }),
    ]), META);
    await applyRunIdentities(census([]), META);
    for (const [id, eg] of [[RUN_A, "cr-inv-1"], [RUN_B, "cr-inv-2"], [RUN_C, "cr-inv-3"]]) {
      expect(db.activeMembers(id).map((m) => m.cedar_ridge_user_id)).toEqual([eg]);
    }
    expect(db.committed.identities.get(RUN_A)!.last_observed_availability).toBe("unavailable");
  });

  it("does not propagate identity by folder: each run keeps its own accepted set", async () => {
    db.resolved("cr-inv-1", 1);
    await applyRunIdentities(census([
      household(RUN_A, linked(["cr-inv-1"], 1), { source_folder_id: "folder-shared", superseded_by: RUN_B }),
      household(RUN_B, unreviewed(0), { source_folder_id: "folder-shared" }),
    ]), META);
    expect(db.activeMembers(RUN_A)).toHaveLength(1);
    expect(db.activeMembers(RUN_B)).toEqual([]);
  });

  it("an injected failure rolls the whole identity phase back; retry applies exactly once", async () => {
    db.resolved("cr-inv-1", 1);
    const c = census([household(RUN_A, linked(["cr-inv-1"], 1)), household(RUN_B, linked(["cr-inv-1"], 1))]);
    for (const point of ["member", "history", "audit"] as const) {
      db.failAt = point;
      const failed = await applyRunIdentities(c, META);
      expect(failed).toMatchObject({ status: "failed", reason: "transaction_failed" });
      expect(db.committed.identities.size).toBe(0);
      expect(db.committed.members.size).toBe(0);
      expect(db.committed.history).toHaveLength(0);
      expect(db.committed.audits).toHaveLength(0);
    }
    db.failAt = null;
    expect(await applyRunIdentities(c, META)).toMatchObject({ status: "applied", audited: true });
    expect(await applyRunIdentities(c, META)).toMatchObject({ status: "applied", audited: false });
    expect(db.committed.history).toHaveLength(2);
    expect(db.committed.audits).toHaveLength(1);
  });

  it("a resolver integrity failure fails the phase with a reason code and writes nothing", async () => {
    db.resolverMalformed = true;
    const outcome = await applyRunIdentities(census([household(RUN_A, linked(["cr-inv-1"], 1))]), META);
    expect(outcome).toMatchObject({ status: "failed", reason: "resolver_error" });
    expect(db.committed.identities.size).toBe(0);
  });

  it("a run without a mirrored parent is not inserted", async () => {
    const outcome = await applyRunIdentities(census([household(run(99), linked(["cr-inv-1"], 1))]), META);
    expect(outcome).toMatchObject({ status: "applied", audited: false, counts: { missingParent: 1, inserted: 0 } });
    expect(db.committed.identities.size).toBe(0);
  });

  it("acquires the lock before any identity read and never writes before it", async () => {
    await applyRunIdentities(census([household(RUN_A, linked(["cr-inv-1"], 1))]), META);
    const first = db.events.findIndex((e) => e.endsWith(":read") || e.endsWith(":write"));
    expect(db.events[0]).toBe("w1:lock");
    expect(first).toBeGreaterThan(0);
  });
});

describe("T3.4/T3.7 concurrent workers", () => {
  it("serializes on the lock; a stale worker re-reads and cannot overwrite a newer version", async () => {
    db.resolved("cr-inv-1", 1);
    db.resolved("cr-inv-2", 2);
    await applyRunIdentities(census([household(RUN_A, linked(["cr-inv-1"], 1))]), META);

    let releaseNewer!: () => void;
    const holdNewer = new Promise<void>((r) => (releaseNewer = r));
    db.beforeResolve = async () => {
      db.beforeResolve = null;
      await holdNewer;
    };
    const newer = applyRunIdentities(census([household(RUN_A, linked(["cr-inv-2"], 3))]), META);
    await vi.waitFor(() => expect(db.events).toContain("w2:lock"));
    // A worker that fetched an older version while the newer one holds the lock.
    const stale = applyRunIdentities(census([household(RUN_A, linked(["cr-inv-1"], 2))]), META);
    await new Promise((r) => setTimeout(r, 10));
    expect(db.events).not.toContain("w3:lock");
    releaseNewer();
    const [newerOutcome, staleOutcome] = await Promise.all([newer, stale]);
    expect(newerOutcome).toMatchObject({ status: "applied", counts: { sourceApplied: 1 } });
    expect(staleOutcome).toMatchObject({ status: "applied", counts: { staleRejected: 1 } });
    expect(db.committed.identities.get(RUN_A)!.identity_version).toBe("3");
    expect(db.activeMembers(RUN_A).map((m) => m.cedar_ridge_user_id)).toEqual(["cr-inv-2"]);
    expect(db.events.indexOf("w3:lock")).toBeGreaterThan(db.events.indexOf("w2:commit"));
  });

  it("uses CRM state read after the lock, not state from before waiting", async () => {
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((r) => (releaseFirst = r));
    db.beforeResolve = async () => {
      db.beforeResolve = null;
      await holdFirst;
    };
    const c = census([household(RUN_A, linked(["cr-inv-1"], 1))]);
    const first = applyRunIdentities(c, META);
    await vi.waitFor(() => expect(db.events).toContain("w1:lock"));
    const second = applyRunIdentities(c, META);
    // CRM changes after the first worker's resolver statement, while the second waits.
    await new Promise((r) => setTimeout(r, 5));
    db.resolved("cr-inv-1", 5);
    releaseFirst();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ status: "applied", counts: { inserted: 1 } });
    expect(b).toMatchObject({ status: "applied", counts: { unchanged: 1, resolutionRefreshed: 1 } });
    expect(db.activeMembers(RUN_A)[0]).toMatchObject({ resolution_outcome: "resolved", canonical_contact_identity_id: "con_inv5" });
    expect(db.committed.history).toHaveLength(2);
  });

  it("identical concurrent workers commit one history row and one audit", async () => {
    db.resolved("cr-inv-1", 1);
    const c = census([household(RUN_A, linked(["cr-inv-1"], 1))]);
    const results = await Promise.all([applyRunIdentities(c, META), applyRunIdentities(c, META), applyRunIdentities(c, META)]);
    expect(results.every((r) => r.status === "applied")).toBe(true);
    expect(db.committed.history).toHaveLength(1);
    expect(db.committed.audits).toHaveLength(1);
  });
});

describe("identityStateChanged", () => {
  it("is false for an all-unchanged count set", () => {
    const zero = {
      observed: 3, inserted: 0, sourceApplied: 0, unchanged: 2, staleRejected: 1, quarantinedEqualVersion: 0,
      quarantinedUnreviewed: 0, unavailablePreserved: 0, missingParent: 0, resolutionRefreshed: 0, historyRows: 0,
      membersActivated: 0, membersRetired: 0, resolved: 2, missing: 0, ambiguous: 0, conflict: 0,
    };
    expect(identityStateChanged(zero)).toBe(false);
    expect(identityStateChanged({ ...zero, historyRows: 1 })).toBe(true);
  });
});
