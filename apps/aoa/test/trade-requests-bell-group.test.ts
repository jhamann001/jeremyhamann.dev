// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BellNotification, BellNotificationList } from "@/lib/trade-requests/notifications-model";

const { fetchList, markOne, markAll } = vi.hoisted(() => ({ fetchList: vi.fn(), markOne: vi.fn(), markAll: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/trade-requests/notifications-model", async (actual) => ({
  ...(await actual<typeof import("@/lib/trade-requests/notifications-model")>()),
  fetchBellNotifications: fetchList, postBellMarkRead: markOne, postBellMarkAllRead: markAll,
}));

import { NotificationsMenu, type OperationalNotification } from "@/components/shell/Topbar";
import { SessionMessagesProvider, useSessionMessages } from "@/components/trade-requests/bell/session-messages";
import { BELL_REFRESH_MS, TradeRequestGroup, TradeRequestNotificationsProvider } from "@/components/trade-requests/bell/notifications";

const REMINDER: OperationalNotification = { id: "roster", title: "Employee roster due", body: "Upload the synthetic roster.", href: "/crm/employees", tone: "red" };
const note = (n: number, isRead = false): BellNotification => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, message: `Synthetic notification ${n}`, isRead,
  date: `2026-10-17T0${n % 10}:00:00.000Z`,
});
const list = (notifications: BellNotification[], unreadCount = notifications.filter((item) => !item.isRead).length): BellNotificationList =>
  ({ notifications, unreadCount });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let raise: (message: string) => void = () => {};
function Writer() {
  raise = useSessionMessages().add;
  return null;
}

function renderBell({ roster = [] as OperationalNotification[], state = "ready" as "ready" | "loading" | "unavailable" } = {}) {
  const shell = (children: ReactNode) => createElement(SessionMessagesProvider, null,
    createElement(TradeRequestNotificationsProvider, null, createElement(Writer), children));
  return render(shell(createElement(NotificationsMenu, { notifications: roster, state, tradeRequestGroup: createElement(TradeRequestGroup) })));
}

