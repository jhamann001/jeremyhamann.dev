import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ enabled: vi.fn(), session: vi.fn(), load: vi.fn(), queue: vi.fn() }));
vi.mock("@/lib/flags", () => ({ tradeRequestsWorkspaceEnabled: m.enabled }));
vi.mock("@/lib/auth/request-session", () => ({ getRequestSession: m.session }));
vi.mock("@/lib/trade-requests/detail", () => ({ loadTradeRequestDetail: m.load }));
vi.mock("@/components/trade-requests/queue/TradingQueue", () => ({
  TradingQueue: (props: unknown) => { m.queue(props); return "QUEUE-WITH-DETAIL"; },
}));
vi.mock("@/components/trade-requests/detail/status-actions", () => ({ RequestStatusActions: () => null }));
vi.mock("@/components/trade-requests/detail/resubmit-clone-actions", () => ({ ResubmitCloneActions: () => null }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: () => { throw new Error("REDIRECT"); },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import Page from "@/app/(authenticated)/trade-requests/[id]/page";
import { RequestStatusActions } from "@/components/trade-requests/detail/status-actions";
import { ResubmitCloneActions } from "@/components/trade-requests/detail/resubmit-clone-actions";

// ticket: the direct-link route — flag and role gate, then the Trading Queue
// with the loaded request, not-found (AC-10) or failure (AC-83) over it, or the
// not-set-up card. The queue's rendering of each is in trade-requests-queue-ui.

const params = (id: string) => Promise.resolve({ id });
async function html(id = "REQ-SYN1") {
  return renderToStaticMarkup(await Page({ params: params(id) }));
}
function signIn(role: string) {
  m.session.mockResolvedValue({ user: { role, name: "Riley Ops", email: "ops@example.invalid" } });
}

beforeEach(() => {
  vi.resetAllMocks();
  m.enabled.mockReturnValue(true);
  signIn("OPERATIONS");
});

describe("/trade-requests/[id] (ticket)", () => {
  it("flag off: not found for every role, before any session or service call", async () => {
    m.enabled.mockReturnValue(false);
    await expect(Page({ params: params("REQ-SYN1") })).rejects.toThrow("NOT_FOUND");
    expect(m.session).not.toHaveBeenCalled();
    expect(m.load).not.toHaveBeenCalled();
  });

  it("CLIENT_SERVICE and VIEWER get nothing from the page (the layout shows the permission screen)", async () => {
    for (const role of ["CLIENT_SERVICE", "VIEWER", "HEAD_OF_ADVISORY"]) {
      signIn(role);
      expect(await Page({ params: params("REQ-SYN1") })).toBeNull();
    }
    expect(m.load).not.toHaveBeenCalled();
  });

  it("workspace roles see the queue with the request over it and the signed-in person as exporter (AC-9)", async () => {
    for (const role of ["ADMIN", "OPERATIONS", "ADVISOR"]) {
      signIn(role);
      m.load.mockResolvedValue({ kind: "found", request: { id: "REQ-SYN1" }, accounts: [] });
      expect(await html()).toBe("QUEUE-WITH-DETAIL");
      expect(m.queue).toHaveBeenLastCalledWith({
        reviewer: role !== "ADVISOR",
        role,
        exporter: { name: "Riley Ops", email: "ops@example.invalid" },
        actions: expect.objectContaining({ props: { exporter: { name: "Riley Ops", email: "ops@example.invalid" } } }),
        direct: { id: "REQ-SYN1", kind: "found", request: { id: "REQ-SYN1" }, accounts: [] },
        detail: { actions: expect.objectContaining({ props: { children: [
          expect.objectContaining({ type: RequestStatusActions, props: { role } }),
          expect.objectContaining({ type: ResubmitCloneActions, props: { role } }),
        ] } }) },
      });
    }
    expect(m.load).toHaveBeenCalledWith("REQ-SYN1");
  });

  it("not found: the queue with the not-found screen (AC-10)", async () => {
    m.load.mockResolvedValue({ kind: "not_found" });
    expect(await html("REQ-NOPE")).toBe("QUEUE-WITH-DETAIL");
    expect(m.queue.mock.lastCall![0]).toMatchObject({ direct: { id: "REQ-NOPE", kind: "not_found" } });
  });

  it("other failures: the queue with the failure and its message (AC-83)", async () => {
    m.load.mockResolvedValue({ kind: "failed", message: "Validation failed: id: ID is too long" });
    await html();
    expect(m.queue.mock.lastCall![0]).toMatchObject({ direct: { id: "REQ-SYN1", kind: "failed", message: "Validation failed: id: ID is too long" } });
  });

  it("a person the service cannot confirm sees the not-set-up card", async () => {
    m.load.mockResolvedValue({ kind: "not_set_up", message: "x" });
    expect(await html()).toContain("Your account is not set up for Trade Requests — contact Operations.");
  });
});
