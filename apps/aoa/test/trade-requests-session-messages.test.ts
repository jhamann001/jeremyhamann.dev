// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMessagesProvider, useSessionMessages } from "@/components/trade-requests/bell/session-messages";

function Writer({ page }: { page: string }) {
  const { add } = useSessionMessages();
  return createElement("button", { type: "button", onClick: () => add(`Synthetic message from ${page}`) }, `Raise on ${page}`);
}

function Bell() {
  const { messages, markRead, clear } = useSessionMessages();
  return createElement("div", null,
    createElement("ul", { "aria-label": "Session messages" },
      messages.map((item) => createElement("li", { key: item.id, "data-date": item.date },
        createElement("button", { type: "button", onClick: () => markRead(item.id) }, item.message)))),
    createElement("button", { type: "button", onClick: clear }, "Mark all read"));
}

const shell = (page: ReactNode, key = "synthetic.user@example.test") =>
  createElement(SessionMessagesProvider, { key, children: [createElement(Bell, { key: "bell" }), createElement("main", { key: "page" }, page)] });
const listed = () => screen.queryAllByRole("listitem").map((item) => item.textContent);

describe("session-message store", () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("adds messages newest first with their date", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T09:30:00Z"));
    render(shell(createElement(Writer, { page: "queue" })));
    fireEvent.click(screen.getByText("Raise on queue"));
    vi.setSystemTime(new Date("2026-10-17T09:31:00Z"));
    fireEvent.click(screen.getByText("Raise on queue"));
    expect(listed()).toEqual(["Synthetic message from queue", "Synthetic message from queue"]);
    expect(screen.getAllByRole("listitem").map((item) => item.dataset.date)).toEqual(["2026-10-17T09:31:00.000Z", "2026-10-17T09:30:00.000Z"]);
  });

  it("returns distinct ids and removes only the selected message", () => {
    let ids: string[] = [];
    function Capture() {
      const { add } = useSessionMessages();
      return createElement("button", { type: "button", onClick: () => { ids = [add("First synthetic"), add("Second synthetic")]; } }, "Raise two");
    }
    render(shell(createElement(Capture)));
    fireEvent.click(screen.getByText("Raise two"));
    expect(new Set(ids).size).toBe(2);
    expect(listed()).toEqual(["Second synthetic", "First synthetic"]);
    fireEvent.click(screen.getByText("Second synthetic"));
    expect(listed()).toEqual(["First synthetic"]);
  });

  it("clears every message", () => {
    render(shell(createElement(Writer, { page: "queue" })));
    fireEvent.click(screen.getByText("Raise on queue"));
    fireEvent.click(screen.getByText("Raise on queue"));
    fireEvent.click(screen.getByText("Mark all read"));
    expect(listed()).toEqual([]);
  });

  it("keeps messages when the page inside the shell changes", () => {
    const view = render(shell(createElement(Writer, { page: "queue" })));
    fireEvent.click(screen.getByText("Raise on queue"));
    view.rerender(shell(createElement(Writer, { page: "detail" })));
    expect(screen.queryByText("Raise on queue")).toBeNull();
    fireEvent.click(screen.getByText("Raise on detail"));
    expect(listed()).toEqual(["Synthetic message from detail", "Synthetic message from queue"]);
  });

  it("starts empty after the shell remounts (full page load or sign-out) or another user signs in", () => {
    const view = render(shell(createElement(Writer, { page: "queue" })));
    fireEvent.click(screen.getByText("Raise on queue"));
    view.rerender(shell(createElement(Writer, { page: "queue" }), "other.user@example.test"));
    expect(listed()).toEqual([]);
    fireEvent.click(screen.getByText("Raise on queue"));
    view.unmount();
    render(shell(createElement(Writer, { page: "queue" }), "other.user@example.test"));
    expect(listed()).toEqual([]);
  });

  it("refuses use outside the shell", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => render(createElement(Bell))).toThrow("useSessionMessages must be used inside SessionMessagesProvider");
    } finally { spy.mockRestore(); }
  });

  it("does not re-create its actions when messages change", () => {
    const seen = new Set<unknown>();
    function Probe() {
      const { add, markRead, clear } = useSessionMessages();
      seen.add(add); seen.add(markRead); seen.add(clear);
      return createElement("button", { type: "button", onClick: () => add("Synthetic") }, "Raise");
    }
    render(shell(createElement(Probe)));
    act(() => { fireEvent.click(screen.getByText("Raise")); });
    expect(seen.size).toBe(3);
  });
});
