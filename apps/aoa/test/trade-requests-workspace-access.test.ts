import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ enabled: vi.fn(), noPlanCopy: vi.fn(), session: vi.fn(), pathname: "/trade-requests" }));
vi.mock("@/lib/flags", () => ({ tradeRequestsWorkspaceEnabled: m.enabled, tradeRequestsNoPlanCopyEnabled: m.noPlanCopy }));
vi.mock("@/lib/auth/request-session", () => ({ getRequestSession: m.session }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: () => { throw new Error("REDIRECT"); },
  usePathname: () => m.pathname,
}));
const sections = vi.hoisted(() => vi.fn());
vi.mock("@/lib/trade-requests/workspace-sections", () => ({ tradeRequestsWorkspaceSections: sections }));

import Layout from "@/app/(authenticated)/trade-requests/layout";
import Page from "@/app/(authenticated)/trade-requests/page";
import { TradeRequestsNotSetUp } from "@/components/trade-requests/WorkspaceNotices";
import { WorkspaceFrame } from "@/components/trade-requests/WorkspaceFrame";
import { useNoPlanCopy } from "@/components/trade-requests/form/NoPlanCopy";
import { TRADE_REQUESTS_COPY } from "@/lib/trade-requests/copy";
import { currentWorkspaceView } from "@/lib/trade-requests/routes";

const ROLES = ["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE", "VIEWER"];
const child = createElement("div", { "data-testid": "child" }, "CHILD-CONTENT");

async function layoutHtml() {
  return renderToStaticMarkup(await Layout({ children: child }));
}

function signIn(role: string) {
  m.session.mockResolvedValue({ user: { role, email: `${role.toLowerCase()}@example.invalid` } });
}

beforeEach(() => {
  vi.resetAllMocks();
  m.enabled.mockReturnValue(true);
  m.noPlanCopy.mockReturnValue(false);
  m.pathname = "/trade-requests";
  signIn("OPERATIONS");
});

describe("/trade-requests workspace gate (ticket)", () => {
  it("flag off: layout and page return not found for every role", async () => {
    m.enabled.mockReturnValue(false);
    for (const role of ROLES) {
      signIn(role);
      await expect(Layout({ children: child })).rejects.toThrow("NOT_FOUND");
      await expect(Page()).rejects.toThrow("NOT_FOUND");
    }
    expect(m.session).not.toHaveBeenCalled();
  });

  it("flag on: workspace roles get the frame, the sub-navigation and the Home header", async () => {
    for (const role of ["ADMIN", "OPERATIONS", "ADVISOR"]) {
      signIn(role);
      const html = await layoutHtml();
      expect(html).toContain("CHILD-CONTENT");
      expect(html).toContain('aria-label="Trade Requests workspace"');
      expect(html).toContain('href="/trade-requests"');
      expect(html).toContain('href="/trade-requests/new"');
      expect(html).toContain('href="/trade-requests/queue"');
      expect(html).not.toContain("permission to view");
      const page = renderToStaticMarkup((await Page())!);
      expect(page).toContain("Trade Requests");
      expect(page).toContain(`<h1>Welcome back, ${role.toLowerCase()}</h1>`);
    }
  });

  // auth.ts normalizes session roles to the five application roles, so these
  // are the only non-workspace roles a session can carry.
  it("flag on: CLIENT_SERVICE and VIEWER get the permission screen and no workspace content", async () => {
    for (const role of ["CLIENT_SERVICE", "VIEWER"]) {
      signIn(role);
      const html = await layoutHtml();
      expect(html).toContain("You don&#x27;t have permission to view this page.");
      expect(html).toContain('href="/command-center"');
      expect(html).toContain("Go Home");
      expect(html).not.toContain("CHILD-CONTENT");
      expect(html).not.toContain("Trade Requests workspace");
      expect(await Page()).toBeNull();
    }
  });

  it("hands the no-plan copy switch to the New Request form in both positions (ticket)", async () => {
    function Probe() {
      return createElement("span", null, `no-plan-copy:${useNoPlanCopy()}`);
    }
    const probe = createElement(Probe);
    expect(renderToStaticMarkup(await Layout({ children: probe }))).toContain("no-plan-copy:false");
    m.noPlanCopy.mockReturnValue(true);
    expect(renderToStaticMarkup(await Layout({ children: probe }))).toContain("no-plan-copy:true");
  });

  it("no session redirects to sign-in", async () => {
    m.session.mockResolvedValue(null);
    await expect(Layout({ children: child })).rejects.toThrow("REDIRECT");
    await expect(Page()).rejects.toThrow("REDIRECT");
  });

  it("the sub-navigation marks the current view", () => {
    expect(currentWorkspaceView("/trade-requests")).toBe("home");
    expect(currentWorkspaceView("/trade-requests/")).toBe("home");
    expect(currentWorkspaceView("/trade-requests/new")).toBe("newRequest");
    expect(currentWorkspaceView("/trade-requests/new/abc")).toBe("newRequest");
    expect(currentWorkspaceView("/trade-requests/queue")).toBe("tradingQueue");
    expect(currentWorkspaceView("/trade-requests/7f1c")).toBe("tradingQueue");
    m.pathname = "/trade-requests/queue";
    const html = renderToStaticMarkup(createElement(WorkspaceFrame, null, child));
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('<a aria-current="page" href="/trade-requests/queue">Trading Queue</a>');
  });

  it("the not-set-up card shows the AC-22 message", () => {
    expect(renderToStaticMarkup(createElement(TradeRequestsNotSetUp)))
      .toContain("Your account is not set up for Trade Requests — contact Operations.");
  });

  it("copy matches the epic byte for byte", () => {
    expect(TRADE_REQUESTS_COPY.notSetUp).toBe("Your account is not set up for Trade Requests \u2014 contact Operations.");
    expect(TRADE_REQUESTS_COPY.notSetUp.includes("\u2014")).toBe(true);
    expect(TRADE_REQUESTS_COPY.noPermission).toBe("You don\u0027t have permission to view this page.");
    expect(TRADE_REQUESTS_COPY.noPermission.includes("\u0027")).toBe(true);
    expect(TRADE_REQUESTS_COPY.noPermission.includes("\u2019")).toBe(false);
  });
});
