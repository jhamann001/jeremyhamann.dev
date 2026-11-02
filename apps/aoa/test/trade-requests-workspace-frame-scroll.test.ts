// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const loc = vi.hoisted(() => ({ path: "/trade-requests/roster" }));
vi.mock("next/navigation", () => ({ usePathname: () => loc.path, useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children: unknown; prefetch?: boolean }) =>
    createElement("a", { href, ...rest }, children as never),
}));
vi.mock("@/components/trade-requests/queue/QueueProvider", () => ({ TradeRequestsQueueProvider: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/trade-requests/form/NewRequestDraft", () => ({ NewRequestDraftProvider: ({ children }: { children: unknown }) => children }));

import { WorkspaceFrame } from "@/components/trade-requests/WorkspaceFrame";

// A 358 px bar holding five pills; the Roster pill sits past the right edge until the bar scrolls (ticket).
const box = (left: number, width: number) => ({ left, right: left + width, width, top: 0, bottom: 44, height: 44, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
function geometry(this: HTMLElement): DOMRect {
  if (this.tagName === "NAV") return box(16, 358);
  if (this.tagName === "A") {
    const nav = this.closest("nav") as HTMLElement;
    return box(this.getAttribute("href") === "/trade-requests/roster" ? 405 - nav.scrollLeft : 16, 73);
  }
  return box(0, 0);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Workspace pill bar at phone width (ticket)", () => {
  it("scrolls the current pill into the bar after a direct load and leaves a visible one alone", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(geometry);
    const frame = () => createElement(WorkspaceFrame, { sections: { drift: true, roster: true }, children: createElement("span", null, "child") });
    render(frame());
    expect(screen.getByRole("navigation", { name: "Trade Requests workspace" }).scrollLeft).toBe(246.5);
    cleanup();
    loc.path = "/trade-requests";
    render(frame());
    expect(screen.getByRole("navigation", { name: "Trade Requests workspace" }).scrollLeft).toBe(0);
  });
});
