import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HouseholdDirectoryPage } from "@/lib/data/households";

// Exercise the component's actual effect and fetch protocol in the repository's
// Node harness. Frames and visibility are controlled; browser paint is not timed.
const hooks = vi.hoisted(() => ({
  effect: undefined as (() => void | (() => void)) | undefined,
  values: [] as unknown[], cursor: 0,
  set: vi.fn<(index: number, value: unknown) => void>(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => { hooks.effect = effect; },
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (index >= hooks.values.length) hooks.values.push(initial);
    return [hooks.values[index], (value: unknown) => hooks.set(index, value)];
  },
}));
vi.mock("@/components/households/HouseholdsPreview", () => ({ HouseholdsPreview: () => null }));
vi.mock("@/components/households/HouseholdsTable", () => ({ HouseholdsTable: () => null }));

import { DeferredHouseholdsDirectory } from "@/components/households/DeferredHouseholdsDirectory";
import { HouseholdsPreview } from "@/components/households/HouseholdsPreview";
import { HouseholdsTable } from "@/components/households/HouseholdsTable";
import { DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS as filters, householdDirectoryQueryKey } from "@/lib/navigation/household-query";

const scope = "b".repeat(64);
const preview = [{
  sf_id: "synthetic-household", name: "Synthetic Household", stage: "Client",
  lead_advisor_email: "synthetic@example.invalid", advisor_name: null,
}];
const props = { preview, filters, scope, showFirm: true };
function directory(): HouseholdDirectoryPage & { queryKey: string } {
  return {
    rows: [{ ...preview[0], status: "Active", household_kind: "CLIENT", member_count: 1,
      aum: 100, aum_source: "mirror", employeeStatus: null }],
    total: 1, page: 1, pageCount: 1, pageSize: 100,
    snapshot: "a".repeat(32), queryKey: householdDirectoryQueryKey(filters),
    counts: { all: 1, client: 1, lost_client: 0 },
    summaryCounts: { clients: 1, prospects: 0, lost: 0 }, advisorOptions: [], statusOptions: [],
    aumSplit: { total: 100, firm: 0, employee: 0, available: true },
  };
}
function response(body = directory(), responseScope = scope) {
  return Response.json(body, { headers: { "X-AOA-Navigation-Scope": responseScope } });
}

let visibility: DocumentVisibilityState;
let documentEvents: EventTarget;
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
let reload: ReturnType<typeof vi.fn>;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let cleanup: (() => void) | undefined;

function render() {
  hooks.cursor = 0;
  return DeferredHouseholdsDirectory(props);
}
function mount() {
  const element = render();
  cleanup = hooks.effect?.() || undefined;
  return element;
}
function frame() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(16 * frameId);
}
function setVisibility(value: DocumentVisibilityState) {
  visibility = value;
  documentEvents.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  hooks.values.length = 0;
  hooks.cursor = 0;
  hooks.effect = undefined;
  hooks.set.mockReset().mockImplementation((index, value) => { hooks.values[index] = value; });
  visibility = "visible";
  documentEvents = new EventTarget();
  Object.defineProperty(documentEvents, "visibilityState", { get: () => visibility });
  frames = new Map();
  frameId = 0;
  reload = vi.fn();
  fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal("document", documentEvents);
  vi.stubGlobal("window", { location: { reload } });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
});

describe("Household exact-card scheduling", () => {
  it("keeps the preview and starts exactly one scoped request at the second frame without an idle timer", () => {
    const initial = mount();
    expect(initial.type).toBe(HouseholdsPreview);
    expect(initial.props).toEqual({ rows: preview, unavailable: false });
    setVisibility("visible");
    expect(fetcher).not.toHaveBeenCalled();
    frame();
    setVisibility("visible");
    expect(fetcher).not.toHaveBeenCalled();
    frame();
    // No timer is advanced: returning from frame two must already start fetch.
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/households?page=1", {
      signal: expect.any(AbortSignal), cache: "no-store", credentials: "same-origin", redirect: "error",
    });
    setVisibility("hidden");
    setVisibility("visible");
    frame();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(false);
  });

  it("holds a hidden tab until it is visible after the paint gate, then starts once", () => {
    visibility = "hidden";
    mount();
    frame();
    frame();
    expect(fetcher).not.toHaveBeenCalled();
    setVisibility("visible");
    expect(fetcher).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    setVisibility("hidden");
    setVisibility("visible");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])("cancels pending frames and the visibility listener when unmounted after %i frames", (count) => {
    mount();
    for (let i = 0; i < count; i++) frame();
    cleanup?.();
    cleanup = undefined;
    expect(frames.size).toBe(0);
    expect(getEventListeners(documentEvents, "visibilitychange")).toHaveLength(0);
    setVisibility("visible");
    frame();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("replaces the preview with the validated exact cards and directory, preserving props", async () => {
    const exact = directory();
    fetcher.mockResolvedValue(response(exact));
    mount(); frame(); frame();
    await vi.waitFor(() => expect(hooks.values[0]).toEqual(exact));
    const loaded = render();
    expect(loaded.type).toBe(HouseholdsTable);
    expect(loaded.props).toEqual({ initialDirectory: exact, initialFilters: filters, scope, showFirm: true });
    expect(reload).not.toHaveBeenCalled();
  });

  it.each(["success", "unauthorized"])("aborts an in-flight request and ignores late %s after unmount", async (outcome) => {
    let resolve!: (value: Response) => void;
    fetcher.mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
    mount(); frame(); frame();
    const signal = fetcher.mock.calls[0][1]?.signal as AbortSignal;
    cleanup?.();
    cleanup = undefined;
    expect(signal.aborted).toBe(true);
    resolve(outcome === "success" ? response() : new Response(null, { status: 401 }));
    // Allow the real fetch protocol and component promise chain to settle.
    await new Promise<void>((done) => setImmediate(done));
    expect(hooks.set).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it.each([401, 403, 409, 416])("reloads for auth/snapshot status %i without accepting exact data", async (status) => {
    fetcher.mockResolvedValue(new Response(null, { status }));
    mount(); frame(); frame();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(hooks.set).not.toHaveBeenCalled();
  });

  it("reloads when a successful response belongs to a different navigation scope", async () => {
    fetcher.mockResolvedValue(response(directory(), "c".repeat(64)));
    mount(); frame(); frame();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(hooks.set).not.toHaveBeenCalled();
  });

  it.each(["server", "network", "invalid JSON"])("keeps preview links and marks cards unavailable on %s failure", async (failure) => {
    if (failure === "network") fetcher.mockRejectedValue(new Error("synthetic network failure"));
    else if (failure === "server") fetcher.mockResolvedValue(new Response(null, { status: 503 }));
    else fetcher.mockResolvedValue(new Response("not-json", { headers: { "X-AOA-Navigation-Scope": scope } }));
    mount(); frame(); frame();
    await vi.waitFor(() => expect(hooks.values[1]).toBe(true));
    const unavailable = render();
    expect(unavailable.type).toBe(HouseholdsPreview);
    expect(unavailable.props).toEqual({ rows: preview, unavailable: true });
    expect(hooks.values[0]).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });
});
