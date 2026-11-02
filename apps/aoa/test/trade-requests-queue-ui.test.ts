// @vitest-environment jsdom
import { createElement, useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
const loc = vi.hoisted(() => ({ path: "/trade-requests/queue", listeners: new Set<() => void>(), stack: [] as string[] }));
vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => { loc.listeners.add(listener); return () => { loc.listeners.delete(listener); }; };
  return {
    useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: nav.refresh }),
    usePathname: () => useSyncExternalStore(subscribe, () => loc.path),
  };
});
vi.mock("server-only", () => ({}));
vi.mock("@/app/(authenticated)/trade-requests/[id]/actions", () => ({ loadRequestPdfExclusions: vi.fn() }));
vi.mock("@/lib/trade-requests/request-pdf", () => ({ buildRequestPdf: vi.fn() }));
const ck = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("@/app/(authenticated)/trade-requests/checklist-actions", () => ({ readRequestChecklist: ck.read, writeRequestChecklistItem: ck.write }));
vi.mock("next/link", () => ({
  default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children: unknown; prefetch?: boolean }) =>
    createElement("a", { href, ...rest }, children as never),
}));

import { TradeRequestsQueueProvider, useTradeRequestQueueEntry } from "@/components/trade-requests/queue/QueueProvider";
import { TradingQueue } from "@/components/trade-requests/queue/TradingQueue";
import { TradeRequestsHome } from "@/components/trade-requests/home/TradeRequestsHome";
import { useRequestDetailFrame } from "@/components/trade-requests/detail/RequestDetailDialog";
import { useRequestChecklistSummary } from "@/components/trade-requests/checklist/RequestChecklistScope";

type Body = { ok: boolean; status?: number; redirected?: boolean; body: unknown };
type Reply = Body | "network" | Promise<Body>;
type Call = { url: URL; q: string | null; before: string | null; signal?: AbortSignal };
let replies: Reply[];
let calls: Call[];
const header = (init: RequestInit | undefined, name: string) => {
  const value = (init?.headers as Record<string, string> | undefined)?.[name];
  return value === undefined ? null : decodeURIComponent(value);
};
const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
  const signal = init?.signal ?? undefined;
  calls.push({ url: new URL(input, "http://127.0.0.1"), q: header(init, "x-trade-requests-search"), before: header(init, "x-trade-requests-before"), signal });
  const next = replies.shift();
  if (!next) return new Promise(() => undefined);
  if (next === "network") throw new TypeError("Failed to fetch");
  const reply = await next;
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return { ok: reply.ok, redirected: reply.redirected ?? false, status: reply.status ?? (reply.ok ? 200 : 503), json: async () => reply.body };
});
function deferred() {
  let resolve!: (body: Body) => void;
  const promise = new Promise<Body>((done) => { resolve = done; });
  return { promise, resolve };
}
const reload = vi.fn();
function go(path: string) {
  loc.path = path;
  loc.listeners.forEach((listener) => listener());
}

const STATUSES = ["Pending Review", "Needs Info", "Pending Current Asset Liquidation", "Approved", "Rejected", "Completed"];
const entry = (n: number) => ({
  id: `REQ-${String(n).padStart(3, "0")}`, clientName: `Client ${n}`, clientNames: n % 4 === 0 ? [`Client ${n}`, "Partner"] : [`Client ${n}`],
  advisor: "Rachel Moss", submittedBy: n % 5 === 0 ? "Riley Ops" : "Avery Stone", tradeType: "Raise Cash",
  status: STATUSES[n % 6], date: new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString(), updatedAt: `u${n}`,
  clientId: `HH-${n}`, clientIds: [`HH-${n}`], selectedAccounts: [], accountMetadata: [], equityStrategies: [],
  auditLog: [{ id: `a${n}`, date: "2026-10-01T00:00:00.000Z", user: "Avery Stone", action: "Request Created", notes: "" }],
});
const page = (from: number, count: number, nextCursor: string | null) =>
  ({ ok: true, body: { ok: true, data: { data: Array.from({ length: count }, (_, i) => entry(from - i)), nextCursor } } });
const failed = (message: string) => ({ ok: true, body: { ok: false, outcome: "failed", message } });

const rows = () => screen.queryAllByRole("row", { name: /^View request / });
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

