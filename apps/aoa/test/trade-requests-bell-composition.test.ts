import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, Suspense, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { reminder, auth, fetchList } = vi.hoisted(() => ({ reminder: vi.fn(), auth: vi.fn(), fetchList: vi.fn() }));
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
vi.mock("@/lib/trade-requests/notifications-model", async (actual) => ({
  ...(await actual<typeof import("@/lib/trade-requests/notifications-model")>()), fetchBellNotifications: fetchList,
}));

import Layout from "@/app/(authenticated)/layout";
import { RosterNotifications } from "@/components/shell/RosterNotifications";
import { NotificationsMenu, Topbar } from "@/components/shell/Topbar";
import { SessionMessagesProvider } from "@/components/trade-requests/bell/session-messages";
import { TradeRequestGroup, TradeRequestNotificationsProvider } from "@/components/trade-requests/bell/notifications";

function find(node: ReactNode, match: (element: ReactElement) => boolean): ReactElement | undefined {
  if (!isValidElement(node)) return undefined;
  if (match(node)) return node;
  for (const value of Object.values(node.props as Record<string, unknown>)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      const found = find(child as ReactNode, match);
      if (found) return found;
    }
  }
  return undefined;
}

async function bellFor(role: string) {
  auth.mockResolvedValue({ user: { role, email: `${role.toLowerCase()}@example.test` }, navigationScope: "synthetic", expires: "2026-10-01T00:00:00Z" });
  const page = await Layout({ children: "Synthetic page" });
  return (find(page, (el) => el.type === Topbar)!.props as { notificationContent: ReactElement }).notificationContent;
}

describe("bell composition by role and flag", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  for (const role of ["ADMIN", "OPERATIONS", "ADVISOR"]) {
    it(`gives ${role} the Trade Request group in both the roster fallback and the resolved bell (AC-60, AC-159, AC-160)`, async () => {
      vi.stubEnv("EPIC_TRADE_REQUESTS_WORKSPACE", "1");
      const bell = await bellFor(role);
      expect(bell.type).toBe(TradeRequestNotificationsProvider);
      const suspense = find(bell, (el) => el.type === Suspense)!;
      const { fallback, children } = suspense.props as { fallback: ReactElement; children: ReactElement };
      expect(fallback.type).toBe(NotificationsMenu);
      expect((fallback.props as { state: string }).state).toBe("loading");
      expect(((fallback.props as { tradeRequestGroup: ReactElement }).tradeRequestGroup).type).toBe(TradeRequestGroup);
      expect(children.type).toBe(RosterNotifications);
      expect(((children.props as { tradeRequestGroup: ReactElement }).tradeRequestGroup).type).toBe(TradeRequestGroup);
      expect((children.props as { identity: unknown }).identity).toEqual({ role, email: `${role.toLowerCase()}@example.test` });
      expect(reminder).not.toHaveBeenCalled();
    });
  }

  for (const [role, flag] of [["CLIENT_SERVICE", "1"], ["VIEWER", "1"], ["ADMIN", "0"], ["OPERATIONS", "0"], ["ADVISOR", "0"], ["ADVISOR", "true"]]) {
    it(`mounts no Trade Request provider or group for ${role} with EPIC_TRADE_REQUESTS_WORKSPACE=${flag} (AC-158)`, async () => {
      vi.stubEnv("EPIC_TRADE_REQUESTS_WORKSPACE", flag);
      const bell = await bellFor(role);
      expect(bell.type).toBe(Suspense);
      expect(find(bell, (el) => el.type === TradeRequestNotificationsProvider || el.type === TradeRequestGroup)).toBeUndefined();
      const { fallback, children } = bell.props as { fallback: ReactElement; children: ReactElement };
      expect(fallback.props).toEqual({ state: "loading" });
      expect(children.props).toEqual({ identity: { role, email: `${role.toLowerCase()}@example.test` } });
    });
  }

  it("keeps the Trade Request group when the roster cannot be checked (AC-161)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    reminder.mockRejectedValue(new Error("synthetic roster failure"));
    try {
      const menu = await RosterNotifications({ identity: { role: "ADMIN" }, tradeRequestGroup: createElement(TradeRequestGroup) });
      const markup = renderToStaticMarkup(createElement(SessionMessagesProvider, null, createElement(TradeRequestNotificationsProvider, null, menu)));
      expect(markup).toContain("Notifications could not be checked. Refresh to try again");
      expect(markup).toContain('aria-label="Trade Requests"');
      expect(markup).toContain("Mark all read");
      expect(markup.indexOf('aria-label="Operations"')).toBeLessThan(markup.indexOf('aria-label="Trade Requests"'));
    } finally { spy.mockRestore(); }
    expect(fetchList).not.toHaveBeenCalled();
  });
});