const group = () => within(screen.getByRole("region", { name: "Trade Requests" }));
const summary = () => document.querySelector("summary")!;
const header = () => document.querySelector("summary + div > div > span")!.textContent;
const items = () => group().queryAllByRole("button").filter((button) => button.textContent !== "Mark all read");
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("Trade Request group in the bell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchList.mockReset();
    markOne.mockResolvedValue(true);
    markAll.mockResolvedValue(true);
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("shows the checking line during the first load, then the list, loading on mount (AC-173, AC-155)", async () => {
    const first = deferred<BellNotificationList | null>();
    fetchList.mockReturnValueOnce(first.promise);
    renderBell();
    expect(fetchList).toHaveBeenCalledTimes(1);
    expect(group().getByRole("status").textContent).toBe("Checking Trade Request notifications…");
    expect(group().queryByText("No notifications")).toBeNull();
    await act(async () => first.resolve(list([note(2), note(1, true)])));
    expect(group().queryByRole("status")).toBeNull();
    expect(items().map((item) => item.querySelector("span")!.textContent)).toEqual(["Synthetic notification 2", "Synthetic notification 1"]);
  });

  it("lists session messages newest first, then service notifications newest first, each with message and date (AC-60, AC-169)", async () => {
    fetchList.mockResolvedValue(list([note(3), note(2, true)]));
    renderBell();
    await flush();
    act(() => { raise("Export failed: synthetic"); });
    act(() => { raise("Status update failed: synthetic"); });
    const rows = items();
    expect(rows.map((row) => row.querySelector("span")!.textContent)).toEqual([
      "Status update failed: synthetic", "Export failed: synthetic", "Synthetic notification 3", "Synthetic notification 2",
    ]);
    const notification = rows[2].querySelector("time")!;
    expect(notification.getAttribute("dateTime")).toBe(note(3).date);
    expect(notification.textContent).toBe(new Date(note(3).date).toLocaleString());
    expect(rows[0].querySelector("time")!.textContent).not.toBe("");
  });

  it("presents unread notifications and every session message distinguished from read ones (AC-168)", async () => {
    fetchList.mockResolvedValue(list([note(2), note(1, true)]));
    renderBell();
    await flush();
    act(() => { raise("Export failed: synthetic"); });
    expect(items().map((row) => row.className.includes("bellUnread") ? "unread" : row.className.includes("bellRead") ? "read" : "?"))
      .toEqual(["unread", "unread", "read"]);
  });

  it("gives unread notifications and session messages a hidden Unread cue, and read ones none (AC-168)", async () => {
    fetchList.mockResolvedValue(list([note(2), note(1, true)]));
    renderBell();
    await flush();
    act(() => { raise("Export failed: synthetic"); });
    expect(items().map((row) => row.querySelector("em")?.textContent ?? null)).toEqual(["Unread", "Unread", null]);
    expect(items().every((row) => !row.querySelector("em") || row.querySelector("em")!.className.includes("srOnly"))).toBe(true);
    expect(items()[0].querySelector("span")!.textContent).toBe("Export failed: synthetic");
  });

  it("selecting an already-read notification makes no mark-read call and no reload", async () => {
    fetchList.mockResolvedValue(list([note(2), note(1, true)]));
    renderBell();
    await flush();
    const before = window.location.href;
    fireEvent.click(group().getByText("Synthetic notification 1"));
    await flush();
    expect(markOne).not.toHaveBeenCalled();
    expect(fetchList).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe(before);
  });

  it("shows No notifications only after a successful load with nothing to show (AC-65)", async () => {
    fetchList.mockResolvedValue(list([]));
    renderBell();
    await flush();
    expect(group().getByText("No notifications")).toBeTruthy();
    act(() => { raise("Export failed: synthetic"); });
    expect(group().queryByText("No notifications")).toBeNull();
  });

  it("shows the could-not-be-checked line below session messages while no load has succeeded (AC-156)", async () => {
    fetchList.mockResolvedValue(null);
    renderBell();
    await flush();
    act(() => { raise("Export failed: synthetic"); });
    const section = screen.getByRole("region", { name: "Trade Requests" });
    expect(group().getByRole("status").textContent).toBe("Trade Request notifications could not be checked.");
    expect(group().queryByText("No notifications")).toBeNull();
    const message = group().getByText("Export failed: synthetic");
    expect(message.compareDocumentPosition(group().getByRole("status")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(section.textContent).not.toContain("Checking");
  });

  it("refreshes every 30 seconds without overlapping, keeping the previous list and count when a refresh fails (AC-64, AC-66)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    fetchList.mockResolvedValueOnce(list([note(1)]));
    renderBell();
    await flush();
    expect(summary().getAttribute("aria-label")).toBe("Notifications, 1 open");

    const slow = deferred<BellNotificationList | null>();
    fetchList.mockReturnValueOnce(slow.promise);
    act(() => { vi.advanceTimersByTime(BELL_REFRESH_MS - 1); });
    expect(fetchList).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(1); });
    expect(fetchList).toHaveBeenCalledTimes(2);
    act(() => { vi.advanceTimersByTime(BELL_REFRESH_MS * 2); });
    expect(fetchList).toHaveBeenCalledTimes(2);
    await act(async () => slow.resolve(null));
    expect(items()).toHaveLength(1);
    expect(summary().getAttribute("aria-label")).toBe("Notifications, 1 open");
    expect(group().queryByRole("status")).toBeNull();

    fetchList.mockResolvedValueOnce(list([note(2), note(1)]));
    await act(async () => { vi.advanceTimersByTime(BELL_REFRESH_MS); });
    await flush();
    expect(fetchList).toHaveBeenCalledTimes(3);
    expect(items()).toHaveLength(2);
    expect(summary().getAttribute("aria-label")).toBe("Notifications, 2 open");
  });

  it("counts roster reminders, unread notifications and session messages that have data, in the badge, label and header (AC-61, AC-167)", async () => {
    const first = deferred<BellNotificationList | null>();
    fetchList.mockReturnValueOnce(first.promise);
    renderBell({ roster: [REMINDER] });
    expect(summary().getAttribute("aria-label")).toBe("Notifications, 1 open");
    expect(header()).toBe("1 open");
    await act(async () => first.resolve(list([note(3), note(2), note(1, true)], 5)));
    act(() => { raise("Export failed: synthetic"); });
    expect(summary().getAttribute("aria-label")).toBe("Notifications, 7 open");
    expect(summary().querySelector("span")!.textContent).toBe("7");
    expect(header()).toBe("7 open");
  });

  it("shows no badge and 0 open when nothing is open, also while the roster loads or is unavailable (AC-61, AC-167)", async () => {
    for (const state of ["loading", "unavailable", "ready"] as const) {
      fetchList.mockResolvedValueOnce(null);
      renderBell({ state });
      await flush();
      expect(summary().getAttribute("aria-label")).toBe("Notifications");
      expect(summary().querySelector("span")).toBeNull();
      expect(header()).toBe("0 open");
      cleanup();
    }
  });

  it("removes a selected session message and marks a selected notification read, staying on the page (AC-77, AC-154, AC-62)", async () => {
    fetchList.mockResolvedValueOnce(list([note(1)])).mockResolvedValueOnce(list([note(1, true)]));
    renderBell();
    await flush();
    act(() => { raise("Export failed: synthetic"); });
    const before = window.location.href;
    expect(document.querySelectorAll("section[aria-label='Trade Requests'] a")).toHaveLength(0);
    fireEvent.click(group().getByText("Export failed: synthetic"));
    expect(group().queryByText("Export failed: synthetic")).toBeNull();
    expect(markOne).not.toHaveBeenCalled();
    fireEvent.click(group().getByText("Synthetic notification 1"));
    await flush();
    expect(markOne).toHaveBeenCalledExactlyOnceWith(note(1).id);
    expect(items()[0].className).toContain("bellRead");
    expect(fetchList).toHaveBeenCalledTimes(2);
    expect(window.location.href).toBe(before);
    expect(summary().getAttribute("aria-label")).toBe("Notifications");
  });

  it("Mark all read removes every session message and marks notifications read, leaving the roster reminder (AC-78, AC-164, AC-63)", async () => {
    fetchList.mockResolvedValueOnce(list([note(2), note(1)])).mockResolvedValueOnce(list([note(2, true), note(1, true)]));
    renderBell({ roster: [REMINDER] });
    await flush();
    act(() => { raise("Export failed: synthetic"); raise("Status update failed: synthetic"); });
    expect(header()).toBe("5 open");
    fireEvent.click(group().getByRole("button", { name: "Mark all read" }));
    await flush();
    expect(markAll).toHaveBeenCalledTimes(1);
    expect(group().queryByText(/synthetic$/)).toBeNull();
    expect(items().every((row) => row.className.includes("bellRead"))).toBe(true);
    expect(screen.getByRole("link", { name: /Employee roster due/ }).getAttribute("href")).toBe("/crm/employees");
    expect(header()).toBe("1 open");
  });

  it("clears session messages even when the service mark-all fails, keeping notifications unread", async () => {
    fetchList.mockResolvedValue(list([note(1)]));
    markAll.mockResolvedValue(false);
    renderBell();
    await flush();
    act(() => { raise("Export failed: synthetic"); });
    fireEvent.click(group().getByRole("button", { name: "Mark all read" }));
    await flush();
    expect(group().queryByText("Export failed: synthetic")).toBeNull();
    expect(items()[0].className).toContain("bellUnread");
    expect(fetchList).toHaveBeenCalledTimes(1);
  });

  it("keeps a notification marked read after a refresh that was already in progress completes (AC-170)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    fetchList.mockResolvedValueOnce(list([note(2), note(1)]));
    renderBell();
    await flush();
    const stale = deferred<BellNotificationList | null>();
    fetchList.mockReturnValueOnce(stale.promise);
    act(() => { vi.advanceTimersByTime(BELL_REFRESH_MS); });
    expect(fetchList).toHaveBeenCalledTimes(2);
    fireEvent.click(group().getByText("Synthetic notification 2"));
    await flush();
    expect(fetchList).toHaveBeenCalledTimes(2);
    const reconciled = deferred<BellNotificationList | null>();
    fetchList.mockReturnValueOnce(reconciled.promise);
    await act(async () => stale.resolve(list([note(3), note(2), note(1)])));
    expect(items().map((row) => row.className.includes("bellUnread"))).toEqual([true, false, true]);
    expect(summary().getAttribute("aria-label")).toBe("Notifications, 2 open");
    expect(fetchList).toHaveBeenCalledTimes(3);
    await act(async () => reconciled.resolve(list([note(3), note(2, true), note(1)])));
    expect(items().map((row) => row.className.includes("bellUnread"))).toEqual([true, false, true]);
    expect(fetchList).toHaveBeenCalledTimes(3);
  });

  it("keeps everything marked by Mark all read as read after an in-progress refresh completes (AC-170)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    fetchList.mockResolvedValueOnce(list([note(2), note(1)]));
    renderBell();
    await flush();
    const stale = deferred<BellNotificationList | null>();
    fetchList.mockReturnValueOnce(stale.promise);
    act(() => { vi.advanceTimersByTime(BELL_REFRESH_MS); });
    fireEvent.click(group().getByRole("button", { name: "Mark all read" }));
    await flush();
    const reconciled = deferred<BellNotificationList | null>();
    fetchList.mockReturnValueOnce(reconciled.promise);
    await act(async () => stale.resolve(list([note(3), note(2), note(1)], 3)));
    expect(items().map((row) => row.className.includes("bellUnread"))).toEqual([true, false, false]);
    expect(summary().getAttribute("aria-label")).toBe("Notifications, 1 open");
    expect(fetchList).toHaveBeenCalledTimes(3);
    await act(async () => reconciled.resolve(list([note(3, true), note(2, true), note(1, true)], 0)));
    expect(summary().getAttribute("aria-label")).toBe("Notifications");
  });

  it("keeps the roster reminder when notifications fail, and the group when the roster is unavailable (AC-162, AC-161, AC-159)", async () => {
    fetchList.mockResolvedValue(null);
    renderBell({ roster: [REMINDER] });
    await flush();
    expect(screen.getByRole("link", { name: /Employee roster due/ })).toBeTruthy();
    expect(group().getByRole("status").textContent).toBe("Trade Request notifications could not be checked.");
    cleanup();
    fetchList.mockResolvedValue(list([note(1)]));
    renderBell({ state: "unavailable" });
    await flush();
    expect(screen.getByText(/Notifications could not be checked\. Refresh to try again/)).toBeTruthy();
    expect(group().getByText("Synthetic notification 1")).toBeTruthy();
  });

  it("lists the Operations section first and the Trade Requests group after it, each under its heading (AC-160)", async () => {
    fetchList.mockResolvedValue(list([]));
    renderBell({ roster: [REMINDER] });
    await flush();
    const sections = [...document.querySelectorAll("details section")].map((section) => section.getAttribute("aria-label"));
    expect(sections).toEqual(["Operations", "Trade Requests"]);
    expect(group().getByText("Trade Requests").className).toContain("label");
  });
});
