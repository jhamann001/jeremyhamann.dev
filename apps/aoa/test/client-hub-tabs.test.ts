import { afterEach, describe, expect, it, vi } from "vitest";

const { useParams, usePathname, useSearchParams } = vi.hoisted(() => ({
  useParams: vi.fn(), usePathname: vi.fn(), useSearchParams: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useParams, usePathname, useSearchParams }));

import { ClientHubTabs } from "@/components/client-portrait/ClientHubTabs";

function browser(path = "/client-portrait/SYNTHETIC", paramsId = "SYNTHETIC") {
  const location = { href: `http://127.0.0.1:3103${path}` };
  let routerUrl = new URL(location.href);
  const metadata = Object.freeze({
    __NA: true, _N: true,
    __aoaListNavigationEntryV1: "list-entry",
    __aoaHouseholdReturnEntryV1: "household-entry",
    __PRIVATE_NEXTJS_INTERNALS_TREE: ["router-tree"],
  });
  const replaceState = vi.fn((state: Record<string, unknown>, _unused: string, href: string) => {
    location.href = new URL(href, location.href).href;
    if (!state.__NA && !state._N) routerUrl = new URL(location.href);
  });
  vi.stubGlobal("window", { location, history: { state: metadata, replaceState } });
  useParams.mockReturnValue({ id: paramsId });
  usePathname.mockImplementation(() => routerUrl.pathname);
  useSearchParams.mockImplementation(() => routerUrl.searchParams);
  return { location, replaceState, metadata };
}

function link(label: string, showContact = false) {
  return ClientHubTabs({ showContact }).props.children.find((item: { props: { children: string } }) => item.props.children === label);
}

function click(overrides: Record<string, unknown> = {}) {
  return { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, preventDefault: vi.fn(), ...overrides };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("Client hub hierarchy", () => {
  it("places Core Financial first and selects it on bare entry", () => {
    browser();
    const links = ClientHubTabs().props.children;
    expect(links.map((item: { props: { children: string } }) => item.props.children)).toEqual([
      "Core Financial", "Portrait", "Dual-View", "Reminders",
    ]);
    expect(link("Core Financial").props["aria-current"]).toBe("page");
    expect(link("Portrait").props["aria-current"]).toBeUndefined();
    expect(links.every((item: { props: { prefetch: boolean } }) => item.props.prefetch === false)).toBe(true);
  });

  it.each([undefined, false, true])("includes Contact only with an explicit opt-in (%s)", showContact => {
    browser();
    const links = ClientHubTabs({ showContact }).props.children;
    expect(links.map((item: { props: { children: string } }) => item.props.children)).toEqual([
      "Core Financial", "Portrait", ...(showContact ? ["Contact"] : []), "Dual-View", "Reminders",
    ]);
    expect(link("Contact", showContact)?.props.href).toBe(showContact ? "/client-portrait/SYNTHETIC/contact" : undefined);
  });

  it.each([false, true])("switches both top tabs with metadata-safe replacement when Contact is %s", showContact => {
    const selectedLink = (label: string) => link(label, showContact);
    const { replaceState, metadata } = browser("/client-portrait/SYNTHETIC?q=Sample&portraitTab=portrait#accounts");
    const event = click();
    selectedLink("Core Financial").props.onClick(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(replaceState).toHaveBeenCalledExactlyOnceWith({
      __aoaListNavigationEntryV1: "list-entry", __aoaHouseholdReturnEntryV1: "household-entry",
      __PRIVATE_NEXTJS_INTERNALS_TREE: metadata.__PRIVATE_NEXTJS_INTERNALS_TREE,
    }, "", "/client-portrait/SYNTHETIC?q=Sample&portraitTab=financial#accounts");
    expect(selectedLink("Core Financial").props["aria-current"]).toBe("page");
    expect(selectedLink("Portrait").props["aria-current"]).toBeUndefined();
    selectedLink("Portrait").props.onClick(click());
    expect(replaceState).toHaveBeenLastCalledWith(expect.any(Object), "", "/client-portrait/SYNTHETIC?q=Sample&portraitTab=comms#accounts");
    expect(selectedLink("Portrait").props["aria-current"]).toBe("page");
    expect(metadata.__NA).toBe(true);
    expect(metadata._N).toBe(true);
  });

  it.each(["comms", "portrait", "insights", "relationships", "documents"])("keeps Portrait active for the known %s submenu", requested => {
    browser(`/client-portrait/SYNTHETIC?portraitTab=${requested}`);
    expect(link("Portrait").props["aria-current"]).toBe("page");
    expect(link("Core Financial").props["aria-current"]).toBeUndefined();
  });

  it.each(["", "unknown", "illustration"])("selects Financial for the unsupported %s pane", requested => {
    browser(`/client-portrait/SYNTHETIC?portraitTab=${requested}`);
    expect(link("Core Financial").props["aria-current"]).toBe("page");
    expect(link("Portrait").props["aria-current"]).toBeUndefined();
  });

  it.each(["acat", "ira-beneficiary", "wire"])("marks Core Financial as the ancestor of the %s form", slug => {
    browser(`/client-portrait/SYNTHETIC/forms/${slug}`);
    expect(link("Core Financial").props["aria-current"]).toBe("page");
    expect(link("Portrait").props["aria-current"]).toBeUndefined();
  });

  it("keeps route changes as links and preserves unrelated search state", () => {
    const { replaceState } = browser("/client-portrait/SYNTHETIC/contact/details?portraitTab=financial&q=Sample");
    expect(link("Contact", true).props["aria-current"]).toBe("page");
    expect(link("Core Financial").props["aria-current"]).toBeUndefined();
    expect(link("Portrait").props.href).toBe("/client-portrait/SYNTHETIC?portraitTab=comms&q=Sample");
    expect(link("Core Financial").props.href).toBe("/client-portrait/SYNTHETIC?portraitTab=financial&q=Sample");
    const event = click();
    link("Core Financial").props.onClick(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it.each([{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }])("retains normal link behavior for modified clicks %j", overrides => {
    const { replaceState } = browser();
    const event = click(overrides);
    link("Core Financial").props.onClick(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(link("Core Financial").props.href).toBe("/client-portrait/SYNTHETIC?portraitTab=financial");
  });

  it("follows the canonical visible identity after a retired route is replaced", () => {
    const { replaceState } = browser("/client-portrait/CANONICAL?portraitTab=financial", "RETIRED");
    expect(link("Core Financial").props["aria-current"]).toBe("page");
    expect(link("Contact", true).props.href).toBe("/client-portrait/CANONICAL/contact");
    link("Portrait").props.onClick(click());
    expect(replaceState).toHaveBeenCalledWith(expect.any(Object), "", "/client-portrait/CANONICAL?portraitTab=comms");
    expect(link("Portrait").props["aria-current"]).toBe("page");
  });
});
