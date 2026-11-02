import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MouseEvent, ReactElement } from "react";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(), back: vi.fn(), pathname: "/households/synthetic-1",
  layoutEffect: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, back: mocks.back }),
  usePathname: () => mocks.pathname,
}));
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: vi.fn(),
  useLayoutEffect: mocks.layoutEffect,
  useCallback: (callback: unknown) => callback,
  useRef: (initial: unknown) => ({ current: initial }),
  useState: (initial: unknown) => [initial, vi.fn()],
}));

import { HouseholdBackLink } from "@/components/navigation/HouseholdBackLink";
import { ClearNavigationMemory, ListNavigationBoundary } from "@/components/navigation/ListNavigationBoundary";
import { getBrowserListNavigationMemory } from "@/lib/navigation/list-memory";
import { clearListHistoryState, getListHistoryEntryId } from "@/lib/navigation/history-entry";

const scope = "synthetic-session-1";
const origin = "/households?q=Demo&stage=all";
const position = { firstPage: 1, lastPage: 2, anchorId: null, anchorOffset: 0, scrollTop: 200 };
type LinkProps = { href: string; onClick: (event: MouseEvent<HTMLAnchorElement>) => void };

function event(overrides: Partial<MouseEvent<HTMLAnchorElement>> = {}) {
  return {
    button: 0, defaultPrevented: false, metaKey: false, ctrlKey: false,
    altKey: false, shiftKey: false, preventDefault: vi.fn(), ...overrides,
  } as unknown as MouseEvent<HTMLAnchorElement>;
}

beforeEach(() => {
  clearListHistoryState();
  mocks.replace.mockClear();
  mocks.back.mockClear();
  mocks.layoutEffect.mockClear();
  mocks.pathname = "/households/synthetic-1";
  vi.stubGlobal("window", Object.defineProperty({ addEventListener: vi.fn() }, "history", {
    get: () => { throw new Error("never inspect history length or private state"); },
  }));
  getBrowserListNavigationMemory()!.clear();
});
afterEach(() => {
  getBrowserListNavigationMemory()!.clear();
  clearListHistoryState();
  vi.unstubAllGlobals();
});

function repeatedDetailVisits() {
  let historyState: Record<string, unknown> = {};
  let pathname = "/households";
  let random = 0;
  vi.stubGlobal("window", {
    history: {
      get state() { return historyState; },
      replaceState: (next: Record<string, unknown>) => { historyState = next; },
    },
    location: { get pathname() { return pathname; }, search: "" },
    crypto: { getRandomValues: (values: Uint8Array) => { values.fill(++random); return values; } },
    addEventListener: vi.fn(),
  });
  const memory = getBrowserListNavigationMemory()!;
  memory.setScope(scope);
  const firstId = getListHistoryEntryId(scope, origin)!;
  memory.save(scope, origin, position, firstId);
  memory.rememberReturn(scope, mocks.pathname, origin, firstId);
  historyState = {}; pathname = mocks.pathname;
  HouseholdBackLink({ scope });
  (mocks.layoutEffect.mock.calls.at(-1)![0] as () => void)();
  const firstDetailState = historyState;
  const otherOrigin = "/households?q=Different";
  historyState = {}; pathname = "/households";
  const secondId = getListHistoryEntryId(scope, otherOrigin)!;
  memory.save(scope, otherOrigin, position, secondId);
  memory.rememberReturn(scope, mocks.pathname, otherOrigin, secondId);
  historyState = {}; pathname = mocks.pathname;
  HouseholdBackLink({ scope });
  (mocks.layoutEffect.mock.calls.at(-1)![0] as () => void)();
  // Browser traversal returns to the older occurrence of this same household.
  historyState = firstDetailState;
  return { memory, firstId, otherOrigin, replaceCurrentState: () => { historyState = {}; } };
}

