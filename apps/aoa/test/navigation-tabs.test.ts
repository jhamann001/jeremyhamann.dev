import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const { useSearchParams } = vi.hoisted(() => ({ useSearchParams: vi.fn() }));
vi.mock("next/navigation", () => ({ useSearchParams }));

import { NavigationTabs } from "@/components/navigation/NavigationTabs";
import { TabPane } from "@/components/ui/Tabs";

const tabs = [
  { id: "comms", label: "Communications" },
  { id: "financial", label: "Core Financial" },
  { id: "portrait", label: "Portrait" },
];

function browser(initialState: Record<string, unknown> | null, path = "/client-portrait/SYNTHETIC") {
  const location = { href: `http://127.0.0.1:3103${path}` };
  let routerSearch = new URL(location.href).searchParams;
  // The installed Next app-router replaceState seam bypasses hook updates for
  // __NA/_N writes. Model that guard so merely changing the URL cannot pass.
  const replaceState = vi.fn((state: Record<string, unknown>, _unused: string, href: string) => {
    location.href = new URL(href, location.href).href;
    if (!state.__NA && !state._N) routerSearch = new URL(location.href).searchParams;
  });
  vi.stubGlobal("window", { location, history: { state: initialState, replaceState } });
  useSearchParams.mockImplementation(() => routerSearch);
  return { location, replaceState };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("NavigationTabs native-history updates", () => {
  it("removes only Next write markers from a clone, retaining app metadata and router tree", () => {
    const custom = { entryKey: "synthetic-entry", returnHref: "/client-portrait?q=Sample" };
    const tree = ["synthetic-router-tree"];
    const original = Object.freeze({ __NA: true, _N: true, __PRIVATE_NEXTJS_INTERNALS_TREE: tree, __aoaListNavigationEntryV1: "synthetic-list-entry", __aoaHouseholdReturnEntryV1: "synthetic-return-entry", aoaNavigation: custom, extra: 42 });
    const { replaceState } = browser(original);
    NavigationTabs({ tabs }).props.onActiveChange("financial");
    expect(replaceState).toHaveBeenCalledExactlyOnceWith({ __PRIVATE_NEXTJS_INTERNALS_TREE: tree, __aoaListNavigationEntryV1: "synthetic-list-entry", __aoaHouseholdReturnEntryV1: "synthetic-return-entry", aoaNavigation: custom, extra: 42 }, "", "/client-portrait/SYNTHETIC?portraitTab=financial");
    const written = replaceState.mock.calls[0][0];
    expect(written).not.toBe(original);
    expect(written.aoaNavigation).toBe(custom);
    expect(written.__PRIVATE_NEXTJS_INTERNALS_TREE).toBe(tree);
    expect(original.__NA).toBe(true);
    expect(original._N).toBe(true);
  });

  it("updates the controlled financial pane immediately without requiring reload", () => {
    browser({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ["synthetic-tree"] });
    const before = NavigationTabs({ tabs });
    expect(before.props.activeId).toBe("comms");
    before.props.onActiveChange("financial");
    expect(NavigationTabs({ tabs }).props.activeId).toBe("financial");
  });

  it("selects Communications explicitly while retaining unrelated query and hash state", () => {
    const { replaceState } = browser({ __NA: true, aoaEntry: "synthetic-entry" }, "/client-portrait/SYNTHETIC?q=Sample&portraitTab=financial#accounts");
    const before = NavigationTabs({ tabs });
    expect(before.props.activeId).toBe("financial");
    before.props.onActiveChange("comms");
    expect(replaceState).toHaveBeenCalledExactlyOnceWith({ aoaEntry: "synthetic-entry" }, "", "/client-portrait/SYNTHETIC?q=Sample&portraitTab=comms#accounts");
    expect(NavigationTabs({ tabs }).props.activeId).toBe("comms");
  });

  it("handles an absent history state without introducing custom metadata", () => {
    const { replaceState } = browser(null);
    NavigationTabs({ tabs }).props.onActiveChange("financial");
    expect(replaceState).toHaveBeenCalledExactlyOnceWith({}, "", "/client-portrait/SYNTHETIC?portraitTab=financial");
    expect(NavigationTabs({ tabs }).props.activeId).toBe("financial");
  });

  it("defaults an unknown requested pane to the first tab", () => {
    browser({ __NA: true }, "/client-portrait/SYNTHETIC?portraitTab=unknown");
    expect(NavigationTabs({ tabs }).props.activeId).toBe("comms");
  });

  it.each(["portrait", "insights"])("opens Insights from the %s bookmark", (requested) => {
    browser({ __NA: true }, `/client-portrait/SYNTHETIC?portraitTab=${requested}`);
    const submenuTabs = [{ id: "comms", label: "Communications" }, { id: "portrait", label: "Insights" }];
    expect(NavigationTabs({ tabs: submenuTabs }).props.activeId).toBe("portrait");
  });

  it.each(["", "?portraitTab=financial", "?portraitTab=unknown", "?portraitTab=illustration"])("shows the Financial default exactly once for %s", query => {
    browser({ __NA: true }, `/client-portrait/SYNTHETIC${query}`);
    const html = renderToStaticMarkup(NavigationTabs({
      tabs: [{ id: "comms", label: "Communications" }, { id: "portrait", label: "Insights" }],
      standaloneTab: { id: "financial", label: "Core Financial" },
      children: [
        createElement(TabPane, { key: "comms", tabId: "comms", children: "Communications content" }),
        createElement(TabPane, { key: "financial", tabId: "financial", children: "Accounts content" }),
        createElement(TabPane, { key: "portrait", tabId: "portrait", children: "Insights content" }),
      ],
    }));
    expect(html).toMatch(/^<div[^>]* hidden="">/);
    expect(html).toContain('<section aria-label="Core Financial">Accounts content</section>');
    expect(html.match(/Accounts content/g)).toHaveLength(1);
    expect(html).not.toContain('-tab-financial');
    expect(html).toContain('>Insights</button>');
  });

  it.each(["comms", "portrait", "insights", "relationships", "documents"])("keeps the Financial pane hidden for the available %s submenu", requested => {
    browser({ __NA: true }, `/client-portrait/SYNTHETIC?portraitTab=${requested}`);
    const view = NavigationTabs({
      tabs: [
        { id: "comms", label: "Communications" }, { id: "portrait", label: "Insights" },
        { id: "relationships", label: "Relationships" }, { id: "documents", label: "Documents" },
      ],
      standaloneTab: { id: "financial", label: "Core Financial" },
    });
    expect(view.props.children[0].props.hidden).toBe(false);
    expect(view.props.children[0].props.children.props.activeId).toBe(requested === "insights" ? "portrait" : requested);
    expect(view.props.children[1].props.hidden).toBe(true);
  });

  it.each(["relationships", "documents"])("retains the Portrait fallback for a known but unavailable %s submenu", requested => {
    browser({ __NA: true }, `/client-portrait/SYNTHETIC?portraitTab=${requested}`);
    const view = NavigationTabs({
      tabs: [{ id: "comms", label: "Communications" }, { id: "portrait", label: "Insights" }],
      standaloneTab: { id: "financial", label: "Core Financial" },
    });
    expect(view.props.children[0].props.hidden).toBe(false);
    expect(view.props.children[0].props.children.props.activeId).toBe("comms");
    expect(view.props.children[1].props.hidden).toBe(true);
  });
});
