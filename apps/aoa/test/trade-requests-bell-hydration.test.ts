// @vitest-environment jsdom
// The bell inside the roster's Suspense boundary hydrates after the provider above it, so the provider's first load
// can answer first. The bell must still match the server's HTML on that first render (React error #418 otherwise).
import { createElement, lazy, Suspense, type ComponentType } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { fetchList } = vi.hoisted(() => ({ fetchList: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/trade-requests/notifications-model", async (actual) => ({
  ...(await actual<typeof import("@/lib/trade-requests/notifications-model")>()),
  fetchBellNotifications: fetchList,
}));

import { SessionMessagesProvider } from "@/components/trade-requests/bell/session-messages";
import { BellSummary, TradeRequestGroup, TradeRequestNotificationsProvider } from "@/components/trade-requests/bell/notifications";
import { BELL_COPY } from "@/lib/trade-requests/notifications-model";

function Bell() {
  return createElement("div", null, createElement(BellSummary, { rosterOpen: 1 }), createElement(TradeRequestGroup));
}

function tree(Late: ComponentType) {
  return createElement(SessionMessagesProvider, null,
    createElement(TradeRequestNotificationsProvider, null,
      createElement(Suspense, { fallback: createElement("p", null, "Loading") }, createElement(Late))));
}

describe("the bell's first render on the client", () => {
  it("matches the server's HTML even when the first load answers before the bell hydrates", async () => {
    fetchList.mockResolvedValue({
      notifications: [{ id: "00000000-0000-4000-8000-000000000001", message: "Synthetic notification", isRead: false, date: "2026-10-17T09:00:00.000Z" }],
      unreadCount: 1,
    });
    const container = document.createElement("div");
    container.innerHTML = renderToString(tree(Bell));
    document.body.append(container);
    expect(container.textContent).toContain(BELL_COPY.checking);

    // On the client the bell's code arrives late, as the roster's streamed boundary does.
    let arrive!: () => void;
    const LateBell = lazy(() => new Promise<{ default: ComponentType }>((resolve) => { arrive = () => resolve({ default: Bell }); }));
    const recoverable = vi.fn();
    await act(async () => { hydrateRoot(container, tree(LateBell), { onRecoverableError: recoverable }); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fetchList).toHaveBeenCalled();
    await act(async () => { arrive(); await Promise.resolve(); await Promise.resolve(); });

    expect(recoverable).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Synthetic notification");
    expect(container.querySelector("summary")?.getAttribute("aria-label")).toBe("Notifications, 2 open");
  });
});