const EXPORTER = { name: "Riley Ops", email: "ops@example.invalid" };
function renderQueue(reviewer: boolean, extra: Partial<Parameters<typeof TradingQueue>[0]> = {}) {
  return render(createElement(TradeRequestsQueueProvider, null, createElement(TradingQueue, { reviewer, role: reviewer ? "OPERATIONS" : "ADVISOR", exporter: EXPORTER, ...extra })));
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.open = true; };
});

beforeEach(() => {
  vi.useFakeTimers();
  replies = [];
  calls = [];
  nav.push.mockReset();
  nav.replace.mockReset();
  nav.push.mockImplementation((path: string) => go(path));
  loc.path = "/trade-requests/queue";
  loc.stack = [];
  vi.spyOn(window.history, "pushState").mockImplementation((_data, _unused, url) => { loc.stack.push(loc.path); go(String(url)); });
  vi.spyOn(window.history, "back").mockImplementation(() => go(loc.stack.pop() ?? loc.path));
  vi.stubGlobal("fetch", fetchMock);
  reload.mockReset();
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, reload, get pathname() { return loc.path; } } });
  window.sessionStorage.clear();
  ck.read.mockReset();
  ck.write.mockReset();
  ck.read.mockResolvedValue({ ok: true, checklist: { exclusions: { checked: true, value: "", by: "Riley Ops", at: "2026-10-01T00:00:00.000Z" } } });
  ck.write.mockResolvedValue({ ok: true, checklist: {} });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Trading Queue", () => {
  it("shows the loading line, then the newest 50 with reviewer columns (AC-69)", async () => {
    replies = [page(120, 50, "c1")];
    renderQueue(true);
    expect(screen.getByRole("status").textContent).toBe("Loading requests...");
    await flush();
    expect(rows()).toHaveLength(50);
    expect(calls[0].url.pathname).toBe("/api/trade-requests/requests");
    expect(calls[0].url.search).toBe("");
    expect(calls[0].q).toBeNull();
    const headers = screen.getAllByRole("columnheader").map((th) => th.textContent?.replace(/[↑↓↕]/g, ""));
    expect(headers).toEqual(["Request ID", "Household", "Trade Type", "Date", "Advisor", "Submitted by", "Status"]);
    const first = within(rows()[0]).getAllByRole("cell").map((td) => td.textContent);
    expect(first[0]).toBe("REQ-120");
    expect(first[1]).toBe("Client 120 & Partner");
    expect(first[5]).toBe("Riley Ops");
    expect(screen.getByRole("table").querySelector("caption")?.textContent).toBe("All trade requests across advisors");
  });

  it("advisors see the five shared columns", async () => {
    replies = [page(10, 10, null)];
    renderQueue(false);
    await flush();
    expect(screen.getAllByRole("columnheader").map((th) => th.textContent?.replace(/[↑↓↕]/g, ""))).toEqual(["Request ID", "Household", "Trade Type", "Date", "Status"]);
  });

  it("sorts the listed rows: new column ascending, same column reverses, Status by workflow (AC-70, AC-75, AC-76)", async () => {
    replies = [page(12, 12, null)];
    renderQueue(true);
    await flush();
    const header = (name: string) => screen.getAllByRole("columnheader").find((th) => th.textContent?.startsWith(name))!;
    expect(header("Date").getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(within(header("Request ID")).getByRole("button"));
    expect(header("Request ID").getAttribute("aria-sort")).toBe("ascending");
    expect(header("Date").getAttribute("aria-sort")).toBe("none");
    expect(rows().map((r) => r.getAttribute("data-request-id"))[0]).toBe("REQ-001");
    fireEvent.click(within(header("Request ID")).getByRole("button"));
    expect(header("Request ID").getAttribute("aria-sort")).toBe("descending");
    expect(rows()[0].getAttribute("data-request-id")).toBe("REQ-012");
    fireEvent.click(within(header("Status")).getByRole("button"));
    const order = rows().map((r) => STATUSES.indexOf(String(entry(Number(r.getAttribute("data-request-id")!.slice(4))).status)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(calls).toHaveLength(1);
  });

  it("Load more appends the next 50 and disappears when nothing older remains (AC-28, AC-30)", async () => {
    replies = [page(120, 50, "c1")];
    renderQueue(true);
    await flush();
    replies = [page(70, 50, "c2")];
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));
    expect(screen.getByRole("button", { name: "Loading..." })).toHaveProperty("disabled", true);
    await flush();
    expect(rows()).toHaveLength(100);
    expect(calls[1].before).toBe("c1");
    expect(calls[1].url.search).toBe("");
    replies = [page(20, 20, null)];
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));
    await flush();
    expect(rows()).toHaveLength(120);
    expect(screen.queryByRole("button", { name: "Load More" })).toBeNull();
  });

  it("a failed Load more or refresh keeps the rows behind the banner; Retry reloads (AC-80, AC-149)", async () => {
    replies = [page(120, 50, "c1")];
    renderQueue(true);
    await flush();
    replies = [failed("Request failed with status code 503")];
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));
    await flush();
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("Unable to refresh — showing last loaded data.");
    expect(rows()).toHaveLength(50);
    expect(screen.getByRole("button", { name: "Load More" })).toBeTruthy();
    replies = ["network"];
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(rows()).toHaveLength(50);
    expect(screen.getByRole("alert")).toBeTruthy();
    replies = [page(121, 50, "c1")];
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }));
    await flush();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(rows()[0].getAttribute("data-request-id")).toBe("REQ-121");
  });

  it("an initial failure shows the failure message and Retry, no table (AC-79)", async () => {
    replies = [failed("Request failed with status code 500")];
    renderQueue(true);
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Request failed with status code 500");
    expect(screen.queryByRole("table")).toBeNull();
    replies = ["network"];
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Failed to load requests");
    replies = [page(5, 5, null)];
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(rows()).toHaveLength(5);
  });

  it("refreshes every 30 s and on becoming visible with the newest 50 for the search, discarding added pages (AC-113)", async () => {
    replies = [page(120, 50, "c1")];
    renderQueue(true);
    await flush();
    replies = [page(70, 50, "c2")];
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));
    await flush();
    expect(rows()).toHaveLength(100);
    replies = [page(121, 50, "c1")];
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(rows()).toHaveLength(50);
    expect(rows()[0].getAttribute("data-request-id")).toBe("REQ-121");
    expect(calls.at(-1)!.before).toBeNull();

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    const before = calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(calls).toHaveLength(before);

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    replies = [page(122, 50, "c1")];
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(0); });
    expect(calls).toHaveLength(before + 1);
    expect(rows()[0].getAttribute("data-request-id")).toBe("REQ-122");
  });

  it("applies the search 300 ms after typing stops, keeps it for refreshes, and shows the empty lines (AC-114, AC-116, AC-117)", async () => {
    replies = [{ ok: true, body: { ok: true, data: { data: [], nextCursor: null } } }];
    renderQueue(false);
    await flush();
    expect(screen.getByText("No active trade requests found.")).toBeTruthy();
    const box = screen.getByRole("searchbox", { name: "Search trade requests" });
    fireEvent.change(box, { target: { value: "gold" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    fireEvent.change(box, { target: { value: "aufderhar" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(299); });
    expect(calls).toHaveLength(1);
    replies = [{ ok: true, body: { ok: true, data: { data: [], nextCursor: null } } }];
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(calls).toHaveLength(2);
    expect(calls[1].q).toBe("aufderhar");
    expect(calls[1].url.search).toBe("");
    expect(screen.getByText("No requests match your search.")).toBeTruthy();
    replies = [{ ok: true, body: { ok: true, data: { data: [], nextCursor: null } } }];
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(calls[2].q).toBe("aufderhar");
  });

  it("opens a request on click, Enter or Space at its address, and hands over the loaded entry", async () => {
    replies = [page(3, 3, null)];
    let handed: unknown;
    function Probe() { handed = useTradeRequestQueueEntry("REQ-002"); return null; }
    render(createElement(TradeRequestsQueueProvider, null, createElement(TradingQueue, { reviewer: false, role: "ADVISOR", exporter: EXPORTER }), createElement(Probe)));
    await flush();
    const row = screen.getByRole("row", { name: "View request REQ-002" });
    expect(row.getAttribute("tabindex")).toBe("0");
    for (const openRow of [() => fireEvent.click(row), () => fireEvent.keyDown(row, { key: "Enter" }), () => fireEvent.keyDown(row, { key: " " })]) {
      openRow();
      expect(loc.path).toBe("/trade-requests/queue/REQ-002");
      act(() => go("/trade-requests/queue"));
    }
    expect(vi.mocked(window.history.pushState).mock.calls.map((call) => call[2])).toEqual(["/trade-requests/queue/REQ-002", "/trade-requests/queue/REQ-002", "/trade-requests/queue/REQ-002"]);
    expect(nav.push).not.toHaveBeenCalled();
    expect(handed).toMatchObject({ id: "REQ-002", updatedAt: "u2" });
  });

  it("an unconfirmed person gets the not-set-up card instead of the queue (AC-22)", async () => {
    replies = [{ ok: true, body: { ok: false, outcome: "not_set_up", message: "x" } }];
    renderQueue(true);
    await flush();
    expect(screen.getByTestId("trade-requests-not-set-up").textContent).toContain("Your account is not set up for Trade Requests — contact Operations.");
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("Trading Queue races and session end", () => {
  it("discards a slower earlier response that arrives after a newer search", async () => {
    replies = [page(120, 50, "c1")];
    renderQueue(true);
    await flush();
    const slow = deferred();
    replies = [slow.promise];
    const box = screen.getByRole("searchbox", { name: "Search trade requests" });
    fireEvent.change(box, { target: { value: "gold" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(calls.at(-1)!.q).toBe("gold");
    replies = [page(7, 1, null)];
    fireEvent.change(box, { target: { value: "aufderhar" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(calls.at(-1)!.q).toBe("aufderhar");
    expect(calls.at(-2)!.signal?.aborted).toBe(true);
    expect(rows().map((r) => r.getAttribute("data-request-id"))).toEqual(["REQ-007"]);
    await act(async () => { slow.resolve(page(99, 50, "stale")); await vi.advanceTimersByTimeAsync(0); });
    expect(rows().map((r) => r.getAttribute("data-request-id"))).toEqual(["REQ-007"]);
    expect(screen.queryByRole("button", { name: "Load More" })).toBeNull();
  });

  it("unmounting leaves no timers and aborts the load in flight", async () => {
    replies = [page(120, 50, "c1")];
    const view = renderQueue(true);
    await flush();
    replies = [];
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));
    const inFlight = calls.at(-1)!;
    view.unmount();
    expect(inFlight.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const before = calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); document.dispatchEvent(new Event("visibilitychange")); });
    expect(calls).toHaveLength(before);
  });

  it("skips a scheduled or on-visible refresh while Load more is in flight", async () => {
    replies = [page(120, 50, "c1")];
    renderQueue(true);
    await flush();
    const more = deferred();
    replies = [more.promise];
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));
    const before = calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(0); });
    expect(calls).toHaveLength(before);
    await act(async () => { more.resolve(page(70, 50, "c2")); await vi.advanceTimersByTimeAsync(0); });
    expect(rows()).toHaveLength(100);
  });

  it("Retry after a failed Load more reloads the newest 50 and clears the banner", async () => {
    replies = [page(120, 50, "c1")];
    renderQueue(true);
    await flush();
    replies = [failed("Request failed with status code 502")];
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("Unable to refresh — showing last loaded data.");
    replies = [page(121, 50, "c9")];
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }));
    await flush();
    expect(calls.at(-1)!.before).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(rows()).toHaveLength(50);
    expect(rows()[0].getAttribute("data-request-id")).toBe("REQ-121");
    replies = [page(71, 50, null)];
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));
    await flush();
    expect(calls.at(-1)!.before).toBe("c9");
    expect(rows()).toHaveLength(100);
  });

  it.each([
    ["a 401 from middleware", { ok: false, status: 401, body: { error: "unauthorized" } }],
    ["a 403 role refusal", { ok: false, status: 403, body: { ok: false, outcome: "refused" } }],
    ["a redirect to sign-in", { ok: true, status: 200, redirected: true, body: null }],
  ])("%s on a refresh clears the rows, stops refreshing and reloads", async (_label, reply) => {
    replies = [page(120, 50, "c1")];
    renderQueue(true);
    await flush();
    replies = [reply as Body];
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(rows()).toHaveLength(0);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByTestId("trade-requests-session-ended").textContent).toContain("Your session has ended. Sign in again to continue.");
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/?callbackUrl=%2Ftrade-requests%2Fqueue");
    expect(reload).toHaveBeenCalledTimes(1);
    const before = calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); document.dispatchEvent(new Event("visibilitychange")); });
    expect(calls).toHaveLength(before);
  });
});

