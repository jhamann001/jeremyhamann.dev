import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ session: vi.fn(), aoaServed: vi.fn(), pathname: "/trade-requests" }));
vi.mock("@/lib/auth/request-session", () => ({ getRequestSession: m.session }));
vi.mock("@/lib/trade-requests/serving-state", () => ({ isAoaServed: m.aoaServed }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: () => { throw new Error("REDIRECT"); },
  usePathname: () => m.pathname,
}));
vi.mock("@/components/trade-requests/drift/DriftView", () => ({
  DriftView: (p: { canOverride: boolean }) => createElement("div", { "data-view": "drift", "data-can-override": String(p.canOverride) }, "DRIFT-VIEW"),
}));
vi.mock("@/components/trade-requests/roster/RosterView", () => ({ RosterView: () => createElement("div", { "data-view": "roster" }, "ROSTER-VIEW") }));

import Layout from "@/app/(authenticated)/trade-requests/layout";
import DriftPage from "@/app/(authenticated)/trade-requests/drift/page";
import RosterPage from "@/app/(authenticated)/trade-requests/roster/page";
import { WorkspaceFrame } from "@/components/trade-requests/WorkspaceFrame";
import { tradeRequestsDriftViewEnabled } from "@/lib/flags";
import { currentWorkspaceView, requestIdFromPath } from "@/lib/trade-requests/routes";
import { tradeRequestsWorkspaceSections } from "@/lib/trade-requests/workspace-sections";

const ROLES = ["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE", "VIEWER"];
const NO_PERMISSION = "You don&#x27;t have permission to view this page.";
const searchParams = Promise.resolve({});
const drift = async () => renderToStaticMarkup((await DriftPage({ searchParams }))!);
const roster = async () => renderToStaticMarkup((await RosterPage())!);
const signIn = (role: string) => m.session.mockResolvedValue({ user: { role, email: `${role.toLowerCase()}@example.test` } });

function switches(drift: boolean, rosterAdmin: boolean) {
  vi.stubEnv("EPIC_TRADE_REQUESTS_WORKSPACE", "1");
  vi.stubEnv("EPIC_TRADE_REQUESTS_BACKEND_MOVE", "1");
  vi.stubEnv("TRADE_REQUESTS_DRIFT_VIEW", drift ? "1" : "0");
  vi.stubEnv("TRADE_REQUESTS_ROSTER_ADMIN", rosterAdmin ? "1" : "0");
}

beforeEach(() => {
  vi.resetAllMocks();
  m.pathname = "/trade-requests";
  m.aoaServed.mockResolvedValue(true);
  switches(true, true);
  signIn("ADMIN");
});
afterEach(() => vi.unstubAllEnvs());

