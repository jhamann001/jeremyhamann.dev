import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ enabled: vi.fn(), session: vi.fn(), queue: vi.fn() }));
vi.mock("@/lib/flags", () => ({ tradeRequestsWorkspaceEnabled: m.enabled }));
vi.mock("@/lib/auth/request-session", () => ({ getRequestSession: m.session }));
vi.mock("@/components/trade-requests/queue/TradingQueue", () => ({
  TradingQueue: (props: unknown) => { m.queue(props); return "QUEUE"; },
}));
vi.mock("@/components/trade-requests/detail/status-actions", () => ({ RequestStatusActions: () => null }));
vi.mock("@/components/trade-requests/detail/resubmit-clone-actions", () => ({ ResubmitCloneActions: () => null }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: () => { throw new Error("REDIRECT"); },
}));

import Layout from "@/app/(authenticated)/trade-requests/queue/layout";
import { QueueExportAction } from "@/components/trade-requests/queue/export-action";

// ticket: the shared queue layout puts the export in the queue toolbar slot
// for every workspace role.

beforeEach(() => {
  vi.resetAllMocks();
  m.enabled.mockReturnValue(true);
});

describe("queue layout export slot (ticket)", () => {
  it("passes the export action, with the signed-in person as exporter, for every workspace role", async () => {
    for (const role of ["ADMIN", "OPERATIONS", "ADVISOR"]) {
      m.session.mockResolvedValue({ user: { role, name: "Riley Ops", email: "ops@example.invalid" } });
      expect(renderToStaticMarkup(await Layout({ children: "CHILD" }))).toBe("QUEUECHILD");
      const props = m.queue.mock.lastCall![0] as { actions: { type: unknown; props: unknown }; exporter: unknown };
      expect(props.exporter).toEqual({ name: "Riley Ops", email: "ops@example.invalid" });
      expect(props.actions.type).toBe(QueueExportAction);
      expect(props.actions.props).toEqual({ exporter: { name: "Riley Ops", email: "ops@example.invalid" } });
    }
  });

  it("renders no queue (and no export) for roles without workspace access", async () => {
    for (const role of ["CLIENT_SERVICE", "VIEWER"]) {
      m.session.mockResolvedValue({ user: { role, name: "Casey", email: "cs@example.invalid" } });
      expect(await Layout({ children: "CHILD" })).toBeNull();
    }
    expect(m.queue).not.toHaveBeenCalled();
  });
});