describe("Session end reload guard", () => {
  async function endSession() {
    replies = [{ ok: false, status: 401, body: { error: "unauthorized" } }];
    const view = renderQueue(true);
    await flush();
    expect(screen.getByTestId("trade-requests-session-ended")).toBeTruthy();
    view.unmount();
  }

  it("reloads once, then shows the sign-in prompt without reloading again within 10 seconds", async () => {
    await endSession();
    expect(reload).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    await endSession();
    expect(reload).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await endSession();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not reload when the guard cannot be recorded", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    await endSession();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("A request over the Trading Queue (P2-111, AC-9)", () => {
  const dialog = () => screen.queryByTestId("trade-request-detail");
  function ActionSlot() {
    const frame = useRequestDetailFrame();
    const summary = useRequestChecklistSummary();
    return createElement("button", { type: "button" }, `ACTION-SLOT ${frame.request.id} ${summary ? `${summary.uncheckedCount}/${summary.total}` : "no-scope"}`);
  }
  const SLOTS = { actions: createElement(ActionSlot) };
  const checklistTab = () => within(dialog()!).getByRole("tab", { name: /^Pre-approval Checklist/ });
  const checklistItem = (name: string) => within(dialog()!).getByRole("button", { name }) as HTMLButtonElement;
  async function showChecklist() {
    fireEvent.click(checklistTab());
    await flush();
    return within(dialog()!).getByTestId("trade-request-checklist");
  }

  async function openFromQueue(extra: Partial<Parameters<typeof TradingQueue>[0]> = {}) {
    replies = [page(3, 3, null)];
    renderQueue(true, extra);
    await flush();
    fireEvent.click(screen.getByRole("row", { name: "View request REQ-002" }));
    await flush();
  }

  it("opens from the loaded entry over the queue, at the request address, with no request of its own", async () => {
    await openFromQueue();
    expect(calls).toHaveLength(1);
    expect(loc.path).toBe("/trade-requests/queue/REQ-002");
    expect(within(dialog()!).getByRole("heading", { level: 2 }).textContent).toBe("Client 2 (REQ-002)");
    expect(dialog()!.hasAttribute("open")).toBe(true);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(rows()).toHaveLength(3);
    expect(nav.push).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it.each([
    ["the × button", () => fireEvent.click(within(dialog()!).getAllByRole("button", { name: "Close" })[0])],
    ["the footer Close", () => fireEvent.click(within(dialog()!).getAllByRole("button", { name: "Close" }).at(-1)!)],
    ["Esc", () => fireEvent(dialog()!, new Event("cancel", { cancelable: true }))],
    ["a backdrop click", () => fireEvent.click(dialog()!)],
  ])("%s goes back to the queue, which is still loaded", async (_label, closeIt) => {
    await openFromQueue();
    closeIt();
    await flush();
    expect(window.history.back).toHaveBeenCalledTimes(1);
    expect(loc.path).toBe("/trade-requests/queue");
    expect(dialog()).toBeNull();
    expect(rows()).toHaveLength(3);
    expect(calls).toHaveLength(1);
  });

  it("Back closes it and Forward reopens it from the list, still with no request of its own", async () => {
    await openFromQueue();
    act(() => window.history.back());
    expect(dialog()).toBeNull();
    act(() => go("/trade-requests/queue/REQ-002"));
    await flush();
    expect(within(dialog()!).getByRole("heading", { level: 2 }).textContent).toBe("Client 2 (REQ-002)");
    expect(calls).toHaveLength(1);
  });

  it("the queue keeps refreshing every 30 seconds behind it and the dialog shows the refreshed entry", async () => {
    await openFromQueue();
    replies = [{ ok: true, body: { ok: true, data: { data: [entry(3), { ...entry(2), status: "Approved", updatedAt: "u2-approved" }, entry(1)], nextCursor: null } } }];
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(calls).toHaveLength(2);
    expect(within(dialog()!).getAllByText("Approved").length).toBeGreaterThan(0);
  });

  it("opened from the queue: the Pre-approval Checklist tab loads once, a reviewer edits it, and the actions slot sees its summary", async () => {
    await openFromQueue({ detail: SLOTS });
    expect(ck.read).toHaveBeenCalledTimes(1);
    expect(ck.read).toHaveBeenCalledWith("REQ-002");
    expect(checklistTab().textContent).toBe("Pre-approval Checklist (6)");
    expect(within(dialog()!).getByRole("button", { name: /^ACTION-SLOT / }).textContent).toBe("ACTION-SLOT REQ-002 6/7");
    const panel = await showChecklist();
    expect(within(panel).getByText("1 of 7 complete")).toBeTruthy();
    fireEvent.click(checklistItem("Asset location completed"));
    expect(checklistItem("Asset location completed").getAttribute("aria-pressed")).toBe("true");
    expect(ck.write).toHaveBeenLastCalledWith("REQ-002", { key: "asset_location", checked: true, value: "" });
    expect(checklistTab().textContent).toBe("Pre-approval Checklist (5)");
    expect(within(dialog()!).getByRole("button", { name: /^ACTION-SLOT / }).textContent).toBe("ACTION-SLOT REQ-002 5/7");
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(ck.read).toHaveBeenCalledTimes(1);
    expect(checklistItem("Asset location completed").getAttribute("aria-pressed")).toBe("true");
  });

  it("opened from the queue: an advisor reads the checklist, and a decided request locks it for reviewers", async () => {
    replies = [page(3, 3, null)];
    renderQueue(false);
    await flush();
    fireEvent.click(screen.getByRole("row", { name: "View request REQ-002" }));
    await flush();
    let panel = await showChecklist();
    expect(checklistItem("Asset location completed").disabled).toBe(true);
    expect(panel.textContent).toMatch(/Read-only/);
    cleanup();
    loc.path = "/trade-requests/queue";
    replies = [page(3, 3, null)];
    renderQueue(true);
    await flush();
    fireEvent.click(screen.getByRole("row", { name: "View request REQ-003" }));
    await flush();
    expect(within(dialog()!).getAllByText("Approved").length).toBeGreaterThan(0);
    panel = await showChecklist();
    expect(checklistItem("Asset location completed").disabled).toBe(true);
    expect(panel.textContent).toMatch(/locked/);
  });

  it("opened from the queue: a checklist that fails to load leaves the other tabs working", async () => {
    ck.read.mockResolvedValue({ ok: false, message: "Service Unavailable" });
    await openFromQueue();
    expect(checklistTab().textContent).toBe("Pre-approval Checklist (7)");
    await showChecklist();
    fireEvent.click(within(dialog()!).getByRole("tab", { name: "Audit Trail" }));
    expect(within(dialog()!).getByText("Request Created")).toBeTruthy();
    fireEvent.click(within(dialog()!).getByRole("tab", { name: "Request Details" }));
    expect(within(dialog()!).getByText("Client & Accounts")).toBeTruthy();
  });

  it("a direct link shows the queue with the loaded request over it; closing goes to the queue address", async () => {
    loc.path = "/trade-requests/REQ-SYN1";
    replies = [page(3, 3, null)];
    const request = { ...entry(9), id: "REQ-SYN1", clientName: "Synthetic Family", status: "Pending Review" };
    renderQueue(true, { direct: { id: "REQ-SYN1", kind: "found", request: request as never, accounts: [] }, detail: SLOTS });
    await flush();
    expect(within(dialog()!).getByRole("heading", { level: 2 }).textContent).toBe("Synthetic Family (REQ-SYN1)");
    expect(ck.read).toHaveBeenCalledWith("REQ-SYN1");
    expect(checklistTab().textContent).toBe("Pre-approval Checklist (6)");
    expect(within(dialog()!).getByRole("button", { name: /^ACTION-SLOT / }).textContent).toBe("ACTION-SLOT REQ-SYN1 6/7");
    await showChecklist();
    fireEvent.click(checklistItem("Asset location completed"));
    expect(ck.write).toHaveBeenLastCalledWith("REQ-SYN1", { key: "asset_location", checked: true, value: "" });
    expect(rows()).toHaveLength(3);
    fireEvent.click(within(dialog()!).getAllByRole("button", { name: "Close" }).at(-1)!);
    await flush();
    expect(nav.push).toHaveBeenCalledWith("/trade-requests/queue", { scroll: false });
    expect(window.history.back).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    expect(rows()).toHaveLength(3);
  });

  it("a direct link to a missing request shows not found above the queue (AC-10)", async () => {
    loc.path = "/trade-requests/REQ-NOPE";
    replies = [page(3, 3, null)];
    renderQueue(true, { direct: { id: "REQ-NOPE", kind: "not_found" } });
    await flush();
    const card = screen.getByTestId("trade-request-not-found");
    expect(card.textContent).toContain("Request not found. It may have been removed or you may not have access.");
    expect(within(card).getByRole("link", { name: "Back to Queue" }).getAttribute("href")).toBe("/trade-requests/queue");
    expect(dialog()).toBeNull();
    expect(rows()).toHaveLength(3);
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("a direct link that failed shows the failure with Retry above the queue (AC-83)", async () => {
    loc.path = "/trade-requests/REQ-SYN1";
    replies = [page(3, 3, null)];
    renderQueue(true, { direct: { id: "REQ-SYN1", kind: "failed", message: "Validation failed: ID is too long" } });
    await flush();
    const card = screen.getByTestId("trade-request-load-failed");
    expect(within(card).getByRole("alert").textContent).toBe("Validation failed: ID is too long");
    expect(within(card).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(rows()).toHaveLength(3);
  });

  it("a request a refresh drops from the list stays open, unmounted never, keeping its tab and slot state", async () => {
    function SlotState() {
      const frame = useRequestDetailFrame();
      const [count, setCount] = useState(0);
      return createElement("button", { type: "button", onClick: () => { setCount(count + 1); frame.setError("Slot error"); } }, `Slot ${frame.request.status} ${count}`);
    }
    replies = [page(120, 50, "c1")];
    renderQueue(true, { detail: { actions: createElement(SlotState) } });
    await flush();
    replies = [page(70, 50, null)];
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));
    await flush();
    fireEvent.click(screen.getByRole("row", { name: "View request REQ-060" }));
    await flush();
    const opened = dialog()!;
    fireEvent.click(within(opened).getByRole("tab", { name: "Audit Trail" }));
    fireEvent.click(within(opened).getByRole("button", { name: /^Slot / }));
    expect(within(opened).getByRole("button", { name: /^Slot / }).textContent).toBe("Slot Pending Review 1");

    replies = [page(121, 50, "c2")];
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(rows().some((row) => row.getAttribute("data-request-id") === "REQ-060")).toBe(false);
    expect(dialog()).toBe(opened);
    expect(within(opened).getByRole("tab", { name: "Audit Trail" }).getAttribute("aria-selected")).toBe("true");
    expect(within(opened).getByRole("alert").textContent).toBe("Slot error");
    expect(within(opened).getByRole("button", { name: /^Slot / }).textContent).toBe("Slot Pending Review 1");
    expect(nav.replace).not.toHaveBeenCalled();
    expect(ck.read).toHaveBeenCalledTimes(1);

    replies = [{ ok: true, body: { ok: true, data: { data: [{ ...entry(60), status: "Approved", updatedAt: "u60-approved" }], nextCursor: null } } }];
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(dialog()).toBe(opened);
    expect(within(opened).getByRole("button", { name: /^Slot / }).textContent).toBe("Slot Approved 1");
    expect(within(opened).getByRole("tab", { name: "Audit Trail" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(within(opened).getAllByRole("button", { name: "Close" }).at(-1)!);
    await flush();
    expect(loc.path).toBe("/trade-requests/queue");
    expect(dialog()).toBeNull();
  });

  it("a double click opens the request with one history entry", async () => {
    replies = [page(3, 3, null)];
    renderQueue(true);
    await flush();
    const row = screen.getByRole("row", { name: "View request REQ-002" });
    fireEvent.click(row);
    fireEvent.click(row);
    expect(window.history.pushState).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog()!).getAllByRole("button", { name: "Close" }).at(-1)!);
    expect(loc.path).toBe("/trade-requests/queue");
  });

  it("a queue address for a request the list does not hold is loaded as a direct link", async () => {
    loc.path = "/trade-requests/queue/REQ-999";
    replies = [page(3, 3, null)];
    renderQueue(true);
    await flush();
    expect(nav.replace).toHaveBeenCalledWith("/trade-requests/REQ-999", { scroll: false });
    expect(dialog()).toBeNull();
  });
});

describe("Home", () => {
  const counts = { ok: true, body: { ok: true, data: { total: 112, pendingReview: 20, needsInfo: 19, approved: 37 } } };
  const tile = (key: string) => document.querySelector(`[data-count="${key}"]`) as HTMLElement;

  it("shows loading tiles, then the four firm-wide counts with their hover text (AC-31)", async () => {
    replies = [counts];
    render(createElement(TradeRequestsHome, { firstName: "Dana", reviewer: true }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Welcome back, Dana");
    expect(tile("total").textContent).toContain("…");
    await flush();
    expect(calls[0].url.pathname).toBe("/api/trade-requests/counts");
    expect(tile("total").textContent).toBe("Total Requests112");
    expect(tile("pendingReview").textContent).toBe("Pending Review20");
    expect(tile("needsInfo").textContent).toBe("Needs Info19");
    expect(tile("approved").textContent).toBe("Approved / Done37");
    expect(tile("approved").getAttribute("title")).toBe("Approved or completed requests");
  });

  it("cards open New Request and the Trading Queue with the role's description (AC-32, AC-108, AC-110)", async () => {
    replies = [counts];
    const { unmount } = render(createElement(TradeRequestsHome, { firstName: "Dana", reviewer: true }));
    await flush();
    expect(screen.getByRole("link", { name: /New Trade Request/ }).getAttribute("href")).toBe("/trade-requests/new");
    const queue = screen.getByRole("link", { name: /Trading Queue/ });
    expect(queue.getAttribute("href")).toBe("/trade-requests/queue");
    expect(queue.textContent).toContain("Review and manage all pending trade requests.");
    unmount();
    replies = [counts];
    render(createElement(TradeRequestsHome, { firstName: "Avery", reviewer: false }));
    await flush();
    expect(screen.getByRole("link", { name: /Trading Queue/ }).textContent).toContain("View all trade requests and their status.");
  });

  it("failed counts show 'Unable to load stats.' with Retry in place of the tiles (AC-81)", async () => {
    replies = [{ ok: false, status: 503, body: {} }];
    render(createElement(TradeRequestsHome, { firstName: "Dana", reviewer: true }));
    await flush();
    expect(screen.getByTestId("trade-requests-stats-failed").textContent).toContain("Unable to load stats.");
    expect(tile("total")).toBeNull();
    replies = [counts];
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(tile("total").textContent).toBe("Total Requests112");
  });

  it("Retry loads with an abort signal, and unmounting aborts the load in flight", async () => {
    const first = deferred();
    replies = [first.promise];
    const view = render(createElement(TradeRequestsHome, { firstName: "Dana", reviewer: true }));
    await flush();
    replies = [{ ok: false, status: 503, body: {} }];
    await act(async () => { first.resolve({ ok: false, status: 503, body: {} }); await vi.advanceTimersByTimeAsync(0); });
    const slow = deferred();
    replies = [slow.promise];
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const retry = calls.at(-1)!;
    expect(retry.signal).toBeDefined();
    view.unmount();
    expect(retry.signal?.aborted).toBe(true);
    await act(async () => { slow.resolve(counts as Body); await vi.advanceTimersByTimeAsync(0); });
  });

  it("an ended session shows the sign-in prompt instead of counts", async () => {
    replies = [{ ok: false, status: 401, body: { error: "unauthorized" } }];
    render(createElement(TradeRequestsHome, { firstName: "Dana", reviewer: true }));
    await flush();
    expect(screen.getByTestId("trade-requests-session-ended")).toBeTruthy();
    expect(tile("total")).toBeNull();
  });

  it("an unconfirmed person gets the not-set-up card (AC-22)", async () => {
    replies = [{ ok: true, body: { ok: false, outcome: "not_set_up", message: "x" } }];
    render(createElement(TradeRequestsHome, { firstName: "Dana", reviewer: true }));
    await flush();
    expect(screen.getByTestId("trade-requests-not-set-up")).toBeTruthy();
  });
});