describe("safe household back link", () => {
  it("renders a real safe direct-entry fallback before hydration", () => {
    const result = HouseholdBackLink({ scope }) as ReactElement<LinkProps>;
    expect(result.props.href).toBe("/households");
  });

  it("restores a verified exact-record origin without reading browser history", () => {
    const memory = getBrowserListNavigationMemory()!;
    memory.setScope(scope);
    memory.save(scope, origin, position);
    memory.rememberReturn(scope, mocks.pathname, origin);
    const result = HouseholdBackLink({ scope }) as ReactElement<LinkProps>;
    const click = event();
    result.props.onClick(click);
    expect(click.preventDefault).toHaveBeenCalledOnce();
    expect(mocks.replace).toHaveBeenCalledWith(origin, { scroll: false });
    expect(mocks.back).not.toHaveBeenCalled();
  });

  it("does not reuse another household's remembered origin", () => {
    const memory = getBrowserListNavigationMemory()!;
    memory.setScope(scope);
    memory.save(scope, origin, position);
    memory.rememberReturn(scope, "/households/synthetic-2", origin);
    const result = HouseholdBackLink({ scope }) as ReactElement<LinkProps>;
    result.props.onClick(event());
    expect(mocks.replace).toHaveBeenCalledWith("/households", { scroll: true });
  });

  it("invalidates remembered context at click time when scope changes", () => {
    const memory = getBrowserListNavigationMemory()!;
    memory.setScope(scope);
    memory.save(scope, origin, position);
    memory.rememberReturn(scope, mocks.pathname, origin);
    const result = HouseholdBackLink({ scope }) as ReactElement<LinkProps>;
    memory.setScope("other-session");
    result.props.onClick(event());
    expect(mocks.replace).toHaveBeenCalledWith("/households", { scroll: true });
  });

  it("accepts an explicit exact detail path for canonical route integration", () => {
    const memory = getBrowserListNavigationMemory()!;
    memory.setScope(scope);
    memory.save(scope, origin, position);
    memory.rememberReturn(scope, "/households/canonical-synthetic", origin);
    const result = HouseholdBackLink({ scope, detailHref: "/households/canonical-synthetic" }) as ReactElement<LinkProps>;
    result.props.onClick(event());
    expect(mocks.replace).toHaveBeenCalledWith(origin, { scroll: false });
  });

  it.each([
    { button: 1 }, { metaKey: true }, { ctrlKey: true }, { altKey: true },
    { shiftKey: true }, { defaultPrevented: true },
  ])("preserves modified clicks and native link behavior: %s", (overrides) => {
    const result = HouseholdBackLink({ scope }) as ReactElement<LinkProps>;
    const click = event(overrides);
    result.props.onClick(click);
    expect(click.preventDefault).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("fails closed even if an unsafe fallback bypasses the TypeScript contract", () => {
    const result = HouseholdBackLink({ scope, fallback: "https://example.com" as "/households" }) as ReactElement<LinkProps>;
    expect(result.props.href).toBe("/households");
    result.props.onClick(event());
    expect(mocks.replace).toHaveBeenCalledWith("/households", { scroll: true });
  });

  it("in-app Back honors this household occurrence even after another query opened it", () => {
    const { memory, otherOrigin } = repeatedDetailVisits();
    expect(memory.returnHref(scope, mocks.pathname)).toBe(otherOrigin);
    const result = HouseholdBackLink({ scope }) as ReactElement<LinkProps>;
    result.props.onClick(event());
    expect(mocks.replace).toHaveBeenCalledWith(origin, { scroll: false });
  });

  it("revalidates the bound origin instead of substituting a newer origin when evicted", () => {
    const { memory, firstId } = repeatedDetailVisits();
    memory.forget(scope, origin, firstId);
    const result = HouseholdBackLink({ scope }) as ReactElement<LinkProps>;
    result.props.onClick(event());
    expect(mocks.replace).toHaveBeenCalledWith("/households", { scroll: true });
  });

  it("keeps an older visit's origin when an internal detail filter replaces framework state", () => {
    const { replaceCurrentState } = repeatedDetailVisits();
    const result = HouseholdBackLink({ scope }) as ReactElement<LinkProps>;
    (mocks.layoutEffect.mock.calls.at(-1)![0] as () => void)();
    replaceCurrentState();
    result.props.onClick(event());
    expect(mocks.replace).toHaveBeenCalledWith(origin, { scroll: false });
  });
});

describe("authenticated navigation-memory lifetime", () => {
  it("activates metadata without clearing the signed-in session on layout unmount", () => {
    expect(ListNavigationBoundary({ scope })).toBeNull();
    const effect = mocks.layoutEffect.mock.calls[0][0] as () => () => void;
    const cleanup = effect();
    const memory = getBrowserListNavigationMemory()!;
    expect(memory.save(scope, origin, position)).toBe(true);
    expect(cleanup).toBeUndefined();
    expect(memory.read(scope, origin)).not.toBeNull();
  });

  it("scope changes replace old session metadata without a stale cleanup handler", () => {
    ListNavigationBoundary({ scope });
    const cleanup = (mocks.layoutEffect.mock.calls[0][0] as () => () => void)();
    const memory = getBrowserListNavigationMemory()!;
    memory.setScope("new-scope");
    memory.save("new-scope", origin, position);
    expect(cleanup).toBeUndefined();
    expect(memory.read("new-scope", origin)).not.toBeNull();
    expect(memory.read(scope, origin)).toBeNull();
  });

  it("clears navigation metadata when the server confirms sign-out", () => {
    const memory = getBrowserListNavigationMemory()!;
    memory.setScope(scope); memory.save(scope, origin, position);
    expect(ClearNavigationMemory()).toBeNull();
    (mocks.layoutEffect.mock.calls.at(-1)![0] as () => void)();
    expect(memory.read(scope, origin)).toBeNull();
  });
});
