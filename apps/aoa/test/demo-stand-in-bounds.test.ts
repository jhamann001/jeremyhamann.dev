// The demo's stand-ins keep their records bounded: a record's history stops by count and size, a new record is
// refused once its kind is full, and a failed custodian read leaves a fixed log line, never the data. The store is an
// in-memory copy of demo.stand_in_record (the database's own ceiling is pinned in demo-stand-in-store.integration).
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rows, store, custodianRead } = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  store: { full: false },
  custodianRead: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/demo/outbox", () => ({ recordOutbox: async () => {} }));
vi.mock("@/lib/data/custodian-authority", () => ({ readCustodianAuthorityProfiles: custodianRead }));
vi.mock("@/lib/demo/stand-ins/store", () => {
  const key = (s: string, k: string, id: string) => `${s}|${k}|${id}`;
  const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  return {
    listRecords: async (s: string, k: string) => [...rows.entries()]
      .filter(([id]) => id.startsWith(`${s}|${k}|`))
      .map(([id, doc]) => ({ id: id.split("|")[2], doc: copy(doc), updatedAt: new Date() })),
    readRecord: async (s: string, k: string, id: string) =>
      rows.has(key(s, k, id)) ? { id, doc: copy(rows.get(key(s, k, id))), updatedAt: new Date() } : null,
    saveRecord: async (s: string, k: string, id: string, doc: unknown) => {
      if (store.full && !rows.has(key(s, k, id))) return "full";
      rows.set(key(s, k, id), copy(doc));
      return "saved";
    },
    changeRecord: async (s: string, k: string, id: string, change: (d: unknown) => unknown) => {
      if (!rows.has(key(s, k, id))) return null;
      const next = change(copy(rows.get(key(s, k, id))));
      if (next) rows.set(key(s, k, id), copy(next));
      return copy(next ?? rows.get(key(s, k, id)));
    },
  };
});

import { TRACKER_ROUTES, type TrackerRecord } from "@/lib/demo/stand-ins/tracker";
import { PIPELINE_ROUTES } from "@/lib/demo/stand-ins/pipeline";
import { newTrackerRecord } from "@/lib/demo/stand-ins/tracker-model";
import type { StandInCall, StandInRoute } from "@/lib/demo/stand-ins/fetch";

const USER = "user-00000000-0000-4000-8000-000000000001";
const route = (routes: readonly StandInRoute[], method: string, pattern: string) =>
  routes.find(([m, p]) => m === method && p === pattern)![2];
const call = (params: Record<string, string>, body: unknown): StandInCall =>
  ({ method: "POST", url: new URL("https://stand-in.test/"), params, body, headers: new Headers() });
const record = () => rows.get("tracker|acat|acat-1") as TrackerRecord;

beforeEach(() => {
  rows.clear();
  store.full = false;
  custodianRead.mockReset();
  rows.set("tracker|acat|acat-1", newTrackerRecord({ id: "acat-1", clientName: "Ada Okafor", acatDate: "2026-10-01" }));
  rows.set(`tracker|client|${USER}`, { cedarRidgeUserId: USER, displayName: "Ada Okafor", eligibility: "ACTIVE", accounts: [] });
});

describe("the tracker stand-in's bounds", () => {
  it("keeps a record's newest history, stopping by count and by size", async () => {
    const patch = route(TRACKER_ROUTES, "PATCH", "/api/machine/acats/by-record/:id");
    for (let i = 0; i < 30; i++) {
      const reply = await patch(call({ id: "acat-1" }, { notes: String(i % 10).repeat(2000) }));
      expect(reply.status).toBe(200);
    }
    const history = record().history;
    // Each entry carries two 2,000-character values, so the size ceiling stops it well before the count.
    expect(history.length).toBeGreaterThan(1);
    expect(history.length).toBeLessThan(30);
    expect(JSON.stringify(history).length).toBeLessThanOrEqual(32_000 + history.length + 2);
    expect(history[0].newValue).toBe("9".repeat(2000));

    for (let i = 0; i < 150; i++) await patch(call({ id: "acat-1" }, { notes: `note ${i}` }));
    expect(record().history).toHaveLength(100);
    expect(record().history[0].newValue).toBe("note 149");
  });

  it("refuses a new transfer record once the store is full, and adds nothing", async () => {
    store.full = true;
    const create = route(TRACKER_ROUTES, "POST", "/api/machine/acats");
    const reply = await create(call({}, { cedarRidgeUserIds: [USER] }));
    expect(reply).toEqual({ status: 422, json: { error: "The demo can't hold more transfer records until tonight's reset.", code: "DEMO_LIMIT" } });
    expect([...rows.keys()].filter((k) => k.startsWith("tracker|acat|"))).toEqual(["tracker|acat|acat-1"]);
    store.full = false;
    expect((await create(call({}, { cedarRidgeUserIds: [USER] }))).status).toBe(201);
  });

  it("logs a fixed marker, and no data, when the custodian library can't be read", async () => {
    custodianRead.mockRejectedValue(new Error("Example Custodian row 42 failed"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const patch = route(TRACKER_ROUTES, "PATCH", "/api/machine/acats/by-record/:id");
    expect((await patch(call({ id: "acat-1" }, { transferringContra: "Example Custodian" }))).status).toBe(200);
    expect(record().custodianId).toBeNull();
    expect(error.mock.calls).toEqual([["[demo-tracker] custodian_library_read_failed"]]);
    error.mockRestore();
  });
});

describe("the pipeline stand-in's bounds", () => {
  it("refuses a new destination once the store is full", async () => {
    rows.set("pipeline|household|run-1", {
      id: "run-1", client_name: "Okafor Household", run_number: 1, processed_at: "2026-10-20T14:05:00Z",
      superseded_by: null, source_folder_id: "folder-1", accounts: [],
    });
    store.full = true;
    const add = route(PIPELINE_ROUTES, "POST", "/api/clients/:folder/destinations");
    const reply = await add(call({ folder: "folder-1" }, { target_account_type: "Individual", owner: "Ada Okafor" }));
    expect(reply.status).toBe(429);
    expect([...rows.keys()].some((k) => k.startsWith("pipeline|destination|"))).toBe(false);
  });
});
