import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetMapReadResult } from "@/app/(authenticated)/asset-mapping/actions";
import type { AssetMapDestination, AssetMapDestinationsView } from "@/lib/data/asset-map-destinations";
import {
  destinationCountLine,
  destinationReducer,
  destinationTag,
  destinationTypeOptions,
  fedByText,
  initialDestinationState,
  suggestionText,
  type DestinationAction,
  type DestinationState,
} from "@/components/asset-mapping/workspace/destinations/destination-model";
import {
  loadDestinations,
  performDestinationSave,
  type DestinationActions,
  type DestinationDeps,
} from "@/components/asset-mapping/workspace/destinations/run-destination";

const H = "11111111-1111-4111-8111-111111111111";
const D1 = "22222222-2222-4222-8222-222222222222";
const D2 = "33333333-3333-4333-8333-333333333333";
const L1 = "44444444-4444-4444-8444-444444444444";
const L2 = "55555555-5555-4555-8555-555555555555";
const ACC = "66666666-6666-4666-8666-666666666666";
const POS = "77777777-7777-4777-8777-777777777777";
const NEW = "88888888-8888-4888-8888-888888888888";
const NEW2 = "99999999-9999-4999-8999-999999999999";

function destination(id: string, extra: Partial<AssetMapDestination> = {}): AssetMapDestination {
  return {
    id, owner: "Synthetic Owner", targetAccountType: "Individual", existingApexNumber: null, needsToBeOpened: true,
    existingCount: 0, suggestedApexNumber: null, sources: [], ...extra,
  };
}

const SOURCE_L1 = { linkId: L1, custodian: "Synthetic Custodian", accountNumberMasked: "••••••••1234", accountId: ACC };
const SOURCE_L2 = { linkId: L2, custodian: "Other Custodian", accountNumberMasked: "••••5678", accountId: null };
const VIEW: AssetMapDestinationsView = {
  destinations: [
    destination(D1, { sources: [SOURCE_L1] }),
    destination(D2, { owner: "Synthetic Second", targetAccountType: "Roth IRA", existingApexNumber: "SYN00001", needsToBeOpened: false, existingCount: 1, sources: [SOURCE_L2] }),
  ],
  accountNumbers: { [ACC]: "••••••••1234" },
  overriddenPositionIds: [POS],
};
const REREAD: AssetMapDestinationsView = {
  destinations: [destination(D1, { owner: "Synthetic Reread", targetAccountType: "Traditional IRA", sources: [SOURCE_L1] })],
  accountNumbers: { [ACC]: "••••••••1234" },
  overriddenPositionIds: [],
};

const ok = <T,>(data: T) => ({ ok: true as const, data });
type LoadReply = AssetMapReadResult<AssetMapDestinationsView> | "throw";
type Entry = { action: DestinationAction; state: DestinationState };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function harness(overrides: Partial<DestinationActions> = {}, loads: LoadReply[] = [ok(VIEW)]) {
  const replies = [...loads];
  const h = { state: initialDestinationState(), open: H as string | null, history: [] as Entry[], seq: 0 };
  // Answers `loads` in order and repeats the last reply once the list is used up.
  const load = vi.fn(async () => {
    const r = replies.length > 1 ? replies.shift()! : replies[0];
    if (r === "throw") throw new Error("synthetic load failure");
    return r;
  });
  const actions: DestinationActions = {
    load,
    add: vi.fn(async (_h: string, owner: string | null, targetAccountType: string) => ok({ id: NEW, owner, targetAccountType })),
    setNeedsOpen: vi.fn(async (_t: string, needsToBeOpened: boolean) => ok({ needsToBeOpened })),
    setType: vi.fn(async (_t: string, targetAccountType: string) => ok({ targetAccountType })),
    remove: vi.fn(async (id: string) => ok({ id })),
    reassign: vi.fn(async (_h: string, linkId: string, target) =>
      ok({ linkId, targetAccountId: "targetAccountId" in target ? target.targetAccountId : NEW2 })),
    ...overrides,
  };
  const deps: DestinationDeps = {
    actions,
    dispatch: (action) => {
      h.state = destinationReducer(h.state, action);
      h.history.push({ action, state: h.state });
    },
    nextSeq: () => ++h.seq,
    schedule: (fn, ms) => { setTimeout(fn, ms); },
    currentHousehold: () => h.open,
  };
  const afterLastSaved = () => {
    const saved = h.history.filter((e) => e.action.type === "saved");
    expect(saved.length).toBeGreaterThan(0);
    return saved[saved.length - 1].state;
  };
  return { h, actions, deps, load, afterLastSaved };
}

async function loaded(overrides: Partial<DestinationActions> = {}, loads?: LoadReply[]) {
  const t = harness(overrides, loads);
  await loadDestinations(H, t.deps);
  return t;
}