describe("Drift and Roster access (ticket)", () => {
  it("the Drift view switch is on only for the exact string 1 together with the epic master", () => {
    for (const [master, view] of [["1", "0"], ["0", "1"], ["1", "true"], ["1", "1 "], [undefined, "1"]]) {
      vi.stubEnv("EPIC_TRADE_REQUESTS_BACKEND_MOVE", master);
      vi.stubEnv("TRADE_REQUESTS_DRIFT_VIEW", view);
      expect(tradeRequestsDriftViewEnabled()).toBe(false);
    }
    vi.stubEnv("EPIC_TRADE_REQUESTS_BACKEND_MOVE", "1");
    vi.stubEnv("TRADE_REQUESTS_DRIFT_VIEW", "1");
    expect(tradeRequestsDriftViewEnabled()).toBe(true);
  });

  it("sections follow the switch, the serving state and the role; the serving state is read only when switched on", async () => {
    switches(false, true);
    for (const role of ROLES) expect(await tradeRequestsWorkspaceSections(role)).toEqual({ drift: false, roster: false });
    expect(m.aoaServed).not.toHaveBeenCalled();
    switches(true, true);
    m.aoaServed.mockResolvedValue(false);
    for (const role of ROLES) expect(await tradeRequestsWorkspaceSections(role)).toEqual({ drift: false, roster: false });
    m.aoaServed.mockResolvedValue(true);
    expect(await tradeRequestsWorkspaceSections("ADMIN")).toEqual({ drift: true, roster: true });
    expect(await tradeRequestsWorkspaceSections("OPERATIONS")).toEqual({ drift: true, roster: false });
    expect(await tradeRequestsWorkspaceSections("ADVISOR")).toEqual({ drift: true, roster: false });
    expect(await tradeRequestsWorkspaceSections("CLIENT_SERVICE")).toEqual({ drift: false, roster: false });
    expect(await tradeRequestsWorkspaceSections("VIEWER")).toEqual({ drift: false, roster: false });
    switches(true, false);
    expect(await tradeRequestsWorkspaceSections("ADMIN")).toEqual({ drift: true, roster: false });
  });

  it("the workspace navigation adds the Drift and Roster pills only for their sections and marks the current one", () => {
    const html = (sections?: { drift: boolean; roster: boolean }) =>
      renderToStaticMarkup(createElement(WorkspaceFrame, { sections, children: createElement("span", null, "child") }));
    for (const none of [undefined, { drift: false, roster: false }]) {
      expect(html(none)).not.toContain('href="/trade-requests/drift"');
      expect(html(none)).not.toContain('href="/trade-requests/roster"');
    }
    expect(html({ drift: true, roster: false })).toContain('href="/trade-requests/drift"');
    expect(html({ drift: true, roster: false })).not.toContain('href="/trade-requests/roster"');
    m.pathname = "/trade-requests/drift";
    expect(html({ drift: true, roster: true })).toContain('<a aria-current="page" href="/trade-requests/drift">Drift</a>');
    expect(html({ drift: true, roster: true })).toContain('<a href="/trade-requests/roster">Roster</a>');
    expect(currentWorkspaceView("/trade-requests/drift")).toBe("drift");
    expect(currentWorkspaceView("/trade-requests/roster/")).toBe("roster");
    expect(requestIdFromPath("/trade-requests/drift")).toBeNull();
    expect(requestIdFromPath("/trade-requests/roster")).toBeNull();
  });

  it("the layout shows the pills while AOA-served and none while standalone-served", async () => {
    const layout = async () => renderToStaticMarkup(await Layout({ children: createElement("span", null, "child") }));
    expect(await layout()).toContain('href="/trade-requests/roster"');
    expect(await layout()).toContain('href="/trade-requests/drift"');
    m.aoaServed.mockResolvedValue(false);
    expect(await layout()).not.toContain('href="/trade-requests/drift"');
    expect(await layout()).not.toContain('href="/trade-requests/roster"');
  });

  it("Drift: workspace roles get the view (overrides for ADMIN and OPERATIONS only); CLIENT_SERVICE and VIEWER get nothing", async () => {
    for (const [role, canOverride] of [["ADMIN", "true"], ["OPERATIONS", "true"], ["ADVISOR", "false"]]) {
      signIn(role);
      expect(await drift()).toContain(`data-can-override="${canOverride}"`);
    }
    for (const role of ["CLIENT_SERVICE", "VIEWER"]) {
      signIn(role);
      expect(await DriftPage({ searchParams })).toBeNull();
      expect(renderToStaticMarkup(await Layout({ children: createElement("span", null, "child") }))).toContain(NO_PERMISSION);
    }
  });

  it("Drift is not found while switched off or standalone-served", async () => {
    switches(false, true);
    await expect(DriftPage({ searchParams })).rejects.toThrow("NOT_FOUND");
    switches(true, true);
    m.aoaServed.mockResolvedValue(false);
    await expect(DriftPage({ searchParams })).rejects.toThrow("NOT_FOUND");
  });

  it("Roster: ADMIN gets the view; OPERATIONS and ADVISOR the permission screen; CLIENT_SERVICE and VIEWER nothing", async () => {
    expect(await roster()).toContain("ROSTER-VIEW");
    for (const role of ["OPERATIONS", "ADVISOR"]) {
      signIn(role);
      const html = await roster();
      expect(html).toContain(NO_PERMISSION);
      expect(html).not.toContain("ROSTER-VIEW");
    }
    for (const role of ["CLIENT_SERVICE", "VIEWER"]) {
      signIn(role);
      expect(await RosterPage()).toBeNull();
    }
  });

  it("Roster is not found while either switch is off or standalone-served", async () => {
    switches(true, false);
    await expect(RosterPage()).rejects.toThrow("NOT_FOUND");
    switches(false, true);
    await expect(RosterPage()).rejects.toThrow("NOT_FOUND");
    switches(true, true);
    m.aoaServed.mockResolvedValue(false);
    await expect(RosterPage()).rejects.toThrow("NOT_FOUND");
  });
});
