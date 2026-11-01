/**
 * GET /tickets/wm/[number] — the deep link must not be an existence oracle.
 *
 * The finding this covers: the handler authenticated and then resolved the WM number against EVERY
 * queue, 302-ing when it resolved and 404-ing when it did not. Any authenticated staff member could
 * therefore walk `1..N` and learn which ticket numbers exist in queues they cannot read (and collect
 * the internal ids), with the detail page's refusal arriving only after the answer, and no audit row
 * anywhere recording the sweep. The number is now resolved INSIDE `readableQueues(viewer.groups)`,
 * so "does not exist" and "exists somewhere you cannot read" are the same 404.
 *
 * The real `@/lib/rbac` runs — the scope this route passes IS the policy, so mocking it would test
 * nothing. `@/lib/session` and `@/server/tickets` are mocked: what is under test is which queues the
 * route hands the resolver, and that it still redirects and still writes no audit row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OktaGroup, QueueKey, Viewer } from "@/types/domain";

/** `notFound()` throws in Next; a plain sentinel keeps the assertion about the route, not the framework. */
class NotFoundSignal extends Error {
  constructor() {
    super("NEXT_NOT_FOUND");
    this.name = "NotFoundSignal";
  }
}

const mockNav = vi.hoisted(() => ({
  notFound: vi.fn((): never => {
    throw new NotFoundSignal();
  }),
}));
vi.mock("next/navigation", () => mockNav);

const mockSession = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/lib/session", () => mockSession);

const mockTickets = vi.hoisted(() => ({ getTicketIdByNumber: vi.fn() }));
vi.mock("@/server/tickets", () => mockTickets);

const mockAudit = vi.hoisted(() => ({
  writeAudit: vi.fn(),
  writeAuditMany: vi.fn(),
  recordView: vi.fn(),
  recordDenied: vi.fn(),
  recordMaterialRead: vi.fn(),
  recordCoalescedDenial: vi.fn(),
  actorFromViewer: vi.fn(),
}));
vi.mock("@/lib/audit", () => mockAudit);

import { GET } from "@/app/(app)/tickets/wm/[number]/route";

function viewerOf(groups: OktaGroup[]): Viewer {
  return {
    id: `u_${groups.join("_")}`,
    email: `${groups[0]}@wm-helpdesk.local`,
    name: "Deep Link Tester",
    image: null,
    groups,
    isDev: false,
  };
}

function call(raw: string): Promise<Response> {
  return GET(new Request(`https://desk.wm-helpdesk.local/tickets/wm/${raw}`), {
    params: Promise.resolve({ number: raw }),
  });
}

/** The queue scope the route handed the resolver on its single call. */
function scopePassed(): readonly QueueKey[] {
  expect(mockTickets.getTicketIdByNumber).toHaveBeenCalledTimes(1);
  const [, queues] = mockTickets.getTicketIdByNumber.mock.calls[0] as [number, readonly QueueKey[]];
  return queues;
}

beforeEach(() => {
  mockSession.requireUser.mockResolvedValue(viewerOf(["ops_team"]));
  mockTickets.getTicketIdByNumber.mockResolvedValue("tkt_abc");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /tickets/wm/[number]", () => {
  it("resolves the number only within the viewer's readable queues", async () => {
    mockSession.requireUser.mockResolvedValue(viewerOf(["client_services"]));

    await call("42");

    expect(mockTickets.getTicketIdByNumber).toHaveBeenCalledWith(42, ["OPERATIONS", "CLIENT_SERVICE"]);
    expect(scopePassed()).not.toContain("ADVICE");
  });

  it("passes every queue for a viewer who reads every queue", async () => {
    mockSession.requireUser.mockResolvedValue(viewerOf(["compliance_officers"]));

    await call("7");

    expect(scopePassed()).toEqual(["OPERATIONS", "CLIENT_SERVICE", "ADVICE"]);
  });

  it("404s a number outside the readable queues exactly as it 404s one that does not exist", async () => {
    mockSession.requireUser.mockResolvedValue(viewerOf(["client_services"]));
    // What the scoped resolver returns for an ADVICE ticket: nothing, same as for a missing number.
    mockTickets.getTicketIdByNumber.mockResolvedValue(null);

    await expect(call("99")).rejects.toBeInstanceOf(NotFoundSignal);
    expect(mockNav.notFound).toHaveBeenCalledTimes(1);
  });

  it("hands the resolver an empty scope for a viewer with no readable queue, and never redirects", async () => {
    mockSession.requireUser.mockResolvedValue(viewerOf([]));
    mockTickets.getTicketIdByNumber.mockResolvedValue(null);

    await expect(call("1")).rejects.toBeInstanceOf(NotFoundSignal);
    expect(scopePassed()).toEqual([]);
  });

  it("authenticates before it touches the number at all", async () => {
    mockSession.requireUser.mockRejectedValue(new Error("no session"));

    await expect(call("1")).rejects.toThrow("no session");
    expect(mockTickets.getTicketIdByNumber).not.toHaveBeenCalled();
  });

  it("302s to the ticket id, no-store, when the number resolves inside the scope", async () => {
    const res = await call("1024");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/tickets/tkt_abc");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(mockTickets.getTicketIdByNumber).toHaveBeenCalledWith(1024, ["OPERATIONS", "CLIENT_SERVICE", "ADVICE"]);
  });

  it("rejects a non-numeric or out-of-shape segment before any lookup", async () => {
    for (const raw of ["HD-12", "0", "-3", "1.5", "1234567890", ""]) {
      vi.clearAllMocks();
      mockSession.requireUser.mockResolvedValue(viewerOf(["ops_team"]));
      await expect(call(raw)).rejects.toBeInstanceOf(NotFoundSignal);
      expect(mockTickets.getTicketIdByNumber).not.toHaveBeenCalled();
    }
  });

  it("writes no audit row on either outcome — the detail page audits the view", async () => {
    await call("1024");
    mockTickets.getTicketIdByNumber.mockResolvedValue(null);
    await expect(call("1025")).rejects.toBeInstanceOf(NotFoundSignal);

    for (const fn of Object.values(mockAudit)) expect(fn).not.toHaveBeenCalled();
  });
});