const find = (state: DestinationState, id: string) => state.view?.destinations.find((d) => d.id === id);
const linkIds = (d: AssetMapDestination | undefined) => d?.sources.map((s) => s.linkId);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("asset-mapping destinations model and orchestration", () => {
  it("a destination load fills the list, account numbers, and overridden positions", async () => {
    const { h, load } = await loaded();
    expect(load).toHaveBeenCalledWith(H);
    expect(h.state.status).toBe("loaded");
    expect(h.state.view).toEqual(VIEW);
  });

  it("a failed first load marks the section failed", async () => {
    const { h } = await loaded({}, [{ ok: false, reason: "unavailable" }]);
    expect(h.state.status).toBe("failed");
    expect(h.state.view).toBeNull();
  });

  it("an add shows the new destination needing to be opened after the save", async () => {
    const { deps, actions, afterLastSaved } = await loaded();
    await performDestinationSave(H, { kind: "add", owner: "Synthetic Owner", targetAccountType: "Roth IRA" }, deps);
    expect(actions.add).toHaveBeenCalledWith(H, "Synthetic Owner", "Roth IRA");
    const state = afterLastSaved();
    expect(find(state, NEW)).toEqual(destination(NEW, { targetAccountType: "Roth IRA" }));
    expect(state.pending).toEqual([]);
  });

  it("a needs-to-be-opened change shows the saved state, and an existing-account change shows it does not need opening", async () => {
    const { deps, afterLastSaved } = await loaded();
    await performDestinationSave(H, { kind: "needsOpen", targetId: D1, needsToBeOpened: false }, deps);
    expect(find(afterLastSaved(), D1)?.needsToBeOpened).toBe(false);
    await performDestinationSave(H, { kind: "needsOpen", targetId: D2, needsToBeOpened: true }, deps);
    expect(find(afterLastSaved(), D2)?.needsToBeOpened).toBe(true);
  });

  it("a type change shows the new type on the destination", async () => {
    const { deps, afterLastSaved } = await loaded();
    await performDestinationSave(H, { kind: "type", targetId: D1, targetAccountType: "Traditional IRA" }, deps);
    expect(find(afterLastSaved(), D1)?.targetAccountType).toBe("Traditional IRA");
  });

  it("a removal drops the destination after the save", async () => {
    const { deps, afterLastSaved } = await loaded();
    await performDestinationSave(H, { kind: "remove", targetId: D2 }, deps);
    expect(afterLastSaved().view?.destinations.map((d) => d.id)).toEqual([D1]);
  });

  it("a move to an existing destination shows the source there and not on its old destination", async () => {
    const { deps, actions, afterLastSaved } = await loaded();
    await performDestinationSave(H, { kind: "reassign", linkId: L1, targetAccountId: D2 }, deps);
    expect(actions.reassign).toHaveBeenCalledWith(H, L1, { targetAccountId: D2 });
    const state = afterLastSaved();
    expect(linkIds(find(state, D2))).toEqual([L2, L1]);
    expect(linkIds(find(state, D1))).toEqual([]);
  });

  it("a move to a new destination shows a new Individual destination holding the source", async () => {
    const { deps, actions, afterLastSaved } = await loaded();
    await performDestinationSave(H, { kind: "reassignNew", linkId: L1, newOwner: "Synthetic Owner" }, deps);
    expect(actions.reassign).toHaveBeenCalledWith(H, L1, { newOwner: "Synthetic Owner" });
    const state = afterLastSaved();
    expect(find(state, NEW2)).toEqual(destination(NEW2, { sources: [SOURCE_L1] }));
    expect(linkIds(find(state, D1))).toEqual([]);
  });

  it("re-reads the destinations after each confirmed save and shows the re-read list", async () => {
    const { h, deps, load } = await loaded({}, [ok(VIEW), ok(REREAD)]);
    await performDestinationSave(H, { kind: "type", targetId: D1, targetAccountType: "Traditional IRA" }, deps);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls).toEqual([[H], [H]]);
    expect(h.history.map((e) => e.action.type)).toEqual(["loaded", "pending", "saved", "loaded"]);
    expect(h.state.status).toBe("loaded");
    expect(h.state.view).toEqual(REREAD);
  });

  it("keeps the confirmed value when the re-read fails", async () => {
    const { h, deps, load } = await loaded({}, [ok(VIEW), "throw"]);
    await performDestinationSave(H, { kind: "type", targetId: D1, targetAccountType: "Traditional IRA" }, deps);
    expect(load).toHaveBeenCalledTimes(2);
    expect(h.state.status).toBe("loaded");
    expect(find(h.state, D1)?.targetAccountType).toBe("Traditional IRA");
  });

  it("a rejected or unanswered save keeps the last saved values and shows the failure text for 5 seconds", async () => {
    const { h, deps, load } = await loaded({
      setType: vi.fn(async () => ({ ok: false as const, reason: "rejected" as const })),
      remove: vi.fn(async () => { throw new Error("synthetic remove failure"); }),
    });
    await performDestinationSave(H, { kind: "type", targetId: D1, targetAccountType: "Traditional IRA" }, deps);
    expect(h.state.view?.destinations).toEqual(VIEW.destinations);
    expect(h.state.failure).toMatchObject({ key: `type:${D1}`, text: "Failed to update destination" });
    expect(h.state.pending).toEqual([]);
    vi.advanceTimersByTime(4999);
    expect(h.state.failure).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(h.state.failure).toBeNull();
    await performDestinationSave(H, { kind: "remove", targetId: D2 }, deps);
    expect(h.state.failure).toMatchObject({ key: `remove:${D2}`, text: "Failed to remove destination" });
    expect(find(h.state, D2)).toBeDefined();
    expect(h.state.view?.destinations).toEqual(VIEW.destinations);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("a forbidden save shows Operations role required", async () => {
    const { h, deps } = await loaded({ setNeedsOpen: vi.fn(async () => ({ ok: false as const, reason: "forbidden" as const })) });
    await performDestinationSave(H, { kind: "needsOpen", targetId: D1, needsToBeOpened: false }, deps);
    expect(h.state.failure).toMatchObject({ key: `needsOpen:${D1}`, text: "Operations role required" });
    expect(find(h.state, D1)?.needsToBeOpened).toBe(true);
  });

  it("an older failure timer does not clear a newer failure", async () => {
    const { h, deps } = await loaded({
      setType: vi.fn(async () => ({ ok: false as const, reason: "rejected" as const })),
      remove: vi.fn(async () => ({ ok: false as const, reason: "unavailable" as const })),
    });
    await performDestinationSave(H, { kind: "type", targetId: D1, targetAccountType: "Traditional IRA" }, deps);
    vi.advanceTimersByTime(3000);
    await performDestinationSave(H, { kind: "remove", targetId: D2 }, deps);
    vi.advanceTimersByTime(2000);
    expect(h.state.failure).toMatchObject({ key: `remove:${D2}`, seq: 2 });
    vi.advanceTimersByTime(3000);
    expect(h.state.failure).toBeNull();
  });

  it("a reply for a household the user has left is dropped", async () => {
    const reply = deferred<{ ok: true; data: { targetAccountType: string } }>();
    const { h, deps, load } = await loaded({ setType: vi.fn(() => reply.promise) });
    const before = h.state;
    const saving = performDestinationSave(H, { kind: "type", targetId: D1, targetAccountType: "Traditional IRA" }, deps);
    h.open = "other-household";
    reply.resolve(ok({ targetAccountType: "Traditional IRA" }));
    await saving;
    expect(h.history.map((e) => e.action.type)).toEqual(["loaded", "pending"]);
    expect({ ...h.state, pending: before.pending }).toEqual(before);
    expect(load).toHaveBeenCalledTimes(1);

    const loadReply = deferred<AssetMapReadResult<AssetMapDestinationsView>>();
    const fresh = harness({ load: vi.fn(() => loadReply.promise) });
    const loading = loadDestinations(H, fresh.deps);
    fresh.h.open = "other-household";
    loadReply.resolve(ok(VIEW));
    await loading;
    expect(fresh.h.history).toEqual([]);
    expect(fresh.h.state).toEqual(initialDestinationState());
  });

  it("suggestion text says an existing account was found or a new account is suggested", () => {
    expect(suggestionText(destination(D1, { targetAccountType: "Roth IRA", existingCount: 2 }))).toEqual({
      found: true, text: "2 existing Roth IRA accounts found — pick one",
    });
    expect(suggestionText(destination(D1, { targetAccountType: "Roth IRA", existingCount: 1, suggestedApexNumber: "SYN00001" }))).toEqual({
      found: true, text: "Existing Roth IRA account found — SYN00001",
    });
    expect(suggestionText(destination(D1, { owner: null, targetAccountType: "Roth IRA", existingCount: 0 }))).toEqual({
      found: false, text: "No open Roth IRA account for this owner — suggest opening a new one",
    });
  });

  it("type options are the eight pipeline types plus an off-list current type, and tags and counts match the pipeline", () => {
    const joint = destinationTypeOptions("Joint");
    expect(joint).toHaveLength(9);
    expect(joint[0]).toBe("Joint");
    expect(destinationTypeOptions("Individual")).toEqual([
      "Individual", "JWROS", "JTIC", "Joint Community Property",
      "Roth IRA", "Traditional IRA", "Beneficiary Roth IRA", "Beneficiary Traditional IRA",
    ]);
    expect(destinationTag(destination(D1))).toBe("new account");
    expect(destinationTag(destination(D1, { needsToBeOpened: false, existingApexNumber: "SYN00001" }))).toBe("existing · SYN00001");
    expect(destinationTag(destination(D1, { needsToBeOpened: false }))).toBe("existing");
    expect(destinationCountLine([destination(D1), destination(D2), destination(NEW, { needsToBeOpened: false })])).toBe("3 destinations · 2 to open");
    expect(fedByText(1)).toBe("fed by 1 source account");
    expect(fedByText(2)).toBe("fed by 2 source accounts");
  });
});
