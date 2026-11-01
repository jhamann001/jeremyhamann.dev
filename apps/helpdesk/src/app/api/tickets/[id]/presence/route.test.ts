/**
 * GET /api/tickets/[id]/presence — the refusal path.
 *
 * The finding this covers: the route recorded one permanent, hash-chained `AUTHZ_DENIED` row per
 * refusal, and this is the one Wave B surface designed to be POLLED (`PresenceChip` re-fetches every
 * 30 seconds). A tab left open on a ticket whose queue the viewer has lost appended two rows a
 * minute — 2,880 a day — to an append-only ledger with no retention job, each taking the global
 * `AuditLog.chain` advisory lock every other audited write queues behind.
 *
 * What is under test is therefore the SHAPE of the refusal, not presence itself: the first refusal
 * still writes a full row naming the actor and the ticket, repeats inside the window write nothing,
 * the count reaches the ledger on the next row, and two different tickets are still two rows —
 * enumeration by an authenticated viewer is exactly what the row exists to show.
 *
 * No database: the session, presence and the audit writer are mocked. The throttle is the REAL one,
 * reset between tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSession = vi.hoisted(() => ({ requireViewerOrThrow: vi.fn() }));
vi.mock("@/lib/session", () => mockSession);

const mockDb = vi.hoisted(() => ({ prisma: {} }));
vi.mock("@/lib/db", () => mockDb);

const mockPresence = vi.hoisted(() => ({ ticketPresence: vi.fn() }));
vi.mock("@/server/presence", () => mockPresence);

const mockAudit = vi.hoisted(() => ({
  actorFromViewer: vi.fn(() => ({ id: "u_ops", email: "ops@wm-helpdesk.local", groups: ["ops_team"] })),
  deniedEntityType: vi.fn((what: string, ticketId?: string | null) =>
    ticketId ? "TICKET" : /\baudit:/.test(what) ? "AUDIT_LOG" : "QUEUE",
  ),
  writeAudit: vi.fn(async () => {}),
}));
vi.mock("@/lib/audit", () => mockAudit);

import { ForbiddenError } from "@/lib/errors";
import { resetDenialThrottle } from "@/lib/denial-throttle";
import { PRESENCE_DENIAL_WINDOW_MS } from "@/lib/denial-throttle";
import { GET } from "@/app/api/tickets/[id]/presence/route";

const VIEWER = {
  id: "u_ops",
  email: "ops@wm-helpdesk.local",
  name: "Mia Ops",
  image: null,
  groups: ["ops_team"],
  isDev: false,
};

type AuditCall = [
  client: unknown,
  actor: { id: string | null; email: string },
  ctx: unknown,
  entry: {
    action: string;
    entityType: string;
    entityId: string | null;
    ticketId: string | null;
    fieldChanged: string;
    newValue: string;
    metadata: { route: string; coalesced: boolean; count: number; perInstance: boolean };
  },
];

function auditCall(index: number): AuditCall {
  return mockAudit.writeAudit.mock.calls[index] as unknown as AuditCall;
}

function call(ticketId: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/tickets/${ticketId}/presence`), {
    params: Promise.resolve({ id: ticketId }),
  });
}

/** A refusal on a ticket that exists but sits in a queue this viewer may not read. */
function forbid(ticketId: string): void {
  mockPresence.ticketPresence.mockRejectedValueOnce(new ForbiddenError("Forbidden: queue:read", ticketId));
}

describe("presence refusals are coalesced", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDenialThrottle();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T12:00:00.000Z"));
    mockSession.requireViewerOrThrow.mockResolvedValue(VIEWER);
    mockAudit.actorFromViewer.mockReturnValue({ id: "u_ops", email: "ops@wm-helpdesk.local", groups: ["ops_team"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetDenialThrottle();
  });

  it("writes ONE full AUTHZ_DENIED row for the first refusal, naming the actor and the ticket", async () => {
    forbid("tkt_1");
    const res = await call("tkt_1");

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "not_found" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    expect(mockAudit.writeAudit).toHaveBeenCalledTimes(1);
    const entry = auditCall(0)[3];
    expect(auditCall(0)[1].email).toBe("ops@wm-helpdesk.local");
    expect(entry.action).toBe("AUTHZ_DENIED");
    expect(entry.entityType).toBe("TICKET");
    expect(entry.entityId).toBe("tkt_1");
    expect(entry.ticketId).toBe("tkt_1");
    expect(entry.fieldChanged).toBe("capability");
    expect(entry.newValue).toBe("presence:read");
    expect(entry.metadata.count).toBe(1);
    expect(entry.metadata.coalesced).toBe(true);
    expect(entry.metadata.route).toBe("/api/tickets/[id]/presence");
    expect(entry.metadata.perInstance).toBe(true);
  });

  it("writes nothing for the repeats inside the window, and answers 404 every time", async () => {
    for (let i = 0; i < 4; i++) {
      forbid("tkt_1");
      // 30 seconds apart: the interval PresenceChip actually polls on.
      vi.setSystemTime(new Date(Date.parse("2026-09-20T12:00:00.000Z") + i * 30_000));
      const res = await call("tkt_1");
      expect(res.status).toBe(404);
    }
    expect(mockAudit.writeAudit).toHaveBeenCalledTimes(1);
  });

  it("states the suppressed count on the next window's row", async () => {
    for (let i = 0; i < 4; i++) {
      forbid("tkt_1");
      vi.setSystemTime(new Date(Date.parse("2026-09-20T12:00:00.000Z") + i * 30_000));
      await call("tkt_1");
    }
    expect(mockAudit.writeAudit).toHaveBeenCalledTimes(1);

    forbid("tkt_1");
    vi.setSystemTime(new Date(Date.parse("2026-09-20T12:00:00.000Z") + PRESENCE_DENIAL_WINDOW_MS + 1));
    await call("tkt_1");

    expect(mockAudit.writeAudit).toHaveBeenCalledTimes(2);
    // One row standing for the three refusals it suppressed plus itself: nothing is dropped.
    expect(auditCall(1)[3].metadata.count).toBe(4);
  });

  it("keeps one row per ticket, so enumeration is still row by row", async () => {
    forbid("tkt_1");
    await call("tkt_1");
    forbid("tkt_2");
    await call("tkt_2");

    expect(mockAudit.writeAudit).toHaveBeenCalledTimes(2);
    expect(auditCall(0)[3].ticketId).toBe("tkt_1");
    expect(auditCall(1)[3].ticketId).toBe("tkt_2");
  });

  it("writes nothing at all when the read is allowed", async () => {
    mockPresence.ticketPresence.mockResolvedValueOnce({ viewers: [], generatedAt: "2026-09-20T12:00:00.000Z" });
    const res = await call("tkt_1");
    expect(res.status).toBe(200);
    expect(mockAudit.writeAudit).not.toHaveBeenCalled();
  });

  it("propagates a failed denial insert rather than answering an unaudited 404 (I3/I5)", async () => {
    forbid("tkt_1");
    mockAudit.writeAudit.mockRejectedValueOnce(new Error("ledger down"));
    await expect(call("tkt_1")).rejects.toThrow("ledger down");
  });
});
