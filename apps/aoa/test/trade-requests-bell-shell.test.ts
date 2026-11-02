import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, Suspense, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

const { reminder, auth } = vi.hoisted(() => ({ reminder: vi.fn(), auth: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth, signOut: vi.fn() }));
vi.mock("@/lib/data/employee-roster", () => ({ employeeRosterReminder: reminder }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error(`redirect:${url}`); },
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/components/shell/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/components/shell/SessionTimeout", () => ({ SessionTimeout: () => null }));
vi.mock("@/components/navigation/ListNavigationBoundary", () => ({ ListNavigationBoundary: () => null }));

import Layout from "@/app/(authenticated)/layout";
import { RosterNotifications } from "@/components/shell/RosterNotifications";
import { NotificationsMenu, Topbar, type OperationalNotification } from "@/components/shell/Topbar";
import { SessionMessagesProvider } from "@/components/trade-requests/bell/session-messages";
import { TradeRequestNotificationsProvider } from "@/components/trade-requests/bell/notifications";

const TODAY = JSON.parse(readFileSync("test/fixtures/bell-today.json", "utf8")) as Record<"empty" | "due" | "loading" | "unavailable", string>;
const REMINDER: OperationalNotification = {
  id: "synthetic-roster", title: "Employee roster due", body: "Upload the synthetic roster.", href: "/crm/employees", tone: "red",
};
const GROUP = createElement("section", { "aria-label": "Trade Requests", "data-synthetic-group": "" }, "Synthetic group");
const html = (element: ReactElement) => renderToStaticMarkup(element).replace(/_([A-Za-z]+)_[0-9a-f]{6}/g, "$1");
const menu = (props: Parameters<typeof NotificationsMenu>[0]) => html(createElement(NotificationsMenu, props));
// The layout mounts both stores around a bell that carries the group.
const grouped = (element: ReactElement) =>
  html(createElement(SessionMessagesProvider, null, createElement(TradeRequestNotificationsProvider, null, element)));

function find(node: ReactNode, match: (element: ReactElement) => boolean): ReactElement | undefined {
  if (!isValidElement(node)) return undefined;
  if (match(node)) return node;
  const props = node.props as Record<string, unknown>;
  for (const value of Object.values(props)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      const found = find(child as ReactNode, match);
      if (found) return found;
    }
  }
  return undefined;
}

describe("shared bell shell", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("renders today's bell byte for byte when no Trade Request group is given (AC-157)", () => {
    expect(menu({})).toBe(TODAY.empty);
    expect(menu({ notifications: [REMINDER] })).toBe(TODAY.due);
    expect(menu({ state: "loading" })).toBe(TODAY.loading);
    expect(menu({ state: "unavailable" })).toBe(TODAY.unavailable);
  });

  for (const flag of ["1", "0"]) {
    for (const role of ["CLIENT_SERVICE", "VIEWER"]) {
      it(`composes today's roster-only bell for ${role} with the epic flag ${flag === "1" ? "on" : "off"} (AC-157)`, async () => {
        vi.stubEnv("EPIC_TRADE_REQUESTS_WORKSPACE", flag);
        auth.mockResolvedValue({ user: { role, email: `${role.toLowerCase()}@example.test` }, navigationScope: "synthetic", expires: "2026-10-01T00:00:00Z" });
        const page = await Layout({ children: "Synthetic page" });
        const topbar = find(page, (el) => el.type === Topbar)!;
        const bell = (topbar.props as { notificationContent: ReactElement }).notificationContent;
        expect(bell.type).toBe(Suspense);
        const { fallback, children } = bell.props as { fallback: ReactElement; children: ReactElement };
        expect(fallback.type).toBe(NotificationsMenu);
        expect(fallback.props).toEqual({ state: "loading" });
        expect(children.type).toBe(RosterNotifications);
        expect(children.props).toEqual({ identity: { role, email: `${role.toLowerCase()}@example.test` } });
        reminder.mockResolvedValue(null);
        expect(html(await RosterNotifications({ identity: { role } }))).toBe(TODAY.empty);
        expect(reminder).toHaveBeenCalledTimes(1);
      });
    }
  }

  it("mounts the session-message store around the top bar and page content, keyed by the signed-in user", async () => {
    auth.mockResolvedValue({ user: { role: "ADVISOR", email: "advisor@example.test" }, navigationScope: "synthetic", expires: "2026-10-01T00:00:00Z" });
    const page = await Layout({ children: "Synthetic page" });
    const provider = find(page, (el) => el.type === SessionMessagesProvider)!;
    expect(provider.key).toBe("advisor@example.test");
    expect(find(provider, (el) => el.type === Topbar)).toBeTruthy();
    expect(find(provider, (el) => (el.props as { children?: unknown }).children === "Synthetic page")).toBeTruthy();
  });

  it("keeps the reminder's workflow link in both renderings (AC-163)", async () => {
    reminder.mockResolvedValue({ notification: REMINDER });
    for (const markup of [html(await RosterNotifications({ identity: { role: "OPERATIONS" } })), grouped(await RosterNotifications({ identity: { role: "OPERATIONS" }, tradeRequestGroup: GROUP }))]) {
      expect(markup).toContain('<a class="notificationItem red" href="/crm/employees"><strong>Employee roster due</strong><span>Upload the synthetic roster.</span><small>Open workflow →</small></a>');
    }
  });

  it("shows today's empty line under the Operations heading, before the group (AC-166)", async () => {
    reminder.mockResolvedValue(null);
    const markup = grouped(await RosterNotifications({ identity: { role: "ADVISOR" }, tradeRequestGroup: GROUP }));
    expect(markup).toContain('<section class="notificationSection" aria-label="Operations"><div class="label notificationHeading">Operations</div><p class="notificationEmpty">No operational actions need attention.</p></section>');
    expect(markup.indexOf('aria-label="Operations"')).toBeLessThan(markup.indexOf("data-synthetic-group"));
    expect(markup).toContain('<strong>Operations notifications</strong>');
  });

  it("shows today's unavailable line and roster link when the roster cannot be checked, keeping the group (AC-171)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    reminder.mockRejectedValue(new Error("synthetic roster failure"));
    try {
      const markup = grouped(await RosterNotifications({ identity: { role: "ADMIN" }, tradeRequestGroup: GROUP }));
      expect(markup).toContain('<p class="notificationEmpty" role="status">Notifications could not be checked. Refresh to try again, or open Employee roster to review its status. <a href="/crm/employees">Employee roster →</a></p>');
      expect(markup).toContain(">Operations</div>");
      expect(markup).toContain("data-synthetic-group");
      expect(markup).not.toMatch(/No operational actions|synthetic roster failure/);
    } finally { spy.mockRestore(); }
  });

  it("shows today's loading line in the roster section while the check runs (AC-172)", () => {
    const markup = grouped(createElement(NotificationsMenu, { state: "loading", tradeRequestGroup: GROUP }));
    expect(markup).toContain('<p class="notificationEmpty" role="status">Checking operations notifications…</p>');
    expect(markup).toContain(">Operations</div>");
    expect(markup).toContain("data-synthetic-group");
    expect(markup).not.toMatch(/No operational actions|could not be checked/);
  });
});
