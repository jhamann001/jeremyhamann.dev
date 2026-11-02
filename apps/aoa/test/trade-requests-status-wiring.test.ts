import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ enabled: vi.fn(), session: vi.fn() }));
vi.mock("@/lib/flags", () => ({ tradeRequestsWorkspaceEnabled: m.enabled }));
vi.mock("@/lib/auth/request-session", () => ({ getRequestSession: m.session }));
vi.mock("@/components/trade-requests/queue/TradingQueue", () => ({ TradingQueue: () => null }));
vi.mock("@/components/trade-requests/detail/status-actions", () => ({ RequestStatusActions: () => null }));
vi.mock("@/components/trade-requests/detail/resubmit-clone-actions", () => ({ ResubmitCloneActions: () => null }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: () => { throw new Error("REDIRECT"); },
}));

import QueueLayout from "@/app/(authenticated)/trade-requests/queue/layout";
import { TradingQueue } from "@/components/trade-requests/queue/TradingQueue";
import { RequestStatusActions } from "@/components/trade-requests/detail/status-actions";
import { ResubmitCloneActions } from "@/components/trade-requests/detail/resubmit-clone-actions";

// ticket: the queue path hands the request dialog the reviewer status
// actions (and ticket the advisor's Edit & Resubmit and Clone) with the viewer's role (the direct-link page is covered in
// trade-requests-detail-route).

beforeEach(() => {
  vi.resetAllMocks();
  m.enabled.mockReturnValue(true);
});

describe("Trading Queue layout (ticket)", () => {
  it.each(["ADMIN", "OPERATIONS", "ADVISOR"])("passes the status actions for %s in the detail slot", async (role) => {
    m.session.mockResolvedValue({ user: { role, name: "Riley Ops", email: "ops@example.invalid" } });
    const tree = (await QueueLayout({ children: null }))!;
    const queue = (tree.props.children as Array<{ type: unknown; props: Record<string, unknown> }>)[0];
    expect(queue.type).toBe(TradingQueue);
    expect(queue.props.detail).toEqual({ actions: expect.objectContaining({ props: { children: [
      expect.objectContaining({ type: RequestStatusActions, props: { role } }),
      expect.objectContaining({ type: ResubmitCloneActions, props: { role } }),
    ] } }) });
  });

  it("flag off: not found before any session read", async () => {
    m.enabled.mockReturnValue(false);
    await expect(QueueLayout({ children: null })).rejects.toThrow("NOT_FOUND");
    expect(m.session).not.toHaveBeenCalled();
  });
});
