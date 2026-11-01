/**
 * The shortcut binding table, as pure functions.
 *
 * Two behaviours are load-bearing and both are tested as refusals: a shortcut never fires while
 * somebody is typing (a draft lost to an "n" is a client reply lost), and a modifier key releases every
 * binding so the browser keeps its own shortcuts.
 */
import { describe, expect, it } from "vitest";
import {
  SHORTCUT_ROW_ATTR,
  SHORTCUT_TARGETS,
  activateResolvedTarget,
  isTypingTarget,
  matchShortcut,
  shortcutAnnouncement,
} from "@/components/shell/keyboard-shortcuts";

type FakeEl = { tagName: string; isContentEditable?: boolean; closest: (s: string) => unknown };

function el(tagName: string, over: Partial<FakeEl> = {}): Element {
  return { tagName, closest: () => null, ...over } as unknown as Element;
}

function press(key: string, over: Partial<Parameters<typeof matchShortcut>[0]> = {}) {
  return matchShortcut({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null, ...over });
}

describe("isTypingTarget", () => {
  it("is true for the three fields and for contenteditable", () => {
    expect(isTypingTarget(el("INPUT"))).toBe(true);
    expect(isTypingTarget(el("TEXTAREA"))).toBe(true);
    expect(isTypingTarget(el("SELECT"))).toBe(true);
    expect(isTypingTarget(el("DIV", { isContentEditable: true }))).toBe(true);
  });

  it("is true inside a contenteditable, not only on it", () => {
    expect(isTypingTarget(el("SPAN", { closest: (s) => (s === "[contenteditable=true]" ? {} : null) }))).toBe(true);
  });

  it("is false for an ordinary element and for nothing at all", () => {
    expect(isTypingTarget(el("DIV"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("matchShortcut", () => {
  it("binds the documented keys", () => {
    expect(press("j")).toBe("next");
    expect(press("k")).toBe("previous");
    expect(press("o")).toBe("open");
    expect(press("a")).toBe("assign-to-me");
    expect(press("r")).toBe("reply");
    expect(press("n")).toBe("internal-note");
    expect(press("e")).toBe("edit-ticket");
    expect(press("/")).toBe("search");
    expect(press("?")).toBe("help");
    expect(press("Escape")).toBe("dismiss");
  });

  it("FIRES NOTHING while focus is in a field — typing must always win", () => {
    for (const key of ["j", "k", "o", "a", "r", "n", "e", "/", "?"]) {
      expect(press(key, { target: el("TEXTAREA") }), key).toBeNull();
    }
  });

  it("still lets Escape close what is open from inside a field", () => {
    expect(press("Escape", { target: el("TEXTAREA") })).toBe("dismiss");
  });

  it("releases every binding when a modifier is held, so browser shortcuts survive", () => {
    expect(press("a", { metaKey: true })).toBeNull();
    expect(press("r", { ctrlKey: true })).toBeNull();
    expect(press("/", { altKey: true })).toBeNull();
  });

  it("ignores keys it does not own", () => {
    expect(press("z")).toBeNull();
    expect(press("Enter")).toBeNull(); // the focused control keeps its own Enter behaviour
  });
});

describe("SHORTCUT_TARGETS", () => {
  it("activates existing controls by attribute — no shortcut calls a server action itself", () => {
    expect(SHORTCUT_TARGETS["assign-to-me"]).toContain('[data-shortcut="assign-to-me"]');
    expect(SHORTCUT_TARGETS.reply).toContain('[data-shortcut="reply"]');
    expect(SHORTCUT_TARGETS["internal-note"]).toContain('[data-shortcut="internal-note"]');
    expect(SHORTCUT_TARGETS["edit-ticket"]).toContain('[data-shortcut="edit-ticket"]');
  });

  it("finds a search box without needing its owner to co-operate", () => {
    expect(SHORTCUT_TARGETS.search).toContain('input[type="search"]');
  });

  it("walks rows through its own attribute, so a page opts INTO the cursor", () => {
    // Not `data-ticket-id`: that one is emitted by five components for three purposes (see
    // ticket-list-probe.test.ts), and every element that knows a ticket id is not a cursor stop.
    expect(SHORTCUT_ROW_ATTR).toBe("data-shortcut-row");
    expect(SHORTCUT_ROW_ATTR.startsWith("data-shortcut")).toBe(true);
  });
});

/**
 * Fix round 1. `r` and `n` resolve to Radix `TabsTrigger`s, which do not move on a synthetic
 * `HTMLElement.click()`. The old `activate()` clicked and then announced `"<label> opened."`
 * unconditionally, so a screen-reader user was told they were in the internal-note composer while the
 * composer was still on the client-visible PUBLIC channel — a wrong-channel hazard on the one surface
 * whose entire design keeps the two channels apart.
 *
 * `vitest.config.mts` runs `environment: "node"`, so there is no DOM to render the composer into and
 * no Radix to run. The verification path is therefore tested against a fake tab that behaves the two
 * ways a real one can: automatic activation (focus selects) and the old broken path (click alone moves
 * nothing). Both the SELECTED TAB and the LIVE-REGION TEXT are asserted, which is the pairing that was
 * missing. Recorded as a deviation from the finding's literal "render the composer and press r".
 */
describe("activateResolvedTarget announces only what it observed", () => {
  type FakeTab = {
    selected: boolean;
    focused: boolean;
    clicked: number;
    getAttribute(name: string): string | null;
    focus(): void;
    click(): void;
  };

  /** `selectsOnFocus: true` is Radix's automatic activation; false is what a click-only path sees. */
  function fakeTab(selected: boolean, selectsOnFocus: boolean): FakeTab {
    const el: FakeTab = {
      selected,
      focused: false,
      clicked: 0,
      getAttribute(name) {
        if (name === "role") return "tab";
        if (name === "aria-selected") return el.selected ? "true" : "false";
        return null;
      },
      focus() {
        el.focused = true;
        if (selectsOnFocus) el.selected = true;
      },
      click() {
        el.clicked += 1;
      },
    };
    return el;
  }

  const runNow = (fn: () => void): void => fn();

  it("presses r on the Public reply tab while Internal note is selected: the tab moves AND the announcement says so", () => {
    const publicTab = fakeTab(false, true);
    const said: string[] = [];

    activateResolvedTarget(publicTab, "The reply composer", (m) => said.push(m), runNow);

    expect(publicTab.selected, "the reply tab is now the selected one").toBe(true);
    expect(publicTab.focused, "a tab is selected by focus, not by a synthetic click").toBe(true);
    expect(said).toEqual(["The reply composer opened."]);
  });

  it("does NOT claim the composer opened when the tab did not move", () => {
    const publicTab = fakeTab(false, false);
    const said: string[] = [];

    activateResolvedTarget(publicTab, "The reply composer", (m) => said.push(m), runNow);

    expect(publicTab.selected, "nothing moved — this is the shipped bug's DOM state").toBe(false);
    expect(said).toHaveLength(1);
    expect(said[0], "the failure must not read as success").not.toContain("opened.");
    expect(said[0]).toContain("did not open");
  });

  it("presses n on the Internal note tab and reports the internal channel, not the public one", () => {
    const internalTab = fakeTab(false, true);
    const said: string[] = [];

    activateResolvedTarget(internalTab, "The internal note composer", (m) => said.push(m), runNow);

    expect(internalTab.selected).toBe(true);
    expect(said).toEqual(["The internal note composer opened."]);
  });

  it("still clicks an ordinary control and announces it — e (edit ticket) is a plain Button", () => {
    let clicks = 0;
    const said: string[] = [];
    const button = {
      getAttribute: (name: string) => (name === "role" ? null : null),
      focus: () => undefined,
      click: () => {
        clicks += 1;
      },
    };

    activateResolvedTarget(button, "Edit ticket", (m) => said.push(m), runNow);

    expect(clicks).toBe(1);
    expect(said).toEqual(["Edit ticket opened."]);
  });

  it("keeps the three announcement forms distinct", () => {
    expect(shortcutAnnouncement("X", "opened")).toBe("X opened.");
    expect(shortcutAnnouncement("X", "absent")).toBe("X is not available here.");
    expect(shortcutAnnouncement("X", "no-change")).not.toContain("opened.");
  });
});
