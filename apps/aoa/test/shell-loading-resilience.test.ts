import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
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
import PageError from "@/app/(authenticated)/error";
import PageLoading from "@/app/(authenticated)/loading";
import { RosterNotifications } from "@/components/shell/RosterNotifications";
import { NotificationsMenu } from "@/components/shell/Topbar";
import { SessionMessagesProvider } from "@/components/trade-requests/bell/session-messages";
import { TradeRequestGroup, TradeRequestNotificationsProvider } from "@/components/trade-requests/bell/notifications";

describe("authenticated shell loading isolation", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns the shell and children without starting or awaiting the optional reminder", async () => {
    auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "ops@example.test" }, navigationScope: "synthetic", expires: "2026-10-01T00:00:00Z" });
    reminder.mockImplementation(() => new Promise(() => {}));
    const page = await Layout({ children: "Synthetic page" });
    expect(page).toBeTruthy();
    expect(reminder).not.toHaveBeenCalled();
    const source = readFileSync("app/(authenticated)/layout.tsx", "utf8");
    expect(source).toContain('<Suspense fallback={<NotificationsMenu state="loading" />}');
    expect(source).toContain("<RosterNotifications identity={identity} />");
  });

  it("does not catch or bypass authentication failure", async () => {
    auth.mockResolvedValue(null);
    await expect(Layout({ children: "protected" })).rejects.toThrow("redirect:/");
    auth.mockRejectedValue(new Error("auth unavailable"));
    await expect(Layout({ children: "protected" })).rejects.toThrow("auth unavailable");
    expect(reminder).not.toHaveBeenCalled();
  });

  it("shows due notification after its read succeeds with the same identity", async () => {
    const identity = { role: "OPERATIONS", email: "ops@example.test" };
    reminder.mockResolvedValue({ notification: { id: "synthetic", title: "Roster due", body: "Review current roster", href: "/crm/employees", tone: "amber" } });
    const html = renderToStaticMarkup(await RosterNotifications({ identity }));
    expect(reminder).toHaveBeenCalledWith(identity);
    expect(html).toContain("Roster due");
    expect(html).toContain("1 open");
  });

  it("never labels unavailable or loading metadata as zero actions", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    reminder.mockRejectedValue(new Error("SELECT private_client WHERE secret='sensitive'"));
    try {
      const html = renderToStaticMarkup(await RosterNotifications({ identity: { role: "ADMIN" } }));
      expect(html).toContain("Notifications could not be checked");
      expect(html).not.toMatch(/private_client|sensitive|0 open|No operational actions/);
      expect(spy).toHaveBeenCalledExactlyOnceWith("[roster-notifications] unavailable");
      const loading = renderToStaticMarkup(createElement(NotificationsMenu, { state: "loading" }));
      expect(loading).toContain("Checking operations notifications");
      expect(loading).not.toMatch(/0 open|No operational actions/);
    } finally { spy.mockRestore(); }
  });

  it("composes the grouped bell for workspace roles with the flag on without awaiting the reminder", async () => {
    vi.stubEnv("EPIC_TRADE_REQUESTS_WORKSPACE", "1");
    try {
      auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "ops@example.test" }, navigationScope: "synthetic", expires: "2026-10-01T00:00:00Z" });
      reminder.mockImplementation(() => new Promise(() => {}));
      expect(await Layout({ children: "Synthetic page" })).toBeTruthy();
      expect(reminder).not.toHaveBeenCalled();
      const source = readFileSync("app/(authenticated)/layout.tsx", "utf8");
      expect(source).toContain('<Suspense fallback={<NotificationsMenu state="loading" tradeRequestGroup={<TradeRequestGroup />} />}>');
      expect(source).toContain("<RosterNotifications identity={identity} tradeRequestGroup={<TradeRequestGroup />} />");
    } finally { vi.unstubAllEnvs(); }
  });

  // P2 §6: the roster-only bell (CLIENT_SERVICE, VIEWER, flag off) never says
  // "0 open" while loading or unavailable; the grouped bell's header always
  // states the combined count, so it does (AC-167).
  it("states the combined count as 0 open in the grouped bell while the roster loads or is unavailable", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const group = createElement(TradeRequestGroup);
    const inBell = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(
      createElement(SessionMessagesProvider, null, createElement(TradeRequestNotificationsProvider, null, element)),
    );
    reminder.mockRejectedValue(new Error("synthetic roster failure"));
    try {
      const unavailable = inBell(await RosterNotifications({ identity: { role: "ADMIN" }, tradeRequestGroup: group }));
      expect(unavailable).toContain("Notifications could not be checked");
      expect(unavailable).toContain("<span>0 open</span>");
      expect(unavailable).toContain("Checking Trade Request notifications…");
      expect(unavailable).not.toMatch(/synthetic roster failure|No operational actions/);
      const loading = inBell(createElement(NotificationsMenu, { state: "loading", tradeRequestGroup: group }));
      expect(loading).toContain("Checking operations notifications");
      expect(loading).toContain("<span>0 open</span>");
      expect(loading).not.toMatch(/No operational actions|Loading…/);
    } finally { spy.mockRestore(); }
  });

  it("keeps the successful empty state and a generic retry/loading boundary", async () => {
    reminder.mockResolvedValue(null);
    expect(renderToStaticMarkup(await RosterNotifications({ identity: { role: "VIEWER" } }))).toContain("No operational actions need attention");
    const error = renderToStaticMarkup(createElement(PageError, { reset: vi.fn() }));
    expect(error).toContain("This page could not load");
    expect(error).toContain("Try again");
    expect(error).not.toContain("No data was changed");
    expect(renderToStaticMarkup(createElement(PageLoading))).toContain('role="status"');
  });
});
